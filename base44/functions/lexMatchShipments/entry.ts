import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import {
  corridorOverlap,
  serviceLevelOk,
  carrierAvailableCapacityKg,
  nowIso,
} from "../../shared/lexUtils.ts";

// LEX Match Service — pairs pending shipments with available Community Carriers
// based on corridor, capacity, package size, service level, rating, and travel timing.
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const autoAssign = !!body.auto_assign;
    // Matching reads all pending shipments and carriers system-wide (bypassing RLS) — admin only.
    if (user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });
    const limit = Math.min(body.limit || 50, 200);

    const shipments = await base44.asServiceRole.entities.Shipment.filter({
      status: "pending",
    });
    const carriers = await base44.asServiceRole.entities.CommunityCarrier.filter({
      status: "available",
    });
    // Phase 3 — Carrier Reputation Engine exposes reliability scores to matching.
    const reputations = await base44.asServiceRole.entities.CarrierReputation.filter({});
    const reliabilityByCarrier = {};
    for (const r of reputations) reliabilityByCarrier[r.carrier_id] = r.reliability_score ?? 70;

    const matches = [];
    for (const ship of shipments.slice(0, limit)) {
      for (const carrier of carriers) {
        const corridor = corridorOverlap(
          ship.origin,
          ship.destination,
          carrier.route_origin,
          carrier.route_destination
        );
        if (corridor === 0) continue;
        if (!serviceLevelOk(carrier.service_levels, ship.service_level)) continue;
        if (carrierAvailableCapacityKg(carrier) < (ship.weight_kg || 0)) continue;

        const capacityHeadroom =
          carrierAvailableCapacityKg(carrier) / Math.max(1, carrier.capacity_total_kg || 1);
        const ratingFactor = (carrier.rating || 5) / 5;
        const reputation = reliabilityByCarrier[carrier.id] ?? 70;
        const reputationFactor = reputation / 100;
        const score = Math.round(
          (corridor * 50 + capacityHeadroom * 25 + ratingFactor * 25 + reputationFactor * 10) * 100
        ) / 100;

        matches.push({
          shipment_id: ship.id,
          tracking_id: ship.tracking_id,
          carrier_id: carrier.id,
          carrier_name: carrier.name,
          corridor_score: corridor,
          capacity_headroom: Math.round(capacityHeadroom * 100) / 100,
          rating: carrier.rating,
          reputation_score: reputation,
          match_score: score,
        });
      }
    }

    matches.sort((a, b) => b.match_score - a.match_score);

    let assigned = 0;
    const assignedCarrierIds = new Set();
    const assignedShipmentIds = new Set();
    if (autoAssign) {
      for (const m of matches) {
        if (assignedCarrierIds.has(m.carrier_id)) continue;
        // A shipment may hold several candidate matches — assign it only once per run.
        if (assignedShipmentIds.has(m.shipment_id)) continue;
        const ship = shipments.find((s) => s.id === m.shipment_id);
        if (!ship) continue;
        await base44.asServiceRole.entities.Shipment.update(ship.id, {
          assigned_carrier_id: m.carrier_id,
          status: "matched",
        });
        const carrierRecord = carriers.find((c) => c.id === m.carrier_id);
        await base44.asServiceRole.entities.CommunityCarrier.update(m.carrier_id, {
          status: "assigned",
          // Accumulate on any capacity already in use — never overwrite it.
          capacity_used_kg:
            Math.round(((carrierRecord?.capacity_used_kg || 0) + (ship.weight_kg || 0)) * 100) / 100,
        });
        await base44.asServiceRole.entities.ChainOfCustodyEvent.create({
          shipment_id: ship.id,
          tracking_id: ship.tracking_id,
          event_type: "matched",
          location: ship.origin,
          actor_id: user.id,
          actor_name: "LEX Match Service",
          notes: "Auto-matched to carrier " + m.carrier_name,
          timestamp: nowIso(),
        });
        await base44.asServiceRole.entities.AuditLog.create({
          actor_id: user.id,
          actor_name: user.full_name || "LEX",
          actor_role: user.role,
          action: "shipment.matched",
          entity_type: "Shipment",
          entity_id: ship.id,
          details: "Matched to carrier " + m.carrier_name + " (score " + m.match_score + ")",
          severity: "info",
        });
        assignedCarrierIds.add(m.carrier_id);
        assignedShipmentIds.add(m.shipment_id);
        assigned++;
      }
    }

    return Response.json({
      candidates: matches.length,
      assigned,
      matches: matches.slice(0, 25),
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}