import {resolveLocalOperation} from "../../shared/lexTrustedIsolation.ts";
import {recoverBundle} from "../../shared/lexBundleRecovery.ts";
import { createClientFromRequest } from "npm:@base44/sdk@0.8.49";
import { uuid } from "../../shared/lexUtils.ts";
import { requirePerm } from "../../shared/lexPermissions.ts";
import { transitionShipment } from "../../shared/lexTransitions.ts";

// LEX Smart Bundle Service — forms bundles from matched shipments using a
// rule-aware grouping pipeline:
//   1. Group by assigned carrier + destination corridor + service level + package size
//   2. Evaluate the active OperationalRule set (size limits, weight limits,
//      carrier eligibility, corridor restrictions) — a bundle is only formed
//      when every rule passes
//   3. Respect each community carrier's remaining weight capacity (the max
//      size per carrier), splitting a group into multiple bundles when it
//      would exceed the ceiling
const BUNDLE_RULE_TYPES = new Set([
  "package_size_limit",
  "weight_limit",
  "carrier_eligibility",
  "corridor_restriction",
]);

const DEFAULTS = {
  maxPackagesPerBundle: 8,
  maxBundleWeightKg: null as number | null,
  allowedSizes: ["small", "medium", "large", "xl"],
  maxWeightPerPackageKg: null as number | null,
  requireSameCorridor: true,
  requireServiceLevelMatch: true,
  minCarrierRating: 0,
  blockedCorridors: [] as string[],
};

function corridorKey(origin: string, destination: string) {
  return `${(origin || "").trim().toLowerCase()}|${(destination || "").trim().toLowerCase()}`;
}

function loadRules(rules: any[]) {
  const cfg = { ...DEFAULTS, blockedCorridors: [...DEFAULTS.blockedCorridors] };
  const applied: string[] = [];
  for (const r of rules) {
    if (r.enabled === false) continue;
    const p = r.parameters || {};
    applied.push(r.name);
    if (r.rule_type === "package_size_limit") {
      if (Array.isArray(p.allowed_sizes)) cfg.allowedSizes = p.allowed_sizes.map(String);
      if (p.max_packages_per_bundle != null) cfg.maxPackagesPerBundle = Number(p.max_packages_per_bundle);
      if (p.max_weight_per_package_kg != null) cfg.maxWeightPerPackageKg = Number(p.max_weight_per_package_kg);
    } else if (r.rule_type === "weight_limit") {
      if (p.max_bundle_weight_kg != null) cfg.maxBundleWeightKg = Number(p.max_bundle_weight_kg);
    } else if (r.rule_type === "carrier_eligibility") {
      if (p.min_rating != null) cfg.minCarrierRating = Number(p.min_rating);
      if (p.require_service_level_match != null) cfg.requireServiceLevelMatch = !!p.require_service_level_match;
      if (p.require_same_corridor != null) cfg.requireSameCorridor = !!p.require_same_corridor;
    } else if (r.rule_type === "corridor_restriction") {
      if (Array.isArray(p.blocked_corridors)) cfg.blockedCorridors = p.blocked_corridors.map(String);
    }
  }
  return { cfg, applied };
}

