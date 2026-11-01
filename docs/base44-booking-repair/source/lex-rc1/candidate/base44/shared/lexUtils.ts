import {requireOrdinaryEvent} from "./lexEventIsolation.ts";
// LEX shared utilities — geo, scoring, and optimization helpers used across engine services.

export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad((lat2 || 0) - (lat1 || 0));
  const dLng = toRad((lng2 || 0) - (lng1 || 0));
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1 || 0)) * Math.cos(toRad(lat2 || 0)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function normalize(str) {
  return (str || "").toLowerCase().trim();
}

// A carrier "covers" a shipment corridor when its route origin/destination overlap the shipment's.
// Used for RANKING only — eligibility is decided by carrierEligibleForShipment.
export function corridorOverlap(shipOrigin, shipDest, carrierOrigin, carrierDest) {
  const so = normalize(shipOrigin);
  const sd = normalize(shipDest);
  const co = normalize(carrierOrigin);
  const cd = normalize(carrierDest);
  if (!so || !sd || !co || !cd) return 0;
  let score = 0;
  if (so === co || so.includes(co) || co.includes(so)) score += 0.5;
  if (sd === cd || sd.includes(cd) || cd.includes(sd)) score += 0.5;
  return score;
}

// Strict service-level validation. A carrier with no declared service levels is
// NOT treated as eligible — missing required data is not verified eligibility.
export function serviceLevelOk(carrierLevels, required) {
  if (!carrierLevels || carrierLevels.length === 0) return false;
  if (!required) return false;
  return carrierLevels.map(normalize).includes(normalize(required));
}

// Eligibility (hard gate). A carrier must cover BOTH endpoints, or an endpoint
// plus an explicitly supported intermediate stop. A shared origin alone is NOT
// eligibility. Missing endpoint data is NOT eligibility. Returns { ok, reasons }.
export function carrierEligibleForShipment(ship, carrier) {
  if (!ship || !carrier) return { ok: false, reasons: ["missing data"] };
  const so = normalize(ship.origin), sd = normalize(ship.destination);
  const co = normalize(carrier.route_origin), cd = normalize(carrier.route_destination);
  const stops = (carrier.intermediate_stops || []).map(normalize).filter(Boolean);
  if (!so || !sd || !co || !cd) return { ok: false, reasons: ["missing endpoint data"] };
  const originCovered = so === co || so.includes(co) || co.includes(so) || stops.includes(so);
  const destCovered = sd === cd || sd.includes(cd) || cd.includes(sd) || stops.includes(sd);
  const reasons = [];
  if (!originCovered) reasons.push("origin not covered");
  if (!destCovered) reasons.push("destination not covered");
  return { ok: originCovered && destCovered, reasons };
}

// Departure/arrival timing vs shipment deadlines. Returns { ok, reasons }.
export function timingEligible(ship, carrier) {
  const reasons = [];
  const now = Date.now();
  if (carrier.departure_time) {
    const dep = new Date(carrier.departure_time).getTime();
    if (!Number.isNaN(dep) && ship.pickup_deadline) {
      const dl = new Date(ship.pickup_deadline).getTime();
      if (!Number.isNaN(dl) && dep > dl) reasons.push("carrier departs after pickup deadline");
    }
  }
  if (carrier.arrival_time) {
    const arr = new Date(carrier.arrival_time).getTime();
    if (!Number.isNaN(arr) && ship.delivery_deadline) {
      const dl = new Date(ship.delivery_deadline).getTime();
      if (!Number.isNaN(dl) && arr > dl) reasons.push("carrier arrives after delivery deadline");
    }
  }
  return { ok: reasons.length === 0, reasons };
}

export function carrierAvailableCapacityKg(carrier) {
  return Math.max(0, (carrier.capacity_total_kg || 0) - (carrier.capacity_used_kg || 0));
}

// Nearest-neighbor TSP over an array of {lat,lng,label} stops, starting from a depot.
export function nearestNeighborRoute(depot, stops) {
  const remaining = [...stops];
  const route = [];
  let current = depot;
  while (remaining.length) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineKm(current.lat, current.lng, remaining[i].lat, remaining[i].lng);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    current = remaining[bestIdx];
    route.push({ ...remaining[bestIdx], leg_km: Math.round(bestDist * 10) / 10 });
    remaining.splice(bestIdx, 1);
  }
  return route;
}

export function uuid() {
  return "lex-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function nowIso() {
  return new Date().toISOString();
}

// Durable outbox — appends a versioned event envelope to EventLog. THROWS on
// persistence failure (no silent success): callers must either handle the error
// or accept that a failed append leaves the business change without its outbound
// event, to be reconciled by the outbox sweep. The EventLog record id is the
// stable event_id, preserved across retries and replays.
export async function appendToOutbox(base44, { event_type, payload, correlation_id, causation_id, aggregate }) {
  await requireOrdinaryEvent(base44,{event_name:event_type,payload:payload||{},aggregate_type:aggregate?.type||null,aggregate_id:aggregate?.id||null});
  const now = nowIso();
  return await base44.asServiceRole.entities.EventLog.create({
    event_name: event_type,
    payload: payload || {},
    correlation_id: correlation_id || null,
    published_at: now,
    schema_version: 1,
    source: "statelines-lex",
    occurred_at: now,
    causation_id: causation_id || null,
    aggregate_type: aggregate?.type || null,
    aggregate_id: aggregate?.id || null,
    aggregate_version: aggregate?.version ?? null,
  });
}

// Durable event publication — throws on persistence failure (no silent success).
// Prefer appendToOutbox directly when you have aggregate provenance.
export async function publishEvent(base44, name, payload, correlationId?:any) {
  return await appendToOutbox(base44, { event_type: name, payload, correlation_id: correlationId, causation_id: null, aggregate: null });
}