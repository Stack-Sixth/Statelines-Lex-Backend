// Server-side authority for acting on the domain network on behalf of a
// merchant, plus the RELEASE GATE that decides whether a booking or a
// cancellation command may be sent. This is the only place that decides it.
//
// Two layers, reported separately because they prove different things:
//
//   1. LOCAL CONFIGURATION (no network): an authorized DomainMerchantLink row
//      exists for this merchant and that merchant's OWN dedicated credentials
//      are present in app secrets. This proves configuration only. It does NOT
//      prove the backend accepts the credential.
//
//   2. VERIFIED AUTHORIZATION (network): GET /api/v1/merchant-context with that
//      dedicated credential, requiring the returned merchant_id, client_id and
//      subject to match the mapping and the signing identity exactly. Only this
//      proves the credential is accepted and speaks for the merchant we mapped.
//
// A command is released only when BOTH hold AND the coordinated verification is
// recorded on the mapping (scope_verified_at + verified_merchant_id +
// verified_client_id + verified_subject + verified_credential_fingerprint).
// Until that is recorded by the server-side recorder, the gate stays closed:
// adding credentials and an authorized mapping can never by itself reopen
// booking, and rotating the credential pair invalidates an existing stamp.
//
// The individual rules live in authorityRules.ts (pure, unit-tested); this
// module only performs the I/O they need.

import { secrets } from "base44:runtime";
import { resolveCallerMerchant } from "./portalMemberships.ts";
import { verifyMerchantContext } from "./renderClient.ts";
import {
  credentialFingerprint,
  evaluateBookingRelease,
  evaluateLocalConfiguration,
  verificationStampState,
  BOOKING_RELEASE_FLAG,
  DEPLOYMENT_ACTION,
  PROVISIONING_ACTION,
  VERIFICATION_ACTION,
  type BookingRelease,
  type LocalResult,
} from "./authorityRules.ts";

export type {
  AuthorityFailure,
  DomainCredentials,
  DomainLink,
  LocalConfig,
  LocalFailure,
  LocalFailureCode,
  LocalResult,
} from "./authorityRules.ts";
export {
  PROVISIONING_ACTION,
  VERIFICATION_ACTION,
  DEPLOYMENT_ACTION,
  credentialNames,
  evaluateLocalConfiguration,
  verificationStampState,
  credentialFingerprint,
} from "./authorityRules.ts";

export type VerificationStatus =
  | "verified"
  | "not_verified"
  | "backend_unavailable"
  | "unauthorized"
  | "mismatch"
  | "malformed"
  | "not_attempted";

export interface VerificationReport {
  status: VerificationStatus;
  code: string;
  message: string;
  checked_at: string;
  http_status?: number;
}

export interface VerifiedAuthority {
  /**
   * Authorization gate: local configuration + verified backend context +
   * recorded verification stamp. Cancellation commands use this.
   */
  ready: boolean;
  release_gate: "open" | "closed";
  /**
   * Booking gate: `ready` AND the separate operator release switch. A
   * successful merchant-context probe never opens booking on its own.
   */
  booking_release: BookingRelease;
  local: LocalResult;
  verification: VerificationReport;
  /** Backend-evidenced isolation. A browser marker never sets this. */
  isolation: { sandbox_isolated: boolean; evidenced: boolean };
  code: string;
  message: string;
  action: string;
  merchant_id?: string;
  identity?: {
    merchant_id: string;
    domain_merchant_id: string;
    client_id: string;
    signing_subject: string;
    /** Fingerprint of the credential pair in use; never the secret itself. */
    credential_fingerprint: string;
  };
}

// Resolve LOCAL configuration for the authenticated user's own merchant.
// Merchant identity comes from the account — the caller cannot name another.
export async function loadLocalAuthority(
  sr: { entities: Record<string, any> },
  user: { id: string; email?: string },
): Promise<LocalResult> {
  const merchant = await resolveCallerMerchant(sr, user);
  if (!merchant) {
    return {
      ok: false,
      code: "merchant_missing",
      message: "No merchant account is associated with this login.",
      action: "Complete merchant onboarding for this account, then retry.",
    };
  }

  const page = await sr.entities.DomainMerchantLink.filter(
    { merchant_id: merchant.id },
    { sort: "-created_date", limit: 1 },
  );
  const link = (page?.items || [])[0] || null;

  return evaluateLocalConfiguration({
    merchant,
    link,
    readSecret: (name: string) => secrets.get(name) || "",
    platformClientId: secrets.get("LEX_SERVICE_CLIENT_ID") || "",
  });
}

