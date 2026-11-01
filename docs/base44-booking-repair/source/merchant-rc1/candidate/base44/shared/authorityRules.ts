// Pure authority rules for the Merchant → Domain Platform integration.
//
// Nothing here touches the network, the database, or platform runtime secrets:
// every rule takes its inputs as arguments and returns a verdict. That keeps the
// authorization model, the release gate, the verification stamp and the
// cancellation preflight unit-testable under plain Node (tests/authority.test.ts)
// and reusable from any handler.

export interface DomainCredentials {
  client_id: string;
  client_secret: string;
}

export interface DomainLink {
  id?: string;
  merchant_id?: string;
  user_id?: string;
  /** Canonical MER_… identity returned by provisioning. Never a client id. */
  domain_merchant_id?: string;
  /** Dedicated client bound to this merchant (one immutable binding). */
  domain_client_id?: string;
  /** Subject approved for that client during provisioning (expected = client id). */
  signing_subject?: string;
  credential_key?: string;
  status?: string;
  note?: string;
  /** Coordinated verification stamp, written by the server-side recorder only. */
  scope_verified_at?: string;
  verified_merchant_id?: string;
  verified_client_id?: string;
  verified_subject?: string;
  /** Fingerprint of the credential pair that was verified. Rotating it invalidates. */
  verified_credential_fingerprint?: string;
  verification_source?: string;
  last_error?: string;
}

export type LocalFailureCode =
  | "merchant_missing"
  | "no_mapping"
  | "not_authorized"
  | "credentials_missing"
  | "merchant_id_invalid"
  | "client_identity_mismatch"
  | "subject_not_approved";

export type LocalFailure = {
  ok: false;
  code: LocalFailureCode;
  message: string;
  action: string;
  merchant_id?: string;
};

/** Compatibility alias: a failed authority result is always a local failure. */
export type AuthorityFailure = LocalFailure;

export interface LocalConfig {
  ok: true;
  merchant_id: string;
  /** MER_… canonical merchant identity (from provisioning). */
  domain_merchant_id: string;
  /** Dedicated client identity, distinct from the canonical merchant identity. */
  client_id: string;
  /** JWT iss = sub used for booking, cancellation and reconciliation. */
  signing_subject: string;
  credentials: DomainCredentials;
  link_id?: string;
  link: DomainLink;
}

export type LocalResult = LocalConfig | LocalFailure;

export interface MerchantContext {
  merchant_id: string;
  client_id: string;
  subject: string;
  /**
   * Backend-evidenced sandbox isolation for this merchant. Only the backend can
   * assert it; a request body marker is never accepted as this value.
   */
  sandbox_isolated: boolean;
}

export type MerchantContextOutcome =
  | { ok: true; status: number; context: MerchantContext }
  | {
      ok: false;
      status: number;
      kind: "backend_unavailable" | "unauthorized" | "mismatch" | "malformed";
      code: string;
      message: string;
    };

export const PROVISIONING_ACTION =
  "Ask Statelines to provision this merchant on the domain network, store the MER_… identity it returns, and issue this merchant's dedicated client credentials.";

export const VERIFICATION_ACTION =
  "Booking stays disabled until Statelines records the coordinated scope verification for this merchant.";

export const DEPLOYMENT_ACTION =
  "Booking stays disabled until the domain backend is deployed and this merchant's merchant-context check passes.";

