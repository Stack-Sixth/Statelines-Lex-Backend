import {canonicalMerchant, authorityBinding, backendTarget} from "./lexAuthorityBinding.ts";
// Shared merchant-authorization resolution for the Render LEX engine.
//
// Authorization unit is the PAIR (issuing client, subject): the dedicated client
// determines `iss`, and `sub` must be an explicitly approved subject for THAT
// client. A shared credential is never used for a merchant request — fail closed,
// including when no mapping row exists.
//
// Two separate questions are answered here:
//   1. request_authorized — may this caller reach the engine as a merchant at all?
//      mapping + status=provisioned + subject approved + dedicated credential.
//   2. booking_ready — may a booking be created? additionally requires the booking
//      flag, a recorded read-back validation bound to this exact client+subject,
//      and the global switch. All switches are closed.
//
// Local credential presence is configuration readiness only; authorization comes
// from a matching GET /api/v1/merchant-context read-back against the backend.
//
// Secret values are only ever read here to sign a token; they are never returned.
import { secrets } from "base44:runtime";
import { renderBaseUrl, signedRenderHeadersWith } from "./lexRenderJwt.ts";

export const MERCHANT_CONTEXT_PATH = "/api/v1/merchant-context";

export type MerchantBlocker = { code: string; detail: string };
export type MerchantCredential = { clientId: string; secret: string };

export type MerchantContext = {
  applicable: boolean;
  mapped: boolean;
  merchant_id: string | null;
  business_id: string | null;
  merchant_name: string | null;
  mapping_status: string | null;
  subject_approved: boolean;
  credential_source: "dedicated" | "none";
  credential_ref: string | null;
  credential_present: boolean;
  request_authorized: boolean;
  authorization_blockers: MerchantBlocker[];
  merchant_booking_flag: boolean;
  global_gate_open: boolean;
  sandbox: boolean;
  synthetic: boolean;
  activation_state: string;
  isolation_confirmed: boolean;
  validation_status: string | null;
  validated_subject: string | null;
  validated_credential_ref: string | null;
  validation_matches_caller: boolean;
  booking_ready: boolean;
  booking_blockers: MerchantBlocker[];
  blockers: MerchantBlocker[];
  contract_version: string | null;
  backend_commit: string | null;
  credential: MerchantCredential | null;
  backend_target?: string;
};

// Global switch. Unset/false keeps merchant booking disabled regardless of any
// per-merchant row, so no code path can enable booking by data alone.
export function merchantBookingGateOpen(): boolean {
  return String(secrets.get("LEX_MERCHANT_BOOKING_ENABLED") || "").trim().toLowerCase() === "true";
}

// Model A: one credential per merchant, resolved by name prefix. Presence only —
// the values are returned solely to the server-side signer.
export function resolveDedicatedCredential(credentialRef: string | null | undefined): MerchantCredential | null {
  const ref = String(credentialRef || "").trim();
  if (!ref) return null;
  const clientId = secrets.get(`${ref}_CLIENT_ID`);
  const secret = secrets.get(`${ref}_CLIENT_SECRET`);
  if (!clientId || !secret) return null;
  return { clientId, secret };
}

// Stable, non-reversible label for a client id, so a report can distinguish two
// dedicated clients without exposing the identifier itself.
export async function clientFingerprint(clientId: string): Promise<string> {
  if (!clientId) return "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(clientId));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
}

