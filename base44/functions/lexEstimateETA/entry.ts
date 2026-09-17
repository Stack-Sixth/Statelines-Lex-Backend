import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import { haversineKm, publishEvent } from "../../shared/lexUtils.ts";

// LEX ETA Engine — estimates pickup, carrier-arrival, node, and delivery ETAs
// from distance, service-level speed, carrier schedule, and weather/traffic factors.
// Admin or shipment owner.
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    let ship;
    if (body.shipment_id) {
      ship = await base44.asServiceRole.entities.Shipment.get(body.shipment_id);
    } else {
      const recent = await base44.asServiceRole.entities.Shipment.filter({}, "-updated_date", 20);
      ship = recent.find((s) => ["matched", "picked_up", "in_transit", "out_for_delivery"].includes(s.status)) || recent[0];
    }
    if (!ship) return Response.json({ error: "No shipment found" }, { status: 404 });

    const isOwner = ship.created_by_id === user.id;
    if (!isOwner && user.role !== "admin")
      return Response.json({ error: "Forbidden" }, { status: 403 });

    const carrier = ship.assigned_carrier_id
      ? await base44.asServiceRole.entities.CommunityCarrier.get(ship.assigned_carrier_id)
      : null;

    const distance = haversineKm(ship.origin_lat, ship.origin_lng, ship.destination_lat, ship.destination_lng) || 0;
    const speed =
      ship.service_level === "overnight" ? 80 :
      ship.service_level === "same_day" ? 60 :
      ship.service_level === "express" ? 70 : 50; // km/h

    const weather = body.weather_factor || 1;
    const traffic = body.traffic_factor || 1;
    const transitHours = (distance / speed) * weather * traffic;
    const ms = (h) => h * 3600 * 1000;

    const pickupEta = carrier?.departure_time
      ? new Date(carrier.departure_time)
      : new Date(Date.now() + ms(1));
    const carrierArrival = new Date(pickupEta.getTime() + ms(transitHours * 0.5));
    const nodeEta = new Date(pickupEta.getTime() + ms(transitHours * 0.75));
    const deliveryEta = new Date(pickupEta.getTime() + ms(transitHours));

    const factors = {
      distance_km: Math.round(distance * 10) / 10,
      speed_kmh: speed,
      weather_factor: weather,
      traffic_factor: traffic,
    };

    const eta = await base44.asServiceRole.entities.ShipmentETA.create({
      shipment_id: ship.id,
      tracking_id: ship.tracking_id,
      pickup_eta: pickupEta.toISOString(),
      carrier_arrival_eta: carrierArrival.toISOString(),
      node_eta: nodeEta.toISOString(),
      delivery_eta: deliveryEta.toISOString(),
      distance_km: factors.distance_km,
      factors,
      confidence: Math.round((1 - (weather - 1) * 0.2 - (traffic - 1) * 0.2) * 100) / 100,
    });

    await publishEvent(base44, "ETAUpdated", { shipment_id: ship.id, delivery_eta: eta.delivery_eta });

    await base44.asServiceRole.entities.AuditLog.create({
      actor_id: user.id,
      actor_name: user.full_name || "LEX",
      actor_role: user.role,
      action: "eta.updated",
      entity_type: "Shipment",
      entity_id: ship.id,
      details: "Delivery ETA " + eta.delivery_eta + " (conf " + eta.confidence + ")",
      severity: "info",
    });

    return Response.json({ eta });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}