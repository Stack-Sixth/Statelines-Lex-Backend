import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import { nowIso } from "../../shared/lexUtils.ts";

// LEX Phase 3 — Recommendation Analytics. Aggregates AI recommendation
// performance: generated / accepted / rejected / ignored, confidence trends,
// and breakdown by decision type. Read-only.
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    const decisions = await base44.asServiceRole.entities.Decision.list("-created_date", 500);

    const bySource = { rules: 0, ai: 0, manual_override: 0 };
    const byStatus = { pending: 0, accepted: 0, rejected: 0, ignored: 0 };
    const byType = {};
    let confidenceSum = 0;
    let confidenceCount = 0;
    const dayBuckets = {};

    for (const d of decisions) {
      bySource[d.decision_source || "rules"]++;
      byStatus[d.recommendation_status || "pending"]++;
      byType[d.decision_type] = (byType[d.decision_type] || 0) + 1;
      if (d.confidence != null) {
        confidenceSum += d.confidence;
        confidenceCount++;
        const day = (d.created_date || "").slice(0, 10);
        (dayBuckets[day] ||= { sum: 0, count: 0 });
        dayBuckets[day].sum += d.confidence;
        dayBuckets[day].count += 1;
      }
    }

    const confidenceTrend = Object.entries(dayBuckets)
      .sort()
      .slice(-14)
      .map(([day, b]) => ({ day, avg_confidence: Math.round((b.sum / b.count) * 1000) / 10 }));

    return Response.json({
      generated_at: nowIso(),
      total_decisions: decisions.length,
      by_source: bySource,
      by_recommendation_status: byStatus,
      avg_confidence: confidenceCount
        ? Math.round((confidenceSum / confidenceCount) * 1000) / 10
        : null,
      confidence_trend: confidenceTrend,
      by_decision_type: Object.entries(byType)
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count),
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}