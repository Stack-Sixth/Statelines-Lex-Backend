import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import { computeMerchantMetrics } from "../../shared/lexPhase3.ts";
import { nowIso } from "../../shared/lexUtils.ts";

// LEX Phase 3 — Merchant Intelligence. Read-only operational metrics per merchant
// (volume, growth, processing time, claims, packaging compliance, reliability)
// computed from existing shipment data for use by LEX decision engines.
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    const [shipments, custody, fraudAlerts, weightRules, existing] = [
      await base44.asServiceRole.entities.Shipment.filter({}),
      await base44.asServiceRole.entities.ChainOfCustodyEvent.filter({}),
      await base44.asServiceRole.entities.FraudAlert.filter({}),
      await base44.asServiceRole.entities.OperationalRule.filter({ rule_type: "weight_limit", enabled: true }),
      await base44.asServiceRole.entities.MerchantProfile.filter({}),
    ];

    const maxWeightKg =
      weightRules.flatMap((r) => Object.values(r.parameters || {})).find((v) => typeof v === "number") || 68;

    const metrics = computeMerchantMetrics({ shipments, custody, fraudAlerts, maxWeightKg });
    const byName = {};
    for (const e of existing) byName[e.merchant_name] = e;

    for (const m of metrics) {
      const payload = { ...m, computed_at: nowIso() };
      if (byName[m.merchant_name]) {
        await base44.asServiceRole.entities.MerchantProfile.update(byName[m.merchant_name].id, payload);
      } else {
        await base44.asServiceRole.entities.MerchantProfile.create(payload);
      }
    }

    await base44.asServiceRole.entities.AuditLog.create({
      actor_id: user.id,
      actor_name: user.full_name || "LEX",
      actor_role: user.role,
      action: "merchant_intelligence.computed",
      entity_type: "MerchantProfile",
      entity_id: "-",
      details: "Computed intelligence for " + metrics.length + " merchants",
      severity: "info",
    });

    return Response.json({ computed: metrics.length, merchants: metrics });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}