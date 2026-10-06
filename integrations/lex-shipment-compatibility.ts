/** Portable Base44/Node preflight. No persistence, fallback weights, or network calls. */
export type WeightReviewCode =
  | 'WEIGHT_REVIEW_REQUIRED'
  | 'INVALID_WEIGHT'
  | 'CONFLICTING_WEIGHT'
  | 'UNVERIFIED_PACKAGE_SHAPE'
  | 'CONFLICTING_PACKAGE_SIZE'
  | 'INVALID_PAYLOAD';
export type WeightPreparation =
  | { ok: true; payload: Record<string, unknown>; weight_sources: string[] }
  | {
      ok: false;
      code: WeightReviewCode;
      status: 'needs_information';
      retryable: false;
      render_attempted: false;
      needs_information: 'weight_kg';
      issues: string;
      message: string;
    };

function review(
  code: WeightReviewCode,
  message: string,
): Extract<WeightPreparation, { ok: false }> {
  return {
    ok: false,
    code,
    status: 'needs_information',
    retryable: false,
    render_attempted: false,
    needs_information: 'weight_kg',
    issues: message,
    message,
  };
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function absent(value: unknown) {
  return (
    value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
  );
}
function kilograms(value: unknown): number | null {
  // Decimal strings are used by PostgreSQL numeric columns in canonical read responses.
  // Never infer units from a bare `weight`, convert dimensional weight, or round measurements.
  if (typeof value === 'string') {
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(value.trim())) return null;
    value = Number(value.trim());
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1_000_000)
    return null;
  // Same exact decimal precision rule as the existing three-decimal API contract.
  const text = String(value);
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(text)) return null;
  return value;
}

/**
 * Input is a CREATE command payload, not an arbitrary existing shipment to recreate.
 * Supports only observed contracts: flat weight_kg and single package.weight_kg/size.
 * The caller owns stable command IDs and must retain the original source record/tracking ID.
 */
export function prepareLexShipmentWeight(input: unknown): WeightPreparation {
  if (!object(input))
    return review('INVALID_PAYLOAD', 'Shipment command payload must be an object');
  if (input.packages !== undefined)
    return review(
      'UNVERIFIED_PACKAGE_SHAPE',
      'Package collections need a verified complete manifest; automatic summation is disabled',
    );
  const pkg = input.package;
  if (
    pkg !== undefined &&
    (!object(pkg) || Object.keys(pkg).some((k) => !['weight_kg', 'size'].includes(k)))
  ) {
    return review(
      'UNVERIFIED_PACKAGE_SHAPE',
      'Only the documented single-package weight_kg/size projection can be translated',
    );
  }
  const hasOverride = !absent(input.weight_override_kg);
  if (hasOverride && input.weight_source !== 'entered') {
    return review(
      'INVALID_WEIGHT',
      'A weight_override_kg requires the existing entered-weight provenance; do not infer or guess it',
    );
  }
  const candidates = [
    { path: 'weight_kg', raw: input.weight_kg },
    { path: 'weight_override_kg', raw: input.weight_override_kg },
    { path: 'package.weight_kg', raw: object(pkg) ? pkg.weight_kg : undefined },
  ].filter((c) => !absent(c.raw));
  if (!candidates.length)
    return review(
      'WEIGHT_REVIEW_REQUIRED',
      'No verified kilogram weight is available; retain this record for review without submitting or assigning a default',
    );
  const values = candidates.map((c) => kilograms(c.raw));
  const invalid = values.findIndex((v) => v === null);
  if (invalid !== -1)
    return review(
      'INVALID_WEIGHT',
      `${candidates[invalid]!.path} must be positive kilograms with at most three decimal places and no more than 1000000 kg`,
    );
  if (values.some((v) => v !== values[0]))
    return review(
      'CONFLICTING_WEIGHT',
      'Shipment and package weights disagree; review the source measurements',
    );
  const payload: Record<string, unknown> = { ...input, weight_kg: values[0]! };
  if (hasOverride) {
    delete payload.weight_override_kg;
    delete payload.weight_source;
  }
  if (object(pkg)) {
    if (!absent(pkg.size)) {
      if (!absent(input.package_size) && input.package_size !== pkg.size)
        return review('CONFLICTING_PACKAGE_SIZE', 'Shipment and package sizes disagree');
      payload.package_size = pkg.size;
    }
    delete payload.package;
  }
  return { ok: true, payload, weight_sources: candidates.map((c) => c.path) };
}

/** Resolve only measurement fields on a source record. Caller must verify any cross-record link. */
export function resolveLexShipmentWeight(source: unknown) {
  if (!object(source))
    return review('INVALID_PAYLOAD', 'Source shipment/package must be an object');
  const result = prepareLexShipmentWeight({
    weight_kg: source.weight_kg,
    weight_override_kg: source.weight_override_kg,
    weight_source: source.weight_source,
    ...(source.package === undefined ? {} : { package: source.package }),
    ...(source.packages === undefined ? {} : { packages: source.packages }),
  });
  if (!result.ok) return result;
  return {
    ok: true as const,
    weight_kg: result.payload.weight_kg as number,
    weight_sources: result.weight_sources,
  };
}