/** Canonical merchant identity shape returned by provisioning (MER_…). */
const MERCHANT_ID_PATTERN = /^MER_[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Strict canonical identity form. The controlled test mappings must carry this
 * exact shape; the shape is required, never inferred from a client id.
 */
export const STRICT_MERCHANT_ID_PATTERN = /^MER_[0-9a-f]{32}$/;

/** Canonical shipment identity shape returned by provisioning/reads (SHP_…). */
const SHIPMENT_ID_PATTERN = /^SHP_[A-Za-z0-9][A-Za-z0-9_-]*$/;

// Deterministic secret names for a merchant's own domain credentials.
export function credentialNames(credentialKey: string): { id: string; secret: string } {
  const slug = String(credentialKey || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return {
    id: `LEX_DOMAIN_${slug}_CLIENT_ID`,
    secret: `LEX_DOMAIN_${slug}_CLIENT_SECRET`,
  };
}

// A credential pair is what actually speaks for the merchant. Its fingerprint
// ties a verification stamp to the exact pair that was tested, so rotating the
// secret (or re-pointing the client) invalidates the stamp without storing any
// secret material.
export async function credentialFingerprint(credential: DomainCredentials): Promise<string> {
  const material = `${credential.client_id}\u0000${credential.client_secret}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

// Layer 1 — local configuration. Pure (no I/O) so the rules stay testable.
export function evaluateLocalConfiguration(input: {
  merchant: { id: string; created_by_id?: string } | null;
  link: DomainLink | null | undefined;
  readSecret: (name: string) => string;
  platformClientId?: string;
}): LocalResult {
  const { merchant, link, readSecret } = input;

  if (!merchant?.id) {
    return {
      ok: false,
      code: "merchant_missing",
      message: "No merchant account is associated with this login.",
      action: "Complete merchant onboarding for this account, then retry.",
    };
  }

  const merchantId = merchant.id;

  // A mapping filled in from a client-supplied id would be a tenant-isolation
  // break: the link must belong to THIS merchant record.
  if (!link || (link.merchant_id && link.merchant_id !== merchantId)) {
    return {
      ok: false,
      code: "no_mapping",
      merchant_id: merchantId,
      message: "This merchant is not mapped to a domain merchant yet.",
      action: PROVISIONING_ACTION,
    };
  }

  if (link.user_id && merchant.created_by_id && link.user_id !== merchant.created_by_id) {
    return {
      ok: false,
      code: "not_authorized",
      merchant_id: merchantId,
      message: "The domain mapping for this merchant belongs to a different account.",
      action: "Ask Statelines to correct the merchant mapping for this account.",
    };
  }

  if (String(link.status || "") !== "authorized" || !link.domain_merchant_id) {
    return {
      ok: false,
      code: "not_authorized",
      merchant_id: merchantId,
      message: `Domain authorization is ${link.status || "missing"} for this merchant.`,
      action: PROVISIONING_ACTION,
    };
  }

  // The mapping must carry the canonical MER_… identity from provisioning. A
  // client id in this field would put the tenant boundary on a credential,
  // which the backend contract forbids.
  if (!MERCHANT_ID_PATTERN.test(link.domain_merchant_id)) {
    return {
      ok: false,
      code: "merchant_id_invalid",
      merchant_id: merchantId,
      message: "The mapping does not carry the canonical MER_… merchant identity.",
      action: PROVISIONING_ACTION,
    };
  }

  // Never let the platform's own service-client scope stand in for a merchant:
  // that would put every merchant's shipments under one tenant.
  if (input.platformClientId && link.domain_merchant_id === input.platformClientId) {
    return {
      ok: false,
      code: "not_authorized",
      merchant_id: merchantId,
      message: "The platform service-client scope cannot be used as a merchant scope.",
      action: PROVISIONING_ACTION,
    };
  }

  if (!link.credential_key) {
    return {
      ok: false,
      code: "credentials_missing",
      merchant_id: merchantId,
      message: "This merchant's dedicated domain credentials are not configured.",
      action: PROVISIONING_ACTION,
    };
  }

  const names = credentialNames(link.credential_key);
  const client_id = readSecret(names.id);
  const client_secret = readSecret(names.secret);
  if (!client_id || !client_secret) {
    return {
      ok: false,
      code: "credentials_missing",
      merchant_id: merchantId,
      message: "This merchant's dedicated domain credentials are not configured.",
      action: PROVISIONING_ACTION,
    };
  }

  // Merchant identity and client identity must stay separate: deriving the
  // MER_… from the client id would collapse the two.
  if (link.domain_merchant_id === client_id) {
    return {
      ok: false,
      code: "merchant_id_invalid",
      merchant_id: merchantId,
      message: "The merchant identity is derived from a client id instead of the provisioned MER_… identity.",
      action: PROVISIONING_ACTION,
    };
  }

  // The mapping names the dedicated client; a different client in the secrets
  // means the mapping and the credential disagree.
  if (link.domain_client_id && link.domain_client_id !== client_id) {
    return {
      ok: false,
      code: "client_identity_mismatch",
      merchant_id: merchantId,
      message: "The stored credential belongs to a different client than this merchant's mapping.",
      action: PROVISIONING_ACTION,
    };
  }

  // Only the client's own id is an approved subject; a mapping that names a
  // different subject can never be signed with this credential.
  const subject = String(client_id);
  if (link.signing_subject && link.signing_subject !== subject) {
    return {
      ok: false,
      code: "subject_not_approved",
      merchant_id: merchantId,
      message: "The mapped signing subject is not the subject approved for this client.",
      action: PROVISIONING_ACTION,
    };
  }

  return {
    ok: true,
    merchant_id: merchantId,
    domain_merchant_id: link.domain_merchant_id,
    client_id,
    signing_subject: subject,
    credentials: { client_id, client_secret },
    link_id: link.id,
    link,
  };
}

// The recorded coordinated verification must match the identity AND the
// credential pair in use now. A stamp written for another merchant/client/
// subject, or for a credential pair that has since been rotated, no longer
// counts — so neither re-pointing a mapping nor swapping a secret can reopen
// booking on its own.
export function verificationStampState(
  link: DomainLink,
  identity: { domain_merchant_id: string; client_id: string; signing_subject: string },
  credential_fingerprint?: string,
): { verified: boolean; reason: string } {
  if (!link?.scope_verified_at) {
    return {
      verified: false,
      reason: "No coordinated scope verification has been recorded for this merchant.",
    };
  }
  const mismatched: string[] = [];
  if (link.verified_merchant_id !== identity.domain_merchant_id) mismatched.push("merchant");
  if (link.verified_client_id !== identity.client_id) mismatched.push("client");
  if (link.verified_subject !== identity.signing_subject) mismatched.push("subject");
  if (mismatched.length > 0) {
    return {
      verified: false,
      reason: `The recorded verification does not match this merchant's current ${mismatched.join(", ")} identity.`,
    };
  }
  if (credential_fingerprint && link.verified_credential_fingerprint !== credential_fingerprint) {
    return {
      verified: false,
      reason: "The credential pair changed since this merchant's scope verification was recorded.",
    };
  }
  return { verified: true, reason: "Coordinated scope verification matches this merchant's identity." };
}

