import { readFile } from 'node:fs/promises';
import { resolveLexShipmentWeight } from '../integrations/lex-shipment-compatibility.js';

// Read-only export inspection. No network, updates, guessed values, or synchronization claims.
const file = process.argv[2];
if (!file || process.argv.length !== 3)
  throw new Error('Usage: npm run audit:lex-weights -- /path/to/records.json');
const records: unknown = JSON.parse(await readFile(file, 'utf8'));
if (!Array.isArray(records) || records.length > 10000)
  throw new Error('Expected an array of at most 10000 shipment/package records');
const results = records.map((record: unknown, index: number) => {
  const data =
    record && typeof record === 'object' && !Array.isArray(record)
      ? (record as Record<string, unknown>)
      : {};
  const weight = resolveLexShipmentWeight(record);
  return {
    index,
    source_id: data.id ?? null,
    tracking_id: data.tracking_id ?? null,
    created_at: data.created_date ?? data.created_at ?? null,
    status: weight.ok ? 'weight_ready' : 'needs_information',
    ...(weight.ok
      ? { weight_kg: weight.weight_kg, weight_sources: weight.weight_sources }
      : { code: weight.code, reason: weight.message }),
  };
});
console.log(
  JSON.stringify(
    {
      mode: 'read_only_weight_audit',
      records: results.length,
      weight_ready: results.filter((r) => r.status === 'weight_ready').length,
      needs_information: results.filter((r) => r.status === 'needs_information').length,
      render_attempted: false,
      results,
    },
    null,
    2,
  ),
);
