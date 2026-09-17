// LEX Phase 3 shared intelligence computations — pure functions over engine data.
// Consumed by lexCapacityEngine, lexCorridorIntelligence, lexCarrierReputation,
// lexMerchantIntelligence, lexSimulate, lexSustainability, and lexLearningFeedback.
import { corridorOverlap, haversineKm } from "./lexUtils.ts";

export function corridorKey(origin, destination) {
  return (origin || "?") + "|" + (destination || "?");
}

export function pct(part, total) {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}

export function avg(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

export function round2(v) {
  return Math.round(v * 100) / 100;
}

const LAST_MILE_VEHICLES = ["bike", "walker", "sedan"];

const TREND_FACTOR = { rising: 1.15, stable: 1.05, declining: 0.9 };
function trendFactor(t) {
  return TREND_FACTOR[t] || 1;
}

function monthKey(iso) {
  return (iso || "").slice(0, 7);
}

// ---------------------------------------------------------------------------
// Item 1 — Network capacity across carriers, partners, nodes, last mile, corridors
export function computeCapacity({ shipments, carriers, nodes, forecasts }) {
  const totalOf = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);
  const carrierTotal = totalOf(carriers, (c) => c.capacity_total_kg);
  const carrierUsed = totalOf(carriers, (c) => c.capacity_used_kg);
  const nodesAll = nodes || [];
  const partnerNodes = nodesAll.filter((n) => n.type === "partner_shop");
  const lastMileCarriers = carriers.filter((c) => LAST_MILE_VEHICLES.includes(c.vehicle_type));

  const dim = (total, used) => ({
    total_kg: round2(total),
    used_kg: round2(used),
    available_kg: round2(Math.max(0, total - used)),
    utilization_pct: pct(used, total),
  });

  // corridor demand vs covering-carrier capacity
  const corridors = {};
  for (const s of shipments) {
    const key = corridorKey(s.origin, s.destination);
    const c = (corridors[key] ||= {
      corridor: key,
      origin: s.origin,
      destination: s.destination,
      shipments: 0,
      demand_kg: 0,
      active_demand_kg: 0,
      capacity_kg: 0,
    });
    c.shipments += 1;
    c.demand_kg += s.weight_kg || 0;
    if (s.status === "pending" || s.status === "matched") c.active_demand_kg += s.weight_kg || 0;
  }
  for (const carrier of carriers) {
    for (const key of Object.keys(corridors)) {
      const c = corridors[key];
      if (
        corridorOverlap(c.origin, c.destination, carrier.route_origin, carrier.route_destination) > 0
      ) {
        c.capacity_kg += Math.max(0, (carrier.capacity_total_kg || 0) - (carrier.capacity_used_kg || 0));
      }
    }
  }
  const forecastByCorridor = {};
  for (const f of forecasts || []) {
    const key = corridorKey(f.origin, f.destination);
    forecastByCorridor[key] = f;
  }

  const activeDemand = Object.values(corridors).reduce((a, c) => a + c.active_demand_kg, 0);
  const corridorCapacity = Object.values(corridors).reduce((a, c) => a + c.capacity_kg, 0);

  const corridorList = Object.values(corridors).map((c) => {
    const f = forecastByCorridor[c.corridor];
    const tf = f ? trendFactor(f.trend) : 1;
    const current = pct(c.active_demand_kg, c.capacity_kg);
    return {
      ...c,
      demand_kg: round2(c.demand_kg),
      active_demand_kg: round2(c.active_demand_kg),
      capacity_kg: round2(c.capacity_kg),
      utilization_pct: current,
      trend: f?.trend || "stable",
      forecast_utilization_pct: {
        today: round2(current * tf),
        tomorrow: round2(current * tf * 1.05),
        next_7_days: round2(current * tf * 1.12),
      },
    };
  });

  const overallUtil = pct(activeDemand, corridorCapacity);
  const tfAll = avg(
    (forecasts || []).filter((f) => f.trend).map((f) => trendFactor(f.trend))
  ) || 1;

  const bottlenecks = [];
  for (const c of corridorList) {
    if (c.capacity_kg === 0 && c.active_demand_kg > 0)
      bottlenecks.push({ type: "corridor", name: c.corridor, detail: "no covering carrier capacity", severity: "high" });
    else if (c.utilization_pct >= 90)
      bottlenecks.push({ type: "corridor", name: c.corridor, detail: c.utilization_pct + "% utilized", severity: c.utilization_pct >= 100 ? "high" : "medium" });
  }
  for (const n of nodesAll) {
    const u = pct(n.capacity_used, n.capacity_total);
    if (u >= 90)
      bottlenecks.push({ type: "node", name: n.name, detail: u + "% utilized", severity: u >= 100 ? "high" : "medium" });
  }
  for (const c of carriers) {
    const u = pct(c.capacity_used_kg, c.capacity_total_kg);
    if (u >= 90)
      bottlenecks.push({ type: "carrier", name: c.name, detail: u + "% utilized", severity: u >= 100 ? "high" : "medium" });
  }

  return {
    overall: {
      capacity_kg: round2(corridorCapacity),
      active_demand_kg: round2(activeDemand),
      utilization_pct: overallUtil,
      forecast_utilization_pct: {
        today: round2(overallUtil * tfAll),
        tomorrow: round2(overallUtil * tfAll * 1.05),
        next_7_days: round2(overallUtil * tfAll * 1.12),
      },
    },
    carrier: dim(carrierTotal, carrierUsed),
    node: dim(totalOf(nodesAll, (n) => n.capacity_total), totalOf(nodesAll, (n) => n.capacity_used)),
    partner: dim(
      totalOf(partnerNodes, (n) => n.capacity_total),
      totalOf(partnerNodes, (n) => n.capacity_used)
    ),
    last_mile: dim(
      totalOf(lastMileCarriers, (c) => c.capacity_total_kg),
      totalOf(lastMileCarriers, (c) => c.capacity_used_kg)
    ),
    corridors: corridorList.sort((a, b) => b.utilization_pct - a.utilization_pct),
    bottlenecks,
  };
}

