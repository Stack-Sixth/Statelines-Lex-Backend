// CONTROLLED TEST EXCEPTION — exactly two synthetic businesses.
//
// General Merchant booking stays closed (BOOKING_RELEASE_ENABLED off) and LEX
// booking is always closed. This module names a SECOND, independent release: a
// quarantined booking command for one registered synthetic business, which can
// be open while the ordinary global release is closed.
//
// IDENTITY — distinct fields, never inferred equal:
//   synthetic_label         locally minted register id (SYNTH-…)
//   lex_business_reference  the business reference LEX knows (SBX-BIZ-…)
//   local_merchant_id       the app's own Merchant record id
//   approved_user_id        the verified account for that Merchant record
//   mapping_id              the DomainMerchantLink row approved for it
//   canonical_merchant_id   the MER_… identity LEX provisions (strict hex form)
//   client_id               the dedicated client (the merchant signing subject)
//   credential_key          suffix for LEX_DOMAIN_<KEY>_CLIENT_ID / _SECRET
//
// No equality is inferred between a synthetic label, a local merchant id and a
// MER_… identity. A missing canonical identity keeps the entry closed.
//
// FAIL-CLOSED. An entry is open only when ALL hold:
//   1. the register is valid,
//   2. the entry carries a strict canonical MER_… identity,
//   3. that business's dedicated credential pair is present (both parts),
//   4. LEX has issued that business's authenticated user id,
//   5. the DomainMerchantLink carries the exact merchant / account / client /
//      subject / credential key this entry names,
//   6. the recorded verification stamp matches that identity and credential,
//   7. the live merchant-context probe reports sandbox isolation,
//   8. the operator confirmed isolation AND switched the exception on.
//
// A synthetic booking command is QUARANTINED: it is not payment authority, not
// a carrier hand-off, and not permission to dispatch, notify or fulfil.
//
// Pure: no network, no database, no runtime secrets. Callers pass a readSecret
// probe in, so this never handles a secret value it could return.

import { credentialNames, STRICT_MERCHANT_ID_PATTERN, type DomainLink } from "./authorityRules.ts";

export { credentialNames, STRICT_MERCHANT_ID_PATTERN } from "./authorityRules.ts";

export const EXCEPTION_MAX = 2;

/** Operator switch for this exception. Never a general booking release. */
export const EXCEPTION_FLAG = "BOOKING_EXCEPTION_ENABLED";
/** Set only after backend isolation has been confirmed by the operator. */
export const ISOLATION_FLAG = "EXCEPTION_ISOLATION_CONFIRMED";

/** Locally minted synthetic label prefix. NOT a canonical identity. */
export const SYNTHETIC_PREFIX = "SYNTH-";

export const SIGNING_POLICY = {
  merchant: {
    party: "merchant",
    claim: "sub",
    value: "dedicated client_id",
    rule: "iss = sub = client_id",
  },
  lex: {
    party: "lex",
    claim: "sub",
    value: "authenticated LEX user id",
    rule: "sub = authenticated_user_id",
  },
} as const;

export interface LocalBinding {
  user_id: string;
  merchant_id: string;
  business_name: string;
  bound_at: string;
  purpose: string;
}

export interface ExceptionBusiness {
  synthetic_label: string;
  lex_business_reference: string;
  local_merchant_id: string | null;
  approved_user_id: string | null;
  mapping_id: string | null;
  lex_mapping_record_id?: string;
  canonical_merchant_id: string | null;
  client_id: string;
  credential_key: string;
  lex_authenticated_user_id: string | null;
  lex_user_id_source: string;
  /** Display only. Read by no authorization predicate. */
  local_binding?: LocalBinding;
}

