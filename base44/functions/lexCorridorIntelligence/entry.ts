import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import { computeCorridorMetrics } from "../../shared/lexPhase3.ts";
import { nowIso } from "../../shared/lexUtils.ts";

// LEX Phase 3 — Corridor Intelligence. Expands Demand Forecasting into full
// corridor analytics: volume, revenue, margin, utilization, delivery
// performance, delay rate, claims rate, bundle efficiency, monthly trends.
// Read-only.
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    const [shipments, quotes, carriers, custody, fraudAlerts, bundles, forecasts] = [
      await base44.asServiceRole.entities.Shipment.filter({}),
      await base44.asServiceRole.entities.PriceQuote.filter({}),
      await base44.asServiceRole.entities.CommunityCarrier.filter({}),
      await base44.asServiceRole.entities.ChainOfCustodyEvent.filter({}),
      await base44.asServiceRole.entities.FraudAlert.filter({}),
      await base44.asServiceRole.entities.SmartBundle.filter({}),
      await base44.asServiceRole.entities.DemandForecast.filter({}),
    ];

    const corridors = computeCorridorMetrics({
      shipments, quotes, carriers, custody, fraudAlerts, bundles,
    });

    const forecastByCorridor = {};
    for (const f of forecasts) {
      forecastByCorridor[(f.origin || "?") + "|" + (f.destination || "?")] = {
        predicted_volume: f.predicted_volume,
        trend: f.trend,
        confidence: f.confidence_score,
        period: f.period,
      };
    }

    return Response.json({
      generated_at: nowIso(),
      corridors: corridors.map((c) => ({ ...c, forecast: forecastByCorridor[c.corridor] || null })),
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}