// Shared helpers for the Merchant → Render Domain Platform integration.
// Server-side only. Never import from src/.

import { secrets } from "base44:runtime";
import {
  collectShipmentPages,
  selectExactMatch,
  type CallRenderFn,
} from "./canonicalRead.ts";

const LB_TO_KG = 0.45359237;

// Generate a RFC 4122 v4 UUID for command_id. This is the idempotency key sent
// to Render for a single create-shipment command. It is generated ONCE before
// the first request and persisted on the Shipment row; a retry of the SAME
// operation reuses the SAME command_id. A new shipment gets a new command_id.
export function generateCommandId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Set version (4) and variant bits per RFC 4122.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Validate a command_id is a well-formed UUID. Rejects empty/invalid values
// so a retry cannot accidentally send a malformed key.
export function isValidCommandId(id: unknown): id is string {
  if (typeof id !== "string" || !id) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    id,
  );
}

// Validate and normalize weight. weight_lb is the user input; weight_kg is
// derived and validated to 2 decimal places. Rejects negative/NaN weights.
export function normalizeWeight(
  weightLb: unknown,
): { weight_lb: number; weight_kg: number } | null {
  const lb = Number(weightLb);
  if (!Number.isFinite(lb) || lb < 0 || lb > 10000) return null;
  const kg = Math.round(lb * LB_TO_KG * 100) / 100; // 2dp
  return { weight_lb: Math.round(lb * 100) / 100, weight_kg: kg };
}

// Generate a canonical shipment ID (domain-local, until Render assigns one).
// Format: STL-SHIP-<timestamp36>-<rand36>
export function generateCanonicalShipmentId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `STL-SHIP-${ts}-${rand}`.toUpperCase();
}

// Generate a domain order ID (separate from shipment; an order is the
// domain intent, a shipment is the physical movement).
export function generateOrderId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `STL-ORD-${ts}-${rand}`.toUpperCase();
}