// Evaluates one mapping row. `subjectUserId` null means "no specific caller"
// (readiness report): approval is then reported, never granted.
export async function evaluateMerchantRow(row: any, subjectUserId: string | null): Promise<MerchantContext> {
  const gateOpen = merchantBookingGateOpen();
  const mapped = !!row;
  const approvedList: string[] = Array.isArray(row?.approved_subjects) ? row.approved_subjects : [];
  const subjectApproved = mapped && !!subjectUserId && approvedList.includes(subjectUserId);
  const status = mapped ? String(row.status || "pending") : null;
  const credentialRef = mapped ? String(row.credential_ref || "") || null : null;
  const credential = mapped ? resolveDedicatedCredential(credentialRef) : null;
  const bookingFlag = !!(mapped && row.booking_enabled);
  const sandbox = !!(mapped && /^SBX-BIZ-(ALPHA-001|BETA-002)$/.test(row.merchant_id || ""));
  const activationState = mapped ? String(row.activation_state || "none") : "none";
  const isolationConfirmed = !!(mapped && row.isolation_confirmed_at);
  const validationStatus = mapped ? String(row.validation_status || "unverified") : null;
  const validatedSubject = mapped ? String(row.validated_subject || "") || null : null;
  const validatedCredentialRef = mapped ? String(row.validated_credential_ref || "") || null : null;

  let bindingMatches = false;
  try {
    bindingMatches = validationStatus === "verified" && !!credential && !!subjectUserId &&
      row.validation_binding === await authorityBinding(row, subjectUserId, credential, renderBaseUrl());
  } catch { /* incomplete mapping/configuration fails closed */ }
  // 1. Request authorization — fatal. No mapping means no merchant authorization.
  const authorizationBlockers: MerchantBlocker[] = [];
  if (!mapped) {
    authorizationBlockers.push({
      code: "merchant_mapping_missing",
      detail:
        "No MerchantAuthorization row lists this caller in approved_subjects, so merchant identity cannot be resolved server-side and no shared credential may be used instead.",
    });
  } else {
    if (status !== "provisioned")
      authorizationBlockers.push({
        code: "merchant_not_provisioned",
        detail: `Mapping status is "${status}"; merchant requests require "provisioned".`,
      });
    if (!subjectUserId)
      authorizationBlockers.push({
        code: "merchant_subject_required",
        detail: "No subject was supplied for evaluation; approval cannot be established.",
      });
    else if (!subjectApproved)
      authorizationBlockers.push({
        code: "merchant_subject_not_approved",
        detail: "Caller is not listed in this merchant's approved_subjects, so the dedicated client must not be used for it.",
      });
    if (!credential)
      authorizationBlockers.push({
        code: "merchant_credential_missing",
        detail: credentialRef
          ? `Dedicated credential secrets ${credentialRef}_CLIENT_ID / ${credentialRef}_CLIENT_SECRET are not present.`
          : "credential_ref is not set; no dedicated merchant credential can be selected.",
      });
  }
  if (mapped && !canonicalMerchant(row)) authorizationBlockers.push({code:"canonical_merchant_missing",detail:"An explicit provisioned MER identity is required; SBX labels are local references."});
  if (sandbox && (row.sandbox !== true || row.synthetic !== true))
    authorizationBlockers.push({code:"synthetic_metadata_incomplete",detail:"Registered synthetic mapping must retain both controlled-test flags."});
  if (mapped && (row.sandbox || row.synthetic) && !sandbox)
    authorizationBlockers.push({code:"synthetic_business_not_registered",detail:"Synthetic flags cannot register another business."});
  const requestAuthorized = authorizationBlockers.length === 0;

  // 2. Booking readiness — separate from authorization; all switches closed.
  const bookingBlockers: MerchantBlocker[] = [];
  if (!requestAuthorized)
    bookingBlockers.push({
      code: "merchant_request_unauthorized",
      detail: "Booking cannot be considered until merchant request authorization succeeds.",
    });
  if (mapped && !bookingFlag)
    bookingBlockers.push({
      code: "merchant_booking_flag_off",
      detail: "MerchantAuthorization.booking_enabled is false.",
    });
  if (mapped) {
    if (validationStatus !== "verified")
      bookingBlockers.push({
        code: "merchant_validation_unverified",
        detail: `validation_status is "${validationStatus}"; no matching merchant-context read-back is recorded against the deployed backend.`,
      });
    else if (!bindingMatches)
      bookingBlockers.push({
        code: "merchant_validation_stale",
        detail:
          "The recorded validation was made for a different subject or credential_ref than the one signing now; it must be re-run after any approval or credential change.",
      });
  }
  if (!gateOpen)
    bookingBlockers.push({
      code: "merchant_booking_gate_closed",
      detail:
        'LEX_MERCHANT_BOOKING_ENABLED is not "true"; booking stays disabled until the candidate backend is deployed and provisioning is verified.',
    });

  return {
    applicable: subjectUserId !== null,
    mapped,
    merchant_id: canonicalMerchant(row),
    business_id: mapped ? String(row.merchant_id || "") || null : null,
    merchant_name: mapped ? String(row.merchant_name || "") || null : null,
    mapping_status: status,
    subject_approved: subjectApproved,
    credential_source: credential ? "dedicated" : "none",
    credential_ref: credentialRef,
    credential_present: !!credential,
    request_authorized: requestAuthorized,
    authorization_blockers: authorizationBlockers,
    merchant_booking_flag: bookingFlag,
    global_gate_open: gateOpen,
    sandbox,
    synthetic: !!(mapped && row.synthetic),
    activation_state: activationState,
    isolation_confirmed: isolationConfirmed,
    validation_status: validationStatus,
    validated_subject: validatedSubject,
    validated_credential_ref: validatedCredentialRef,
    validation_matches_caller: bindingMatches,
    booking_ready: requestAuthorized && bookingBlockers.length === 0,
    booking_blockers: bookingBlockers,
    blockers: [...authorizationBlockers, ...bookingBlockers],
    contract_version: mapped ? String(row.contract_version || "") || null : null,
    backend_commit: mapped ? String(row.backend_commit || "") || null : null,
    credential,
  };
}

