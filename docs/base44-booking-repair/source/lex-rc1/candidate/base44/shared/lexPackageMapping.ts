// Shared package-field mapping for the cross-app hub. Normalizes weight and
// service_level values arriving from sibling apps (NOC, Merchant, Carrier) into
// the LEX engine contract, and identifies test fixtures so they can be excluded
// from operational engine sync. Imported by lexIngest and lexSyncEngine â€” never
// copied. Weights are never invented: a missing weight resolves to null.
const LB_TO_KG = 0.45359237;
const G_TO_KG = 0.001;
const OZ_TO_KG = 0.0283495231;

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function positive(n: any): number | null {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : null;
}

// Map any plausible weight field name to a positive kg value, converting units
// where necessary. Returns null when no usable weight is present.
export function mapWeight(pkg: any): number | null {
  if (!pkg || typeof pkg !== "object") return null;
  const entries: Array<[string, any]> = Object.entries(pkg);
  // Explicit-unit fields first so unit conversion is unambiguous.
  for (const [k, v] of entries) {
    const key = String(k).toLowerCase().trim();
    const n = positive(v);
    if (n === null) continue;
    if (key === "weight_kg" || key === "kg" || key === "weightkilograms") return round(n);
    if (key === "weight_lbs" || key === "weight_lb" || key === "lbs" || key === "lb" || key === "pounds" || key === "weight_pounds") return round(n * LB_TO_KG);
    if (key === "weight_g" || key === "grams" || key === "gram") return round(n * G_TO_KG);
    if (key === "weight_oz" || key === "oz" || key === "ounces") return round(n * OZ_TO_KG);
  }
  // Generic weight fields â€” assumed kg (the canonical hub unit).
  for (const [k, v] of entries) {
    const key = String(k).toLowerCase().trim();
    if (key === "weight" || key === "package_weight" || key === "shipment_weight" || key === "wt") {
      const n = positive(v);
      if (n !== null) return round(n);
    }
  }
  return null;
}

const SERVICE_LEVEL_MAP: Record<string, string> = {
  standard: "standard", normal: "standard", economy: "standard", regular: "standard", basic: "standard",
  express: "express", expedited: "express", priority: "express",
  same_day: "same_day", sameday: "same_day", rush: "same_day", critical: "same_day", urgent: "same_day",
  overnight: "overnight", next_day: "overnight", nextday: "overnight",
};

export function mapServiceLevel(val: any): string {
  if (!val) return "standard";
  const norm = String(val).toLowerCase().trim().replace(/[-\s]+/g, "_");
  return SERVICE_LEVEL_MAP[norm] || "standard";
}

// Legacy advisory helper only. Never use prefixes/flags as trusted isolation
// or as authority to suppress operational processing. Current mutation paths
// use protected mappings plus persisted backend isolation.
const TEST_PATTERNS = [
  /(^|[-_])test([-_]|$)/i,
  /(^|[-_])qa(\d|$|[-_])/i,
  /(^|[-_])conn[-_]?test([-_]|$)/i,
  /(^|[-_])sec[-_]?test([-_]|$)/i,
  /(^|[-_])ingest([-_]|$)/i,
  /(^|[-_])dummy([-_]|$)/i,
  /(^|[-_])sample([-_]|$)/i,
  /(^|[-_])demo([-_]|$)/i,
];

export function detectTest(tracking_id: string, pkg: any): boolean {
  const tid = String(tracking_id || "");
  if (TEST_PATTERNS.some((re) => re.test(tid))) return true;
  if (pkg && pkg.is_test === true) return true;
  const m = pkg && (pkg.merchant_name || pkg.note);
  if (m && /(^|[-_\s])(test|demo|sample|fixture|probe|roundtrip)([-_\s]|$)/i.test(String(m))) return true;
  return false;
}

// Effective weight for engine sync: a manual override (entered in the hub) takes
// precedence over the source-provided weight; both must be > 0.
export function effectiveWeight(pkg: any): number | null {
  const ov = positive(pkg && pkg.weight_override_kg);
  if (ov !== null) return ov;
  return positive(pkg && pkg.weight_kg);
}
