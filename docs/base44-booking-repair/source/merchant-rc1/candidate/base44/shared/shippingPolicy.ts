// Canonical shipping policy data and validation logic for server-side use.
// Imported by the validateShipmentCompliance backend function.
// The frontend display copy lives in src/lib/shippingPolicy.js — keep in sync.

export const POLICY_VERSION = "1.0";

// Category classification for server-side validation.
// Each entry maps a category id to its eligibility status.
export const CATEGORY_STATUS: Record<string, string> = {
  // Permitted
  "general-dry-goods": "permitted",
  "consumer-electronics": "permitted",
  "non-hazardous-liquids": "permitted",
  "non-perishable-food": "permitted",
  "otc-healthcare": "permitted",
  "industrial-automotive": "permitted",
  // Prohibited
  "explosives-incendiaries": "prohibited",
  "compressed-gases": "prohibited",
  "flammable-liquids": "prohibited",
  "toxic-corrosives": "prohibited",
  "loose-lithium-batteries": "prohibited",
  "damaged-batteries": "prohibited",
  "illegal-drugs": "prohibited",
  "firearms-weapons": "prohibited",
  "alcohol-tobacco-vaping": "prohibited",
  "cannabis-cbd": "prohibited",
  "perishable-foods": "prohibited",
  "live-animals-biological": "prohibited",
  "cremated-remains": "prohibited",
  "other-prohibited": "prohibited",
  // Restricted
  "alcohol-sanitizer": "restricted",
  "alcohol-cosmetics": "restricted",
  "tier1-battery-exceeding-limits": "restricted",
  "industrial-battery-equipment": "restricted",
  "large-format-batteries": "restricted",
};

// Keyword-based prohibited item detection. If the contents description
// contains any of these keywords, the shipment is flagged.
export const PROHIBITED_KEYWORDS: Record<string, string[]> = {
  "explosives-incendiaries": ["ammunition", "ammo", "firework", "flare", "blasting cap", "black powder", "flash powder", "flash cotton", "flash paper", "dynamite", "tnt", "c4"],
  "compressed-gases": ["aerosol", "propane", "butane", "fire extinguisher", "oxygen tank", "scuba tank", "helium tank", "nitrogen canister", "co2 cartridge", "compressed gas"],
  "flammable-liquids": ["gasoline", "diesel", "kerosene", "lighter fluid", "oil-based paint", "paint thinner", "acetone", "nail polish", "solvent", "rubbing alcohol", "isopropyl alcohol", "perfume", "cologne", "aftershave", "turpentine", "mineral spirits"],
  "toxic-corrosives": ["pesticide", "herbicide", "acid", "corrosive", "mercury", "lye", "drain cleaner", "chemical reagent"],
  "loose-lithium-batteries": ["power bank", "portable charger", "external battery", "spare battery", "loose battery", "battery pack", "powerbank"],
  "damaged-batteries": ["damaged battery", "swollen battery", "leaking battery", "recalled battery", "bloated battery"],
  "illegal-drugs": ["marijuana", "cannabis", "weed", "narcotics", "controlled substance", "cocaine", "heroin", "methamphetamine"],
  "firearms-weapons": ["firearm", "handgun", "rifle", "shotgun", "switchblade", "stun gun", "taser", "ammunition"],
  "alcohol-tobacco-vaping": ["wine", "liquor", "beer", "spirits", "alcohol", "tobacco", "cigarette", "cigar", "vape", "e-cigarette", "e-liquid", "vape juice", "nicotine"],
  "cannabis-cbd": ["cannabis", "marijuana", "cbd", "hemp", "delta-8", "delta-9", "thc", "weed", "edibles"],
  "perishable-foods": ["fresh meat", "frozen", "refrigerated", "perishable", "dairy", "fresh produce", "raw meat"],
  "live-animals-biological": ["live animal", "live pet", "biological sample", "medical specimen", "live culture"],
  "cremated-remains": ["cremated remains", "ashes", "human remains", "pet remains"],
};

// Keyword-based restricted item detection.
export const RESTRICTED_KEYWORDS: Record<string, string[]> = {
  "alcohol-sanitizer": ["hand sanitizer", "sanitizer"],
  "alcohol-cosmetics": ["alcohol-based cosmetic", "alcohol cosmetic"],
  "tier1-battery-exceeding-limits": ["large battery", "multiple battery", "battery bank"],
  "industrial-battery-equipment": ["industrial battery", "industrial equipment battery"],
  "large-format-batteries": ["e-bike", "electric bike", "mobility scooter", "solar battery", "golf cart battery"],
};

