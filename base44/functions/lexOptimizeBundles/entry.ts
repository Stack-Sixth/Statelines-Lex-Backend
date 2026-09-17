import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import { uuid, nowIso } from "../../shared/lexUtils.ts";

// LEX Smart Bundle Service — groups matched shipments sharing a carrier + corridor
// into optimized bundles, computing weight, savings, and carbon reduction.
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    // Bundle optimization mutates shipments system-wide and writes SmartBundle records — admin only.
    if (user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    const matched = await base44.asServiceRole.entities.Shipment.filter({
      status: "matched",
    });

    // Group by assigned carrier + corridor key.
    const groups = {};
    for (const s of matched) {
      if (!s.assigned_carrier_id) continue;
      const key = s.assigned_carrier_id + "::" + s.origin + "::" + s.destination;
      if (!groups[key]) groups[key] = [];
      groups[key].push(s);
    }

    const bundles = [];
    for (const [key, ships] of Object.entries(groups)) {
      if (ships.length < 2) continue;
      const [carrierId, origin, destination] = key.split("::");
      const totalWeight = ships.reduce((sum, s) => sum + (s.weight_kg || 0), 0);
      const stops = Array.from(new Set(ships.map((s) => s.destination)));
      const bundleId = uuid();
      const savingsPct = Math.round((1 - 1 / ships.length) * 1000) / 10;
      const carbonKg = Math.round(ships.length * 0.42 * 10) / 10;

      const bundle = await base44.asServiceRole.entities.SmartBundle.create({
        bundle_id: bundleId,
        shipment_ids: ships.map((s) => s.id),
        carrier_id: carrierId,
        total_weight_kg: Math.round(totalWeight * 100) / 100,
        stops,
        status: "active",
        estimated_savings_pct: savingsPct,
        carbon_savings_kg: carbonKg,
      });

      for (const s of ships) {
        await base44.asServiceRole.entities.Shipment.update(s.id, {
          bundle_id: bundleId,
          status: "in_transit",
        });
        await base44.asServiceRole.entities.ChainOfCustodyEvent.create({
          shipment_id: s.id,
          tracking_id: s.tracking_id,
          event_type: "bundled",
          location: origin,
          actor_id: user.id,
          actor_name: "LEX Bundle Service",
          notes: "Added to bundle " + bundleId,
          timestamp: nowIso(),
        });
      }

      bundles.push({
        bundle_id: bundleId,
        carrier_id: carrierId,
        origin,
        destination,
        shipment_count: ships.length,
        total_weight_kg: Math.round(totalWeight * 100) / 100,
        stops,
        estimated_savings_pct: savingsPct,
        carbon_savings_kg: carbonKg,
      });
    }

    await base44.asServiceRole.entities.AuditLog.create({
      actor_id: user.id,
      actor_name: user.full_name || "LEX",
      actor_role: user.role,
      action: "bundles.optimized",
      entity_type: "SmartBundle",
      entity_id: "-",
      details: "Created " + bundles.length + " smart bundles",
      severity: "info",
    });

    return Response.json({ bundles_created: bundles.length, bundles });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}