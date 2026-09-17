import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";

// LEX Demand Forecast Service — aggregates historical shipments by corridor and
// uses an LLM to forecast volume, trend, confidence, and peak windows.
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    // Demand forecasting reads all shipments and writes DemandForecast records — admin only.
    if (user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const horizon = body.horizon || "next_7_days";

    const shipments = await base44.asServiceRole.entities.Shipment.filter({});
    const corridors = {};
    for (const s of shipments) {
      const key = (s.origin || "?") + " → " + (s.destination || "?");
      if (!corridors[key]) corridors[key] = { origin: s.origin, destination: s.destination, count: 0 };
      corridors[key].count++;
    }
    const corridorStats = Object.entries(corridors)
      .map(([corridor, v]) => ({ corridor, ...v }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);

    const prompt =
      "You are the demand forecasting module of a logistics orchestration engine. " +
      "Given historical shipment counts per corridor, forecast volume for " +
      horizon +
      ". Return JSON array of {corridor, origin, destination, predicted_volume, confidence_score (0-1), trend (rising|stable|declining), peak_window}. " +
      "Historical data: " + JSON.stringify(corridorStats);

    const llm = await base44.asServiceRole.integrations.Core.InvokeLLM({
      prompt,
      response_json_schema: {
        type: "object",
        properties: {
          forecasts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                corridor: { type: "string" },
                origin: { type: "string" },
                destination: { type: "string" },
                predicted_volume: { type: "number" },
                confidence_score: { type: "number" },
                trend: { type: "string" },
                peak_window: { type: "string" },
              },
            },
          },
        },
      },
    });

    const forecasts = llm.forecasts || [];
    const created = [];
    for (const f of forecasts.slice(0, 12)) {
      const rec = await base44.asServiceRole.entities.DemandForecast.create({
        corridor: f.corridor,
        origin: f.origin,
        destination: f.destination,
        period: horizon,
        predicted_volume: f.predicted_volume,
        confidence_score: f.confidence_score,
        trend: f.trend,
        peak_window: f.peak_window,
      });
      created.push(rec);
    }

    await base44.asServiceRole.entities.AuditLog.create({
      actor_id: user.id,
      actor_name: user.full_name || "LEX",
      actor_role: user.role,
      action: "demand.forecasted",
      entity_type: "DemandForecast",
      entity_id: "-",
      details: "Generated " + created.length + " corridor forecasts for " + horizon,
      severity: "info",
    });

    return Response.json({ horizon, corridors_analyzed: corridorStats.length, forecasts: created });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}