// Battery validation: installed batteries are permitted under Tier 1, loose
// batteries are prohibited.
export function validateBattery(hasBattery: boolean, batteryDetails: string): { status: string; reason: string } {
  if (!hasBattery) return { status: "permitted", reason: "No battery declared." };

  const details = (batteryDetails || "").toLowerCase();

  // Loose / spare / power bank → prohibited
  if (PROHIBITED_KEYWORDS["loose-lithium-batteries"].some((kw) => details.includes(kw))) {
    return {
      status: "prohibited",
      reason: "Loose, spare, or standalone lithium batteries are prohibited. Only pre-installed, non-removable batteries in devices are permitted under the Tier 1 Battery Rule.",
    };
  }

  // Damaged / recalled → prohibited
  if (PROHIBITED_KEYWORDS["damaged-batteries"].some((kw) => details.includes(kw))) {
    return {
      status: "prohibited",
      reason: "Damaged, swollen, leaking, or recalled batteries are strictly prohibited, including within devices.",
    };
  }

  // Large-format / industrial → restricted
  if (RESTRICTED_KEYWORDS["tier1-battery-exceeding-limits"].some((kw) => details.includes(kw)) ||
      RESTRICTED_KEYWORDS["large-format-batteries"].some((kw) => details.includes(kw))) {
    return {
      status: "restricted",
      reason: "Battery specifications exceed standard Tier 1 limits. Compliance review required.",
    };
  }

  // Default: installed battery, no red flags → permitted under Tier 1
  return {
    status: "permitted",
    reason: "Pre-installed battery permitted under Tier 1 Battery Rule. Device must be powered off and terminals protected.",
  };
}

// Main validation function. Returns the compliance decision for a shipment.
export function validateCompliance(input: {
  itemCategory: string;
  contentsDescription: string;
  quantity: number;
  hasBattery: boolean;
  batteryDetails: string;
}): {
  status: "permitted" | "restricted" | "prohibited" | "unknown";
  reason: string;
  packagingConditions: string;
  reviewRequired: boolean;
  matchedCategory: string | null;
} {
  const { itemCategory, contentsDescription, quantity, hasBattery, batteryDetails } = input;
  const desc = (contentsDescription || "").toLowerCase();
  const cat = (itemCategory || "").toLowerCase().trim();

  // 1. Check prohibited keywords in contents description
  for (const [catId, keywords] of Object.entries(PROHIBITED_KEYWORDS)) {
    if (keywords.some((kw) => desc.includes(kw))) {
      return {
        status: "prohibited",
        reason: `Contents match prohibited category: ${catId}. This item cannot be shipped via Statelines.`,
        packagingConditions: "Not shippable via Statelines.",
        reviewRequired: false,
        matchedCategory: catId,
      };
    }
  }

  // 2. Check restricted keywords in contents description
  for (const [catId, keywords] of Object.entries(RESTRICTED_KEYWORDS)) {
    if (keywords.some((kw) => desc.includes(kw))) {
      return {
        status: "restricted",
        reason: `Contents match restricted category: ${catId}. Advance compliance approval is required before shipping.`,
        packagingConditions: "Pending compliance review — submit product specifications and packaging details.",
        reviewRequired: true,
        matchedCategory: catId,
      };
    }
  }

  // 3. Check battery rules
  if (hasBattery) {
    const batteryResult = validateBattery(hasBattery, batteryDetails);
    if (batteryResult.status === "prohibited") {
      return {
        status: "prohibited",
        reason: batteryResult.reason,
        packagingConditions: "Not shippable via Statelines.",
        reviewRequired: false,
        matchedCategory: "loose-lithium-batteries",
      };
    }
    if (batteryResult.status === "restricted") {
      return {
        status: "restricted",
        reason: batteryResult.reason,
        packagingConditions: "Pending compliance review — submit battery specifications.",
        reviewRequired: true,
        matchedCategory: "tier1-battery-exceeding-limits",
      };
    }
  }

  // 4. Check category-based classification
  if (cat && CATEGORY_STATUS[cat]) {
    const catStatus = CATEGORY_STATUS[cat];
    if (catStatus === "prohibited") {
      return {
        status: "prohibited",
        reason: `Category '${cat}' is prohibited under Statelines' Zero-Hazmat policy.`,
        packagingConditions: "Not shippable via Statelines.",
        reviewRequired: false,
        matchedCategory: cat,
      };
    }
    if (catStatus === "restricted") {
      return {
        status: "restricted",
        reason: `Category '${cat}' requires advance compliance approval.`,
        packagingConditions: "Pending compliance review.",
        reviewRequired: true,
        matchedCategory: cat,
      };
    }
    // Permitted category
    return {
      status: "permitted",
      reason: `Category '${cat}' is permitted under Statelines shipping guidelines.`,
      packagingConditions: hasBattery
        ? "Power off device, protect battery terminals, use sturdy packaging."
        : "Use strong, undamaged outer packaging. Fully enclosed and opaque.",
      reviewRequired: false,
      matchedCategory: cat,
    };
  }

  // 5. Unknown category — require manual review
  if (!cat || cat === "unknown" || cat === "unclassified") {
    return {
      status: "unknown",
      reason: "Item category is unclassified. Manual compliance review is required before this shipment can proceed.",
      packagingConditions: "Submit item description and specifications for compliance review.",
      reviewRequired: true,
      matchedCategory: null,
    };
  }

  // 6. Category not in our policy map — treat as unknown
  return {
    status: "unknown",
    reason: "Item category not found in approved policy directory. Manual review required.",
    packagingConditions: "Submit item description and specifications for compliance review.",
    reviewRequired: true,
    matchedCategory: null,
  };
}