// Exactly two. Never extend without a separately reviewed change.
export const EXCEPTION_BUSINESSES: readonly ExceptionBusiness[] = [
  {
    synthetic_label: "SYNTH-BIZ-0001",
    lex_business_reference: "SBX-BIZ-ALPHA-001",
    local_merchant_id: "6ae36089acdf77499fbf16d5",
    approved_user_id: "6ae36074e14192b2f7f51dc7",
    mapping_id: null, // Actual Merchant DomainMerchantLink ID still requires confirmation.
    lex_mapping_record_id: "6ae34e39a9b77923c0e445ab",
    canonical_merchant_id: null,
    client_id: "sbx-alpha-lex-01",
    credential_key: "SYNTH_A",
    lex_authenticated_user_id: "6ac144d7ba5eefb2dc02e410",
    lex_user_id_source: "lex_issued",
    local_binding: {
      user_id: "6ae36074e14192b2f7f51dc7",
      merchant_id: "6ae36089acdf77499fbf16d5",
      business_name: "Statelines Test Alpha",
      bound_at: "2026-10-29T15:30:00.000Z",
      purpose:
        "Display only. Sender access comes from the account rule; no membership record was fabricated.",
    },
  },
  {
    synthetic_label: "SYNTH-BIZ-0002",
    lex_business_reference: "SBX-BIZ-BETA-002",
    local_merchant_id: "6ae36c0f51cbdef3e3e7b3c7",
    approved_user_id: "6ae36bfacc7ef5a364d5403f",
    mapping_id: null, // Do not reuse a LEX-local record ID as a Merchant link ID.
    lex_mapping_record_id: "6ae34e396fbaac9f2498224f",
    canonical_merchant_id: null,
    client_id: "sbx-beta-lex-02",
    credential_key: "SYNTH_B",
    lex_authenticated_user_id: "6ad55271cafef064e29ff2dd",
    lex_user_id_source: "lex_issued",
    local_binding: {
      user_id: "6ae36bfacc7ef5a364d5403f",
      merchant_id: "6ae36c0f51cbdef3e3e7b3c7",
      business_name: "Statelines Test Beta",
      bound_at: "2026-10-29T16:55:00.000Z",
      purpose:
        "Display only. Sender access comes from the account rule; no membership record was fabricated.",
    },
  },
];

export type SecretProbe = (name: string) => string;

export interface ControlledContext {
  /** Presence probe. Values are used for checks only and never returned. */
  readSecret: SecretProbe;
  exceptionFlagEnabled: boolean;
  isolationConfirmed: boolean;
}

export interface RegisterVerdict {
  valid: boolean;
  count: number;
  max: number;
  code: "exception_register_valid" | "exception_register_invalid";
  message: string;
}

export function validateExceptionRegister(
  entries: readonly ExceptionBusiness[] = EXCEPTION_BUSINESSES,
): RegisterVerdict {
  const fail = (message: string): RegisterVerdict => ({
    valid: false,
    count: entries.length,
    max: EXCEPTION_MAX,
    code: "exception_register_invalid",
    message,
  });

  if (entries.length !== EXCEPTION_MAX) {
    return fail(`The exception must contain exactly ${EXCEPTION_MAX} businesses, found ${entries.length}.`);
  }
  const labels = new Set<string>();
  const merchants = new Set<string>();
  const clients = new Set<string>();
  const keys = new Set<string>();
  for (const entry of entries) {
    if (!entry.synthetic_label || !entry.client_id || !entry.credential_key || !entry.lex_business_reference) {
      return fail("Every entry needs a synthetic label, LEX business reference, client id and credential key.");
    }
    if (!entry.synthetic_label.startsWith(SYNTHETIC_PREFIX)) {
      return fail(`${entry.synthetic_label} is not a synthetic label.`);
    }
    if (entry.canonical_merchant_id && !STRICT_MERCHANT_ID_PATTERN.test(entry.canonical_merchant_id)) {
      return fail(`${entry.synthetic_label}: canonical merchant identity is not a MER_… identifier.`);
    }
    if (labels.has(entry.synthetic_label)) return fail(`Duplicate synthetic label ${entry.synthetic_label}.`);
    if (clients.has(entry.client_id)) return fail(`Duplicate client id ${entry.client_id}.`);
    if (keys.has(entry.credential_key)) return fail(`Duplicate credential key ${entry.credential_key}.`);
    if (entry.local_merchant_id) {
      if (merchants.has(entry.local_merchant_id)) return fail(`Duplicate local merchant id ${entry.local_merchant_id}.`);
      merchants.add(entry.local_merchant_id);
    }
    labels.add(entry.synthetic_label);
    clients.add(entry.client_id);
    keys.add(entry.credential_key);
  }
  return {
    valid: true,
    count: entries.length,
    max: EXCEPTION_MAX,
    code: "exception_register_valid",
    message: `${entries.length} synthetic businesses registered.`,
  };
}

