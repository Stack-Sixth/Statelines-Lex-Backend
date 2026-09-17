import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import { publishEvent, nowIso } from "../../shared/lexUtils.ts";

// LEX Rewards Event Service — publishes reward events (does NOT compute rewards;
// the Rewards Platform performs calculations). Admin only. Single shipment, or
// batch delivery_completed for all delivered shipments not yet rewarded.
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const eventType = body.event_type || "delivery_completed";
    const correlationId = body.correlation_id || "rex-" + Date.now().toString(36);

    const targets = [];
    if (body.shipment_id) {
      const ship = await base44.asServiceRole.entities.Shipment.get(body.shipment_id);
      if (ship) targets.push(ship);
    } else {
      const delivered = await base44.asServiceRole.entities.Shipment.filter({ status: "delivered" });
      const rewarded = await base44.asServiceRole.entities.RewardEvent.filter({ event_type: "delivery_completed" });
      const rewardedIds = new Set(rewarded.map((r) => r.shipment_id).filter(Boolean));
      for (const s of delivered) if (!rewardedIds.has(s.id)) targets.push(s);
    }

    const events = [];
    for (const s of targets) {
      const ev = await base44.asServiceRole.entities.RewardEvent.create({
        event_type: eventType,
        shipment_id: s.id,
        carrier_id: s.assigned_carrier_id,
        merchant_id: s.created_by_id,
        metadata: body.metadata || { tracking_id: s.tracking_id },
        correlation_id: correlationId,
        published_at: nowIso(),
      });
      events.push(ev);
      await publishEvent(base44, "RewardTriggered", { event_type: eventType, shipment_id: s.id }, correlationId);
    }

    if (events.length) {
      await base44.asServiceRole.entities.AuditLog.create({
        actor_id: user.id,
        actor_name: user.full_name || "LEX",
        actor_role: user.role,
        action: "reward.published",
        entity_type: "RewardEvent",
        entity_id: events[0].id,
        details: "Published " + events.length + " reward event(s): " + eventType,
        severity: "info",
      });
    }

    return Response.json({ published: events.length, event_type: eventType, events: events.slice(0, 10) });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}