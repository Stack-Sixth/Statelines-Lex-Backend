import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import { nearestNeighborRoute, haversineKm } from "../../shared/lexUtils.ts";

// LEX Route Optimization Service — computes an optimized stop order for a bundle
// using nearest-neighbor TSP and returns total distance + leg breakdown.
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    // Route optimization mutates SmartBundle state — admin only.
    if (user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const bundleId = body.bundle_id;
    if (!bundleId) return Response.json({ error: "bundle_id required" }, { status: 400 });

    const bundle = await base44.asServiceRole.entities.SmartBundle.filter({ bundle_id: bundleId });
    if (!bundle.length) return Response.json({ error: "Bundle not found" }, { status: 404 });
    const b = bundle[0];

    const shipments = await base44.asServiceRole.entities.Shipment.filter({ bundle_id: bundleId });
    const carrier = b.carrier_id
      ? await base44.asServiceRole.entities.CommunityCarrier.get(b.carrier_id)
      : null;

    const depot = carrier
      ? { lat: carrier.current_lat, lng: carrier.current_lng, label: carrier.current_location || "Depot" }
      : { lat: shipments[0]?.origin_lat, lng: shipments[0]?.origin_lng, label: "Depot" };

    const stops = shipments
      .map((s) => ({
        lat: s.destination_lat,
        lng: s.destination_lng,
        label: s.destination,
        tracking_id: s.tracking_id,
      }))
      .filter((s) => s.lat != null && s.lng != null);

    const route = nearestNeighborRoute(depot, stops);
    let totalKm = 0;
    for (const leg of route) totalKm += leg.leg_km || 0;

    await base44.asServiceRole.entities.SmartBundle.update(b.id, {
      optimized_route: route,
      status: "in_transit",
    });

    await base44.asServiceRole.entities.AuditLog.create({
      actor_id: user.id,
      actor_name: user.full_name || "LEX",
      actor_role: user.role,
      action: "route.optimized",
      entity_type: "SmartBundle",
      entity_id: b.id,
      details: "Optimized route: " + route.length + " stops, " + Math.round(totalKm) + " km",
      severity: "info",
    });

    return Response.json({
      bundle_id: bundleId,
      depot: depot.label,
      stop_order: route,
      total_distance_km: Math.round(totalKm * 10) / 10,
      stop_count: route.length,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}