/** True only when this entry carries a strict canonical MER_… identity. */
export function canonicalMerchantIdPresent(entry: ExceptionBusiness | null | undefined): boolean {
  return Boolean(entry?.canonical_merchant_id && STRICT_MERCHANT_ID_PATTERN.test(entry.canonical_merchant_id));
}

export function findExceptionByLabel(label: unknown): ExceptionBusiness | null {
  const value = String(label || "");
  return EXCEPTION_BUSINESSES.find((entry) => entry.synthetic_label === value) || null;
}

/**
 * Resolve an entry from a LOCAL merchant id or a CANONICAL MER_… identity.
 * Each field is compared on its own; the two are never treated as equal.
 */
export function findExceptionByMerchant(input: {
  local_merchant_id?: unknown;
  canonical_merchant_id?: unknown;
  client_id?: unknown;
  entries?: readonly ExceptionBusiness[];
}): ExceptionBusiness | null {
  const local = input.local_merchant_id ? String(input.local_merchant_id) : "";
  const canonical = input.canonical_merchant_id ? String(input.canonical_merchant_id) : "";
  const client = input.client_id ? String(input.client_id) : "";
  return (
    (input.entries || EXCEPTION_BUSINESSES).find(
      (entry) =>
        (local && entry.local_merchant_id === local) ||
        (canonical && entry.canonical_merchant_id === canonical) ||
        (client && entry.client_id === client),
    ) || null
  );
}

/** Prefix check: suspicion only. It never selects authority or opens a release. */
export function isSyntheticBusinessId(value: unknown): boolean {
  return String(value || "").startsWith(SYNTHETIC_PREFIX);
}

export interface ControlledChecks {
  identity: boolean;
  canonical_mapping: boolean;
  link_identity: boolean;
  credentials: boolean;
  lex_identity: boolean;
  mapping_stamp: boolean;
  isolation: boolean;
  switch_on: boolean;
}

/**
 * Every gate is a prerequisite of a controlled live test. The former
 * sandbox-base / sandbox-payment gates are gone: the controlled command targets
 * the trusted LEX_API_URL and is quarantined, so no sandbox origin or sandbox
 * charge is part of the design.
 */
export type PrerequisiteClass = "live_test";

export const PREREQUISITE_CLASS: Record<keyof ControlledChecks, PrerequisiteClass> = {
  identity: "live_test",
  canonical_mapping: "live_test",
  link_identity: "live_test",
  credentials: "live_test",
  lex_identity: "live_test",
  mapping_stamp: "live_test",
  isolation: "live_test",
  switch_on: "live_test",
};

export interface PrerequisiteItem {
  key: keyof ControlledChecks;
  class: PrerequisiteClass;
  satisfied: boolean;
}

export interface PrerequisiteClassification {
  live_test: PrerequisiteItem[];
  sandbox_isolation: PrerequisiteItem[];
  live_test_blockers: (keyof ControlledChecks)[];
  sandbox_isolation_blockers: (keyof ControlledChecks)[];
  message: string;
}

