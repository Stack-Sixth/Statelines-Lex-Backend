// Canonical Statelines price model.
//
// AUTHORITY: this module is the single pricing authority used by the Merchant
// app (requestLiveRate) and by booking validation (finalizeShipment). The
// booking screen mirrors the same arithmetic for immediate feedback, but the
// amount that is accepted, persisted on the Shipment and later charged is only
// ever the one this module returns.
//
// VERIFIED DEPENDENCY: the LEX/Render Domain API (LEX_API_URL) exposes
//   GET  /api/v1/shipments            → 200
//   POST /api/v1/shipments            → canonical create command
//   GET  /api/v1/shipments/:id        → canonical read
// and NO quote/rate route (/api/v1/quotes, /api/v1/quote, /api/v1/rates all
// return 404). Until LEX publishes a quote contract (see base44/shared/README
// note in requestLiveRate), prices are computed here and labelled as such —
// there is no competing external price source to reconcile.

export const RATE_VERSION = "2026-10-merchant-rate-v1";

// Every price produced by this module is computed locally. Consumers persist
// this label next to the amount so a locally priced booking is never mistaken
// for a LEX-quoted one.
export const PRICING_AUTHORITY = "statelines_rate_engine";

export const SERVICE_MULTIPLIERS: Record<string, number> = {
  saver: 0.85,
  standard: 1,
  priority: 1.6,
  express: 2.0,
  same_day: 2.4,
  overnight: 2.0,
};

export const SERVICE_DAYS: Record<string, number> = {
  saver: 7,
  standard: 5,
  priority: 2,
  express: 1,
  same_day: 0,
  overnight: 1,
};

export const MIN_RATE = 2.99;
export const INSURANCE_FEE = 2.5;
export const TAX_RATE = 0.08;
export const POINTS_PER_DOLLAR = 100;
export const CURRENCY = "USD";
// A quote is valid for 15 minutes. Booking re-validates it server-side.
export const QUOTE_TTL_SECONDS = 900;

export const PROMOS: Record<string, { percent: number; label: string }> = {
  SAVE10: { percent: 0.1, label: "10% off" },
  STAT15: { percent: 0.15, label: "15% off" },
  WELCOME5: { percent: 0.05, label: "5% off" },
};

export interface RateQuoteInput {
  weight_lb?: number;
  declared_value?: number;
  service_level?: string;
}

export interface RateQuote {
  rate: number;
  service_level: string;
  eta_days: number;
  base_rate: number;
  weight_component: number;
  value_component: number;
  multiplier: number;
}

export interface SettlementInput extends RateQuoteInput {
  insurance?: boolean;
  promo_code?: string;
  rewards_points?: number;
}

export interface Settlement {
  rate: number;
  insurance_fee: number;
  subtotal: number;
  promo_code: string;
  promo_discount: number;
  rewards_points: number;
  rewards_discount: number;
  taxable: number;
  tax: number;
  total: number;
  currency: string;
  service_level: string;
  eta_days: number;
  rate_version: string;
  pricing_authority: string;
  expires_at: string;
}

export function computeQuote(input: RateQuoteInput): RateQuote {
  // Weight falls back to 1 lb exactly as the booking flow does, so an
  // unfinished package still returns a usable quote.
  const weight = Number(input.weight_lb) > 0 ? Number(input.weight_lb) : 1;
  const declared = Number(input.declared_value) > 0 ? Number(input.declared_value) : 0;
  const requested = String(input.service_level || "standard");
  const level = requested in SERVICE_MULTIPLIERS ? requested : "standard";

  const weightComponent = round2(weight * 0.8);
  const valueComponent = round2(declared * 0.01);
  const baseRate = 3 + weightComponent + valueComponent;
  const multiplier = SERVICE_MULTIPLIERS[level];
  const rate = Math.max(MIN_RATE, round2(baseRate * multiplier));

  return {
    rate,
    service_level: level,
    eta_days: SERVICE_DAYS[level] ?? 5,
    base_rate: round2(baseRate),
    weight_component: weightComponent,
    value_component: valueComponent,
    multiplier,
  };
}

// The complete amount a merchant pays: service price, insurance, promo and
// rewards discounts, and tax. This is the number persisted on the booking and
// the number a charge would be raised against.
export function settlePrice(input: SettlementInput): Settlement {
  const quote = computeQuote(input);
  const insuranceFee = input.insurance ? INSURANCE_FEE : 0;
  const subtotal = round2(quote.rate + insuranceFee);

  const promoCode = normalizePromoCode(input.promo_code);
  const promo = promoCode ? PROMOS[promoCode] : null;
  const promoDiscount = promo ? round2(subtotal * promo.percent) : 0;

  const rewardsPoints = Math.max(0, Math.floor(Number(input.rewards_points) || 0));
  const rewardsRaw = Math.min(rewardsPoints / POINTS_PER_DOLLAR, Math.max(0, subtotal - promoDiscount));
  const rewardsDiscount = round2(rewardsRaw);

  const taxable = round2(Math.max(0, subtotal - promoDiscount - rewardsDiscount));
  const tax = round2(taxable * TAX_RATE);
  const total = round2(Math.max(0, taxable + tax));

  return {
    rate: quote.rate,
    insurance_fee: insuranceFee,
    subtotal,
    promo_code: promo ? promoCode : "",
    promo_discount: promoDiscount,
    rewards_points: rewardsPoints,
    rewards_discount: rewardsDiscount,
    taxable,
    tax,
    total,
    currency: CURRENCY,
    service_level: quote.service_level,
    eta_days: quote.eta_days,
    rate_version: RATE_VERSION,
    pricing_authority: PRICING_AUTHORITY,
    expires_at: new Date(Date.now() + QUOTE_TTL_SECONDS * 1000).toISOString(),
  };
}

export function normalizePromoCode(raw: unknown): string {
  const code = String(raw || "").trim().toUpperCase();
  return code && code in PROMOS ? code : "";
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}