export interface VerifiedAuthorityOptions {
  /** Staging base URL. When set, the probe runs there and never opens the gate. */
  stagingBaseUrl?: string;
}

// Full authority: local configuration + verified backend authorization + gate.
// Every network branch fails closed.
export async function loadVerifiedAuthority(
  sr: { entities: Record<string, any> },
  user: { id: string; email?: string },
  options: VerifiedAuthorityOptions = {},
): Promise<VerifiedAuthority> {
  const checked_at = new Date().toISOString();
  const local = await loadLocalAuthority(sr, user);

  if (!local.ok) {
    return {
      ready: false,
      release_gate: "closed",
      booking_release: {
        open: false,
        code: "release_not_authorized",
        message: "Booking stays closed until this merchant's authorization is verified.",
      },
      local,
      verification: {
        status: "not_attempted",
        code: "local_configuration_incomplete",
        message: "Backend authorization was not checked because the local merchant configuration is incomplete.",
        checked_at,
      },
      isolation: { sandbox_isolated: false, evidenced: false },
      code: local.code,
      message: local.message,
      action: local.action,
      merchant_id: local.merchant_id,
    };
  }

  const fingerprint = await credentialFingerprint(local.credentials);
  const identity = {
    merchant_id: local.merchant_id,
    domain_merchant_id: local.domain_merchant_id,
    client_id: local.client_id,
    signing_subject: local.signing_subject,
    credential_fingerprint: fingerprint,
  };

  const outcome = await verifyMerchantContext({
    credential: local.credentials,
    expected: {
      merchant_id: identity.domain_merchant_id,
      client_id: identity.client_id,
      subject: identity.signing_subject,
    },
    baseUrl: options.stagingBaseUrl,
  });

  const verification: VerificationReport = outcome.ok
    ? {
        status: "verified",
        code: "verified",
        message: `Backend confirms merchant ${outcome.context.merchant_id}, client ${outcome.context.client_id}, subject ${outcome.context.subject}.`,
        checked_at,
        http_status: outcome.status,
      }
    : {
        status: outcome.kind,
        code: outcome.code,
        message: outcome.message,
        checked_at,
        http_status: outcome.status,
      };

  const stamp = verificationStampState(
    local.link,
    {
      domain_merchant_id: identity.domain_merchant_id,
      client_id: identity.client_id,
      signing_subject: identity.signing_subject,
    },
    fingerprint,
  );

  // A staging probe proves nothing about production: it can report the
  // backend's answer but never opens the release gate.
  const ready = outcome.ok && stamp.verified && !options.stagingBaseUrl;

  // Authorization is not a booking release. Even with the stamp recorded, the
  // operator must switch booking on separately once the coordinated booking,
  // payment and cancellation checks have passed.
  const booking_release = evaluateBookingRelease({
    authorized: ready,
    flagEnabled: String(secrets.get(BOOKING_RELEASE_FLAG) || "").toLowerCase() === "true",
  });

  let code: string;
  let message: string;
  let action: string;

  if (!outcome.ok) {
    code = outcome.code;
    message =
      outcome.kind === "backend_unavailable"
        ? `Backend authorization could not be verified (${outcome.message}).`
        : `Backend authorization failed: ${outcome.message}`;
    action = outcome.kind === "backend_unavailable" ? DEPLOYMENT_ACTION : PROVISIONING_ACTION;
  } else if (!stamp.verified) {
    code = "verification_not_recorded";
    message = stamp.reason;
    action = VERIFICATION_ACTION;
  } else if (options.stagingBaseUrl) {
    code = "staging_probe_only";
    message = "Staging accepted this merchant's identity. Production booking stays closed until production verification passes.";
    action = VERIFICATION_ACTION;
  } else {
    code = "authorized";
    message = "Merchant scope is verified by the backend.";
    action = "";
  }

  return {
    ready,
    release_gate: ready ? "open" : "closed",
    booking_release,
    local,
    verification,
    isolation: {
      sandbox_isolated: outcome.ok ? outcome.context.sandbox_isolated === true : false,
      // Evidence requires a successful probe that positively reported isolation.
      evidenced: outcome.ok && outcome.context.sandbox_isolated === true,
    },
    code,
    message,
    action,
    merchant_id: local.merchant_id,
    identity,
  };
}

// Persist the authorization outcome on the shipment so the merchant sees the
// real reason in the app, not a bare 403.
export function provisioningSyncMessage(result: { message: string }): string {
  return `merchant_not_provisioned: ${result.message}`.slice(0, 280);
}