// ---------------------------------------------------------------------------
// Item 7 — Corridor intelligence (volume, revenue, margin, performance, trends)
export function computeCorridorMetrics({ shipments, quotes, carriers, custody, fraudAlerts, bundles }) {
  const deliveredByShipment = {};
  for (const e of custody || []) {
    if (e.event_type === "delivered" && e.shipment_id) deliveredByShipment[e.shipment_id] = e;
  }
  const corridors = {};
  for (const s of shipments) {
    const key = corridorKey(s.origin, s.destination);
    const c = (corridors[key] ||= {
      corridor: key,
      origin: s.origin,
      destination: s.destination,
      volume: 0,
      delivered: 0,
      late: 0,
      claims: 0,
      revenue: 0,
      margin: 0,
      capacity_kg: 0,
      demand_kg: 0,
      months: {},
    });
    c.volume += 1;
    c.demand_kg += s.weight_kg || 0;
    if (s.status === "delivered") c.delivered += 1;
    const m = monthKey(s.created_date);
    c.months[m] = (c.months[m] || 0) + 1;
    const dv = deliveredByShipment[s.id];
    if (dv) {
      if (s.delivery_deadline && new Date(dv.timestamp) > new Date(s.delivery_deadline)) c.late += 1;
    }
  }
  for (const q of quotes || []) {
    const c = corridors[q.corridor];
    if (!c) continue;
    c.revenue += q.merchant_price || 0;
    c.margin += q.platform_margin || 0;
  }
  for (const a of fraudAlerts || []) {
    const s = shipments.find((x) => x.id === a.entity_id);
    if (!s) continue;
    const c = corridors[corridorKey(s.origin, s.destination)];
    if (c) c.claims += 1;
  }
  for (const carrier of carriers || []) {
    for (const key of Object.keys(corridors)) {
      const c = corridors[key];
      if (corridorOverlap(c.origin, c.destination, carrier.route_origin, carrier.route_destination) > 0)
        c.capacity_kg += Math.max(0, (carrier.capacity_total_kg || 0) - (carrier.capacity_used_kg || 0));
    }
  }
  const shipmentCorridor = {};
  for (const s of shipments) shipmentCorridor[s.id] = corridorKey(s.origin, s.destination);
  const bundleByCorridor = {};
  for (const b of bundles || []) {
    for (const sid of b.shipment_ids || []) {
      const key = shipmentCorridor[sid];
      if (key) (bundleByCorridor[key] ||= []).push(b.estimated_savings_pct || 0);
    }
  }

  const months = [...new Set(shipments.map((s) => monthKey(s.created_date)).filter(Boolean))].sort();
  return Object.values(corridors)
    .map((c) => ({
      corridor: c.corridor,
      origin: c.origin,
      destination: c.destination,
      volume: c.volume,
      delivered: c.delivered,
      revenue: round2(c.revenue),
      gross_margin: round2(c.margin),
      gross_margin_pct: pct(c.margin, c.revenue),
      capacity_utilization_pct: pct(c.demand_kg, c.capacity_kg),
      delivery_performance_pct: pct(c.delivered, c.volume),
      delay_rate_pct: pct(c.late, c.delivered),
      claims_rate_pct: pct(c.claims, c.volume),
      bundle_efficiency_pct: round2(avg(bundleByCorridor[c.corridor] || [])),
      monthly_volume: months.map((m) => ({ month: m, volume: c.months[m] || 0 })),
    }))
    .sort((a, b) => b.volume - a.volume);
}