// Pure evaluation of a GET /api/v1/merchant-context response. Kept free of
// fetch so every branch (success, mismatch, malformed, 401/403, unavailable)
// is unit-testable.
export function evaluateMerchantContext(input: {
  ok: boolean;
  status: number;
  body?: unknown;
  code?: string;
  message?: string;
  expected: { merchant_id: string; client_id: string; subject: string };
}): MerchantContextOutcome {
  if (!input.ok) {
    const kind =
      input.status === 401 || input.status === 403
        ? "unauthorized"
        : input.status === 404 || input.status === 0 || input.status >= 500
          ? "backend_unavailable"
          : "malformed";
    return {
      ok: false,
      status: input.status,
      kind,
      code: input.code || "render_error",
      message: input.message || `Render responded ${input.status}`,
    };
  }

  const body = (input.body && typeof input.body === "object" ? input.body : {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const isolationBlock =
    body.isolation && typeof body.isolation === "object" ? (body.isolation as Record<string, unknown>) : {};
  const context: MerchantContext = {
    merchant_id: text(body.merchant_id),
    client_id: text(body.client_id),
    subject: text(body.subject) || text(body.sub),
    sandbox_isolated: body.sandbox_isolated === true || isolationBlock.sandbox_isolated === true,
  };

  if (!context.merchant_id || !context.client_id || !context.subject) {
    return {
      ok: false,
      status: input.status,
      kind: "malformed",
      code: "malformed_context",
      message: "merchant-context response is missing merchant_id, client_id or subject",
    };
  }

  const mismatches: string[] = [];
  if (context.merchant_id !== input.expected.merchant_id)
    mismatches.push(`merchant_id ${context.merchant_id} != ${input.expected.merchant_id}`);
  if (context.client_id !== input.expected.client_id)
    mismatches.push(`client_id ${context.client_id} != ${input.expected.client_id}`);
  if (context.subject !== input.expected.subject)
    mismatches.push(`subject ${context.subject} != ${input.expected.subject}`);

  if (mismatches.length > 0) {
    return {
      ok: false,
      status: input.status,
      kind: "mismatch",
      code: "context_mismatch",
      message: `merchant-context mismatch: ${mismatches.join("; ")}`,
    };
  }

  return { ok: true, status: input.status, context };
}

// Identity recorded on a booking command must not change under a retry.
// Returns the names of the fields that drifted (empty = no drift).
export function identityDriftFields(
  saved: {
    domain_merchant_scope?: string;
    domain_client_id?: string;
    domain_signing_subject?: string;
  },
  current: { domain_merchant_id: string; client_id: string; signing_subject: string },
): string[] {
  return [
    ["domain_merchant_scope", saved.domain_merchant_scope, current.domain_merchant_id],
    ["domain_client_id", saved.domain_client_id, current.client_id],
    ["domain_signing_subject", saved.domain_signing_subject, current.signing_subject],
  ]
    .filter(([, stored, now]) => Boolean(stored) && stored !== now)
    .map(([field]) => String(field));
}

// ---------------------------------------------------------------------------
// Submission evidence
// ---------------------------------------------------------------------------
//
// A missing canonical shipment id is NOT evidence that nothing reached the
// domain: a POST can be accepted remotely while its response is lost, leaving
// no canonical ids locally. Booking persists command_id + correlation_id
// BEFORE the POST precisely so a submission leaves a trace, so the presence of
// any such trace means "possibly created remotely" and must be reconciled.
// Only a row with none of these traces is provably never submitted.
export interface SubmissionEvidenceFields {
  command_id?: string;
  correlation_id?: string;
  idempotency_key?: string;
  canonical_shipment_id?: string;
  render_id?: string;
  external_shipment_id?: string;
  tracking_id?: string;
  tracking_number?: string;
  synced_at?: string;
  sync_status?: string;
  domain_status?: string;
  version?: number;
  test_harness?: boolean;
}

export type SubmissionVerdict = {
  verdict: "submitted" | "unknown" | "never";
  markers: string[];
};

const SUBMISSION_TRACE_FIELDS = [
  "command_id",
  "correlation_id",
  "idempotency_key",
  "canonical_shipment_id",
  "render_id",
  "external_shipment_id",
  "tracking_id",
  "tracking_number",
  "synced_at",
] as const;

export function classifySubmission(ship: SubmissionEvidenceFields | null | undefined): SubmissionVerdict {
  const markers: string[] = [];
  for (const field of SUBMISSION_TRACE_FIELDS) {
    const value = ship?.[field];
    if (typeof value === "string" ? value.trim().length > 0 : Boolean(value)) markers.push(field);
  }
  const domainStatus = String(ship?.domain_status || "").trim();
  if (domainStatus && domainStatus !== "pending") markers.push("domain_status");
  if (Number(ship?.version) >= 2) markers.push("version");
  if (ship?.test_harness) markers.push("test_harness");

  if (markers.length > 0) return { verdict: "submitted", markers };

  const syncStatus = String(ship?.sync_status || "").trim();
  if (syncStatus && syncStatus !== "pending") return { verdict: "unknown", markers: [`sync_status:${syncStatus}`] };

  return { verdict: "never", markers: [] };
}

// ---------------------------------------------------------------------------
// Cancellation preflight
// ---------------------------------------------------------------------------
//
// `render_id` is Render's internal ROW id (a UUID); `canonical_shipment_id` is
// the SHP_… shipment identity every domain command is addressed by. A row id is
// never accepted as a path identifier.
export type CancelPreflight =
  | { mode: "local_only"; reason: "never_submitted"; evidence: string[] }
  | { mode: "domain"; canonical_shipment_id: string; expected_version: number }
  | {
      mode: "ambiguous";
      reason: "submission_unconfirmed" | "version_unconfirmed";
      markers: string[];
      message: string;
    }
  | { mode: "blocked"; code: string; message: string };

const RECONCILE_REQUIRED =
  "This shipment may already exist on the domain network, so it cannot be cancelled locally. Statelines must reconcile it first.";

export function evaluateCancellationPreflight(ship: SubmissionEvidenceFields): CancelPreflight {
  const canonical = String(ship?.canonical_shipment_id || "").trim();
  const renderId = String(ship?.render_id || "").trim();

  if (canonical && canonical === renderId) {
    return {
      mode: "blocked",
      code: "row_id_not_shipment_id",
      message: "The canonical identity is a Render row id, not a shipment identity.",
    };
  }

  if (canonical && !SHIPMENT_ID_PATTERN.test(canonical)) {
    return {
      mode: "blocked",
      code: "canonical_id_invalid",
      message: "The stored canonical shipment identity is not an SHP_… identifier.",
    };
  }

  const version = Number(ship?.version);
  const versionOk = Number.isInteger(version) && version >= 1;

  if (!canonical) {
    const evidence = classifySubmission(ship);
    // Positive evidence only: no trace of a create command ever being issued.
    if (evidence.verdict === "never") {
      return { mode: "local_only", reason: "never_submitted", evidence: evidence.markers };
    }
    return {
      mode: "ambiguous",
      reason: "submission_unconfirmed",
      markers: evidence.markers,
      message: RECONCILE_REQUIRED,
    };
  }

  if (!versionOk) {
    return {
      mode: "ambiguous",
      reason: "version_unconfirmed",
      markers: ["version_missing"],
      message:
        "The canonical shipment version is not recorded, so expected_version cannot be checked yet. Statelines must read it first.",
    };
  }

  return { mode: "domain", canonical_shipment_id: canonical, expected_version: version };
}

// Outcome of the canonical read used to settle an ambiguous submission,
// matching the shape reconcileCanonicalShipment returns.
export interface ReconcileOutcomeLike {
  ok: boolean;
  reason?: string;
  detail?: string;
  canonical?: { canonical_shipment_id?: string; version?: number; tracking_id?: string };
}

export type CancelPlan =
  | {
      mode: "local_only";
      /** Only reachable from positive evidence that no create command was ever issued. */
      reason: "never_submitted";
      evidence: string[];
    }
  | {
      mode: "domain";
      canonical_shipment_id: string;
      expected_version: number;
      adopted_from_reconcile: boolean;
    }
  | { mode: "blocked"; code: string; message: string; detail?: string };

// Settles the ambiguous case against the canonical read. A read that DOES find
// the shipment lets the cancellation proceed on the canonical identity. A read
// that finds nothing, or cannot be taken, leaves the shipment blocked for
// reconciliation: absence at read time cannot rule out a create that is still
// processing or commits afterwards. Never cancels locally on a guess.
export function resolveCancellationPlan(
  ship: SubmissionEvidenceFields,
  reconcile: ReconcileOutcomeLike | null | undefined,
): CancelPlan {
  const preflight = evaluateCancellationPreflight(ship);
  if (preflight.mode !== "ambiguous") return preflight;

  const canonical = String(reconcile?.canonical?.canonical_shipment_id || "").trim();
  const version = Number(reconcile?.canonical?.version);
  if (reconcile?.ok && SHIPMENT_ID_PATTERN.test(canonical) && Number.isInteger(version) && version >= 1) {
    return {
      mode: "domain",
      canonical_shipment_id: canonical,
      expected_version: version,
      adopted_from_reconcile: true,
    };
  }

  if (reconcile && !reconcile.ok && reconcile.reason === "no_match") {
    // A read that finds nothing is NOT proof that the create failed. The original
    // request can still be processing, or commit after this read was taken, and
    // the domain exposes no command-status contract that would prove it was
    // never accepted. So the shipment stays open for reconciliation instead of
    // being closed locally. No endpoint is invented to fill that gap.
    return {
      mode: "blocked",
      code: "cancel_creation_unconfirmed",
      message:
        "The domain read found no shipment yet, which does not prove the create failed: it may still be processing or commit afterwards, and the backend exposes no command-status check. This shipment stays open for reconciliation.",
      detail: reconcile.detail || "no shipment for merchant_id + order_id",
    };
  }

  return {
    mode: "blocked",
    code: "cancel_reconciliation_unresolved",
    message:
      "The domain read could not confirm whether this shipment exists remotely, so it stays open for reconciliation instead of being cancelled.",
    detail: reconcile?.detail || reconcile?.reason || "no canonical read",
  };
}

// ---------------------------------------------------------------------------
// Cancellation command identity + payload
// ---------------------------------------------------------------------------
//
// The backend handoff specifies command_id, expected_version, correlation_id
// and reason. All four are preserved across retries: reusing only some of them
// would make a retry a different command.
export const CANCEL_REASON_MAX = 200;

export function normalizeCancelReason(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return undefined;
  return text.slice(0, CANCEL_REASON_MAX);
}

export interface CancelIdentityFields {
  cancel_command_id?: string;
  cancel_expected_version?: number;
  cancel_correlation_id?: string;
  cancel_reason?: string;
}

export interface CancelCommand {
  command_id: string;
  expected_version: number;
  correlation_id: string;
  reason?: string;
  reused: boolean;
  /** One or more payload fields were absent on a legacy command and are being filled once. */
  backfilled: string[];
}

export type CancelCommandPlan =
  | { ok: true; command: CancelCommand }
  | {
      ok: false;
      code: "version_conflict";
      message: string;
      command_id: string;
      expected_version: number;
      current_version: number;
    }
  | {
      ok: false;
      code: "cancel_payload_unestablished";
      message: string;
      command_id: string;
      expected_version: number | null;
      missing: string[];
    };

// A retry must reproduce the ORIGINAL command, never a repaired version of it.
// If a legacy row recorded a command id without the rest of its payload, the
// payload that actually went out cannot be established, so the row is flagged
// for reconciliation instead of being completed with fields from this request.
export function planCancelCommand(input: {
  ship: CancelIdentityFields;
  current_version: number;
  requested_reason?: unknown;
  new_command_id: string;
  new_correlation_id: string;
}): CancelCommandPlan {
  const storedVersion = Number(input.ship?.cancel_expected_version);
  const existing = String(input.ship?.cancel_command_id || "").trim();

  if (existing) {
    if (!Number.isInteger(storedVersion) || storedVersion !== input.current_version) {
      return {
        ok: false,
        code: "version_conflict",
        message: `The shipment moved from version ${storedVersion} to ${input.current_version} after this cancellation was planned.`,
        command_id: existing,
        expected_version: storedVersion,
        current_version: input.current_version,
      };
    }
    const correlationId = String(input.ship?.cancel_correlation_id || "").trim();
    if (!correlationId) {
      return {
        ok: false,
        code: "cancel_payload_unestablished",
        message:
          "This cancellation was recorded without its correlation id, so a retry cannot reproduce the command that was sent. It is flagged for reconciliation instead of being sent as a repaired command.",
        command_id: existing,
        expected_version: Number.isInteger(storedVersion) ? storedVersion : null,
        missing: ["correlation_id"],
      };
    }
    return {
      ok: true,
      command: {
        command_id: existing,
        expected_version: storedVersion,
        correlation_id: correlationId,
        // The reason is part of the sent payload: a missing one is NOT filled
        // in from this request, because that would change the command.
        reason: normalizeCancelReason(input.ship?.cancel_reason),
        reused: true,
        backfilled: [],
      },
    };
  }

  return {
    ok: true,
    command: {
      command_id: input.new_command_id,
      expected_version: input.current_version,
      correlation_id: input.new_correlation_id,
      reason: normalizeCancelReason(input.requested_reason),
      reused: false,
      backfilled: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Retry after a lost cancellation response
// ---------------------------------------------------------------------------
//
// A cancel command can be applied remotely while its response is lost, which
// moves the canonical version. A moved version is therefore NOT a conflict on
// its own: the canonical state is read first, and a confirmed remote
// cancellation settles the local row without sending anything else.
export type CancelRetry =
  | { mode: "settle_cancelled"; version: number | null; source: "canonical_read" }
  | { mode: "send" }
  | {
      mode: "version_conflict";
      command_id: string;
      expected_version: number;
      current_version: number;
      message: string;
    };

export function resolveCancellationRetry(input: {
  ship: CancelIdentityFields;
  canonical: { status?: string | null; version?: number | null };
}): CancelRetry {
  const status = String(input.canonical?.status || "").trim();
  if (status === "cancelled") {
    const version = Number(input.canonical?.version);
    return {
      mode: "settle_cancelled",
      version: Number.isInteger(version) && version >= 1 ? version : null,
      source: "canonical_read",
    };
  }

  const existing = String(input.ship?.cancel_command_id || "").trim();
  const storedVersion = Number(input.ship?.cancel_expected_version);
  const current = Number(input.canonical?.version);
  if (existing && Number.isInteger(storedVersion) && Number.isInteger(current) && storedVersion !== current) {
    return {
      mode: "version_conflict",
      command_id: existing,
      expected_version: storedVersion,
      current_version: current,
      message: `The shipment moved from version ${storedVersion} to ${current} and the canonical state does not report it cancelled, so the retry is not re-sent.`,
    };
  }

  return { mode: "send" };
}

// ---------------------------------------------------------------------------
// Booking release switch
// ---------------------------------------------------------------------------
//
// A successful merchant-context probe records AUTHORIZATION only. It does not
// release booking: the merchant's verification stamp must exist AND the
// operator must have switched booking on separately, once the coordinated
// booking/payment/cancellation checks have passed.
export const BOOKING_RELEASE_FLAG = "BOOKING_RELEASE_ENABLED";

export type BookingRelease =
  | { open: true; code: "released" }
  | {
      open: false;
      code: "release_not_authorized" | "booking_release_disabled";
      message: string;
    };

export function evaluateBookingRelease(input: { authorized: boolean; flagEnabled: boolean }): BookingRelease {
  if (!input.authorized) {
    return {
      open: false,
      code: "release_not_authorized",
      message: "Merchant authorization or the recorded verification is missing.",
    };
  }
  if (!input.flagEnabled) {
    return {
      open: false,
      code: "booking_release_disabled",
      message:
        "Merchant authorization is verified, but booking is still switched off until the coordinated booking, payment and cancellation checks pass.",
    };
  }
  return { open: true, code: "released" };
}