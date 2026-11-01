// Controlled live-test isolation for the merchant booking exception.
//
// Chosen design: controlled testing against the LIVE backend using dedicated
// synthetic-merchant credentials. There is no separate sandbox engine.
//
// Configuration path — exactly one, and no shared-credential fallback:
//   credential_ref names a business's own dedicated pair, resolved in
//   lexMerchantContext.resolveDedicatedCredential() as <ref>_CLIENT_ID / <ref>_CLIENT_SECRET.
//     ALPHA -> LEX_SANDBOX_ALPHA -> LEX_SANDBOX_ALPHA_CLIENT_ID / _CLIENT_SECRET
//     BETA  -> LEX_SANDBOX_BETA  -> LEX_SANDBOX_BETA_CLIENT_ID  / _CLIENT_SECRET
//   LEX_SANDBOX_BOOKING_ENABLED is this exception's own switch.
//   LEX_API_URL is the live backend base for every caller, these two included.
// Those five names are live and read. LEX_API_URL_SANDBOX, LEX_PAYMENT_MODE and
// LEX_PAYMENT_SANDBOX_KEY are retired and read by nothing. The production URL and the
// shared service credentials are never substituted for a missing dedicated pair: a
// missing pair fails closed.
//
// Exactly two synthetic businesses exist. They are registered here (code, not data)
// so a mapping row can never invent a third one, and every gate below is a hard
// requirement rather than a stored flag any single edit could satisfy.
//
// Signing conventions — different on purpose:
//   LEX-signed requests .......... sub = the authenticated LEX user id
//   Merchant-signed requests ..... sub = that business's dedicated client id
// A LEX read-back therefore only ever asserts the LEX convention; the Merchant
// convention is recorded here so the backend handoff is unambiguous.
//
// Isolation on the live backend rests on three controls, all required per call:
//   1. test-account-only gate ...... only the two approved non-admin test identities
//   2. dedicated credentials ....... that business's own client id/secret, never shared
//   3. verified event isolation .... backend-persisted classification and guarded
//      operational boundaries; all Render workers must enforce quarantine.
import { secrets } from "base44:runtime";
import type { MerchantBlocker, MerchantContext } from "./lexMerchantContext.ts";

export const SANDBOX_BUSINESSES = [
  {
    business_id: "SBX-BIZ-ALPHA-001",
    business_name: "Sandbox Alpha Logistics (synthetic)",
    credential_ref: "LEX_SANDBOX_ALPHA",
    client_id: "sbx-alpha-lex-01",
    lex_subject: "6ac144d7ba5eefb2dc02e410",
    merchant_signing: "sub = dedicated client id",
    lex_signing: "sub = authenticated LEX user id",
  },
  {
    business_id: "SBX-BIZ-BETA-002",
    business_name: "Sandbox Beta Freight (synthetic)",
    credential_ref: "LEX_SANDBOX_BETA",
    client_id: "sbx-beta-lex-02",
    lex_subject: "6ad55271cafef064e29ff2dd",
    merchant_signing: "sub = dedicated client id",
    lex_signing: "sub = authenticated LEX user id",
  },
] as const;

export type SandboxBusiness = (typeof SANDBOX_BUSINESSES)[number];

