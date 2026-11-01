// OUTBOUND CONTAINMENT — trusted classification, not a caller flag.
//
// Every outbound boundary asks the same question: is the subject of this
// delivery a SYNTHETIC record, a resolved PRODUCTION record, or UNKNOWN?
//
//   synthetic  — registered synthetic business (by local merchant id or
//                canonical MER_… identity) or a server-persisted test marker
//   production — exactly one persisted shipment resolved to exactly one trusted
//                business, with no synthetic evidence
//   unknown    — missing record, failed lookup, ambiguous or contradictory
//                identifiers, or an unresolved business
//
// Only PRODUCTION may leave the app. SYNTHETIC is contained on every channel:
// there is no carrier allowance, because a synthetic booking command is
// quarantined and is not permission to call a real carrier. UNKNOWN is denied
// as well — never signed, sent, notified or fulfilled.
//
// A SYNTH- prefix is suspicion only: it is recorded, but it can neither select
// authority nor open a release.
//
// Pure: no network, no database, no secrets.

import {
  EXCEPTION_BUSINESSES,
  isSyntheticBusinessId,
  type ExceptionBusiness,
} from "./bookingException.ts";

export type OutboundChannel = "carrier" | "dispatch" | "fulfillment" | "notification";

export const OUTBOUND_CHANNELS: readonly OutboundChannel[] = [
  "carrier",
  "dispatch",
  "fulfillment",
  "notification",
];

export type SubjectClassification = "synthetic" | "production" | "unknown";

export type ResolutionState =
  | "resolved"
  | "missing"
  | "lookup_error"
  | "ambiguous"
  | "contradictory"
  | "unresolved_business"
  | "no_reference";

export interface ShipmentLike {
  id?: string;
  merchant_id?: string;
  created_by_id?: string;
  tracking_number?: string;
  tracking_id?: string;
  canonical_shipment_id?: string;
  domain_merchant_scope?: string;
  test_harness?: boolean;
}

export interface MerchantLike {
  id: string;
  created_by_id?: string;
}

export interface ResolvedSubject {
  classification: SubjectClassification;
  resolution: ResolutionState;
  shipment_id: string | null;
  canonical_shipment_id: string | null;
  local_merchant_id: string | null;
  canonical_merchant_id: string | null;
  test_harness: boolean;
  reasons: string[];
}

export function unknownSubject(resolution: ResolutionState, reason: string): ResolvedSubject {
  return {
    classification: "unknown",
    resolution,
    shipment_id: null,
    canonical_shipment_id: null,
    local_merchant_id: null,
    canonical_merchant_id: null,
    test_harness: false,
    reasons: [reason],
  };
}

/**
 * Pure classification of one already-resolved subject. `resolution` states how
 * the shipment was found, so a failed or ambiguous lookup can never be reported
 * as an ordinary record.
 */
export function classifySubject(input: {
  shipment: ShipmentLike | null | undefined;
  resolution: ResolutionState;
  merchant: MerchantLike | null | undefined;
  exceptions?: readonly ExceptionBusiness[];
}): ResolvedSubject {
  const { shipment, resolution, merchant } = input;
  const exceptions = input.exceptions || EXCEPTION_BUSINESSES;

  if (resolution === "lookup_error") return unknownSubject("lookup_error", "record lookup failed");
  if (resolution === "ambiguous") return unknownSubject("ambiguous", "more than one record matches");
  if (resolution === "contradictory") return unknownSubject("contradictory", "supplied identifiers disagree");
  if (resolution === "no_reference") return unknownSubject("no_reference", "no shipment or tracking reference supplied");
  if (resolution === "missing" || !shipment) return unknownSubject("missing", "record not found");

  const reasons: string[] = [];
  const canonicalScope = String(shipment.domain_merchant_scope || "");
  const businessId = String(shipment.merchant_id || "");

  // Server-persisted marker: authoritative containment signal.
  if (shipment.test_harness === true) reasons.push("test_harness");

  // Registered synthetic business, by local id or by canonical scope.
  const registered = exceptions.find(
    (entry) =>
      (entry.local_merchant_id && entry.local_merchant_id === businessId) ||
      (entry.canonical_merchant_id && entry.canonical_merchant_id === canonicalScope),
  );
  if (registered) reasons.push(`registered_synthetic:${registered.synthetic_label}`);

  // Prefix only raises suspicion. It never classifies and never authorizes.
  if (!registered && (isSyntheticBusinessId(businessId) || isSyntheticBusinessId(canonicalScope))) {
    reasons.push("synthetic_prefix_suspicion");
  }

  const base = {
    shipment_id: shipment.id || null,
    canonical_shipment_id: shipment.canonical_shipment_id || null,
    local_merchant_id: businessId || null,
    canonical_merchant_id: canonicalScope || null,
    test_harness: shipment.test_harness === true,
    reasons,
  };

  if (reasons.includes("test_harness") || registered) {
    return { ...base, classification: "synthetic", resolution: "resolved" };
  }

  // Production requires a trusted, resolved business. A shipment that names no
  // business, or names a different one than was resolved, is UNKNOWN.
  if (!merchant?.id) {
    return unknownSubject("unresolved_business", "no trusted business resolved for this record");
  }
  if (businessId && businessId !== merchant.id) {
    return unknownSubject("contradictory", "record and resolved business disagree");
  }

  return {
    ...base,
    classification: "production",
    resolution: "resolved",
    local_merchant_id: merchant.id,
  };
}