// ---------------------------------------------------------------------------
// Item 5 — Carrier reputation scores
export function computeReputation({ carriers, shipments, custody, bundles, incidents, fraudAlerts }) {
  const deliveredEvents = {};
  const pickedEvents = {};
  const matchedEvents = {};
  for (const e of custody || []) {
    if (e.event_type === "delivered" && e.shipment_id) deliveredEvents[e.shipment_id] = e;
    if (e.event_type === "picked_up" && e.shipment_id) pickedEvents[e.shipment_id] = e;
    if (e.event_type === "matched" && e.shipment_id) matchedEvents[e.shipment_id] = e;
  }
  const flaggedShipments = new Set((fraudAlerts || []).map((a) => a.entity_id));

  return carriers.map((carrier) => {
    const assigned = shipments.filter((s) => s.assigned_carrier_id === carrier.id);
    const delivered = assigned.filter((s) => s.status === "delivered");
    const picked = assigned.filter((s) => pickedEvents[s.id]);
    const matchedEv = assigned.filter((s) => matchedEvents[s.id]);
    const late = delivered.filter((s) => {
      const dv = deliveredEvents[s.id];
      return dv && s.delivery_deadline && new Date(dv.timestamp) > new Date(s.delivery_deadline);
    });
    const incidentCount = (incidents || []).filter(
      (i) => i.entity_id === carrier.id || assigned.some((s) => s.id === i.entity_id)
    ).length;
    const claimsCount = assigned.filter((s) => flaggedShipments.has(s.id)).length;
    const carrierBundles = (bundles || []).filter((b) => b.carrier_id === carrier.id);
    const bundlePerf = avg(carrierBundles.map((b) => b.estimated_savings_pct || 0));

    const completion = pct(delivered.length, assigned.length);
    const onTime = delivered.length ? pct(delivered.length - late.length, delivered.length) : null;
    const acceptance = matchedEv.length ? pct(picked.length, matchedEv.length) : null;
    const incidentRate = delivered.length ? round2((incidentCount * 10) / delivered.length) : 0;
    const claimsRate = pct(claimsCount, assigned.length);
    const bundleScore = carrierBundles.length ? bundlePerf : null;

    const hasData = assigned.length > 0;
    const reliability = hasData
      ? Math.round(
          0.3 * completion +
            0.25 * (onTime ?? 70) +
            0.2 * (acceptance ?? 70) +
            0.15 * Math.max(0, 100 - incidentRate * 10) +
            0.1 * Math.max(0, 100 - claimsRate)
        )
      : 70;

    return {
      carrier_id: carrier.id,
      carrier_name: carrier.name,
      completion_rate: completion,
      on_time_performance: onTime,
      acceptance_rate: acceptance,
      incident_rate: incidentRate,
      claims_rate: claimsRate,
      bundle_performance: bundleScore,
      reliability_score: reliability,
      deliveries_sampled: delivered.length,
    };
  });
}

