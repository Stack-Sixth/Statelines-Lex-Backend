import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import { publishEvent } from "../../shared/lexUtils.ts";

// LEX Decision Engine — records every significant operational decision made by the engine,
// stored separately from audit logs, for search, review, and AI transparency.
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    if (!body.decision_type) return Response.json({ error: "decision_type required" }, { status: 400 });

    const decision = await base44.asServiceRole.entities.Decision.create({
      decision_type: body.decision_type,
      shipment_id: body.shipment_id || null,
      tracking_id: body.tracking_id || null,
      inputs_evaluated: body.inputs_evaluated || {},
      rules_applied: body.rules_applied || [],
      ai_recommendation: body.ai_recommendation || null,
      confidence: body.confidence ?? null,
      final_decision: body.final_decision || {},
      decision_source: body.decision_source || "rules",
      processing_ms: body.processing_ms ?? null,
      summary: body.summary || "",
      alternatives: body.alternatives || [],
      explanation: body.explanation || "",
      correlation_id: body.correlation_id || null,
    });

    await publishEvent(base44, "lex.decision_recorded", {
      decision_id: decision.id,
      decision_type: decision.decision_type,
      decision_source: decision.decision_source,
    }, decision.correlation_id);

    await base44.asServiceRole.entities.AuditLog.create({
      actor_id: user.id,
      actor_name: user.full_name || "LEX",
      actor_role: user.role,
      action: "decision.record",
      entity_type: "Decision",
      entity_id: decision.id,
      details: decision.decision_type + " decision recorded",
      severity: "info",
    });

    return Response.json({ decision_id: decision.id, recorded: true });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}