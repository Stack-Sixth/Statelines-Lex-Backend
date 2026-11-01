import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import { nowIso } from "../../shared/lexUtils.ts";
import { transitionShipment, STAGE_TO_STATUS } from "../../shared/lexTransitions.ts";
import { requirePerm } from "../../shared/lexPermissions.ts";
import {resolveTrustedIsolation, isolationDenied, operationalLocal} from "../../shared/lexTrustedIsolation.ts";

// LEX Lifecycle Engine — LEX is the authoritative source for shipment state.
// "transition" routes every stage change through the unified transition service.
// "timeline" returns per-shipment history. "sync" backfills the Created stage for
// shipments that predate the engine.
const STAGES = Object.keys(STAGE_TO_STATUS);

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const denied = await requirePerm(base44, user, "transition_shipment");
    if (denied) return denied;

    const body = await req.json().catch(() => ({}));

    const op = body.op || "timeline";

    if (op === "transition") {
      const stage = body.stage;
      if (stage && !STAGES.includes(stage))
        return Response.json({ error: "Invalid stage", stages: STAGES }, { status: 400 });
      const toStatus = body.to_status || STAGE_TO_STATUS[stage];
      if (!toStatus) return Response.json({ error: "stage or to_status required" }, { status: 400 });

      const classification = await resolveTrustedIsolation(base44, body);
      const denied = isolationDenied(classification); if (denied) return denied;
      const resolved = await operationalLocal(base44,classification);
      if (!resolved) return Response.json({code:"local_shipment_unresolved"},{status:409});
      const res = await transitionShipment(base44, {
        shipment_id: resolved.id, tracking_id: resolved.tracking_id,
        command_id: body.command_id, to_status: toStatus, force: !!body.force,
        assign_carrier_id: body.assign_carrier_id,
        trigger_source: body.trigger_source || "operator",
        // responsible_entity is derived server-side from the authenticated actor
        // inside transitionShipment — not from client-supplied body.responsible_entity.
        actor: user, note: body.note || null, correlation_id: body.correlation_id,
        custody: body.custody || null, event_name: body.event_name, event_payload: body.event_payload,
      });
      if (!res.ok) return Response.json({ error: res.error, code: res.code }, { status: res.code || 500 });
      return Response.json(res);
    }

    if (op === "sync") {
      const shipments = await base44.asServiceRole.entities.Shipment.list("-created_date", 500);
      const existing = await base44.asServiceRole.entities.ShipmentLifecycleEvent.list("-created_date", 500);
      const covered = new Set(existing.map((e) => e.shipment_id));
      let backfilled = 0;
      for (const s of shipments) {
        if (covered.has(s.id)) continue;
        const classification = await resolveTrustedIsolation(base44,{shipment_id:s.id,tracking_id:s.tracking_id});
        if (classification.kind !== "ordinary") continue;
        await base44.asServiceRole.entities.ShipmentLifecycleEvent.create({
          shipment_id: s.id, tracking_id: s.tracking_id, stage: "created", previous_stage: null,
          from_status: null, to_status: s.status || "pending",
          trigger_source: "system", responsible_entity: "lifecycle sync",
          note: "backfilled from shipment record", timestamp: s.created_date || nowIso(),
        });
        backfilled++;
      }
      await base44.asServiceRole.entities.AuditLog.create({
        actor_id: user.id, actor_name: user.full_name || "LEX", actor_role: user.role,
        action: "lifecycle.sync", entity_type: "Shipment", entity_id: "-",
        details: "Backfilled Created stage for " + backfilled + " shipments", severity: "info",
      });
      return Response.json({ backfilled });
    }

    // timeline
    let events;
    if (body.shipment_id) events = await base44.asServiceRole.entities.ShipmentLifecycleEvent.filter({ shipment_id: body.shipment_id });
    else if (body.tracking_id) events = await base44.asServiceRole.entities.ShipmentLifecycleEvent.filter({ tracking_id: body.tracking_id });
    else return Response.json({ error: "shipment_id or tracking_id required" }, { status: 400 });
    events.sort((a, b) => new Date(a.timestamp || a.created_date).getTime() - new Date(b.timestamp || b.created_date).getTime());

    let shipment = null;
    if (events.length) shipment = await base44.asServiceRole.entities.Shipment.get(events[0].shipment_id).catch(() => null);
    else if (body.tracking_id) {
      const found = await base44.asServiceRole.entities.Shipment.filter({ tracking_id: body.tracking_id });
      shipment = found[0] || null;
    }
    return Response.json({ stages: STAGES, events, shipment });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

