import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import { nowIso, publishEvent } from "../../shared/lexUtils.ts";

// LEX Phase 3 — Shipment Lifecycle Engine. LEX is the authoritative source for
// shipment state transitions. Ops: "transition" (record a stage change with full
// provenance), "timeline" (searchable per-shipment history), "sync" (backfill
// the Created stage for shipments that predate the engine).
const STAGES = [
  "created", "accepted", "merchant_dropoff", "exchange_partner_intake",
  "bundle_assigned", "carrier_assigned", "in_transit", "arrival",
  "last_mile_assigned", "delivered", "returned", "cancelled", "exception",
];

const STAGE_STATUS = {
  carrier_assigned: "matched",
  in_transit: "in_transit",
  arrival: "at_node",
  last_mile_assigned: "out_for_delivery",
  delivered: "delivered",
  cancelled: "cancelled",
  returned: "flagged",
  exception: "flagged",
};

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const op = body.op || "timeline";

    if (op === "transition") {
      const stage = body.stage;
      if (!STAGES.includes(stage))
        return Response.json({ error: "Invalid stage", stages: STAGES }, { status: 400 });

      let ship = body.shipment_id
        ? await base44.asServiceRole.entities.Shipment.get(body.shipment_id).catch(() => null)
        : null;
      if (!ship && body.tracking_id) {
        const found = await base44.asServiceRole.entities.Shipment.filter({ tracking_id: body.tracking_id });
        ship = found[0];
      }
      if (!ship) return Response.json({ error: "Shipment not found" }, { status: 404 });

      const prev = await base44.asServiceRole.entities.ShipmentLifecycleEvent.filter({ shipment_id: ship.id });
      prev.sort((a, b) => new Date(a.timestamp || a.created_date) - new Date(b.timestamp || b.created_date));
      const previous_stage = prev.length ? prev[prev.length - 1].stage : null;

      const audit = await base44.asServiceRole.entities.AuditLog.create({
        actor_id: user.id,
        actor_name: user.full_name || "LEX",
        actor_role: user.role,
        action: "lifecycle.transition",
        entity_type: "Shipment",
        entity_id: ship.id,
        details:
          "Shipment " + (ship.tracking_id || ship.id) + ": " + (previous_stage || "—") + " → " + stage +
          (body.note ? " (" + body.note + ")" : ""),
        severity: "info",
      });

      const event = await base44.asServiceRole.entities.ShipmentLifecycleEvent.create({
        shipment_id: ship.id,
        tracking_id: ship.tracking_id,
        stage,
        previous_stage,
        trigger_source: body.trigger_source || "operator",
        responsible_entity: body.responsible_entity || user.full_name || user.email || "console",
        note: body.note || null,
        audit_ref: audit.id,
        timestamp: nowIso(),
      });

      if (STAGE_STATUS[stage]) {
        await base44.asServiceRole.entities.Shipment.update(ship.id, { status: STAGE_STATUS[stage] });
      }

      await publishEvent(base44, "lex.lifecycle_transition", {
        shipment_id: ship.id,
        tracking_id: ship.tracking_id,
        stage,
        previous_stage,
      });

      return Response.json({ event, shipment_status: STAGE_STATUS[stage] || ship.status });
    }

    if (op === "sync") {
      const shipments = await base44.asServiceRole.entities.Shipment.list("-created_date", 500);
      const existing = await base44.asServiceRole.entities.ShipmentLifecycleEvent.list("-created_date", 500);
      const covered = new Set(existing.map((e) => e.shipment_id));
      let backfilled = 0;
      for (const s of shipments) {
        if (covered.has(s.id)) continue;
        await base44.asServiceRole.entities.ShipmentLifecycleEvent.create({
          shipment_id: s.id,
          tracking_id: s.tracking_id,
          stage: "created",
          previous_stage: null,
          trigger_source: "system",
          responsible_entity: "lifecycle sync",
          note: "backfilled from shipment record",
          timestamp: s.created_date || nowIso(),
        });
        backfilled++;
      }
      await base44.asServiceRole.entities.AuditLog.create({
        actor_id: user.id,
        actor_name: user.full_name || "LEX",
        actor_role: user.role,
        action: "lifecycle.sync",
        entity_type: "Shipment",
        entity_id: "-",
        details: "Backfilled Created stage for " + backfilled + " shipments",
        severity: "info",
      });
      return Response.json({ backfilled });
    }

    // timeline
    let events;
    if (body.shipment_id) {
      events = await base44.asServiceRole.entities.ShipmentLifecycleEvent.filter({ shipment_id: body.shipment_id });
    } else if (body.tracking_id) {
      events = await base44.asServiceRole.entities.ShipmentLifecycleEvent.filter({ tracking_id: body.tracking_id });
    } else {
      return Response.json({ error: "shipment_id or tracking_id required" }, { status: 400 });
    }
    events.sort((a, b) => new Date(a.timestamp || a.created_date) - new Date(b.timestamp || b.created_date));

    let shipment = null;
    if (events.length) {
      shipment = await base44.asServiceRole.entities.Shipment.get(events[0].shipment_id).catch(() => null);
    } else if (body.tracking_id) {
      const found = await base44.asServiceRole.entities.Shipment.filter({ tracking_id: body.tracking_id });
      shipment = found[0] || null;
    }

    return Response.json({ stages: STAGES, events, shipment });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}