function checkRules(ships: any[], carrier: any, cfg: any, corridor: string) {
  const checks: { rule: string; passed: boolean; detail: string }[] = [];

  const sizeOk = ships.every((s) => cfg.allowedSizes.includes(s.package_size));
  checks.push({
    rule: "allowed_package_sizes",
    passed: sizeOk,
    detail: sizeOk ? "all package sizes permitted" : `sizes outside ${cfg.allowedSizes.join(",")}`,
  });

  const perPkgOk = cfg.maxWeightPerPackageKg == null || ships.every((s) => (s.weight_kg || 0) <= cfg.maxWeightPerPackageKg!);
  checks.push({
    rule: "max_weight_per_package",
    passed: perPkgOk,
    detail: cfg.maxWeightPerPackageKg == null ? "no per-package weight rule" : `≤ ${cfg.maxWeightPerPackageKg}kg each`,
  });

  const blocked = cfg.blockedCorridors.map((c) => c.toLowerCase());
  const corridorOk = !blocked.includes(corridor.toLowerCase());
  checks.push({
    rule: "corridor_restriction",
    passed: corridorOk,
    detail: corridorOk ? "corridor permitted" : "corridor blocked",
  });

  const ratingOk = !carrier || (carrier.rating ?? 0) >= cfg.minCarrierRating;
  checks.push({
    rule: "carrier_min_rating",
    passed: ratingOk,
    detail: ratingOk ? `rating ${carrier?.rating ?? "n/a"} ≥ ${cfg.minCarrierRating}` : `rating below ${cfg.minCarrierRating}`,
  });

  const remaining = carrier ? Math.max(0, (carrier.capacity_total_kg || 0) - (carrier.capacity_used_kg || 0)) : null;
  const totalWeight = ships.reduce((sum, s) => sum + (s.weight_kg || 0), 0);
  const capacityOk = !carrier || totalWeight <= Number(carrier.capacity_total_kg || 0);
  checks.push({
    rule: "carrier_max_capacity",
    passed: capacityOk,
    detail: `total ${Math.round(totalWeight * 100) / 100}kg ${remaining != null ? `≤ ${carrier.capacity_total_kg}kg total capacity (already reserved)` : "(no carrier capacity on file)"}`,
  });

  const ceiling = cfg.maxBundleWeightKg != null ? cfg.maxBundleWeightKg : (carrier?.capacity_total_kg ?? null);
  const weightCeilingOk = ceiling == null || totalWeight <= ceiling;
  checks.push({
    rule: "max_bundle_weight",
    passed: weightCeilingOk,
    detail: ceiling == null ? "no weight ceiling" : `≤ ${ceiling}kg`,
  });

  const allPassed = checks.every((c) => c.passed);
  return { allPassed, checks, totalWeight, remaining, ceiling };
}

