import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import { nowIso, publishEvent } from "../../shared/lexUtils.ts";

// LEX Phase 3 — Learning Feedback Engine. Compares engine predictions against
// actual outcomes (ETA, demand forecast, matching, bundle efficiency, pricing),
// stores accuracy records for trend analysis, and feeds the AI services.
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    const DAY = 86400000;
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - 30 * DAY);
    const iso = (d) => d.toISOString();

    const [etas, custody, shipments, forecasts, bundles] = [
      await base44.asServiceRole.entities.ShipmentETA.filter({}),
      await base44.asServiceRole.entities.ChainOfCustodyEvent.filter({}),
      await base44.asServiceRole.entities.Shipment.filter({}),
      await base44.asServiceRole.entities.DemandForecast.filter({}),
      await base44.asServiceRole.entities.SmartBundle.filter({}),
    ];

    const records = [];

    // ETA accuracy — predicted delivery ETA vs actual custody delivery event
    const deliveredByShipment = {};
    for (const e of custody) {
      if (e.event_type === "delivered" && e.shipment_id) deliveredByShipment[e.shipment_id] = e;
    }
    const etaSamples = [];
    for (const eta of etas) {
      const actual = deliveredByShipment[eta.shipment_id];
      if (!actual || !eta.delivery_eta) continue;
      const errorHours = (new Date(actual.timestamp) - new Date(eta.delivery_eta)) / 3600000;
      etaSamples.push({ abs: Math.abs(errorHours), late: errorHours > 0 });
    }
    if (etaSamples.length) {
      const meanAbs = etaSamples.reduce((a, s) => a + s.abs, 0) / etaSamples.length;
      const withinEta = etaSamples.filter((s) => !s.late).length;
      records.push({
        prediction_type: "eta",
        samples: etaSamples.length,
        accuracy_pct: Math.round((withinEta / etaSamples.length) * 1000) / 10,
        mean_error: Math.round(meanAbs * 100) / 100,
        mean_error_pct: null,
        window_start: iso(windowStart),
        window_end: iso(windowEnd),
        details: {
          metric: "delivered at or before predicted ETA",
          mean_abs_error_hours: Math.round(meanAbs * 100) / 100,
          within_eta: withinEta,
        },
      });
    }

    // Demand forecast accuracy — predicted volume vs actual last-30-day volume per corridor
    const actualVolume = {};
    for (const s of shipments) {
      const created = new Date(s.created_date);
      if (created < windowStart) continue;
      const key = (s.origin || "?") + "|" + (s.destination || "?");
      actualVolume[key] = (actualVolume[key] || 0) + 1;
    }
    const forecastErrors = [];
    for (const f of forecasts) {
      const key = (f.origin || "?") + "|" + (f.destination || "?");
      const actual = actualVolume[key] || 0;
      const predicted = f.predicted_volume || 0;
      if (!predicted) continue;
      forecastErrors.push(Math.abs(actual - predicted) / predicted);
    }
    if (forecastErrors.length) {
      const meanErr = forecastErrors.reduce((a, e) => a + e, 0) / forecastErrors.length;
      records.push({
        prediction_type: "demand_forecast",
        samples: forecastErrors.length,
        accuracy_pct: Math.round(Math.max(0, 100 - meanErr * 100) * 10) / 10,
        mean_error: Math.round(meanErr * 100) / 100,
        mean_error_pct: Math.round(meanErr * 10000) / 100,
        window_start: iso(windowStart),
        window_end: iso(windowEnd),
        details: { metric: "predicted vs actual 30-day corridor volume", corridors: forecastErrors.length },
      });
    }

    // Matching accuracy — matched shipments that completed rather than cancelled/exception
    const matched = shipments.filter((s) => s.assigned_carrier_id);
    if (matched.length) {
      const good = matched.filter((s) => s.status !== "cancelled" && s.status !== "flagged").length;
      records.push({
        prediction_type: "matching",
        samples: matched.length,
        accuracy_pct: Math.round((good / matched.length) * 1000) / 10,
        mean_error: null,
        mean_error_pct: null,
        window_start: iso(windowStart),
        window_end: iso(windowEnd),
        details: { metric: "assignments that did not cancel or flag", matched: matched.length, good },
      });
    }

    // Bundle efficiency — estimated savings of bundles that completed
    const completed = bundles.filter((b) => b.status === "completed");
    if (bundles.length) {
      records.push({
        prediction_type: "bundle_efficiency",
        samples: bundles.length,
        accuracy_pct: completed.length
          ? Math.round((completed.reduce((a, b) => a + (b.estimated_savings_pct || 0), 0) / completed.length) * 10) / 10
          : 0,
        mean_error: null,
        mean_error_pct: null,
        window_start: iso(windowStart),
        window_end: iso(windowEnd),
        details: {
          metric: "average estimated savings across bundles (completion rate " +
            Math.round((completed.length / bundles.length) * 100) + "%)",
        },
      });
    }

    // Pricing accuracy — awaiting settlement data to compare quotes against charges
    records.push({
      prediction_type: "pricing",
      samples: 0,
      accuracy_pct: null,
      mean_error: null,
      mean_error_pct: null,
      window_start: iso(windowStart),
      window_end: iso(windowEnd),
      details: { metric: "quote vs settled charge", note: "awaiting settlement data from billing" },
    });

    const stored = [];
    for (const r of records) {
      stored.push(
        await base44.asServiceRole.entities.PredictionAccuracy.create({ ...r, recorded_at: nowIso() })
      );
    }

    await base44.asServiceRole.entities.AuditLog.create({
      actor_id: user.id,
      actor_name: user.full_name || "LEX",
      actor_role: user.role,
      action: "learning_feedback.evaluated",
      entity_type: "PredictionAccuracy",
      entity_id: "-",
      details: "Evaluated " + stored.length + " prediction types against actual outcomes",
      severity: "info",
    });

    await publishEvent(base44, "lex.learning_feedback", { records: stored.length });

    return Response.json({ evaluated: stored.length, records: stored });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}