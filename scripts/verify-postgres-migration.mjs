import assert from 'node:assert/strict';
import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, 'DATABASE_URL is required');
const parsedUrl = new URL(databaseUrl);
assert.ok(
  ['localhost', '127.0.0.1', '::1'].includes(parsedUrl.hostname),
  'Migration verification only permits a loopback database host',
);
assert.equal(parsedUrl.pathname, '/lex_test', 'Migration verification only permits lex_test');

const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
const shipmentId = '10000000-0000-4000-8000-000000000101';
const commandId = '10000000-0000-4000-8000-000000000102';
const eventId = '10000000-0000-4000-8000-000000000103';
const destinationId = '10000000-0000-4000-8000-000000000104';
const legacyEnvelope = {
  event_id: eventId,
  event_type: 'ShipmentCreated',
  payload: { status: 'created', version: 1 },
};
const expectedShipment = {
  id: shipmentId,
  shipment_id: 'SHP_10000000000040008000000000000101',
  tracking_id: 'LEX-CI-LEGACY-001',
  owner_user_id: 'merchant-ci-user-1',
  origin: 'Lagos',
  destination: 'Abuja',
  status: 'matched',
  version: 4,
  weight_kg: '4.250',
  package_size: 'medium',
  service_level: 'express',
  pickup_deadline: '2030-01-01T10:00:00.000Z',
  delivery_deadline: '2030-01-01T18:00:00.000Z',
};

async function migrationNames() {
  const result = await pool.query('SELECT name FROM lex.schema_migrations ORDER BY name');
  return result.rows.map((row) => row.name);
}

async function snapshot() {
  const result = await pool.query(
    `SELECT s.id::text AS id, i.public_id AS shipment_id, s.tracking_id, s.owner_user_id,
            s.origin, s.destination, s.status, s.version, s.weight_kg::text AS weight_kg,
            s.package_size, s.service_level, s.pickup_deadline, s.delivery_deadline
       FROM lex.shipments s
       JOIN core.shipment_identifiers i ON i.id=s.id
      WHERE s.id=$1`,
    [shipmentId],
  );
  const row = result.rows[0];
  assert.ok(row, 'pre-existing Shipment must remain present');
  return {
    ...row,
    pickup_deadline: row.pickup_deadline.toISOString(),
    delivery_deadline: row.delivery_deadline.toISOString(),
  };
}