export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const denied = await requirePerm(base44, user, "optimize_bundles");
    if (denied) return denied;
    const input=await req.json().catch(()=>({}));
    const scoped=Object.hasOwn(input,'shipment_ids');
    if(scoped&&(!Array.isArray(input.shipment_ids)||input.shipment_ids.length<1||input.shipment_ids.length>20||input.shipment_ids.some(x=>typeof x!=='string'||!x)))return Response.json({error:'Explicit shipment_ids must contain 1–20 native LEX IDs'},{status:400});


    const [candidates, rules] = await Promise.all([
      base44.asServiceRole.entities.Shipment.filter(scoped?{status:"matched",id:{$in:input.shipment_ids}}:{status:"matched"}),
      base44.asServiceRole.entities.OperationalRule.filter({ enabled: true }),
    ]);
    const matched=[];let held=0;
    for(const row of candidates){if((await resolveLocalOperation(base44,'Shipment',row)).kind==='ordinary'&&!row.lex_effects_pending)matched.push(row);else held++;}
    if(!matched.length)return Response.json({bundles_created:0,held,bundles:[],rejected:[]});
    const bundleRules = (rules || []).filter((r: any) => BUNDLE_RULE_TYPES.has(r.rule_type));
    const { cfg, applied } = loadRules(bundleRules);

    // Carrier lookup for capacity + eligibility.
    const carrierIds = Array.from(new Set(matched.map((s: any) => s.assigned_carrier_id).filter(Boolean)));
    const carriers: any[] = carrierIds.length
      ? await base44.asServiceRole.entities.CommunityCarrier.filter({ id: { $in: carrierIds } })
      : [];
    const carrierMap = new Map(carriers.map((c: any) => [c.id, c]));

    // Group by carrier + destination corridor + service level + package size.
    const groups: Record<string, any[]> = {};
    for (const s of matched) {
      if (!s.assigned_carrier_id) continue;
      const corridor = cfg.requireSameCorridor ? corridorKey(s.origin, s.destination) : s.destination?.toLowerCase();
      const svc = cfg.requireServiceLevelMatch ? s.service_level || "any" : "any";
      const size = s.package_size || "any";
      const key = `${s.assigned_carrier_id}::${corridor}::${svc}::${size}`;
      (groups[key] ||= []).push(s);
    }

    const bundles: any[] = [];
    const rejected: any[] = [];

    for (const [key, ships] of Object.entries(groups)) {
      if (ships.length < 2) continue;
      const [carrierId, corridor, svc, size] = key.split("::");
      const carrier = carrierMap.get(carrierId);

      // Greedily pack into bundles respecting maxPackages and weight ceiling.
      let remaining = carrier ? Math.max(0, (carrier.capacity_total_kg || 0) - (carrier.capacity_used_kg || 0)) : null;
      const ceiling = cfg.maxBundleWeightKg != null ? cfg.maxBundleWeightKg : (carrier?.capacity_total_kg ?? null);
      let bucket: any[] = [];
      let bucketWeight = 0;
      const flush = async (groupShips: any[]) => {
        const { allPassed, checks, totalWeight, remaining: rem, ceiling: ceiled } = checkRules(groupShips, carrier, cfg, corridor);
        if (!allPassed) {
          rejected.push({ carrier_id: carrierId, corridor, size, reason: "rules_failed", checks });
          return;
        }
        const bundleId = uuid();
        const stops = Array.from(new Set(groupShips.map((s) => s.destination)));
        const savingsPct = Math.round((1 - 1 / groupShips.length) * 1000) / 10;
        const carbonKg = Math.round(groupShips.length * 0.42 * 10) / 10;
        const bundleDocument={
          bundle_id: bundleId,
          shipment_ids: groupShips.map((s) => s.id),
          carrier_id: carrierId,
          total_weight_kg: Math.round(totalWeight * 100) / 100,
          stops,
          status: "active",
          estimated_savings_pct: savingsPct,
          carbon_savings_kg: carbonKg,
          grouping_basis: { corridor, service_level: svc, package_size: size },
          rules_applied: applied,
          rules_checked: checks,
          carrier_capacity_kg: rem != null ? Math.round(rem * 100) / 100 : null,
          max_weight_per_bundle_kg: ceiled != null ? Math.round(ceiled * 100) / 100 : null,
        };
        const servicePlan={kind:"bundle",document:{bundle_id:bundleId,candidate_ids:groupShips.map(s=>s.id),document:bundleDocument}};
        const outcomes=[];
        for (const s of groupShips) {
          // Status changes route through the unified transition service: CAS on
          // status, version bump, audit + lifecycle history, the "bundled" custody
          // event, the durable outbox event and the engine-sync enqueue. `force`
          // preserves this service's existing behaviour of moving a matched
          // shipment straight to in_transit (no intermediate picked_up stage).
          // The deterministic command_id makes a repeated bundle run idempotent.
          const res = await transitionShipment(base44, {
            shipment_id: s.id,expected_version:s.version||1,metadata_patch:{bundle_id:bundleId},service_plan:servicePlan,
            command_id: `bundle:${bundleId}:${s.id}`,
            to_status: "in_transit",
            force: true,
            custody: { event_type: "bundled", location: s.origin, notes: "Added to bundle " + bundleId },
            trigger_source: "system",
            actor: user,
            note: "Added to bundle " + bundleId,
            event_payload: { bundle_id: bundleId, carrier_id: carrierId },
          });
          outcomes.push(res);
        }
        if(outcomes.some(r=>!r.ok)){rejected.push({bundle_id:bundleId,reason:'member_transition_pending_or_conflict',member_results:outcomes.map(r=>({ok:r.ok,code:r.code,error:r.error}))});return;}
        try {await recoverBundle(base44,servicePlan);}catch {rejected.push({bundle_id:bundleId,reason:'bundle_projection_pending'});return;}
        bundles.push({
          bundle_id: bundleId,
          carrier_id: carrierId,
          corridor,
          service_level: svc,
          package_size: size,
          shipment_count: groupShips.length,
          total_weight_kg: Math.round(totalWeight * 100) / 100,
          stops,
          estimated_savings_pct: savingsPct,
          carbon_savings_kg: carbonKg,
          rules_checked: checks,
        });
      };

      for (const s of ships) {
        const w = s.weight_kg || 0;
        const wouldExceedCount = bucket.length + 1 > cfg.maxPackagesPerBundle;
        const wouldExceedCeiling = ceiling != null && bucketWeight + w > ceiling;
        if (bucket.length && (wouldExceedCount || wouldExceedCeiling)) {
          await flush(bucket);
          bucket = [];
          bucketWeight = 0;
        }
        bucket.push(s);
        bucketWeight += w;
      }
      if (bucket.length >= 2) await flush(bucket);
    }

    // Matching already reserved each parcel. Bundling never adds that weight again.

    await base44.asServiceRole.entities.AuditLog.create({
      actor_id: user.id,
      actor_name: user.full_name || "LEX",
      actor_role: user.role,
      action: "bundles.optimized",
      entity_type: "SmartBundle",
      entity_id: "-",
      details: `Formed ${bundles.length} smart bundles (rules: ${applied.join(", ") || "defaults"}), rejected ${rejected.length} groups`,
      severity: "info",
    });

    return Response.json({
      bundles_created: bundles.length,held,
      rules_applied: applied,
      bundles,
      rejected,
    });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
