import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import { publishEvent, nowIso } from "../../shared/lexUtils.ts";

// LEX Wallet Event Service — publishes wallet events (does NOT compute balances;
// the Travel Wallet processes financial transactions). Admin only. Single shipment,
// or batch delivery_approved for all delivered shipments not yet paid.
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const eventType = body.event_type || "delivery_approved";
    const currency = body.currency || "USD";
    const correlationId = body.correlation_id || "wx-" + Date.now().toString(36);

    const targets = [];
    if (body.shipment_id) {
      const ship = await base44.asServiceRole.entities.Shipment.get(body.shipment_id);
      if (ship) targets.push(ship);
    } else {
      const delivered = await base44.asServiceRole.entities.Shipment.filter({ status: "delivered" });
      const paid = await base44.asServiceRole.entities.WalletEvent.filter({ event_type: "delivery_approved" });
      const paidIds = new Set(paid.map((w) => w.related_entity_id).filter(Boolean));
      for (const s of delivered) if (!paidIds.has(s.id)) targets.push(s);
    }

    const events = [];
    for (const s of targets) {
      let amount = body.amount;
      if (amount == null) {
        const quotes = await base44.asServiceRole.entities.PriceQuote.filter({ shipment_id: s.id }, "-created_date", 1);
        amount = quotes[0]?.carrier_compensation || 0;
      }
      const ev = await base44.asServiceRole.entities.WalletEvent.create({
        event_type: eventType,
        carrier_id: s.assigned_carrier_id,
        amount,
        currency,
        related_entity_id: s.id,
        metadata: body.metadata || { tracking_id: s.tracking_id },
        correlation_id: correlationId,
        published_at: nowIso(),
      });
      events.push(ev);
      await publishEvent(base44, "WalletTriggered", { event_type: eventType, shipment_id: s.id, amount }, correlationId);
    }

    if (events.length) {
      await base44.asServiceRole.entities.AuditLog.create({
        actor_id: user.id,
        actor_name: user.full_name || "LEX",
        actor_role: user.role,
        action: "wallet.published",
        entity_type: "WalletEvent",
        entity_id: events[0].id,
        details: "Published " + events.length + " wallet event(s): " + eventType,
        severity: "info",
      });
    }

    return Response.json({ published: events.length, event_type: eventType, events: events.slice(0, 10) });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}