async function seed() {
  assert.deepEqual(await migrationNames(), ['001_core.sql', '002_domain_foundation.sql']);
  assert.equal(
    (await pool.query("SELECT to_regclass('lex.merchant_shipment_refs') AS relation")).rows[0]
      .relation,
    null,
    'migration 003 must not already be applied in the staged baseline',
  );
  await pool.query('INSERT INTO lex.commands(id,actor_id,fingerprint,result) VALUES($1,$2,$3,$4)', [
    commandId,
    'merchant-ci-user-1',
    'migration-verification-seed',
    { seeded: true },
  ]);
  await pool.query(
    `INSERT INTO lex.shipments(
       id,tracking_id,owner_user_id,origin,destination,weight_kg,package_size,service_level,
       pickup_deadline,delivery_deadline,status,version
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      shipmentId,
      'LEX-CI-LEGACY-001',
      'merchant-ci-user-1',
      'Lagos',
      'Abuja',
      4.25,
      'medium',
      'express',
      '2030-01-01T10:00:00.000Z',
      '2030-01-01T18:00:00.000Z',
      'matched',
      4,
    ],
  );
  await pool.query(
    'INSERT INTO lex.outbox(id,event_type,aggregate_id,aggregate_version,envelope) VALUES($1,$2,$3,1,$4)',
    [eventId, 'ShipmentCreated', shipmentId, legacyEnvelope],
  );
  await pool.query(
    'INSERT INTO lex.destinations(id,name,client_id,url,secret_ref,event_types) VALUES($1,$2,$3,$4,$5,$6)',
    [
      destinationId,
      'Existing LEX',
      'ci-platform',
      'https://receiver.example.com/legacy',
      'ci-webhook',
      ['ShipmentCreated'],
    ],
  );
  const seeded = await snapshot();
  assert.deepEqual(seeded, expectedShipment);
  process.stdout.write(`Seeded pre-003 Shipment snapshot: ${JSON.stringify(seeded)}\n`);
}

async function verify() {
  for (const name of [
    '001_core.sql',
    '002_domain_foundation.sql',
    '003_merchant_shipment_integration.sql',
    '004_canonical_webhook_delivery.sql',
  ]) {
    const count = await pool.query(
      'SELECT count(*)::int AS count FROM lex.schema_migrations WHERE name=$1',
      [name],
    );
    assert.equal(count.rows[0].count, 1, `${name} must be recorded exactly once`);
  }
  assert.deepEqual(
    await snapshot(),
    expectedShipment,
    'migration 003 must preserve the legacy Shipment',
  );
  const oldEvent = (
    await pool.query(
      'SELECT envelope,canonical_envelope,dispatched_at FROM lex.outbox WHERE id=$1',
      [eventId],
    )
  ).rows[0];
  assert.deepEqual(oldEvent.envelope, legacyEnvelope);
  assert.equal(oldEvent.canonical_envelope, null, 'No synthetic historical snapshot');
  assert.equal(oldEvent.dispatched_at, null, 'Migration does not dispatch events');
  const oldDestination = (
    await pool.query('SELECT envelope_format,active FROM lex.destinations WHERE id=$1', [
      destinationId,
    ])
  ).rows[0];
  assert.deepEqual(oldDestination, { envelope_format: 'legacy_v1', active: true });
  assert.equal(
    (await pool.query('SELECT count(*)::int AS count FROM lex.deliveries')).rows[0].count,
    0,
  );
  const referenceRelation = await pool.query(
    "SELECT to_regclass('lex.merchant_shipment_refs') AS relation",
  );
  assert.notEqual(referenceRelation.rows[0].relation, null, 'Merchant reference table must exist');
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int AS count FROM lex.merchant_shipment_refs WHERE shipment_id=$1',
        [shipmentId],
      )
    ).rows[0].count,
    0,
    'legacy Shipment remains without an invented Merchant reference',
  );

  const constraints = await pool.query(
    `SELECT conname, contype FROM pg_constraint
      WHERE conrelid='lex.merchant_shipment_refs'::regclass ORDER BY conname`,
  );
  const byName = new Map(constraints.rows.map((row) => [row.conname, row.contype]));
  for (const [name, type] of [
    ['merchant_shipment_refs_pkey', 'p'],
    ['merchant_shipment_refs_command_id_key', 'u'],
    ['merchant_shipment_refs_merchant_id_order_id_key', 'u'],
    ['merchant_shipment_refs_shipment_id_fkey', 'f'],
    ['merchant_shipment_refs_command_id_fkey', 'f'],
  ]) {
    assert.equal(byName.get(name), type, `expected ${type} constraint ${name}`);
  }
  const indexes = await pool.query(
    "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='lex' AND tablename='merchant_shipment_refs' ORDER BY indexname",
  );
  const indexByName = new Map(indexes.rows.map((row) => [row.indexname, row.indexdef]));
  assert.ok(indexByName.get('merchant_shipment_external_id_uq')?.includes('UNIQUE'));
  assert.ok(indexByName.get('merchant_shipment_refs_merchant_idx'));
  assert.equal(indexByName.size, 5, 'migration 003 must create exactly the expected five indexes');

  const rowSecurity = await pool.query(
    `SELECT c.relrowsecurity FROM pg_class c WHERE c.oid='lex.merchant_shipment_refs'::regclass`,
  );
  assert.equal(
    rowSecurity.rows[0].relrowsecurity,
    true,
    'Merchant reference table must enable RLS',
  );
  const orderTables = await pool.query(
    `SELECT table_schema,table_name FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog','information_schema')
        AND table_type='BASE TABLE' AND table_name ILIKE '%order%'`,
  );
  assert.deepEqual(orderTables.rows, [], 'migration 003 must not create an Order table');
  process.stdout.write('PostgreSQL migration and Shipment preservation assertions passed\n');
}

try {
  const mode = process.argv[2];
  if (mode === 'seed') await seed();
  else if (mode === 'verify') await verify();
  else throw new Error('Usage: node scripts/verify-postgres-migration.mjs <seed|verify>');
} finally {
  await pool.end();
}
