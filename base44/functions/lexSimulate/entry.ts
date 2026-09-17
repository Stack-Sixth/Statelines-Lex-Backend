import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import {
  computeCapacity,
  computeSustainability,
  avg,
  pct,
  round2,
} from "../../shared/lexPhase3.ts";
import { publishEvent } from "../../shared/lexUtils.ts";

// LEX Phase 3 — Optimization Simulator. Projects the impact of operational
// changes against a production snapshot WITHOUT touching production data.
// Results persist only to the isolated SimulationRun entity.
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const type = body.scenario_type;
    const config = body.config || {};
    const name = (body.name || "").trim() || "Untitled simulation";

    const [shipments, carriers, nodes, forecasts, bundles, quotes, etas] = [
      await base44.asServiceRole.entities.Shipment.filter({}),
      await base44.asServiceRole.entities.CommunityCarrier.filter({}),
      await base44.asServiceRole.entities.SmartNode.filter({}),
      await base44.asServiceRole.entities.DemandForecast.filter({}),
      await base44.asServiceRole.entities.SmartBundle.filter({}),
      await base44.asServiceRole.entities.PriceQuote.filter({}),
      await base44.asServiceRole.entities.ShipmentETA.filter({}),
    ];

    const cap = computeCapacity({ shipments, carriers, nodes, forecasts });
    const sust = computeSustainability({ bundles, shipments, carriers });
    const revenue = quotes.reduce((a, q) => a + (q.merchant_price || 0), 0);
    const margin = quotes.reduce((a, q) => a + (q.platform_margin || 0), 0);
    const deliveryHours = etas
      .filter((e) => e.delivery_eta && e.pickup_eta)
      .map((e) => (new Date(e.delivery_eta) - new Date(e.pickup_eta)) / 3600000);

    const baseline = {
      avg_delivery_time_hours: round2(avg(deliveryHours) || 48),
      bundle_efficiency_pct: round2(avg(bundles.map((b) => b.estimated_savings_pct || 0))),
      capacity_utilization_pct: cap.overall.utilization_pct,
      revenue: round2(revenue),
      gross_margin_pct: pct(margin, revenue),
      carbon_savings_kg: sust.carbon_emissions_avoided_kg,
    };
    const p = { ...baseline };
    const assumptions = [];
    const scale = (field, factor) => {
      p[field] = round2(p[field] * factor);
    };

    switch (type) {
      case "additional_carriers": {
        const count = Math.max(1, Number(config.count) || 1);
        const avgCap = avg(carriers.map((c) => c.capacity_total_kg || 0)) || 100;
        const share = count / Math.max(1, carriers.length + count);
        assumptions.push(count + " added carriers modeled at fleet-average capacity " + round2(avgCap) + " kg");
        p.capacity_utilization_pct = round2(baseline.capacity_utilization_pct * (1 - share * 0.5));
        scale("avg_delivery_time_hours", 0.95);
        p.bundle_efficiency_pct = round2(baseline.bundle_efficiency_pct + 2);
        scale("carbon_savings_kg", 1.05);
        break;
      }
      case "carrier_unavailable": {
        const count = Math.max(1, Number(config.count) || 1);
        const share = count / Math.max(1, carriers.length);
        assumptions.push(count + " carrier(s) unavailable, demand redistributed across remaining fleet");
        p.capacity_utilization_pct = round2(baseline.capacity_utilization_pct * (1 + share * 0.5));
        scale("avg_delivery_time_hours", 1.08);
        scale("bundle_efficiency_pct", 0.97);
        break;
      }
      case "corridor_disruption": {
        const key = config.origin && config.destination ? config.origin + "|" + config.destination : null;
        const corridor = key ? cap.corridors.find((c) => c.corridor === key) : null;
        const shareOfDemand =
          cap.overall.active_demand_kg > 0 && corridor
            ? corridor.active_demand_kg / cap.overall.active_demand_kg
            : 0;
        assumptions.push(
          "corridor " + (key || "?") + " fully disrupted — " +
            Math.round(shareOfDemand * 100) + "% of active demand rerouted"
        );
        p.capacity_utilization_pct = round2(baseline.capacity_utilization_pct * (1 + shareOfDemand));
        scale("avg_delivery_time_hours", 1 + shareOfDemand * 0.2);
        scale("bundle_efficiency_pct", 1 - shareOfDemand * 0.05);
        break;
      }
      case "pricing_change": {
        const change = Number(config.pct_change) || 0;
        scale("revenue", 1 + change / 100);
        const volumeFactor = 1 + (-0.5 * change) / 100; // price elasticity of -0.5
        p.revenue = round2(p.revenue * volumeFactor);
        p.gross_margin_pct = round2(Math.max(0, baseline.gross_margin_pct + change * 0.4));
        assumptions.push("price elasticity of -0.5 applied to volume");
        break;
      }
      case "bundle_threshold": {
        const delta = Number(config.delta_pct) || 0;
        p.bundle_efficiency_pct = round2(baseline.bundle_efficiency_pct + delta);
        scale("carbon_savings_kg", 1 + delta / 100);
        scale("avg_delivery_time_hours", 1 - delta / 400);
        assumptions.push("bundle threshold adjusted by " + delta + " points of estimated savings");
        break;
      }
      case "volume_increase": {
        const change = Number(config.pct_change) || 0;
        p.capacity_utilization_pct = round2(baseline.capacity_utilization_pct * (1 + change / 100));
        scale("revenue", 1 + change / 100);
        scale("avg_delivery_time_hours", 1 + change / 400);
        assumptions.push("shipment volume increased " + change + "%");
        break;
      }
      default:
        assumptions.push("custom scenario — projection mirrors baseline");
    }
    assumptions.push("simulation is isolated — no production data was modified");

    const deltas = {};
    for (const k of Object.keys(baseline)) deltas[k] = round2(p[k] - baseline[k]);

    const run = await base44.asServiceRole.entities.SimulationRun.create({
      name,
      scenario_type: type || "custom",
      config,
      baseline,
      projected_impact: p,
      assumptions,
      status: "completed",
      created_by: user.full_name || user.email || "console",
    });

    await base44.asServiceRole.entities.AuditLog.create({
      actor_id: user.id,
      actor_name: user.full_name || "LEX",
      actor_role: user.role,
      action: "simulation.run",
      entity_type: "SimulationRun",
      entity_id: run.id,
      details: name + " (" + type + ") — projected utilization " + p.capacity_utilization_pct + "%",
      severity: "info",
    });

    await publishEvent(base44, "lex.simulation_run", { run_id: run.id, scenario_type: type });

    return Response.json({ run_id: run.id, baseline, projected: p, deltas, assumptions });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}