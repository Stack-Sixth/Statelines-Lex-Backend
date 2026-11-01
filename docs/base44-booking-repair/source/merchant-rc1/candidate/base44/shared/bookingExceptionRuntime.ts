// Runtime binding for the controlled test exception.
//
// The rules live in bookingException.ts (pure). This module is the only place
// that reads the exception switches and probes secret PRESENCE for them, and the
// only place that loads the trusted link/merchant/account subject from the
// database. Every handler builds the same context, so no handler touches
// secrets directly.

import { secrets } from "base44:runtime";
import {
  EMPTY_CONTROLLED_SUBJECT,
  EXCEPTION_FLAG,
  ISOLATION_FLAG,
  evaluateControlledBooking,
  type ControlledBookingVerdict,
  type ControlledContext,
  type ControlledSubject,
} from "./bookingException.ts";
import type { DomainLink, LocalConfig } from "./authorityRules.ts";
import type { VerifiedAuthority } from "./domainMerchant.ts";

export function exceptionContext(): ControlledContext {
  return {
    readSecret: (name: string) => secrets.get(name) || "",
    exceptionFlagEnabled: String(secrets.get(EXCEPTION_FLAG) || "").toLowerCase() === "true",
    isolationConfirmed: String(secrets.get(ISOLATION_FLAG) || "").toLowerCase() === "true",
  };
}

/**
 * Build the controlled subject from an ALREADY VERIFIED authority. Nothing here
 * reads a browser flag: the isolation evidence comes from the live backend
 * probe, and the identity/link come from the authorized server-side resolution.
 */
export function subjectFromAuthority(
  authority: Pick<VerifiedAuthority, "local" | "identity" | "verification" | "isolation">,
  account: { id: string } | null,
  merchant: { id: string; created_by_id?: string } | null,
): ControlledSubject {
  const local: LocalConfig | null = authority.local && authority.local.ok ? authority.local : null;
  const link: DomainLink | null = local?.link || null;
  const identity = authority.identity
    ? {
        domain_merchant_id: authority.identity.domain_merchant_id,
        client_id: authority.identity.client_id,
        signing_subject: authority.identity.signing_subject,
        credential_fingerprint: authority.identity.credential_fingerprint,
      }
    : null;

  return {
    ...EMPTY_CONTROLLED_SUBJECT,
    account: account ? { id: account.id } : null,
    merchant: merchant ? { id: merchant.id, created_by_id: merchant.created_by_id } : null,
    link,
    identity,
    probe: {
      ok: authority.verification.status === "verified",
      sandbox_isolated: authority.isolation?.sandbox_isolated === true,
    },
    // `ready` already means local + verified probe + recorded stamp.
    stamp_verified: authority.verification.status === "verified" && Boolean(link?.scope_verified_at),
  };
}

export function evaluateForAuthority(
  authority: Pick<VerifiedAuthority, "local" | "identity" | "verification" | "isolation">,
  account: { id: string } | null,
  merchant: { id: string; created_by_id?: string } | null,
  ctx: ControlledContext = exceptionContext(),
): ControlledBookingVerdict {
  const subject = subjectFromAuthority(authority, account, merchant);
  return evaluateControlledBooking({
    local_merchant_id: merchant?.id,
    canonical_merchant_id: authority.identity?.domain_merchant_id,
    client_id: authority.identity?.client_id,
    subject,
    ctx,
  });
}

/** Reporting-only view for one business, with no subject resolved. */
export function evaluatePrepared(
  localMerchantId: string | null,
  canonicalMerchantId: string | null,
  clientId: string | null,
  ctx: ControlledContext = exceptionContext(),
): ControlledBookingVerdict {
  return evaluateControlledBooking({
    local_merchant_id: localMerchantId,
    canonical_merchant_id: canonicalMerchantId,
    client_id: clientId,
    subject: EMPTY_CONTROLLED_SUBJECT,
    ctx,
  });
}