export interface ContainmentDecision {
  decision: "allow" | "deny";
  allowed: boolean;
  classification: SubjectClassification;
  channel: OutboundChannel;
  sink: "live" | "sandbox_sink" | "none";
  code: string;
  message: string;
  reasons: string[];
  resolution: ResolutionState;
}

/**
 * The single outbound decision. Only a resolved production record is delivered;
 * synthetic and unknown are denied on every channel.
 */
export function evaluateOutboundContainment(input: {
  channel: OutboundChannel;
  subject: ResolvedSubject;
}): ContainmentDecision {
  const { channel, subject } = input;
  const base = {
    channel,
    classification: subject.classification,
    reasons: subject.reasons,
    resolution: subject.resolution,
  };

  if (subject.classification === "unknown") {
    return {
      ...base,
      decision: "deny",
      allowed: false,
      sink: "none",
      code: "containment_unknown",
      message: `Delivery denied: the ${channel} subject could not be classified (${subject.resolution}).`,
    };
  }

  if (subject.classification === "synthetic") {
    return {
      ...base,
      decision: "deny",
      allowed: false,
      sink: "sandbox_sink",
      code: "contained_test_record",
      message: `Test record contained: it may not enter the ${channel} flow.`,
    };
  }

  return {
    ...base,
    decision: "allow",
    allowed: true,
    sink: "live",
    code: "permitted",
    message: "Resolved production record permitted.",
  };
}

// ---------------------------------------------------------------------------
// Shipment-less operational events
// ---------------------------------------------------------------------------
//
// A network-wide alert has no shipment. That is a DISTINCT allowlisted contract,
// not the default for a missing shipment: it needs an authenticated admin, an
// allowlisted event name, and no shipment/tracking/business references at all.
export const SHIPMENTLESS_OPERATIONAL_EVENTS: readonly string[] = ["network_alert"];

export interface OperationalEventDecision {
  allowed: boolean;
  code: string;
  message: string;
}

export function evaluateOperationalEvent(input: {
  event: string;
  actor: { role?: string } | null;
  references?: Record<string, unknown>;
}): OperationalEventDecision {
  const event = String(input.event || "");
  if (!SHIPMENTLESS_OPERATIONAL_EVENTS.includes(event)) {
    return {
      allowed: false,
      code: "event_requires_shipment",
      message: `${event || "This event"} requires a resolved shipment reference.`,
    };
  }
  if (!input.actor || input.actor.role !== "admin") {
    return {
      allowed: false,
      code: "operational_event_forbidden",
      message: "A shipment-less operational event requires an authenticated admin.",
    };
  }
  const refs = input.references || {};
  const supplied = Object.entries(refs)
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== "")
    .map(([key]) => key);
  if (supplied.length > 0) {
    return {
      allowed: false,
      code: "operational_event_has_reference",
      message: `A shipment-less operational event must not carry references (${supplied.join(", ")}).`,
    };
  }
  return { allowed: true, code: "operational_event_permitted", message: "Allowlisted operational event." };
}

export interface ContainmentMatrixRow {
  channel: OutboundChannel;
  synthetic_allowed: boolean;
  production_allowed: boolean;
  unknown_allowed: boolean;
  result: string;
}

/** Evidence table: what each classification may do on every outbound channel. */
export function containmentMatrix(): ContainmentMatrixRow[] {
  const make = (classification: SubjectClassification): ResolvedSubject => ({
    classification,
    resolution: classification === "unknown" ? "missing" : "resolved",
    shipment_id: null,
    canonical_shipment_id: null,
    local_merchant_id: null,
    canonical_merchant_id: null,
    test_harness: false,
    reasons: [],
  });
  return OUTBOUND_CHANNELS.map((channel) => {
    const synthetic = evaluateOutboundContainment({ channel, subject: make("synthetic") }).allowed;
    const production = evaluateOutboundContainment({ channel, subject: make("production") }).allowed;
    const unknown = evaluateOutboundContainment({ channel, subject: make("unknown") }).allowed;
    return {
      channel,
      synthetic_allowed: synthetic,
      production_allowed: production,
      unknown_allowed: unknown,
      result: !synthetic && production && !unknown ? "production_only" : "misconfigured",
    };
  });
}