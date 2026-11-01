import {resolveLocalOperation} from "../../shared/lexTrustedIsolation.ts";
import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import {
  carrierEligibleForShipment, timingEligible, serviceLevelOk,
  carrierAvailableCapacityKg, corridorOverlap, nowIso,
} from "../../shared/lexUtils.ts";
import { transitionShipment } from "../../shared/lexTransitions.ts";
import { requirePerm } from "../../shared/lexPermissions.ts";

// LEX Match Service — pairs pending shipments with available Community Carriers.
// Eligibility (hard gate) is separated from ranking: a shared origin alone is not
// eligibility; both endpoints (or an intermediate stop), service level, package
// size, timing, and capacity are all validated. Auto-assign routes through the
// transition service so two runs cannot overwrite reservations or assign the same
// shipment twice (matched → matched is rejected; a duplicate command_id is a no-op).
const PACKAGE_OK = { small: ["bike", "walker", "sedan", "suv", "van", "truck"], medium: ["sedan", "suv", "van", "truck"], large: ["suv", "van", "truck"], xl: ["van", "truck"] };

function packageEligible(ship, carrier) {
  const allowed = PACKAGE_OK[ship.package_size] || null;
  if (!allowed) return { ok: true, reasons: [] };
  if (!carrier.vehicle_type) return { ok: false, reasons: ["carrier vehicle type unknown"] };
  return { ok: allowed.includes(carrier.vehicle_type), reasons: allowed.includes(carrier.vehicle_type) ? [] : ["vehicle cannot carry " + ship.package_size] };
}

function eligibility(ship, carrier) {
  const checks = [
    { name: "corridor", ...carrierEligibleForShipment(ship, carrier) },
    { name: "service_level", ok: serviceLevelOk(carrier.service_levels, ship.service_level), reasons: serviceLevelOk(carrier.service_levels, ship.service_level) ? [] : ["service level not supported"] },
    { name: "package", ...packageEligible(ship, carrier) },
    { name: "timing", ...timingEligible(ship, carrier) },
    { name: "capacity", ok: carrierAvailableCapacityKg(carrier) >= (ship.weight_kg || 0), reasons: carrierAvailableCapacityKg(carrier) >= (ship.weight_kg || 0) ? [] : ["insufficient capacity"] },
  ];
  const failed = checks.filter((c) => !c.ok).map((c) => c.name + ": " + c.reasons.join("; "));
  return { ok: checks.every((c) => c.ok), failed, checks };
}

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const denied = await requirePerm(base44, user, "match_shipments");
    if (denied) return denied;

    const body = await req.json().catch(() => ({}));
    const autoAssign = !!body.auto_assign;
    const limit = Math.min(body.limit || 50, 200);

    const shipments = (await base44.asServiceRole.entities.Shipment.filter({ status: "pending" })).slice(0, limit);
    const carriers = await base44.asServiceRole.entities.CommunityCarrier.filter({ status: "available" });
    const reputations = await base44.asServiceRole.entities.CarrierReputation.filter({});
    const reliabilityByCarrier = {};
    for (const r of reputations) reliabilityByCarrier[r.carrier_id] = r.reliability_score ?? 70;

    const matches = [];
    for (const ship of shipments) {
      if((await resolveLocalOperation(base44,'Shipment',ship)).kind!=='ordinary'||ship.lex_effects_pending)continue;
      for (const carrier of carriers) {
        const elig = eligibility(ship, carrier);
        if (!elig.ok) continue;
        const corridor = corridorOverlap(ship.origin, ship.destination, carrier.route_origin, carrier.route_destination);
        const capacityHeadroom = carrierAvailableCapacityKg(carrier) / Math.max(1, carrier.capacity_total_kg || 1);
        const ratingFactor = (carrier.rating || 5) / 5;
        const reputationFactor = (reliabilityByCarrier[carrier.id] ?? 70) / 100;
        const score = Math.round((corridor * 50 + capacityHeadroom * 25 + ratingFactor * 25 + reputationFactor * 10) * 100) / 100;
        matches.push({
          shipment_id: ship.id, tracking_id: ship.tracking_id, carrier_id: carrier.id, carrier_name: carrier.name,
          corridor_score: corridor, capacity_headroom: Math.round(capacityHeadroom * 100) / 100,
          rating: carrier.rating, reputation_score: reliabilityByCarrier[carrier.id] ?? 70,
          match_score: score, eligibility: elig.checks,
        });
      }
    }
    matches.sort((a, b) => b.match_score - a.match_score);

    let assigned = 0;
    const assignedShipmentIds = new Set();
    const assignedCarrierIds = new Set();
    if (autoAssign) {
      for (const m of matches) {
        if (assignedCarrierIds.has(m.carrier_id) || assignedShipmentIds.has(m.shipment_id)) continue;
        const ship = shipments.find((s) => s.id === m.shipment_id);
        if (!ship) continue;
        // Deterministic command_id: a repeat of the same shipment+carrier assignment
        // is a no-op; a different shipment state is rejected by the transition matrix.
        const command_id = `match:${ship.id}:${m.carrier_id}`;
        const res = await transitionShipment(base44, {
          shipment_id: ship.id,expected_version:ship.version||1, command_id, to_status: "matched",
          assign_carrier_id: m.carrier_id,
          custody: { event_type: "matched", location: ship.origin, notes: "Auto-matched to carrier " + m.carrier_name },
          trigger_source: "engine", responsible_entity: "LEX Match Service",
          actor: user, note: "Auto-matched to " + m.carrier_name + " (score " + m.match_score + ")",
          event_payload: { carrier_id: m.carrier_id, carrier_name: m.carrier_name, match_score: m.match_score, eligibility: m.eligibility },
        });
        if (res.ok && !res.idempotent) {
          assignedShipmentIds.add(m.shipment_id);
          assignedCarrierIds.add(m.carrier_id);
          assigned++;
        }
      }
    }

    return Response.json({ candidates: matches.length, assigned, matches: matches.slice(0, 25) });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}