// The complete set of secrets the superseded sandbox-engine design introduced, and
// the flow that introduced them. Retired entries remain unset; live entries remain unset until provisioning; kept listed so the
// inventory stays auditable and nobody re-adds them believing a path needs them.
export const SANDBOX_INTRODUCED_SECRETS = [
  {
    name: "LEX_API_URL_SANDBOX",
    purpose: "separate sandbox engine base URL",
    status: "retired",
    read_by: null,
  },
  {
    name: "LEX_SANDBOX_BOOKING_ENABLED",
    purpose: "this exception's own activation switch",
    status: "live",
    read_by: "lexSandbox.sandboxSwitchOpen",
  },
  {
    name: "LEX_PAYMENT_MODE",
    purpose: "sandbox payment mode selector",
    status: "retired",
    read_by: null,
  },
  {
    name: "LEX_PAYMENT_SANDBOX_KEY",
    purpose: "sandbox payment key",
    status: "retired",
    read_by: null,
  },
  {
    name: "LEX_SANDBOX_ALPHA_CLIENT_ID",
    purpose: "dedicated client id — ALPHA (read as LEX_SANDBOX_ALPHA + _CLIENT_ID)",
    status: "live",
    read_by: "lexMerchantContext.resolveDedicatedCredential",
  },
  {
    name: "LEX_SANDBOX_ALPHA_CLIENT_SECRET",
    purpose: "dedicated client secret — ALPHA (read as LEX_SANDBOX_ALPHA + _CLIENT_SECRET)",
    status: "live",
    read_by: "lexMerchantContext.resolveDedicatedCredential",
  },
  {
    name: "LEX_SANDBOX_BETA_CLIENT_ID",
    purpose: "dedicated client id — BETA (read as LEX_SANDBOX_BETA + _CLIENT_ID)",
    status: "live",
    read_by: "lexMerchantContext.resolveDedicatedCredential",
  },
  {
    name: "LEX_SANDBOX_BETA_CLIENT_SECRET",
    purpose: "dedicated client secret — BETA (read as LEX_SANDBOX_BETA + _CLIENT_SECRET)",
    status: "live",
    read_by: "lexMerchantContext.resolveDedicatedCredential",
  },
] as const;

export function sandboxBusinessForMerchantId(merchantId?: string | null): SandboxBusiness | null {
  const id = String(merchantId || "");
  return SANDBOX_BUSINESSES.find((b) => b.business_id === id) || null;
}

export function sandboxBusinessForCredentialRef(ref?: string | null): SandboxBusiness | null {
  const value = String(ref || "");
  return SANDBOX_BUSINESSES.find((b) => b.credential_ref === value) || null;
}

// Activation switch. Unset — the exception is disabled and cannot open. It stays a
// separate switch from LEX_MERCHANT_BOOKING_ENABLED on purpose: it can only ever open
// these two synthetic businesses, while general merchant booking stays governed by the
// global gate, which remains closed.
export function sandboxSwitchOpen(): boolean {
  return String(secrets.get("LEX_SANDBOX_BOOKING_ENABLED") || "").trim().toLowerCase() === "true";
}

// The live backend the controlled test runs against. Read from LEX_API_URL, the same
// engine every operator path uses. A sandbox URL is never consulted, and nothing
// sandbox-named is used as a fallback or substitute.
export function liveEngine(): { base_url: string; usable: boolean; reason: string | null } {
  const base = String(secrets.get("LEX_API_URL") || "").trim();
  if (!base) return { base_url: "", usable: false, reason: "LEX_API_URL is not configured" };
  if (!base.startsWith("https://")) return { base_url: "", usable: false, reason: "LEX_API_URL must use HTTPS" };
  return { base_url: base, usable: true, reason: null };
}

const MARKER = /^(lex-)?sbx[-_]/i;
const FLAG_KEYS = new Set(["sandbox", "synthetic", "is_sandbox", "sandbox_record"]);

