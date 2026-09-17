import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import { haversineKm } from "../../shared/lexUtils.ts";

// LEX Smart Node Service — recommends the best deposit/pickup node for a shipment
// based on proximity to origin/destination, available capacity, and utilization.
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const shipmentId = body.shipment_id;
    if (!shipmentId) return Response.json({ error: "shipment_id required" }, { status: 400 });

    const ship = await base44.asServiceRole.entities.Shipment.get(shipmentId);
    // Only the shipment creator, assigned carrier, or an admin may recommend/assign a node.
    const isOwner = ship?.created_by_id === user.id;
    const isAssignedCarrier = ship?.assigned_carrier_id && ship.assigned_carrier_id === user.id;
    if (!isOwner && !isAssignedCarrier && user.role !== "admin")
      return Response.json({ error: "Forbidden: not authorized for this shipment" }, { status: 403 });

    const nodes = await base44.asServiceRole.entities.SmartNode.filter({});

    const ranked = nodes
      .map((n) => {
        const distOrigin = haversineKm(ship.origin_lat, ship.origin_lng, n.lat, n.lng);
        const distDest = haversineKm(
          ship.destination_lat,
          ship.destination_lng,
          n.lat,
          n.lng
        );
        const proximity = distOrigin + distDest;
        const capacityFree = Math.max(0, (n.capacity_total || 0) - (n.capacity_used || 0));
        const capacityRatio =
          (n.capacity_total || 0) > 0 ? capacityFree / n.capacity_total : 0;
        // Lower proximity + higher free capacity = better score.
        const score = Math.round((capacityRatio * 60 - proximity * 0.4) * 100) / 100;
        return {
          node_id: n.id,
          name: n.name,
          type: n.type,
          address: n.address,
          distance_from_origin_km: Math.round(distOrigin * 10) / 10,
          distance_from_destination_km: Math.round(distDest * 10) / 10,
          free_capacity: capacityFree,
          utilization_score: n.utilization_score,
          recommendation_score: score,
        };
      })
      .sort((a, b) => b.recommendation_score - a.recommendation_score);

    const best = ranked[0];
    if (best) {
      await base44.asServiceRole.entities.Shipment.update(shipmentId, {
        smart_node_id: best.node_id,
      });
      await base44.asServiceRole.entities.AuditLog.create({
        actor_id: user.id,
        actor_name: user.full_name || "LEX",
        actor_role: user.role,
        action: "node.recommended",
        entity_type: "Shipment",
        entity_id: shipmentId,
        details: "Recommended node " + best.name,
        severity: "info",
      });
    }

    return Response.json({ shipment_id: shipmentId, recommended: best, alternatives: ranked.slice(1, 5) });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}