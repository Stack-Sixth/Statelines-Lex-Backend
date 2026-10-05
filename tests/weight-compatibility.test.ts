import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareLexShipmentWeight,
  resolveLexShipmentWeight,
} from '../integrations/lex-shipment-compatibility.js';

test('valid flat kilograms preserve the existing payload and do not mutate source', () => {
  const payload = {
    command_id: 'preserve-command',
    weight_kg: 2.125,
    package_size: 'small',
    other: 'preserve',
  };
  const before = structuredClone(payload);
  const result = prepareLexShipmentWeight(payload);
  assert.ok(result.ok);
  assert.deepEqual(result.payload, payload);
  assert.deepEqual(result.weight_sources, ['weight_kg']);
  assert.deepEqual(payload, before);
});

test('documented single-package decimal weight maps without rounding or overwriting identity', () => {
  const payload = {
    command_id: 'preserve-command',
    tracking_id: 'SHP-legacy',
    version: 4,
    package: { weight_kg: '2.125', size: 'small' },
  };
  const before = structuredClone(payload);
  const result = prepareLexShipmentWeight(payload);
  assert.ok(result.ok);
  assert.deepEqual(result.payload, {
    command_id: 'preserve-command',
    tracking_id: 'SHP-legacy',
    version: 4,
    weight_kg: 2.125,
    package_size: 'small',
  });
  assert.deepEqual(payload, before);
});

test('unknown legacy weights require review, never become zero or a guessed weight', () => {
  for (const payload of [
    {},
    { weight_kg: null },
    { weight_kg: '' },
    { weight: 2 },
    { package: {} },
  ]) {
    const result = prepareLexShipmentWeight(payload);
    assert.ok(!result.ok);
    assert.equal(result.code, 'WEIGHT_REVIEW_REQUIRED');
    assert.equal(result.retryable, false);
    assert.equal(result.render_attempted, false);
    assert.equal(result.status, 'needs_information');
  }
});

test('invalid and unsupported precision/unit values cannot bypass validation', () => {
  for (const value of [
    0,
    -1,
    NaN,
    Infinity,
    true,
    false,
    '2kg',
    '2 lb',
    '2,5',
    '1e2',
    0.0001,
    '1.2345',
    1000001,
    {},
    [],
  ]) {
    const result = prepareLexShipmentWeight({ weight_kg: value, package: { weight_kg: 2 } });
    assert.ok(!result.ok);
    assert.equal(result.code, 'INVALID_WEIGHT', String(value));
  }
});

test('conflicting shipment/package weights or sizes stop instead of choosing a convenient value', () => {
  const weight = prepareLexShipmentWeight({ weight_kg: 2, package: { weight_kg: 3 } });
  assert.ok(!weight.ok);
  assert.equal(weight.code, 'CONFLICTING_WEIGHT');
  const size = prepareLexShipmentWeight({
    weight_kg: 2,
    package_size: 'large',
    package: { size: 'small' },
  });
  assert.ok(!size.ok);
  assert.equal(size.code, 'CONFLICTING_PACKAGE_SIZE');
  const same = prepareLexShipmentWeight({ weight_kg: 2, package: { weight_kg: '2.000' } });
  assert.ok(same.ok);
  assert.equal(same.payload.weight_kg, 2);
});

test('unverified package collections and metadata are never silently discarded or summed', () => {
  for (const payload of [
    { packages: [{ weight_kg: 1 }] },
    { package: { weight_kg: 1, unit: 'lb' } },
    { package: [] },
  ]) {
    const result = prepareLexShipmentWeight(payload);
    assert.ok(!result.ok);
    assert.equal(result.code, 'UNVERIFIED_PACKAGE_SHAPE');
  }
  assert.equal(prepareLexShipmentWeight(null).ok, false);
});

test('published CrossAppPackage entered override is mapped only with provenance and without source mutation', () => {
  const source = {
    id: 'package-existing',
    tracking_id: 'SHP-existing',
    weight_override_kg: 3.25,
    weight_source: 'entered',
    sync_status: 'pending',
  };
  const before = structuredClone(source);
  const result = resolveLexShipmentWeight(source);
  assert.ok(result.ok);
  assert.equal(result.weight_kg, 3.25);
  assert.deepEqual(result.weight_sources, ['weight_override_kg']);
  assert.deepEqual(source, before);
  const unknownProvenance = resolveLexShipmentWeight({ weight_override_kg: 3.25 });
  assert.ok(!unknownProvenance.ok);
  assert.equal(unknownProvenance.code, 'INVALID_WEIGHT');
  const conflict = resolveLexShipmentWeight({ ...source, weight_kg: 4 });
  assert.ok(!conflict.ok);
  assert.equal(conflict.code, 'CONFLICTING_WEIGHT');
});
