// Render read/write adaptation for the documented `weight_kg` asymmetry.
//
// Write side (handoff Â§2a, contract Â§4.6): `weight_kg` is sent as a JSON number.
// Read side (handoff Â§2c, contract Â§1.5): the engine returns a decimal STRING
// such as "2.500". LEX consumes weights as numbers (bundling, capacity, pricing),
// so reads are normalized here.
//
// This only touches responses returned to LEX callers. The submitted Carrier
// contract and everything sent to the engine are unchanged.

function numberOrOriginal(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed === "") return value;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : value;
}

function normalizeShipment(shipment: any): any {
  if (!shipment || typeof shipment !== "object" || Array.isArray(shipment)) return shipment;
  if (!("weight_kg" in shipment)) return shipment;
  return { ...shipment, weight_kg: numberOrOriginal(shipment.weight_kg) };
}

// Accepts a raw response body string and returns the normalized value, or null
// when the body is not JSON (the caller then forwards the original bytes).
export function normalizeShipmentRead(text: string): unknown | null {
  let parsed: any;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) return parsed.map(normalizeShipment);
  if (parsed && typeof parsed === "object" && parsed.shipment) return { ...parsed, shipment: normalizeShipment(parsed.shipment) };
  if (parsed && Array.isArray(parsed.items)) return { ...parsed, items: parsed.items.map(normalizeShipment) };
  return normalizeShipment(parsed);
}