// Mapping rows are admin-only at the row level, so reads go through the service
// role: a merchant-role user must never read another merchant's mapping.
export async function loadMerchantRowForSubject(base44: any, userId: string): Promise<any | null> {
  try {
    const res = await base44.asServiceRole.entities.MerchantAuthorization.filter({ approved_subjects: userId });
    const list: any[] = Array.isArray(res) ? res : res?.items || [];
    return list.length === 1 ? list[0] : null;
  } catch {
    return null;
  }
}

export async function loadMerchantRowByMerchantId(base44: any, merchantId: string): Promise<any | null> {
  try {
    const res = await base44.asServiceRole.entities.MerchantAuthorization.filter({ merchant_id: merchantId });
    const list: any[] = Array.isArray(res) ? res : res?.items || [];
    return list.length === 1 ? list[0] : null;
  } catch {
    return null;
  }
}

export async function loadMerchantContext(base44: any, userId: string): Promise<MerchantContext> {
  const row = await loadMerchantRowForSubject(base44, userId);
  const ctx = await evaluateMerchantRow(row, userId);
  if (ctx.request_authorized && ctx.credential) {
    const live = await validateMerchantAgainstBackend(row, userId, ctx.credential);
    if (live.matched) {
      ctx.backend_target = live.target;
      ctx.validation_matches_caller = ctx.validation_matches_caller && live.binding === row.validation_binding;
      ctx.booking_ready = ctx.booking_ready && ctx.validation_matches_caller;
    }
    if (!live.matched) {
      ctx.request_authorized = false; ctx.booking_ready = false; ctx.validation_matches_caller = false;
      ctx.authorization_blockers.push({code:"merchant_live_context_failed", detail:"Current backend authority/isolation read-back did not match."});
      ctx.blockers = [...ctx.authorization_blockers, ...ctx.booking_blockers];
    }
  }
  return ctx;
}

export type MerchantValidation = {
  status: "verified" | "failed";
  matched: boolean;
  http_status: number;
  expected: { merchant_id: string | null; credential_ref: string | null; subject: string | null; client_fingerprint: string };
  returned: { merchant_id: string | null; subject: string | null; client_fingerprint: string };
  mismatches: { field: string; code: string }[];
  error?: string;
  binding?: string;
  target?: string;
};

