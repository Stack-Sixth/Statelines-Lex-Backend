import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import { nowIso, publishEvent } from "../../shared/lexUtils.ts";

// LEX Manual Override Framework — records controlled operator overrides of engine decisions.
// Every override requires a reason, is stored, audit-logged, and published to the event bus.
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    if (!body.override_type) return Response.json({ error: "override_type required" }, { status: 400 });
    if (!body.reason || !String(body.reason).trim()) return Response.json({ error: "reason required" }, { status: 400 });

    const override = await base44.asServiceRole.entities.ManualOverride.create({
      override_type: body.override_type,
      entity_id: body.entity_id || null,
      reason: String(body.reason).trim(),
      operator_id: user.id,
      operator_name: user.full_name || user.email || "operator",
      original_decision: body.original_decision || {},
      replacement_decision: body.replacement_decision || {},
      timestamp: nowIso(),
    });

    await base44.asServiceRole.entities.AuditLog.create({
      actor_id: user.id,
      actor_name: user.full_name || "LEX",
      actor_role: user.role,
      action: "decision.override",
      entity_type: "ManualOverride",
      entity_id: override.id,
      details: body.override_type + " override: " + String(body.reason).trim().slice(0, 200),
      severity: "warning",
    });

    await publishEvent(base44, "lex.manual_override", {
      override_id: override.id,
      override_type: override.override_type,
      entity_id: override.entity_id,
    });

    return Response.json({ override_id: override.id, recorded: true });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}