export function classifyPrerequisites(checks: ControlledChecks): PrerequisiteClassification {
  const items = (Object.keys(PREREQUISITE_CLASS) as (keyof ControlledChecks)[]).map((key) => ({
    key,
    class: PREREQUISITE_CLASS[key],
    satisfied: Boolean(checks[key]),
  }));
  const open = items.filter((item) => !item.satisfied).map((item) => item.key);
  return {
    live_test: items,
    sandbox_isolation: [],
    live_test_blockers: open,
    sandbox_isolation_blockers: [],
    message: `${open.length} prerequisite(s) open. Every gate belongs to the controlled live test; no sandbox origin or sandbox payment is a prerequisite.`,
  };
}

export interface ControlledSubject {
  account: { id: string } | null;
  merchant: { id: string; created_by_id?: string } | null;
  link: DomainLink | null;
  identity: {
    domain_merchant_id: string;
    client_id: string;
    signing_subject: string;
    credential_fingerprint: string;
  } | null;
  probe: { ok: boolean; sandbox_isolated: boolean } | null;
  stamp_verified: boolean;
}

export const EMPTY_CONTROLLED_SUBJECT: ControlledSubject = {
  account: null,
  merchant: null,
  link: null,
  identity: null,
  probe: null,
  stamp_verified: false,
};

export interface ControlledEntryVerdict {
  synthetic_label: string;
  lex_business_reference: string;
  local_merchant_id: string | null;
  canonical_merchant_id: string | null;
  client_id: string;
  credential_key: string;
  credential_names: { id: string; secret: string };
  merchant_subject: string;
  lex_subject: string | null;
  /** True only when this entry is released for a quarantined booking command. */
  open: boolean;
  code: string;
  message: string;
  checks: ControlledChecks;
  prerequisites: PrerequisiteClassification;
}

const MESSAGES: Record<string, string> = {
  exception_released: "Released for a quarantined synthetic booking command only.",
  exception_register_invalid: "The exception register is invalid.",
  exception_identity_incomplete: "The entry is missing its local merchant, account, mapping or LEX business reference.",
  exception_canonical_identity_missing:
    "No canonical MER_… identity is recorded for this business, so the exception stays closed.",
  exception_link_missing: "No DomainMerchantLink is recorded for this business.",
  exception_link_mismatch:
    "The DomainMerchantLink does not carry the exact merchant, account, client, subject and credential this entry names.",
  exception_credentials_missing: "This business's dedicated credential pair is not present in full.",
  exception_lex_user_unprovisioned: "LEX has not issued this business's authenticated user id.",
  exception_verification_not_recorded: "The coordinated verification stamp is missing or no longer matches.",
  exception_isolation_unproven: "The backend did not evidence sandbox isolation for this business.",
  exception_isolation_unconfirmed: "Backend isolation has not been confirmed by the operator.",
  exception_switch_off: "The exception switch is off.",
  exception_unknown_business: "This business is not one of the two registered exception businesses.",
};

function messageFor(code: string): string {
  return MESSAGES[code] || "The exception entry is not released.";
}

const CHECK_ORDER = [
  "identity",
  "canonical_mapping",
  "link_identity",
  "credentials",
  "lex_identity",
  "mapping_stamp",
  "isolation",
  "switch_on",
] as const;

const CHECK_CODES: Record<(typeof CHECK_ORDER)[number], string> = {
  identity: "exception_identity_incomplete",
  canonical_mapping: "exception_canonical_identity_missing",
  link_identity: "exception_link_mismatch",
  credentials: "exception_credentials_missing",
  lex_identity: "exception_lex_user_unprovisioned",
  mapping_stamp: "exception_verification_not_recorded",
  isolation: "exception_isolation_unproven",
  switch_on: "exception_switch_off",
};