// Correlation ID threads a single request across Merchant/LEX/Render logs.
export function generateCorrelationId(): string {
  return `corr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Idempotency key for submission: deterministic from merchant_id + canonical
// fields, so a retried create with the same payload hits the same key.
export function deriveIdempotencyKey(input: {
  merchant_id?: string;
  origin_address?: string;
  destination_address?: string;
  service_level?: string;
  weight_lb?: number;
  created_date?: string;
}): string {
  const parts = [
    input.merchant_id || "",
    input.origin_address || "",
    input.destination_address || "",
    input.service_level || "",
    String(input.weight_lb ?? ""),
    input.created_date || "",
  ];
  // Simple, deterministic hash (not crypto — just a stable key).
  const str = parts.join("|");
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return `idem-${Math.abs(h).toString(36)}-${str.length.toString(36)}`;
}

// Check if the Render Domain Platform API is configured. Does NOT check if
// the /api/v1/* routes are deployed — that requires a live probe.
// LEX_SERVICE_CLIENT_ID is a client identifier (not a secret); the sensitive
// credential is LEX_SERVICE_CLIENT_SECRET, which stays server-side.
export function isRenderConfigured(): boolean {
  return Boolean(
    secrets.get("LEX_API_URL") &&
    secrets.get("LEX_SERVICE_CLIENT_ID") &&
    secrets.get("LEX_SERVICE_CLIENT_SECRET"),
  );
}

// Map a Merchant Shipment row to Render's POST /api/v1/shipments contract.
// Origin/destination comply with the Render API: { corridor } objects — the
// Render Domain Platform uses corridor (city) semantics, NOT street address.
// We map origin_city -> origin.corridor and destination_city -> destination.corridor.
// Street addresses are NOT sent to Render (they stay on the Merchant Order).
// Does NOT invent canonical_shipment_id or tracking_id — Render generates those.
// command_id must be a valid UUID generated once and persisted on the row.
export interface RenderShipmentPayload {
  command_id: string;
  merchant_id: string;
  order_id: string;
  external_shipment_id?: string;
  correlation_id: string;
  origin: { corridor: string };
  destination: { corridor: string };
  service_level: string;
  package_size: string;
  weight_kg: number;
  pickup_deadline: string;
  delivery_deadline: string;
}

export function mapToRenderShipment(
  ship: {
    command_id?: string;
    merchant_id?: string;
    created_by_id?: string;
    order_id?: string;
    external_shipment_id?: string;
    correlation_id?: string;
    origin_address?: string;
    origin_city?: string;
    destination_address?: string;
    destination_city?: string;
    service_level?: string;
    package_size?: string;
    weight_kg?: number;
    pickup_deadline?: string;
    delivery_deadline?: string;
    drop_off_deadline?: string;
    eta?: string;
  },
  correlationId: string,
): RenderShipmentPayload | null {
  if (!isValidCommandId(ship.command_id)) return null;
  const originCorridor = (ship.origin_city || "").trim();
  const destinationCorridor = (ship.destination_city || "").trim();
  if (!originCorridor || !destinationCorridor) return null;
  const weightKg = Number(ship.weight_kg);
  if (!Number.isFinite(weightKg) || weightKg <= 0) return null;
  const pickupDeadline = ship.pickup_deadline || ship.drop_off_deadline || null;
  const deliveryDeadline = ship.delivery_deadline || ship.eta || null;
  if (!pickupDeadline || !deliveryDeadline || !ship.order_id) return null;
  if (
    !["standard", "express", "same_day", "overnight"].includes(
      String(ship.service_level),
    ) ||
    !["small", "medium", "large", "xl"].includes(String(ship.package_size))
  )
    return null;
  if (
    !Number.isFinite(Date.parse(pickupDeadline)) ||
    !Number.isFinite(Date.parse(deliveryDeadline)) ||
    Date.parse(deliveryDeadline) <= Date.parse(pickupDeadline)
  )
    return null;
  return {
    command_id: ship.command_id,
    merchant_id: ship.merchant_id || ship.created_by_id || "",
    order_id: ship.order_id || "",
    ...(ship.external_shipment_id
      ? { external_shipment_id: ship.external_shipment_id }
      : {}),
    correlation_id: correlationId,
    origin: { corridor: originCorridor },
    destination: { corridor: destinationCorridor },
    service_level: ship.service_level || "standard",
    package_size: ship.package_size || "",
    weight_kg: Math.round(weightKg * 100) / 100,
    pickup_deadline: pickupDeadline,
    delivery_deadline: deliveryDeadline,
  };
}

// ---------------------------------------------------------------------------
// Canonical shipment reconciliation (Merchant → Render Domain Platform)
// ---------------------------------------------------------------------------
//
// Background / contract mismatch this fixes:
//
// POST /api/v1/shipments returns HTTP 201 with a COMMAND-ACCEPTANCE body, e.g.
//   { "status": "accepted", "version": 2 }
// "accepted" is the *command/request* acceptance state, NOT the canonical
// Shipment.status. "version" in that body is the command/version, NOT the
// canonical Shipment.version. Critically, the 201 body does NOT contain
// shipment_id or tracking_id, so the canonical Shipment identity is NOT
// available from the create response.
//
// The canonical Shipment exists on Render after the 201, and is discovered
// through the read API. The first integration test proved:
//   - GET /api/v1/shipments                → list returns the canonical shipment
//   - GET /api/v1/shipments/:shipment_id   → canonical Shipment truth
//
// Reconciliation strategy (safe, read-only, deterministic):
//   1. Try to take canonical IDs directly from the 201 body IF Render included
//      them (future-proof). Never fabricate them.
//   2. If the 201 body has no canonical IDs, read the shipment list scoped by
//      the confirmed read contract:
//        GET /api/v1/shipments?order_id=<encoded order>&limit=50
//        → { items, next_cursor }, paged with after=<next_cursor>
//      order_id is the Merchant Order identity we sent in the create command.
//      Each returned item is still checked for EXACT merchant_id + order_id
//      locally, and exactly one match is required — a filtered read is never
//      trusted as scoping.
//   3. GET /api/v1/shipments/:shipment_id for that one match — the canonical
//      Shipment read is the single source of truth for canonical_shipment_id,
//      tracking_id, domain_status, version, render_id.
//   4. Zero matches  → pending_reconciliation (do NOT re-POST).
//      >1 match      → ambiguous_reconciliation (do NOT re-POST, human review).
//   5. command_id is NEVER regenerated here — it is persisted before the POST
//      and reused on every retry of the same logical creation.
//
// Render API shapes observed:
//   list   → { items: [ { id, shipment_id, tracking_id, merchant_id, order_id,
//                        status, version, ... } ], next_cursor }
//   GET    → { shipment: { id, shipment_id, tracking_id, merchant_id, order_id,
//                        status, version, ... } }
// Some GET responses may also return the shipment at the top level (no
// "shipment" wrapper); we handle both.

export interface CanonicalShipment {
  canonical_shipment_id: string; // Render's shipment_id (SHP_...)
  tracking_id: string; // LEX-...
  render_id: string; // Render row id (UUID)
  domain_status: string; // canonical Shipment.status
  version: number; // canonical Shipment.version
  correlation_id?: string;
  etag?: string;
  sandbox_isolated?: boolean;
}

export type ReconcileResult =
  | { ok: true; canonical: CanonicalShipment }
  | {
      ok: false;
      reason: "not_found" | "ambiguous" | "read_error" | "no_match";
      detail: string;
      matches?: number;
    };

// Extract canonical fields from a create (201) response, if Render included
// them. Returns null when ANY canonical field is missing — the caller must
// NOT invent values; it must fall through to reconcileCanonicalShipment.
export function extractCanonicalFromCreate(
  body: unknown,
): CanonicalShipment | null {
  if (!body || typeof body !== "object") return null;
  const root = body as Record<string, unknown>;
  const b = (
    root.shipment && typeof root.shipment === "object" ? root.shipment : root
  ) as Record<string, unknown>;
  const shipmentId =
    typeof b.shipment_id === "string"
      ? b.shipment_id
      : typeof b.canonical_shipment_id === "string"
        ? b.canonical_shipment_id
        : null;
  const trackingId = typeof b.tracking_id === "string" ? b.tracking_id : null;
  const renderId = typeof b.id === "string" ? b.id : shipmentId;
  const status = typeof b.status === "string" ? b.status : null;
  const version = typeof b.version === "number" ? b.version : null;
  // Only accept as canonical if ALL of the identity + state fields are present
  // AND the status is NOT the command-acceptance marker "accepted" (which we
  // treat as acceptance state, not canonical shipment status).
  if (!shipmentId || !trackingId || !renderId || !status || version === null)
    return null;
  if (status === "accepted") return null; // command-acceptance marker, not canonical
  return {
    canonical_shipment_id: shipmentId,
    tracking_id: trackingId,
    render_id: renderId,
    domain_status: status,
    sandbox_isolated: b.sandbox_isolated === true,
    version,
    correlation_id:
      typeof b.correlation_id === "string" ? b.correlation_id : undefined,
    etag: typeof b.etag === "string" ? b.etag : undefined,
  };
}

function readCanonicalFromListItem(item: unknown): CanonicalShipment | null {
  if (!item || typeof item !== "object") return null;
  const it = item as Record<string, unknown>;
  const shipmentId =
    typeof it.shipment_id === "string"
      ? it.shipment_id
      : typeof it.canonical_shipment_id === "string"
        ? it.canonical_shipment_id
        : null;
  const trackingId = typeof it.tracking_id === "string" ? it.tracking_id : null;
  const renderId = typeof it.id === "string" ? it.id : shipmentId;
  const status = typeof it.status === "string" ? it.status : null;
  const version = typeof it.version === "number" ? it.version : null;
  if (!shipmentId || !trackingId || !renderId || !status || version === null)
    return null;
  return {
    canonical_shipment_id: shipmentId,
    tracking_id: trackingId,
    render_id: renderId,
    domain_status: status,
    sandbox_isolated: it.sandbox_isolated === true,
    version,
    correlation_id:
      typeof it.correlation_id === "string" ? it.correlation_id : undefined,
  };
}

function readCanonicalFromGetBody(
  body: unknown,
  expect?: { merchant_id: string; order_id: string },
): CanonicalShipment | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  // GET wraps the shipment under "shipment"; fall back to top-level if not.
  const target =
    b.shipment && typeof b.shipment === "object" ? b.shipment : body;
  // Defense in depth: the row we read back must still be the intended
  // merchant + order, not merely reachable by id.
  if (expect) {
    const t = target as Record<string, unknown>;
    if (t.merchant_id !== expect.merchant_id) return null;
    if (t.order_id !== expect.order_id) return null;
  }
  return readCanonicalFromListItem(target);
}

// Reconcile canonical Shipment state after a successful POST. Read-only: does
// not mutate Render. `callRender` is injected so this helper stays pure and
// testable — callers pass the shared renderClient.callRender.
export interface DomainCredential {
  client_id: string;
  client_secret: string;
}

export async function reconcileCanonicalShipment(
  callRender: <T = unknown>(opts: {
    method: string;
    path: string;
    timeoutMs?: number;
    credential?: DomainCredential;
  }) => Promise<
    | { ok: true; status: number; data: T; etag?: string }
    | {
        ok: false;
        status: number;
        code: string;
        message: string;
        requestId?: string;
      }
  >,
  input: {
    merchant_id: string;
    order_id: string;
    credential?: DomainCredential;
    requireIsolation?: boolean;
  },
): Promise<ReconcileResult> {
  // Tenant isolation guard: an empty scope would match every shipment on the
  // list, so refuse instead of guessing. Page walking and exact matching live in
  // canonicalRead.ts so both are unit-tested against mocked responses.
  const listing = await collectShipmentPages(
    callRender as unknown as CallRenderFn,
    {
      merchant_id: input.merchant_id,
      order_id: input.order_id,
      credential: input.credential,
    },
  );
  if (!listing.ok) {
    return {
      ok: false,
      reason: "read_error",
      detail: listing.detail,
      matches: 0,
    };
  }
  const match = selectExactMatch(listing.items, {
    merchant_id: input.merchant_id,
    order_id: input.order_id,
  });
  if (!match.ok) {
    return {
      ok: false,
      reason: match.reason,
      detail: match.detail,
      matches: match.matches,
    };
  }
  // We have exactly one. Prefer the list item's canonical fields, but always
  // do the authoritative GET by canonical shipment_id for the canonical truth.
  const listItem = readCanonicalFromListItem(match.item);
  if (!listItem) {
    return {
      ok: false,
      reason: "read_error",
      detail: "List match missing canonical fields",
      matches: 1,
    };
  }

  // Step 3: GET /api/v1/shipments/:shipment_id — canonical Shipment truth.
  const getRes = await callRender<unknown>({
    method: "GET",
    path: `/api/v1/shipments/${encodeURIComponent(listItem.canonical_shipment_id)}`,
    timeoutMs: 10000,
    credential: input.credential,
  });
  if (!getRes.ok) {
    // The list match is still authoritative enough to persist identity, but we
    // cannot confirm canonical status/version without the GET. Report as
    // pending — caller marks pending_reconciliation and does NOT re-POST.
    return {
      ok: false,
      reason: "read_error",
      detail: `GET failed: ${getRes.code}: ${getRes.message}`,
      matches: 1,
    };
  }
  const canonical = readCanonicalFromGetBody(getRes.data, {
    merchant_id: input.merchant_id,
    order_id: input.order_id,
  });
  if (
    !canonical ||
    canonical.canonical_shipment_id !== listItem.canonical_shipment_id ||
    canonical.tracking_id !== listItem.tracking_id ||
    (input.requireIsolation &&
      (match.item.sandbox_isolated !== true ||
        canonical.sandbox_isolated !== true))
  ) {
    return {
      ok: false,
      reason: "read_error",
      detail:
        "GET response missing canonical fields or belongs to another merchant/order",
      matches: 1,
    };
  }
  return {
    ok: true,
    canonical: { ...canonical, etag: getRes.etag || canonical.etag },
  };
}
