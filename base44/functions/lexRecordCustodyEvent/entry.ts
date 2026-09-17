import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import { nowIso, publishEvent } from "../../shared/lexUtils.ts";

// LEX Custody Service — records a chain-of-custody event, advances shipment status,
// writes an audit entry, and publishes a notification to the relevant party.
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { shipment_id, event_type, location, notes, recipient_type } = body;
    if (!shipment_id || !event_type)
      return Response.json({ error: "shipment_id and event_type required" }, { status: 400 });

    const ship = await base44.asServiceRole.entities.Shipment.get(shipment_id);
    // Only the shipment creator, the assigned carrier, or an admin may record custody events.
    const isOwner = ship?.created_by_id === user.id;
    const isAssignedCarrier = ship?.assigned_carrier_id && ship.assigned_carrier_id === user.id;
    if (!isOwner && !isAssignedCarrier && user.role !== "admin")
      return Response.json({ error: "Forbidden: not authorized for this shipment" }, { status: 403 });

    const event = await base44.asServiceRole.entities.ChainOfCustodyEvent.create({
      shipment_id,
      tracking_id: ship?.tracking_id,
      event_type,
      location: location || ship?.origin,
      lat: body.lat,
      lng: body.lng,
      actor_id: user.id,
      actor_name: body.actor_name || user.full_name || "LEX",
      signature: body.signature,
      notes,
      timestamp: nowIso(),
    });

    const statusMap = {
      picked_up: "picked_up",
      deposited_at_node: "at_node",
      bundled: "in_transit",
      in_transit: "in_transit",
      transfer: "in_transit",
      out_for_delivery: "out_for_delivery",
      delivered: "delivered",
      exception: "flagged",
    };
    const newStatus = statusMap[event_type];
    if (newStatus) {
      await base44.asServiceRole.entities.Shipment.update(shipment_id, { status: newStatus });
    }

    // Keep the assigned carrier's state in sync with the shipment lifecycle.
    if (ship?.assigned_carrier_id) {
      const carrier = await base44.asServiceRole.entities.CommunityCarrier.get(
        ship.assigned_carrier_id
      ).catch(() => null);
      if (carrier) {
        if (event_type === "picked_up") {
          await base44.asServiceRole.entities.CommunityCarrier.update(carrier.id, {
            status: "in_transit",
          });
        }
        if (event_type === "delivered") {
          // Free the shipment's share of the carrier's capacity and return the
          // carrier to the available pool once it has no active shipments left.
          const carrierShipments = await base44.asServiceRole.entities.Shipment.filter({
            assigned_carrier_id: carrier.id,
          });
          const stillActive = carrierShipments.some((s) =>
            ["matched", "picked_up", "in_transit", "at_node", "out_for_delivery"].includes(s.status)
          );
          await base44.asServiceRole.entities.CommunityCarrier.update(carrier.id, {
            capacity_used_kg: Math.max(
              0,
              Math.round(((carrier.capacity_used_kg || 0) - (ship.weight_kg || 0)) * 100) / 100
            ),
            total_deliveries: (carrier.total_deliveries || 0) + 1,
            status: stillActive ? carrier.status : "available",
          });
        }
      }
    }

    // Deliveries are the platform-critical milestone — publish to the event bus
    // so the Platform Bridge syncs them to connected Statelines apps.
    if (event_type === "delivered") {
      await publishEvent(base44, "ShipmentDelivered", {
        shipment_id,
        tracking_id: ship?.tracking_id || null,
        location: location || null,
      });
    }

    await base44.asServiceRole.entities.AuditLog.create({
      actor_id: user.id,
      actor_name: user.full_name || "LEX",
      actor_role: user.role,
      action: "custody." + event_type,
      entity_type: "Shipment",
      entity_id: shipment_id,
      details: "Custody event at " + (location || "unknown"),
      severity: event_type === "exception" ? "warning" : "info",
    });

    const notif = await base44.asServiceRole.entities.Notification.create({
      recipient_type: recipient_type || "merchant",
      recipient_id: ship?.created_by_id,
      channel: "in_app",
      subject: "Shipment " + (ship?.tracking_id || shipment_id) + " — " + event_type.replace(/_/g, " "),
      body: "Status update: " + event_type + (location ? " at " + location : "") + (notes ? ". " + notes : ""),
      status: "sent",
      related_entity_id: shipment_id,
    });

    return Response.json({ event, notification: notif });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}