export function evaluateControlledEntry(
  entry: ExceptionBusiness,
  subject: ControlledSubject,
  ctx: ControlledContext,
  register: RegisterVerdict = validateExceptionRegister(),
): ControlledEntryVerdict {
  const names = credentialNames(entry.credential_key);
  const link = subject.link;
  const identity = subject.identity;
  const merchant = subject.merchant;
  const account = subject.account;

  const identityComplete = Boolean(
    entry.local_merchant_id && entry.approved_user_id && entry.lex_business_reference && entry.client_id,
  );
  const canonicalPresent = canonicalMerchantIdPresent(entry);

  const canonical_mapping = Boolean(
    canonicalPresent &&
      identity &&
      link &&
      STRICT_MERCHANT_ID_PATTERN.test(String(link.domain_merchant_id || "")) &&
      link.domain_merchant_id === entry.canonical_merchant_id &&
      identity.domain_merchant_id === entry.canonical_merchant_id,
  );

  const link_identity = Boolean(
    link &&
      merchant &&
      account &&
      entry.local_merchant_id === merchant.id &&
      link.merchant_id === merchant.id &&
      link.user_id === merchant.created_by_id &&
      merchant.created_by_id === account.id &&
      entry.approved_user_id === account.id &&
      link.domain_client_id === entry.client_id &&
      link.signing_subject === entry.client_id &&
      link.credential_key === entry.credential_key &&
      String(link.status || "") === "authorized" &&
      Boolean(entry.mapping_id) && link.id === entry.mapping_id,
  );

  const checks: ControlledChecks = {
    identity: identityComplete,
    canonical_mapping,
    link_identity,
    credentials: Boolean(
      ctx.readSecret(names.id) &&
        ctx.readSecret(names.secret) &&
        identity &&
        identity.client_id === entry.client_id,
    ),
    lex_identity: Boolean(entry.lex_authenticated_user_id),
    mapping_stamp: Boolean(subject.stamp_verified && link?.scope_verified_at),
    isolation: Boolean(
      subject.probe?.ok === true && subject.probe.sandbox_isolated === true && ctx.isolationConfirmed,
    ),
    switch_on: ctx.exceptionFlagEnabled,
  };

  let code = "exception_released";
  if (!register.valid) code = "exception_register_invalid";
  else if (!identityComplete) code = "exception_identity_incomplete";
  else if (!canonicalPresent) code = "exception_canonical_identity_missing";
  else if (!link) code = "exception_link_missing";
  else {
    for (const key of CHECK_ORDER) {
      if (!checks[key]) {
        code = subject.probe && subject.probe.ok === true && subject.probe.sandbox_isolated === false && key === "isolation"
          ? "exception_isolation_unproven"
          : CHECK_CODES[key];
        break;
      }
    }
  }

  const open = code === "exception_released";

  return {
    synthetic_label: entry.synthetic_label,
    lex_business_reference: entry.lex_business_reference,
    local_merchant_id: entry.local_merchant_id,
    canonical_merchant_id: entry.canonical_merchant_id,
    client_id: entry.client_id,
    credential_key: entry.credential_key,
    credential_names: names,
    merchant_subject: entry.client_id,
    lex_subject: entry.lex_authenticated_user_id,
    open,
    code,
    message: `${entry.synthetic_label}: ${register.valid ? messageFor(code) : register.message}`,
    checks,
    prerequisites: classifyPrerequisites(checks),
  };
}

export interface ControlledBookingVerdict {
  open: boolean;
  code: string;
  message: string;
  synthetic_label: string | null;
  canonical_merchant_id: string | null;
  client_id: string | null;
  /** Hard invariant: this exception never opens global merchant or LEX booking. */
  scope: {
    exception_synthetic_label: string | null;
    global_merchant_booking: false;
    lex_booking: false;
  };
  register: RegisterVerdict;
  entry: ControlledEntryVerdict | null;
}

/**
 * Evaluate the controlled exception for one business. Any other business — and
 * any request naming no registered business — is closed.
 */