// Returns the path that marks a payload as sandbox, or null when it is clean.
// Keys named for the sandbox, or identifier-shaped values prefixed SBX-/LEX-SBX-.
// This is a diagnostic payload hint only. It cannot authorize or classify operations.
// Operational boundaries must use lexTrustedIsolation backend reads.
export function sandboxViolation(payload: unknown, path = "$", depth = 0): string | null {
  if (payload === null || payload === undefined || depth > 4) return null;
  if (typeof payload === "string") return MARKER.test(payload.trim()) ? path : null;
  if (typeof payload !== "object") return null;
  if (Array.isArray(payload)) {
    for (let i = 0; i < payload.length; i++) {
      const hit = sandboxViolation(payload[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (FLAG_KEYS.has(key) && (value === true || value === "true")) return `${path}.${key}`;
    const hit = sandboxViolation(value, `${path}.${key}`, depth + 1);
    if (hit) return hit;
  }
  return null;
}

export type SandboxGrant =
  | { allowed: true; business_id: string; credential_ref: string; payment_mode: "no_charge" }
  | { allowed: false; blockers: MerchantBlocker[] };

// The complete authority to create one controlled live-test booking. Every condition is
// checked on each call; nothing is cached, and any single missing condition refuses.
export function sandboxBookingGrant(ctx: MerchantContext | null, userId: string): SandboxGrant {
  const blockers: MerchantBlocker[] = [];
  const push = (code: string, detail: string) => blockers.push({ code, detail });

  if (!ctx || !ctx.sandbox) push("sandbox_tenant_required", "Caller is not a registered synthetic business.");
  const business = ctx ? sandboxBusinessForMerchantId(ctx.business_id) : null;
  if (ctx?.sandbox && !business) push("sandbox_business_not_registered", "Merchant id is not one of the two registered synthetic businesses.");
  if (business && ctx?.credential_ref !== business.credential_ref)
    push("sandbox_credential_ref_mismatch", `This business must use credential_ref ${business.credential_ref}.`);
  if (business && (ctx?.credential?.clientId !== business.client_id || userId !== business.lex_subject))
    push("sandbox_identity_mismatch", "Only this business's explicit client and LEX subject are permitted.");
  if (!ctx?.request_authorized) push("sandbox_request_unauthorized", "Merchant request authorization must succeed before the exception can apply.");

  // Control 1: test-account-only gate. The caller must be one of the approved test
  // identities for this business — an admin or any other user cannot book through it.
  if (!ctx?.subject_approved) push("sandbox_caller_not_test_account", "Caller is not an approved test account for this synthetic business.");
  if (!userId) push("sandbox_caller_not_test_account", "No authenticated test account was resolved for this request.");

  // Control 2: dedicated synthetic-merchant credentials, never the shared client.
  if (ctx?.credential_source !== "dedicated")
    push("sandbox_credential_not_dedicated", "A dedicated synthetic-merchant credential must sign this request.");

  if (!ctx?.isolation_confirmed) push("sandbox_isolation_unconfirmed", "Event isolation has not been verified and recorded for this business.");
  if (ctx?.activation_state !== "active") push("sandbox_exception_not_active", `activation_state is "${ctx?.activation_state ?? "none"}"; the exception is prepared, not active.`);
  if (!ctx?.merchant_booking_flag) push("sandbox_booking_flag_off", "booking_enabled is false on this mapping row.");
  if (!sandboxSwitchOpen()) push("sandbox_switch_closed", 'LEX_SANDBOX_BOOKING_ENABLED is not "true"; the controlled test flow is disabled.');

  // Control 3: the live backend must be resolvable. Nothing sandbox-named is substituted.
  const engine = liveEngine();
  if (!engine.usable) push("live_engine_not_configured", engine.reason || "The live backend is not configured.");

  if (!ctx?.validation_matches_caller)
    push("sandbox_validation_unverified", "No verified merchant-context read-back is bound to this client and subject.");

  if (blockers.length || !business) return { allowed: false, blockers };
  // A controlled booking performs no charge and reads no payment credential, so no
  // sandbox payment key is required and no live key is reachable from this path.
  return { allowed: true, business_id: business.business_id, credential_ref: business.credential_ref, payment_mode: "no_charge" };
}

// Redacted mapping for reports: business ids, credential-key names and user ids in
// clear; never a client id or secret value.
export function redactedBusinessLine(row: any) {
  const approved: string[] = Array.isArray(row?.approved_subjects) ? row.approved_subjects : [];
  const business = sandboxBusinessForMerchantId(row?.merchant_id);
  return {
    business_id: row?.merchant_id ?? null,
    business_name: row?.merchant_name ?? null,
    canonical_merchant_id: row?.canonical_merchant_id ?? null,
    registered: !!business,
    credential_ref: row?.credential_ref ?? null,
    client_id: "redacted (fingerprint only)",
    lex_authenticated_user_ids: approved,
    signing: business
      ? { lex_sub: "authenticated_user_id", merchant_sub: "client_id" }
      : null,
    activation_state: row?.activation_state ?? "none",
    isolation_confirmed_at: row?.isolation_confirmed_at ?? null,
    validation_status: row?.validation_status ?? null,
  };
}

