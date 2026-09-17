import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import { haversineKm, normalize, publishEvent } from "../../shared/lexUtils.ts";

// LEX Pricing Engine — computes a dynamic price quote for a shipment from
// configurable PricingRules (base + per-kg + per-km, priority multiplier, insurance,
// tax, platform margin, carrier share, reward points). Admin or shipment owner.
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    let ship;
    if (body.shipment_id) {
      ship = await base44.asServiceRole.entities.Shipment.get(body.shipment_id);
    } else {
      const recent = await base44.asServiceRole.entities.Shipment.filter({ status: "pending" }, "-created_date", 1);
      ship = recent[0];
    }
    if (!ship) return Response.json({ error: "No shipment to price" }, { status: 404 });

    const isOwner = ship.created_by_id === user.id;
    if (!isOwner && user.role !== "admin")
      return Response.json({ error: "Forbidden" }, { status: 403 });

    const rules = await base44.asServiceRole.entities.PricingRule.filter({ active: true });
    if (!rules.length) return Response.json({ error: "No active pricing rule configured" }, { status: 409 });

    const corridor = (ship.origin || "") + "|" + (ship.destination || "");
    const rule =
      rules.find((r) => r.corridor === corridor) ||
      rules.find((r) => (r.corridor || "any") === "any") ||
      rules.find((r) => !r.corridor) ||
      rules[0];

    const distance = haversineKm(ship.origin_lat, ship.origin_lng, ship.destination_lat, ship.destination_lng) || 0;
    const weight = ship.weight_kg || 0;
    const base = rule.base_rate || 0;
    const weightCost = (rule.per_kg || 0) * weight;
    const distCost = (rule.per_km || 0) * distance;
    const subtotal = base + weightCost + distCost;

    const pm = rule.priority_multiplier || 1.3;
    const priorityMult =
      ship.service_level === "overnight" ? pm :
      ship.service_level === "same_day" ? (pm * 0.9) :
      ship.service_level === "express" ? (1 + (pm - 1) * 0.5) :
      1;

    // Phase 3 — configurable pricing modifiers (demand / capacity / promotional /
    // merchant / enterprise / corridor override) live in the Rules Engine as
    // OperationalRules. No hardcoded modifier logic.
    const modifierRules = await base44.asServiceRole.entities.OperationalRule.filter({ enabled: true });
    const MODIFIER_TYPES = [
      "demand_pricing", "capacity_pricing", "promotional_pricing",
      "merchant_pricing", "enterprise_pricing", "corridor_override",
    ];
    const nowMs = Date.now();
    let modifierMult = 1;
    const modifiersApplied = [];
    for (const r of modifierRules) {
      if (!MODIFIER_TYPES.includes(r.rule_type)) continue;
      if (r.effective_date && new Date(r.effective_date).getTime() > nowMs) continue;
      if (r.expiration_date && new Date(r.expiration_date).getTime() < nowMs) continue;
      const p = r.parameters || {};
      if (r.rule_type === "merchant_pricing" && p.merchant &&
          normalize(p.merchant) !== normalize(ship.merchant_name)) continue;
      if (r.rule_type === "corridor_override" && p.corridor && p.corridor !== corridor) continue;
      let m = p.price_multiplier != null ? Number(p.price_multiplier) : 1;
      if (p.pct_adjust != null) m *= 1 + Number(p.pct_adjust) / 100;
      if (m && m !== 1) {
        modifierMult *= m;
        modifiersApplied.push({ rule: r.name, type: r.rule_type, multiplier: Math.round(m * 100) / 100 });
      }
    }

    const merchantPrice = Math.round(subtotal * priorityMult * modifierMult * 100) / 100;
    const insuranceBase = ship.declared_value || merchantPrice;
    const insuranceFee = Math.round(((rule.insurance_pct || 0) / 100) * insuranceBase * 100) / 100;
    const taxes = Math.round(((rule.tax_pct || 0) / 100) * merchantPrice * 100) / 100;
    const platformMargin = Math.round(((rule.platform_margin_pct || 0) / 100) * merchantPrice * 100) / 100;
    const carrierShare = (rule.carrier_share_pct ?? 70) / 100;
    const carrierCompensation = Math.round((merchantPrice - platformMargin - taxes) * carrierShare * 100) / 100;
    const rewardPoints = Math.round(merchantPrice * (rule.reward_points_per_dollar || 1));

    const breakdown = {
      base_rate: base,
      weight_cost: Math.round(weightCost * 100) / 100,
      distance_cost: Math.round(distCost * 100) / 100,
      priority_multiplier: Math.round(priorityMult * 100) / 100,
      modifier_multiplier: Math.round(modifierMult * 100) / 100,
      modifiers_applied: modifiersApplied,
    };

    const quote = await base44.asServiceRole.entities.PriceQuote.create({
      shipment_id: ship.id,
      tracking_id: ship.tracking_id,
      corridor,
      distance_km: Math.round(distance * 10) / 10,
      merchant_price: merchantPrice,
      carrier_compensation: carrierCompensation,
      platform_margin: platformMargin,
      insurance_fee: insuranceFee,
      taxes,
      reward_points: rewardPoints,
      breakdown,
      rule_id: rule.id,
    });

    await publishEvent(base44, "ShipmentPriced", { shipment_id: ship.id, merchant_price: merchantPrice });

    await base44.asServiceRole.entities.AuditLog.create({
      actor_id: user.id,
      actor_name: user.full_name || "LEX",
      actor_role: user.role,
      action: "shipment.priced",
      entity_type: "Shipment",
      entity_id: ship.id,
      details: "Quote $" + merchantPrice + " (carrier $" + carrierCompensation + ", margin $" + platformMargin + ")",
      severity: "info",
    });

    await base44.asServiceRole.entities.Notification.create({
      recipient_type: "merchant",
      recipient_id: ship.created_by_id,
      channel: "in_app",
      subject: "Price quote ready — " + (ship.tracking_id || ship.id),
      body: "Merchant price: $" + merchantPrice + ". Carrier compensation: $" + carrierCompensation + ". Reward points: " + rewardPoints + ".",
      status: "sent",
      related_entity_id: ship.id,
    });

    return Response.json({ quote });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}