// Server-side read-back: signs GET /api/v1/merchant-context with the merchant's own
// dedicated credential and compares the three returned facts against the trusted
// mapping and the signing identity. Nothing is cached from configuration alone.
export async function validateMerchantAgainstBackend(
  row: any,
  subject: string,
  credential: MerchantCredential,
  baseOverride?: string,
): Promise<MerchantValidation> {
  const expectedClientFingerprint = await clientFingerprint(credential.clientId);
  let http_status = 0;
  let body: any = null;
  let error: string | undefined;
  let binding: string | undefined;
  let validatedTarget: string | undefined;

  try {
    const configured = backendTarget(renderBaseUrl());
    const base = baseOverride ? backendTarget(baseOverride) : configured;
    if (base !== configured) throw new Error("Backend override differs from trusted target");
    binding = await authorityBinding(row, subject, credential, base);
    validatedTarget = base;
    if (!base) throw new Error("LEX_API_URL is not configured");
    const target = new URL(MERCHANT_CONTEXT_PATH, base);
    if (target.protocol !== "https:") throw new Error("LEX_API_URL must use HTTPS");
    const res = await fetch(target, {
      method: "GET",
      headers: await signedRenderHeadersWith(credential, subject, "merchant"),
      signal: AbortSignal.timeout(15000),
      redirect: "manual",
    });
    http_status = res.status;
    const text = await res.text();
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      error = "Merchant-context response was not JSON";
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const returnedClientId = typeof body?.client_id === "string" ? body.client_id : "";
  const returned = {
    merchant_id: typeof body?.merchant_id === "string" ? body.merchant_id : null,
    subject: typeof body?.subject === "string" ? body.subject : null,
    client_fingerprint: returnedClientId ? await clientFingerprint(returnedClientId) : "",
  };

  const mismatches: { field: string; code: string }[] = [];
  if (http_status !== 200) {
    mismatches.push({ field: "response", code: "merchant_context_unreachable" });
  } else {
    const expectedMerchantId = canonicalMerchant(row);
    if (!returned.merchant_id) mismatches.push({ field: "merchant_id", code: "merchant_context_contract_mismatch" });
    else if (returned.merchant_id !== expectedMerchantId) mismatches.push({ field: "merchant_id", code: "merchant_id_mismatch" });

    if (!returned.subject) mismatches.push({ field: "subject", code: "merchant_context_contract_mismatch" });
    else if (returned.subject !== subject) mismatches.push({ field: "subject", code: "subject_mismatch" });

    if (!returnedClientId) mismatches.push({ field: "client_id", code: "merchant_context_contract_mismatch" });
    else if (returnedClientId !== credential.clientId)
      mismatches.push({ field: "client_id", code: "client_id_mismatch" });
  }

  if (!canonicalMerchant(row)) mismatches.push({field:"merchant_id",code:"canonical_merchant_missing"});
  if (!Array.isArray(row?.approved_subjects) || !row.approved_subjects.includes(subject)) mismatches.push({field:"subject",code:"subject_not_approved"});
  if (/^SBX-BIZ-(ALPHA-001|BETA-002)$/.test(row?.merchant_id || "") && body?.sandbox_isolated !== true)
    mismatches.push({field:"sandbox_isolated",code:"backend_isolation_unverified"});
  return {
    ...(binding && !mismatches.length ? {binding,target:validatedTarget} : {}),
    status: mismatches.length === 0 ? "verified" : "failed",
    matched: mismatches.length === 0,
    http_status,
    expected: {
      merchant_id: canonicalMerchant(row),
      credential_ref: String(row?.credential_ref || "") || null,
      subject,
      client_fingerprint: expectedClientFingerprint,
    },
    returned,
    mismatches,
    ...(error ? { error } : {}),
  };
}

// Records the outcome. Only a matched read-back yields "verified"; anything else
// downgrades to "failed" so a stale or drifted mapping cannot authorize booking.
export async function recordMerchantValidation(
  base44: any,
  rowId: string,
  params: { status: "verified" | "failed"; subject: string | null; credential_ref: string | null; validation?: MerchantValidation },
): Promise<void> {
  await base44.asServiceRole.entities.MerchantAuthorization.update(rowId, {
    validation_status: params.status === "verified" && params.validation?.matched && params.validation.binding ? "verified" : "failed",
    validation_binding: params.status === "verified" && params.validation?.matched ? params.validation.binding || null : null,
    validated_subject: params.subject,
    validated_credential_ref: params.credential_ref,
    last_validated_at: new Date().toISOString(),
  });
}

// Strips secret material — safe for API responses and reports.
export function publicMerchantContext(ctx: MerchantContext) {
  return {
    merchant_id: ctx.merchant_id,
    business_id: ctx.business_id,
    merchant_name: ctx.merchant_name,
    mapping_status: ctx.mapping_status,
    subject_approved: ctx.subject_approved,
    credential_source: ctx.credential_source,
    credential_ref: ctx.credential_ref,
    credential_present: ctx.credential_present,
    request_authorized: ctx.request_authorized,
    authorization_blockers: ctx.authorization_blockers,
    merchant_booking_flag: ctx.merchant_booking_flag,
    global_gate_open: ctx.global_gate_open,
    sandbox: ctx.sandbox,
    synthetic: ctx.synthetic,
    activation_state: ctx.activation_state,
    isolation_confirmed: ctx.isolation_confirmed,
    validation_status: ctx.validation_status,
    validated_subject: ctx.validated_subject,
    validated_credential_ref: ctx.validated_credential_ref,
    validation_matches_caller: ctx.validation_matches_caller,
    booking_ready: ctx.booking_ready,
    booking_blockers: ctx.booking_blockers,
    blockers: ctx.blockers,
    contract_version: ctx.contract_version,
    backend_commit: ctx.backend_commit,
  };
}

