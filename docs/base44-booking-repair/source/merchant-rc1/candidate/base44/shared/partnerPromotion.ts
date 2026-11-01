// Promotes a merchant account to match an approved partner application.
// Shared by the LEX webhook receiver (system), the admin approve action,
// and the post-registration setup flow. Looks up the merchant by contact_email
// so it works whether the user already set up their account or is promoted
// after the fact. No auth here — callers are server-side or gate it themselves.
//
// Alongside the merchant promotion, an approved PortalMembership record is
// created for the partner's user. This is what actually authorizes vep/pudo
// portal access: the merchant fields are kept in sync for display, but they
// are client-updatable and are never trusted as authorization evidence.

// Ensure an approved membership exists for the partner's portal. No-op when
// the user is not registered yet (their Setup flow completes it) or when a
// membership of any status already exists (an admin may have suspended it —
// never silently re-approve over an admin decision).
async function ensurePortalMembership(sr, application, portalType, merchantId, approvedBy, callerUser) {
  if (!portalType) return { membership: "skipped", reason: "no_portal_type" };
  try {
    let userId = callerUser ? callerUser.id : null;
    if (!userId) {
      const email = String(application.email || "").toLowerCase();
      if (!email) return { membership: "skipped", reason: "no_email" };
      const users = await sr.entities.User.filter({ email }, "-created_date", 10);
      userId = (users && users[0] && users[0].id) || null;
    }
    if (!userId) return { membership: "skipped", reason: "user_not_yet_registered" };

    const existing = await sr.entities.PortalMembership.filter(
      { user_id: userId, portal_type: portalType },
      "-created_date",
      10
    );
    if (existing && existing.length > 0) return { membership: "exists" };

    await sr.entities.PortalMembership.create({
      user_id: userId,
      portal_type: portalType,
      role: "member",
      status: "approved",
      source: "application",
      organization_id: merchantId || "",
      approved_by: approvedBy || "partner-application-approval",
      approved_at: new Date().toISOString(),
      note: `Approved partner application ${application.id}`,
    });
    return { membership: "created", user_id: userId };
  } catch (e) {
    return { membership: "error", reason: String((e && e.message) || e) };
  }
}

export async function promoteMerchantForApplication(sr, application, options = {}) {
  if (!application || application.status !== "approved") {
    return { promoted: false, reason: "not_approved" };
  }
  const type = application.type; // "exchange_partner" | "pudo_partner"
  if (!type) return { promoted: false, reason: "no_type" };

  const email = String(application.email || "").toLowerCase();
  if (!email) return { promoted: false, reason: "no_email" };

  const portalType = type === "exchange_partner" ? "vep" : "pudo";

  // Find the merchant whose contact email matches the application.
  const found = await sr.entities.Merchant.filter(
    { contact_email: email },
    "-created_date",
    10
  );
  let merchant = (found && found[0]) || null;

  // If no merchant exists yet (the partner applied but never went through
  // the Sender setup wizard), create one now so they land directly on the
  // partner dashboard after login.
  if (!merchant) {
    merchant = await sr.entities.Merchant.create({
      company_name: application.business_name || application.contact_name || email,
      contact_name: application.contact_name || "",
      contact_email: email,
      phone: application.phone || "",
      address: application.address || "",
      merchant_type: type,
      verified_types: ["individual", type],
      active_type: type,
      status: "active",
      partner_status: "approved",
      rewards_points: 0,
    });
  } else if (!(merchant.active_type === type && merchant.merchant_type === type)) {
    // Keep merchant display fields in sync (already promoted accounts skip).
    const verified = Array.isArray(merchant.verified_types)
      ? merchant.verified_types
      : ["individual"];
    const updatedVerified = verified.includes(type) ? verified : [...verified, type];

    await sr.entities.Merchant.update(merchant.id, {
      merchant_type: type,
      active_type: type,
      verified_types: updatedVerified,
      partner_status: "approved",
    });
  }

  // Authoritative grant: the approved PortalMembership record.
  const membership = await ensurePortalMembership(
    sr,
    application,
    portalType,
    merchant.id,
    options.approvedBy,
    options.callerUser
  );

  return {
    promoted: true,
    merchantId: merchant.id,
    type,
    portal_type: portalType,
    membership,
  };
}