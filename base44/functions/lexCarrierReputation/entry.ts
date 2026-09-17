import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import { computeReputation } from "../../shared/lexPhase3.ts";
import { nowIso, publishEvent } from "../../shared/lexUtils.ts";

// LEX Phase 3 — Carrier Reputation Engine. Computes operational scores from
// existing delivery data (completion, on-time, acceptance, incidents, claims,
// bundle performance) and stores them for the Shipment Matching Engine.
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    const [carriers, shipments, custody, bundles, incidents, fraudAlerts, existing] = [
      await base44.asServiceRole.entities.CommunityCarrier.filter({}),
      await base44.asServiceRole.entities.Shipment.filter({}),
      await base44.asServiceRole.entities.ChainOfCustodyEvent.filter({}),
      await base44.asServiceRole.entities.SmartBundle.filter({}),
      await base44.asServiceRole.entities.Incident.filter({}),
      await base44.asServiceRole.entities.FraudAlert.filter({}),
      await base44.asServiceRole.entities.CarrierReputation.filter({}),
    ];

    const scores = computeReputation({ carriers, shipments, custody, bundles, incidents, fraudAlerts });
    const byCarrier = {};
    for (const e of existing) byCarrier[e.carrier_id] = e;

    let updated = 0;
    let created = 0;
    for (const s of scores) {
      const payload = { ...s, computed_at: nowIso() };
      if (byCarrier[s.carrier_id]) {
        await base44.asServiceRole.entities.CarrierReputation.update(byCarrier[s.carrier_id].id, payload);
        updated++;
      } else {
        await base44.asServiceRole.entities.CarrierReputation.create(payload);
        created++;
      }
    }

    await base44.asServiceRole.entities.AuditLog.create({
      actor_id: user.id,
      actor_name: user.full_name || "LEX",
      actor_role: user.role,
      action: "reputation.computed",
      entity_type: "CarrierReputation",
      entity_id: "-",
      details: "Recomputed reputation for " + scores.length + " carriers (" + updated + " updated, " + created + " created)",
      severity: "info",
    });

    await publishEvent(base44, "lex.reputation_computed", {
      carriers: scores.length,
      avg_reliability:
        scores.length
          ? Math.round(scores.reduce((a, s) => a + s.reliability_score, 0) / scores.length)
          : null,
    });

    return Response.json({ computed: scores.length, updated, created, scores });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}