// ---------------------------------------------------------------------------
// Item 6 — Merchant intelligence metrics
export function computeMerchantMetrics({ shipments, custody, fraudAlerts, maxWeightKg }) {
  const byMerchant = {};
  const firstMovement = {};
  for (const e of custody || []) {
    if (!e.shipment_id || e.event_type === "created") continue;
    if (!firstMovement[e.shipment_id] || new Date(e.timestamp) < new Date(firstMovement[e.shipment_id]))
      firstMovement[e.shipment_id] = e.timestamp;
  }
  const flagged = new Set((fraudAlerts || []).map((a) => a.entity_id));
  const now = Date.now();
  const DAY = 86400000;

  for (const s of shipments) {
    const name = s.merchant_name || "unattributed";
    const m = (byMerchant[name] ||= {
      merchant_name: name,
      total: 0,
      last30: 0,
      prev30: 0,
      processingHours: [],
      claims: 0,
      compliant: 0,
      delivered: 0,
      late: 0,
    });
    m.total += 1;
    const age = now - new Date(s.created_date).getTime();
    if (age <= 30 * DAY) m.last30 += 1;
    else if (age <= 60 * DAY) m.prev30 += 1;
    if (flagged.has(s.id)) m.claims += 1;
    if ((s.weight_kg || 0) <= (maxWeightKg || 68)) m.compliant += 1;
    if (s.status === "delivered") {
      m.delivered += 1;
      if (s.updated_date && s.delivery_deadline && new Date(s.updated_date) > new Date(s.delivery_deadline))
        m.late += 1;
    }
    const fm = firstMovement[s.id];
    if (fm)
      m.processingHours.push(
        round2((new Date(fm).getTime() - new Date(s.created_date).getTime()) / 3600000)
      );
  }

  return Object.values(byMerchant)
    .map((m) => ({
      merchant_name: m.merchant_name,
      shipment_volume: m.total,
      growth_trend:
        m.prev30 === 0 ? "rising" : m.last30 > m.prev30 * 1.1 ? "rising" : m.last30 < m.prev30 * 0.9 ? "declining" : "stable",
      avg_processing_time_hours: round2(avg(m.processingHours)),
      claims_rate: pct(m.claims, m.total),
      packaging_compliance_pct: pct(m.compliant, m.total),
      operational_reliability_pct: m.delivered ? pct(m.delivered - m.late, m.delivered) : null,
    }))
    .sort((a, b) => b.shipment_volume - a.shipment_volume);
}

// ---------------------------------------------------------------------------
// Item 16 — Sustainability intelligence
export function computeSustainability({ bundles, shipments, carriers }) {
  const shipmentById = {};
  for (const s of shipments) shipmentById[s.id] = s;
  let carbonKg = 0;
  let sharedDeliveries = 0;
  let vehicleKmReduced = 0;
  const corridorCarbon = {};

  for (const b of bundles || []) {
    const ids = b.shipment_ids || [];
    carbonKg += b.carbon_savings_kg || 0;
    sharedDeliveries += Math.max(0, ids.length - 1);
    const legs = ids
      .map((id) => shipmentById[id])
      .filter(Boolean)
      .map((s) =>
        haversineKm(s.origin_lat, s.origin_lng, s.destination_lat, s.destination_lng)
      );
    if (legs.length > 1) vehicleKmReduced += (legs.length - 1) * avg(legs);
    const key = ids.length ? corridorKey(shipmentById[ids[0]]?.origin, shipmentById[ids[0]]?.destination) : null;
    if (key) {
      const m = monthKey(b.created_date);
      corridorCarbon[key] ||= {};
      corridorCarbon[key][m] = (corridorCarbon[key][m] || 0) + (b.carbon_savings_kg || 0);
    }
  }

  const corridorTrends = Object.entries(corridorCarbon).map(([corridor, months]) => ({
    corridor,
    monthly_carbon_kg: Object.entries(months)
      .sort()
      .map(([month, kg]) => ({ month, carbon_kg: round2(kg) })),
  }));

  return {
    carbon_emissions_avoided_kg: round2(carbonKg),
    shared_deliveries: sharedDeliveries,
    active_bundles: (bundles || []).filter((b) => b.status === "active" || b.status === "in_transit").length,
    bundle_savings_avg_pct: round2(avg((bundles || []).map((b) => b.estimated_savings_pct || 0))),
    vehicle_km_reduced: round2(vehicleKmReduced),
    corridor_trends: corridorTrends,
  };
}