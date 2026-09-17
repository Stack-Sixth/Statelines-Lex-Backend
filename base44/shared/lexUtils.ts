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

export function serviceLevelOk(carrierLevels, required) {
  if (!carrierLevels || carrierLevels.length === 0) return true;
  return carrierLevels.map(normalize).includes(normalize(required));
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

// Event Bus helper — appends an immutable event log entry (best-effort, never throws).
export async function publishEvent(base44, name, payload, correlationId) {
  try {
    await base44.asServiceRole.entities.EventLog.create({
      event_name: name,
      payload: payload || {},
      correlation_id: correlationId || null,
      published_at: nowIso(),
    });
  } catch {
    // event bus is best-effort; never fail the calling service
  }
}