export function evaluateControlledBooking(input: {
  local_merchant_id?: unknown;
  canonical_merchant_id?: unknown;
  client_id?: unknown;
  subject: ControlledSubject;
  ctx: ControlledContext;
  entries?: readonly ExceptionBusiness[];
}): ControlledBookingVerdict {
  const entries = input.entries || EXCEPTION_BUSINESSES;
  const register = validateExceptionRegister(entries);
  const entry = findExceptionByMerchant({
    local_merchant_id: input.local_merchant_id,
    canonical_merchant_id: input.canonical_merchant_id,
    client_id: input.client_id,
    entries,
  });

  const closed = (code: string, message: string): ControlledBookingVerdict => ({
    open: false,
    code,
    message,
    synthetic_label: entry ? entry.synthetic_label : null,
    canonical_merchant_id: entry ? entry.canonical_merchant_id : null,
    client_id: entry ? entry.client_id : null,
    scope: { exception_synthetic_label: null, global_merchant_booking: false, lex_booking: false },
    register,
    entry: entry ? evaluateControlledEntry(entry, input.subject, input.ctx, register) : null,
  });

  if (!register.valid) return closed(register.code, register.message);
  if (!entry) return closed("exception_unknown_business", messageFor("exception_unknown_business"));

  const verdict = evaluateControlledEntry(entry, input.subject, input.ctx, register);
  if (!verdict.open) return closed(verdict.code, verdict.message);

  return {
    open: true,
    code: "exception_released",
    message: `${entry.synthetic_label} is released for a quarantined synthetic booking command only. Ordinary booking and LEX booking remain closed.`,
    synthetic_label: entry.synthetic_label,
    canonical_merchant_id: entry.canonical_merchant_id,
    client_id: entry.client_id,
    scope: { exception_synthetic_label: entry.synthetic_label, global_merchant_booking: false, lex_booking: false },
    register,
    entry: verdict,
  };
}

/** The subject each party signs with. Never a secret, never interchangeable. */
export function exceptionSigningIdentities(entry: ExceptionBusiness) {
  return {
    synthetic_label: entry.synthetic_label,
    merchant: { claim: "sub", subject: entry.client_id, rule: SIGNING_POLICY.merchant.rule },
    lex: {
      claim: "sub",
      subject: entry.lex_authenticated_user_id,
      rule: SIGNING_POLICY.lex.rule,
      issued: Boolean(entry.lex_authenticated_user_id),
    },
  };
}

export interface RedactedMappingEntry {
  synthetic_label: string;
  lex_business_reference: string;
  local_merchant_id: string | null;
  approved_user_id: string | null;
  mapping_id: string | null;
  lex_mapping_record_id?: string;
  canonical_merchant_id: string | null;
  canonical_identity_present: boolean;
  client_id: string;
  credential_key: string;
  credential_names: { id: string; secret: string };
  merchant_subject: string;
  lex_authenticated_user_id: string | null;
  lex_user_id_source: string;
  local_binding: LocalBinding | null;
}

/** Reporting shape: identifiers and presence only. Never a secret value. */
export function redactedMapping(
  entries: readonly ExceptionBusiness[] = EXCEPTION_BUSINESSES,
): RedactedMappingEntry[] {
  return entries.map((entry) => ({
    synthetic_label: entry.synthetic_label,
    lex_business_reference: entry.lex_business_reference,
    local_merchant_id: entry.local_merchant_id,
    approved_user_id: entry.approved_user_id,
    mapping_id: entry.mapping_id,
    lex_mapping_record_id: entry.lex_mapping_record_id,
    canonical_merchant_id: entry.canonical_merchant_id,
    canonical_identity_present: canonicalMerchantIdPresent(entry),
    client_id: entry.client_id,
    credential_key: entry.credential_key,
    credential_names: credentialNames(entry.credential_key),
    merchant_subject: entry.client_id,
    lex_authenticated_user_id: entry.lex_authenticated_user_id,
    lex_user_id_source: entry.lex_user_id_source,
    local_binding: entry.local_binding || null,
  }));
}