// Shared portal-membership logic used by portal access, partner custody,
// and the migration functions. One source of truth for how legacy
// Merchant records map to the sender | vep | pudo portal model.

export const PORTAL_TYPES = ["sender", "vep", "pudo"];

// Maps a legacy Merchant record to the portal access it reliably proves.
//
// Sender access: a merchant record carrying an individual or organization
// verified type proves its own shipping account, so the legacy fallback
// trusts it for the sender portal only.
//
// Partner access (vep | pudo): the Merchant entity is client-updatable by
// its owner (verified_types, partner_status and active_type are ordinary
// fields the owner may write), so merchant fields alone can never prove
// partner approval. By default a claimed partner type produces only a
// pending, flagged entry — operational partner access requires an
// approved PortalMembership record, which only admins (or the service
// role during a sanctioned approval or migration) can create.
//
// The admin-run backfill migration passes { legacyPartners: true } because
// it is a trusted, admin-initiated mapping of records that predate the
// membership model, and it is the sanctioned path for preserving access
// of genuinely approved legacy partners.
export function membershipsFromMerchant(merchant, { legacyPartners = false } = {}) {
  const out = [];
  if (!merchant) return out;
  const verified = Array.isArray(merchant.verified_types) ? merchant.verified_types : [];
  const partnerApproved = merchant.partner_status === "approved";

  if (verified.includes("individual") || verified.includes("organization")) {
    out.push({ portal_type: "sender", status: "approved", role: "member" });
  }

  const partnerClaims = [
    ["exchange_partner", "vep"],
    ["pudo_partner", "pudo"],
  ];
  for (const [type, portal] of partnerClaims) {
    if (!verified.includes(type)) continue;
    if (legacyPartners && partnerApproved) {
      out.push({ portal_type: portal, status: "approved", role: "member" });
    } else {
      out.push({
        portal_type: portal,
        status: "pending",
        role: "member",
        flag: `merchant record claims ${type} — portal access requires an approved PortalMembership (admin-granted); legacy merchant fields are client-updatable and cannot authorize partner access`,
      });
    }
  }

  if (out.length === 0) {
    out.push({
      portal_type: "sender",
      status: "pending",
      role: "member",
      flag: "no verifiable legacy account type — needs manual review",
    });
  }

  return out;
}

// The merchant record that belongs to the signed-in account. A sender
// creates its own record (created_by_id); a partner promoted from an
// approved application gets one written by the service role with their own
// email as contact_email (see partnerPromotion). Both keys are checked, in
// that order.
//
// This must never fall back to a global read: a "newest merchant in the
// database" lookup hands every account whichever merchant was created last,
// so one account's record ends up deciding another account's portal, its
// operating type, and the company name on its dashboard.
export async function resolveCallerMerchant(client, user) {
  const owned = await client.entities.Merchant.filter(
    { created_by_id: user.id },
    { sort: "-created_date", limit: 1 }
  );
  const mine = (owned?.items || [])[0];
  if (mine) return mine;

  const email = String(user?.email || "");
  if (!email) return null;
  const byEmail = await client.entities.Merchant.filter(
    { contact_email: email },
    { sort: "-created_date", limit: 1 }
  );
  return (byEmail?.items || [])[0] || null;
}

// Authoritative portal-access answer for an authenticated user, shared by
// the portal access function and the custody gate. Resolves the user's
// PortalMembership records first; the caller's own Merchant record only
// fills gaps until migration completes.
//
// merchantClient lets a caller that holds a service-role client read the
// caller's own merchant even when row-level security hides it from the user
// client (a partner promoted from an approved application has a merchant
// written by the service role). The filters inside resolveCallerMerchant are
// pinned to the authenticated user's own id and email either way.
export async function resolvePortalAccess(client, user, options = {}) {
  const merchantClient = options.merchantClient || client;
  const membershipPage = await client.entities.PortalMembership.filter(
    { user_id: user.id },
    { sort: "-created_date", limit: 50 }
  );
  const memberships = membershipPage.items || [];

  const merchant = await resolveCallerMerchant(merchantClient, user);

  const portals = { sender: null, vep: null, pudo: null };
  for (const m of memberships) {
    if (m.portal_type && portals[m.portal_type] === null) {
      portals[m.portal_type] = {
        status: m.status,
        role: m.role,
        source: "membership",
        membership_id: m.id,
      };
    }
  }
  const legacy = legacyPortalAccess(merchant);
  for (const portalType of Object.keys(legacy)) {
    if (portals[portalType] === null) {
      portals[portalType] = { ...legacy[portalType], source: "legacy" };
    }
  }

  // The sender portal is the self-serve customer portal: every authenticated
  // account ships on its own account, so signing up grants sender access
  // immediately — no approval step and no denial screen on the way in.
  // An explicit sender PortalMembership still wins, so an admin suspension or
  // revocation stays authoritative. The partner portals (vep | pudo) are
  // untouched and remain membership-gated.
  if (!memberships.some((m) => m.portal_type === "sender")) {
    portals.sender = { status: "approved", role: "member", source: "account" };
  }

  return {
    portals,
    merchant,
    memberships,
    home_portal: resolveHomePortal(portals, merchant),
  };
}

// Legacy fallback view used only until a user has real PortalMembership
// records: derives portal access from the user's own Merchant record.
// It grants the sender portal for a merchant's own account types, and only
// ever flags (never grants) partner claims — see membershipsFromMerchant.
export function legacyPortalAccess(merchant) {
  const result = {};
  if (!merchant) return result;
  for (const m of membershipsFromMerchant(merchant)) {
    result[m.portal_type] = { status: m.status, reason: "legacy merchant record" };
    if (m.flag) result[m.portal_type].note = m.flag;
  }
  return result;
}

// The account's ONE portal. An approved partner membership claims the
// account for that partner portal; every other account is a Sender, which
// is open to all. A pending, suspended, or revoked partner therefore
// resolves to the Sender portal rather than a dead end — there is no
// "no access" state anywhere in the app.
export function resolveHomePortal(portals, merchant) {
  const approved = (p) => portals[p]?.status === "approved";
  if (approved("vep") && approved("pudo")) {
    // Both partner portals are approved (legacy accounts were backfilled
    // with both). The account's own merchant record breaks the tie: the type
    // it was promoted as, then the type it operates as, then what it is
    // verified for — never a blanket preference for one portal.
    const declared = merchant?.merchant_type;
    const active = merchant?.active_type;
    const verified = Array.isArray(merchant?.verified_types) ? merchant.verified_types : [];
    if (declared === "pudo_partner" || active === "pudo_partner") return "pudo";
    if (declared === "exchange_partner" || active === "exchange_partner") return "vep";
    if (verified.includes("pudo_partner") && !verified.includes("exchange_partner")) return "pudo";
    return "vep";
  }
  if (approved("vep")) return "vep";
  if (approved("pudo")) return "pudo";
  return "sender";
}