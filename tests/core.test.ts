import { prepareLexShipmentWeight } from '../integrations/lex-shipment-compatibility.js';
import { internalId, publicId } from '../src/domains/identifiers.js';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { SignJWT } from 'jose';
import { buildApp } from '../src/app.js';
import { postgres, type Database, type Sql } from '../src/db.js';
import { configFromEnv, type Config, type Role } from '../src/config.js';
import { DeliveryWorker } from '../src/delivery.js';
import { publicAddress, signature, verifySignature, validateEndpoint } from '../src/webhooks.js';
const secret = 'test-only-secret-'.repeat(4);
const config: Config = {
  domainReadApiEnabled: true,
  databaseUrl: process.env.TEST_DATABASE_URL || 'postgresql://unused',
  databaseSsl: false,
  poolSize: 5,
  port: 3000,
  host: '127.0.0.1',
  logLevel: 'silent',
  clients: [
    { id: 'test', secret, roles: ['admin', 'operator', 'carrier', 'merchant'] },
    { id: 'statelines-merchant', secret: secret + 'merchant', roles: ['merchant'] },
    { id: 'statelines-other-merchant', secret: secret + 'other-merchant', roles: ['merchant'] },
    { id: 'wallet', secret: secret + 'wallet', roles: ['platform'] },
  ],
  webhookSecrets: { wallet: secret, lex_canonical: 'test-only-dedicated-webhook-key-'.repeat(3) },
  allowedHosts: ['receiver.example.com'],
  pollMs: 100,
  batchSize: 10,
  maxAttempts: 3,
  merchantDomainApiEnabled: true,
};
let db: Database;
let app: Awaited<ReturnType<typeof buildApp>>;
const admin = { role: 'admin' as Role, id: 'admin-1' };
async function token(actor = admin, client = 'test') {
  const cfg = config.clients.find((c) => c.id === client)!;
  return new SignJWT({ role: actor.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(client)
    .setAudience('statelines-lex')
    .setSubject(actor.id)
    .setIssuedAt()
    .setExpirationTime('2m')
    .sign(new TextEncoder().encode(cfg.secret));
}
async function call(
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
  actor = admin,
  client = 'test',
) {
  return app.inject({
    method,
    url,
    headers: { authorization: 'Bearer ' + (await token(actor, client)) },
    ...(body === undefined ? {} : { payload: body as object }),
  });
}
const inHours = (h: number) => new Date(Date.now() + h * 3600000).toISOString();
const shipBody = () => ({
  command_id: randomUUID(),
  owner_user_id: 'merchant-1',
  origin: 'Lagos',
  destination: 'Abuja',
  weight_kg: 5,
  package_size: 'small',
  service_level: 'standard',
  pickup_deadline: inHours(4),
  delivery_deadline: inHours(10),
});
const merchantActor = { role: 'merchant' as Role, id: 'merchant-user-1' };
const merchantShipmentBody = (overrides = {}) => ({
  command_id: randomUUID(),
  merchant_id: 'statelines-merchant',
  order_id: 'STL-ORDER-1',
  external_shipment_id: 'merchant-local-shipment-1',
  correlation_id: 'corr-merchant-1',
  origin: { corridor: 'Lagos' },
  destination: { corridor: 'Abuja' },
  service_level: 'standard',
  package_size: 'small',
  weight_kg: 0.45,
  pickup_deadline: inHours(4),
  delivery_deadline: inHours(10),
  ...overrides,
});
async function createShipment(overrides = {}) {
  const r = await call('POST', '/v1/shipments', { ...shipBody(), ...overrides });
  assert.equal(r.statusCode, 201, r.body);
  return r.json();
}
async function createCarrier(overrides = {}) {
  const r = await call('POST', '/v1/carriers', {
    command_id: randomUUID(),
    user_id: 'carrier-user',
    name: 'Test carrier',
    origin: 'Lagos',
    destination: 'Abuja',
    capacity_kg: 10,
    service_levels: ['standard'],
    package_sizes: ['small'],
    departure_at: inHours(1),
    arrival_at: inHours(8),
    ...overrides,
  });
  assert.equal(r.statusCode, 201, r.body);
  return r.json();
}
async function matched() {
  await createCarrier();
  const s = await createShipment();
  const r = await call('POST', `/v1/shipments/${s.id}/match`, {
    command_id: randomUUID(),
    expected_version: s.version,
  });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
async function transition(s: { id: string; version: number }, status: string, extra = {}) {
  const r = await call('POST', `/v1/shipments/${s.id}/transitions`, {
    command_id: randomUUID(),
    expected_version: s.version,
    status,
    ...extra,
  });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
async function delivered() {
  let s = await matched();
  for (const status of ['picked_up', 'in_transit', 'out_for_delivery', 'delivered'])
    s = await transition(s, status);
  return s;
}
async function destination() {
  const r = await call('POST', '/v1/destinations', {
    command_id: randomUUID(),
    name: 'Wallet',
    client_id: 'wallet',
    url: 'https://receiver.example.com/lex',
    secret_ref: 'wallet',
    event_types: [
      'ShipmentCreated',
      'ShipmentMatched',
      'ShipmentStatusChanged',
      'ShipmentDelivered',
      'WalletApprovalCreated',
    ],
  });
  assert.equal(r.statusCode, 201, r.body);
  return r.json();
}
const count = async (table: string) =>
  Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM lex.${table}`)).rows[0]!.n);
before(async () => {
  if (process.env.TEST_DATABASE_URL) {
    const url = new URL(process.env.TEST_DATABASE_URL);
    if (!url.pathname.endsWith('/lex_test'))
      throw Error('Tests only accept a disposable database named lex_test');
    db = postgres(config);
    await db.query(
      'DROP SCHEMA IF EXISTS core, merchant, carrier, pudo, operations, billing, audit, integration, lex CASCADE',
    );
  } else {
    const pg = new PGlite();
    await pg.waitReady;
    const wrap = (target: Pick<PGlite, 'query' | 'exec'>): Sql => ({
      async query<T>(sql: string, values: unknown[] = []) {
        if (!values.length && sql.includes(';')) {
          const results = await target.exec(sql);
          const r = results.at(-1);
          return { rows: (r?.rows || []) as T[], rowCount: r?.affectedRows || 0 };
        }
        const result = await target.query<T>(sql, values);
        return { rows: result.rows, rowCount: result.affectedRows || result.rows.length };
      },
    });
    db = {
      ...wrap(pg),
      transaction: (fn) => pg.transaction((tx) => fn(wrap(tx))),
      close: () => pg.close(),
    };
  }
  await db.query(await readFile('migrations/001_core.sql', 'utf8'));
  await db.query(await readFile('migrations/002_domain_foundation.sql', 'utf8'));
  await db.query(await readFile('migrations/003_merchant_shipment_integration.sql', 'utf8'));
  await db.query(await readFile('migrations/004_canonical_webhook_delivery.sql', 'utf8'));
  app = await buildApp(db, config);
});
after(async () => {
  await app?.close();
  await db?.close();
});
beforeEach(async () => {
  // Keep Fastify's in-memory rate-limit bucket isolated per test case.
  await app?.close();
  app = await buildApp(db, config);
  await db.query(
    'TRUNCATE lex.delivery_attempts,lex.deliveries,lex.destinations,lex.outbox,lex.audit_log,lex.wallet_approvals,lex.shipment_history,lex.shipments,lex.carriers,lex.commands,lex.worker_heartbeats CASCADE',
  );
});
test('health is available, business endpoints require authentication', async () => {
  assert.equal((await app.inject('/health/ready')).statusCode, 200);
  assert.equal((await app.inject('/v1/shipments')).statusCode, 401);
  const r = await call('GET', '/v1/operations/health');
  assert.equal(r.json().status, 'degraded');
});
test('rejects role escalation by a platform client', async () => {
  assert.equal(
    (await call('GET', '/v1/operations/health', undefined, admin, 'wallet')).statusCode,
    401,
  );
});
test('shipment command is idempotent and payload conflicts are rejected', async () => {
  const b = shipBody();
  const first = await call('POST', '/v1/shipments', b);
  const repeat = await call('POST', '/v1/shipments', b);
  assert.equal(first.statusCode, 201);
  assert.deepEqual(repeat.json(), first.json());
  assert.equal(await count('shipments'), 1);
  assert.equal(await count('outbox'), 1);
  assert.equal((await call('POST', '/v1/shipments', { ...b, weight_kg: 6 })).statusCode, 409);
});
test('invalid weights and merchant ownership are rejected', async () => {
  assert.equal(
    (await call('POST', '/v1/shipments', { ...shipBody(), weight_kg: -1 })).statusCode,
    400,
  );
  assert.equal(
    (await call('POST', '/v1/shipments', shipBody(), { role: 'merchant', id: 'other' })).statusCode,
    403,
  );
});
test('outbox storage failure rolls back shipment, history and command', async () => {
  await db.query(
    "CREATE FUNCTION lex.reject_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated disk failure'; END $$; CREATE TRIGGER reject_event BEFORE INSERT ON lex.outbox FOR EACH ROW EXECUTE FUNCTION lex.reject_event();",
  );
  try {
    assert.equal((await call('POST', '/v1/shipments', shipBody())).statusCode, 500);
    assert.equal(await count('shipments'), 0);
    assert.equal(await count('commands'), 0);
    assert.equal(await count('shipment_history'), 0);
  } finally {
    await db.query('DROP TRIGGER reject_event ON lex.outbox; DROP FUNCTION lex.reject_event();');
  }
});
test('matching rejects wrong destination, unsupported packages and late arrival', async () => {
  const c = await createCarrier({ destination: 'Kano' });
  const s = await createShipment();
  const match = () =>
    call('POST', `/v1/shipments/${s.id}/match`, { command_id: randomUUID(), expected_version: 1 });
  assert.equal((await match()).statusCode, 409);
  await db.query(
    "UPDATE lex.carriers SET destination='abuja',package_sizes=ARRAY['xl'] WHERE id=$1",
    [c.id],
  );
  assert.equal((await match()).statusCode, 409);
  await db.query("UPDATE lex.carriers SET package_sizes=ARRAY['small'],arrival_at=$2 WHERE id=$1", [
    c.id,
    inHours(12),
  ]);
  assert.equal((await match()).statusCode, 409);
});
test('concurrent matching cannot overbook carrier capacity', async () => {
  await createCarrier({ capacity_kg: 5 });
  const a = await createShipment();
  const b = await createShipment();
  const results = await Promise.all(
    [a, b].map((s) =>
      call('POST', `/v1/shipments/${s.id}/match`, {
        command_id: randomUUID(),
        expected_version: 1,
      }),
    ),
  );
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
  assert.equal(
    Number(
      (await db.query<{ reserved_kg: string }>('SELECT reserved_kg FROM lex.carriers')).rows[0]!
        .reserved_kg,
    ),
    5,
  );
});
test('assigned carrier authorization uses explicit user mapping', async () => {
  const s = await matched();
  const body = { command_id: randomUUID(), expected_version: 2, status: 'picked_up' };
  assert.equal(
    (
      await call('POST', `/v1/shipments/${s.id}/transitions`, body, {
        role: 'carrier',
        id: 'wrong-user',
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await call('POST', `/v1/shipments/${s.id}/transitions`, body, {
        role: 'carrier',
        id: 'carrier-user',
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await call('GET', `/v1/shipments/${s.id}`, undefined, { role: 'merchant', id: 'stranger' }))
      .statusCode,
    404,
  );
});
test('delivery releases capacity exactly once and rejects backward transitions', async () => {
  let s = await matched();
  for (const status of ['picked_up', 'in_transit', 'out_for_delivery'])
    s = await transition(s, status);
  const b = { command_id: randomUUID(), expected_version: s.version, status: 'delivered' };
  const first = await call('POST', `/v1/shipments/${s.id}/transitions`, b);
  const repeat = await call('POST', `/v1/shipments/${s.id}/transitions`, b);
  assert.deepEqual(first.json(), repeat.json());
  s = first.json();
  const c = (
    await db.query<{ reserved_kg: string; total_deliveries: number }>(
      'SELECT reserved_kg,total_deliveries FROM lex.carriers',
    )
  ).rows[0]!;
  assert.equal(Number(c.reserved_kg), 0);
  assert.equal(c.total_deliveries, 1);
  assert.equal(
    (
      await call('POST', `/v1/shipments/${s.id}/transitions`, {
        command_id: randomUUID(),
        expected_version: s.version,
        status: 'in_transit',
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await call('POST', `/v1/shipments/${s.id}/transitions`, {
        command_id: randomUUID(),
        expected_version: 1,
        status: 'cancelled',
      })
    ).json().error,
    'stale_version',
  );
});
test('return workflow reserves capacity and releases it on returned', async () => {
  let s = await delivered();
  s = await transition(s, 'return_in_transit', { note: 'Recipient requested return' });
  assert.equal(
    Number(
      (await db.query<{ reserved_kg: string }>('SELECT reserved_kg FROM lex.carriers')).rows[0]!
        .reserved_kg,
    ),
    5,
  );
  await transition(s, 'returned');
  const c = (
    await db.query<{ reserved_kg: string; total_deliveries: number }>(
      'SELECT reserved_kg,total_deliveries FROM lex.carriers',
    )
  ).rows[0]!;
  assert.equal(Number(c.reserved_kg), 0);
  assert.equal(c.total_deliveries, 1);
});
test('wallet requires delivery and concurrent approvals create one event', async () => {
  const pending = await createShipment();
  const body = {
    command_id: randomUUID(),
    expected_version: 1,
    amount_minor: 250000,
    currency: 'NGN',
  };
  assert.equal(
    (await call('POST', `/v1/shipments/${pending.id}/wallet-approval`, body)).statusCode,
    409,
  );
  const s = await delivered();
  const responses = await Promise.all(
    [1, 2].map(() =>
      call('POST', `/v1/shipments/${s.id}/wallet-approval`, {
        ...body,
        command_id: randomUUID(),
        expected_version: s.version,
      }),
    ),
  );
  assert.ok(responses.every((r) => r.statusCode === 200));
  assert.equal(responses[0]!.json().id, responses[1]!.json().id);
  assert.equal(await count('wallet_approvals'), 1);
  assert.equal(
    Number(
      (
        await db.query<{ n: string }>(
          "SELECT count(*) AS n FROM lex.outbox WHERE event_type='WalletApprovalCreated'",
        )
      ).rows[0]!.n,
    ),
    1,
  );
  assert.equal(
    (
      await call('POST', `/v1/shipments/${s.id}/wallet-approval`, {
        ...body,
        command_id: randomUUID(),
        expected_version: s.version,
        amount_minor: 1,
      })
    ).statusCode,
    409,
  );
});
test('webhook retries stop at configured ceiling; replay reconciles same record', async () => {
  await destination();
  await createShipment();
  let sends = 0;
  let succeed = false;
  const worker = new DeliveryWorker(db, config, async () => {
    sends++;
    return succeed
      ? { ok: true, retryable: false, status: 200 }
      : { ok: false, retryable: true, status: 503, error: 'unavailable' };
  });
  for (let i = 0; i < 5; i++) {
    await db.query('UPDATE lex.deliveries SET next_attempt_at=now()');
    await worker.tick();
  }
  assert.equal(sends, 3);
  const d = (await db.query<{ id: string; status: string }>('SELECT * FROM lex.deliveries'))
    .rows[0]!;
  assert.equal(d.status, 'dead_letter');
  succeed = true;
  assert.equal(
    (
      await call('POST', `/v1/deliveries/${d.id}/replay`, {
        command_id: randomUUID(),
        note: 'Receiver repaired',
      })
    ).statusCode,
    200,
  );
  await worker.tick();
  assert.equal(await count('deliveries'), 1);
  assert.equal(
    (await db.query<{ status: string }>('SELECT status FROM lex.deliveries')).rows[0]!.status,
    'accepted',
  );
});
test('disabled destinations receive no new retry calls', async () => {
  const d = await destination();
  await createShipment();
  let sends = 0;
  const worker = new DeliveryWorker(db, config, async () => {
    sends++;
    return { ok: false, retryable: true, status: 503 };
  });
  await worker.tick();
  await call('POST', `/v1/destinations/${d.id}/status`, {
    command_id: randomUUID(),
    active: false,
  });
  await db.query('UPDATE lex.deliveries SET next_attempt_at=now()');
  await worker.tick();
  assert.equal(sends, 1);
});
test('expired worker lease is reclaimed, with same event ID', async () => {
  await destination();
  const s = await createShipment();
  const received: string[] = [];
  const worker = new DeliveryWorker(db, config, async (_u, _k, e) => {
    received.push(String(e.event_id));
    return { ok: true, retryable: false, status: 200 };
  });
  await worker.fanout();
  const abandoned = await worker.claim();
  assert.ok(abandoned);
  assert.equal(await worker.claim(), undefined);
  await db.query("UPDATE lex.deliveries SET lease_until=now()-interval '1 minute'");
  await worker.tick();
  assert.deepEqual(received, [abandoned.event_id]);
  assert.equal(await count('deliveries'), 1);
  assert.ok(s.id);
});
test('concurrent workers cannot claim the same delivery', async () => {
  await destination();
  await createShipment();
  const worker = new DeliveryWorker(db, config, async () => ({
    ok: true,
    retryable: false,
    status: 200,
  }));
  await worker.fanout();
  const claims = await Promise.all([worker.claim(), worker.claim()]);
  assert.equal(claims.filter(Boolean).length, 1);
});
test('outbox fanout handles more than 200 events without duplicate deliveries', async () => {
  await destination();
  for (let i = 0; i < 205; i++) {
    const id = randomUUID();
    await db.query(
      'INSERT INTO lex.outbox(id,event_type,aggregate_id,aggregate_version,envelope) VALUES($1,$2,$3,1,$4)',
      [
        id,
        'ShipmentCreated',
        randomUUID(),
        JSON.stringify({ event_id: id, event_type: 'ShipmentCreated' }),
      ],
    );
  }
  const worker = new DeliveryWorker(db, config, async () => ({
    ok: true,
    retryable: false,
    status: 200,
  }));
  while (await worker.fanout()) {}
  await worker.fanout();
  assert.equal(await count('deliveries'), 205);
});
test('only destination owner may acknowledge processing', async () => {
  await destination();
  await createShipment();
  const worker = new DeliveryWorker(db, config, async () => ({
    ok: true,
    retryable: false,
    status: 200,
  }));
  await worker.tick();
  const d = (await db.query<{ id: string; event_id: string }>('SELECT * FROM lex.deliveries'))
    .rows[0]!;
  assert.equal(
    (
      await call('POST', `/v1/deliveries/${d.id}/processed`, {
        command_id: randomUUID(),
        event_id: d.event_id,
      })
    ).statusCode,
    403,
  );
  const r = await call(
    'POST',
    `/v1/deliveries/${d.id}/processed`,
    { command_id: randomUUID(), event_id: d.event_id },
    { id: 'wallet-worker', role: 'platform' },
    'wallet',
  );
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().status, 'processed');
});
test('webhook signatures bind body and time; destinations must be approved', () => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = signature(secret, timestamp, '{}');
  assert.equal(verifySignature(secret, timestamp, sig, '{}'), true);
  assert.equal(verifySignature(secret, timestamp, sig, '{"tampered":true}'), false);
  assert.equal(verifySignature(secret, '1', signature(secret, '1', '{}'), '{}'), false);
  assert.throws(() => validateEndpoint('http://receiver.example.com', config.allowedHosts));
  assert.throws(() => validateEndpoint('https://127.0.0.1', config.allowedHosts));
  for (const addr of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '100.64.0.1',
    '::1',
  ])
    assert.equal(publicAddress(addr), false, addr);
  assert.equal(publicAddress('8.8.8.8'), true);
});

test('receiver acknowledges only durable inbox records and detects duplicate/conflicting events', async () => {
  const { acceptEvent } = await import('../src/inbox.js');
  await db.query(await readFile('integrations/receiver-schema.sql', 'utf8'));
  await createShipment();
  const envelope = (
    await db.query<{ envelope: Record<string, unknown> }>('SELECT envelope FROM lex.outbox')
  ).rows[0]!.envelope;
  const body = JSON.stringify(envelope);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = signature(secret, timestamp, body);
  const first = await acceptEvent(db, secret, body, timestamp, sig);
  const duplicate = await acceptEvent(db, secret, body, timestamp, sig);
  assert.equal(first.status, 'accepted');
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  const changed = JSON.stringify({ ...envelope, event_type: 'DifferentEvent' });
  await assert.rejects(
    () => acceptEvent(db, secret, changed, timestamp, signature(secret, timestamp, changed)),
    /identity was reused/,
  );
  await db.query(
    "CREATE FUNCTION lex_receiver.reject_inbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'storage failure'; END $$; CREATE TRIGGER reject_inbox BEFORE INSERT ON lex_receiver.inbox FOR EACH ROW EXECUTE FUNCTION lex_receiver.reject_inbox();",
  );
  try {
    const failed = JSON.stringify({ ...envelope, event_id: randomUUID() });
    await assert.rejects(
      () => acceptEvent(db, secret, failed, timestamp, signature(secret, timestamp, failed)),
      /storage failure/,
    );
  } finally {
    await db.query(
      'DROP TRIGGER reject_inbox ON lex_receiver.inbox; DROP FUNCTION lex_receiver.reject_inbox();',
    );
  }
});

test('cancellation releases capacity and carrier schedules cannot change while reserved', async () => {
  const s = await matched();
  const schedule = {
    command_id: randomUUID(),
    origin: 'Abuja',
    destination: 'Lagos',
    service_levels: ['standard'],
    package_sizes: ['small'],
    departure_at: inHours(12),
    arrival_at: inHours(18),
    capacity_kg: 20,
    active: true,
  };
  assert.equal(
    (await call('POST', `/v1/carriers/${s.assigned_carrier_id}/schedule`, schedule)).statusCode,
    409,
  );
  await transition(s, 'cancelled');
  assert.equal(
    (await call('POST', `/v1/carriers/${s.assigned_carrier_id}/schedule`, schedule)).statusCode,
    200,
  );
});
test('return exception cannot be recovered into a second outbound delivery', async () => {
  let s = await delivered();
  s = await transition(s, 'return_in_transit', { note: 'Return requested' });
  s = await transition(s, 'exception', { note: 'Road closure' });
  assert.equal(
    (
      await call('POST', `/v1/shipments/${s.id}/transitions`, {
        command_id: randomUUID(),
        expected_version: s.version,
        status: 'out_for_delivery',
        note: 'Invalid recovery',
      })
    ).statusCode,
    409,
  );
  s = await transition(s, 'return_in_transit', { note: 'Road reopened' });
  await transition(s, 'returned');
});
test('historical backfill is paginated and does not duplicate existing deliveries', async () => {
  const worker = new DeliveryWorker(db, config, async () => ({
    ok: true,
    retryable: false,
    status: 200,
  }));
  await createShipment();
  await createShipment();
  await worker.fanout();
  assert.equal(await count('deliveries'), 0);
  const d = await destination();
  const b = { command_id: randomUUID(), from: inHours(-1), to: inHours(1), limit: 1 };
  const first = await call('POST', `/v1/destinations/${d.id}/backfill`, b);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().created, 1);
  const next = await call('POST', `/v1/destinations/${d.id}/backfill`, {
    ...b,
    command_id: randomUUID(),
    after: first.json().next_cursor,
  });
  assert.equal(next.json().created, 1);
  await call('POST', `/v1/destinations/${d.id}/backfill`, {
    ...b,
    command_id: randomUUID(),
    limit: 100,
  });
  assert.equal(await count('deliveries'), 2);
});
test('permanent receiver failure goes directly to dead letter', async () => {
  await destination();
  await createShipment();
  let sent = 0;
  const worker = new DeliveryWorker(db, config, async () => {
    sent++;
    return { ok: false, retryable: false, status: 401, error: 'invalid signature' };
  });
  await worker.tick();
  await worker.tick();
  assert.equal(sent, 1);
  assert.equal(
    (await db.query<{ status: string }>('SELECT status FROM lex.deliveries')).rows[0]!.status,
    'dead_letter',
  );
});
test('expired final attempt is terminal and is not sent again', async () => {
  await destination();
  await createShipment();
  let sent = 0;
  const worker = new DeliveryWorker(db, config, async () => {
    sent++;
    return { ok: true, retryable: false, status: 200 };
  });
  await worker.fanout();
  await worker.claim();
  await db.query(
    "UPDATE lex.deliveries SET attempts=max_attempts,lease_until=now()-interval '1 minute'",
  );
  await worker.tick();
  assert.equal(sent, 0);
  assert.equal(
    (await db.query<{ status: string }>('SELECT status FROM lex.deliveries')).rows[0]!.status,
    'dead_letter',
  );
});
test('expired service tokens are rejected', async () => {
  const expired = await new SignJWT({ role: 'admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('test')
    .setAudience('statelines-lex')
    .setSubject('admin-1')
    .setIssuedAt(Math.floor(Date.now() / 1000) - 400)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 200)
    .sign(new TextEncoder().encode(secret));
  assert.equal(
    (await app.inject({ url: '/v1/shipments', headers: { authorization: 'Bearer ' + expired } }))
      .statusCode,
    401,
  );
});
test('database RLS prevents a browser role from directly writing engine tables', async () => {
  await db.query(
    'CREATE ROLE lex_browser_test NOLOGIN; GRANT USAGE ON SCHEMA lex TO lex_browser_test; GRANT SELECT,UPDATE ON lex.shipments TO lex_browser_test;',
  );
  try {
    await createShipment();
    await db.transaction(async (sql) => {
      await sql.query('SET LOCAL ROLE lex_browser_test');
      assert.equal((await sql.query('SELECT * FROM lex.shipments')).rows.length, 0);
      assert.equal((await sql.query("UPDATE lex.shipments SET status='delivered'")).rowCount, 0);
    });
  } finally {
    await db.query('DROP OWNED BY lex_browser_test; DROP ROLE lex_browser_test;');
  }
});

test('canonical IDs round-trip full UUIDs and reject wrong entity prefixes', () => {
  const id = randomUUID();
  assert.equal(internalId('shipment', publicId('shipment', id)), id);
  assert.equal(internalId('shipment', id.toUpperCase()), id);
  assert.throws(() => internalId('shipment', publicId('carrier', id)));
  assert.throws(() => internalId('shipment', 'SHP_123'));
});

test('canonical reads preserve legacy IDs, ownership and unchanged command retry results', async () => {
  const body = shipBody();
  const original = await call('POST', '/v1/shipments', body);
  const s = original.json();
  const id = publicId('shipment', s.id);
  const r = await call('GET', '/api/v1/shipments/' + id);
  assert.equal(r.statusCode, 200, r.body);
  const projection = r.json().shipment;
  assert.equal(projection.shipment_id, id);
  assert.equal(projection.tracking_id, s.tracking_id);
  assert.equal(projection.version, 1);
  assert.equal(projection.merchant_id, null);
  assert.equal(projection.order_id, null);
  assert.equal(projection.origin.corridor, 'lagos');
  assert.equal(projection.capacity_reserved, undefined);
  assert.deepEqual((await call('GET', '/api/v1/shipments/' + s.id)).json(), r.json());
  const denied = await call('GET', '/api/v1/shipments/' + id, undefined, {
    id: 'other',
    role: 'merchant',
  });
  assert.equal(denied.statusCode, 404);
  assert.equal(denied.json().error.code, 'NOT_FOUND');
  const own = await call('GET', '/api/v1/shipments/' + id, undefined, {
    id: 'merchant-1',
    role: 'merchant',
  });
  assert.equal(own.statusCode, 200);
  const repeated = await call('POST', '/v1/shipments', body);
  assert.deepEqual(repeated.json(), s);
  const view = (
    await db.query<{ public_id: string; tracking_id: string }>(
      'SELECT public_id,tracking_id FROM core.shipment_identifiers WHERE id=$1',
      [s.id],
    )
  ).rows[0]!;
  assert.equal(view.public_id, id);
  assert.equal(view.tracking_id, s.tracking_id);
});

test('canonical pagination is bounded, role scoped and has reusable cursors', async () => {
  await createShipment();
  await createShipment();
  await createShipment({ owner_user_id: 'other' });
  const actor = { id: 'merchant-1', role: 'merchant' as Role };
  const first = await call('GET', '/api/v1/shipments?limit=1', undefined, actor);
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().items.length, 1);
  assert.ok(first.json().next_cursor);
  const second = await call(
    'GET',
    '/api/v1/shipments?limit=1&after=' + first.json().next_cursor,
    undefined,
    actor,
  );
  assert.equal(second.json().items.length, 1);
  assert.equal(second.json().next_cursor, null);
  assert.notEqual(first.json().items[0].id, second.json().items[0].id);
  assert.equal((await call('GET', '/api/v1/shipments?limit=101')).statusCode, 400);
  assert.equal(
    (await call('GET', '/api/v1/shipments/CAR_123')).json().error.code,
    'INVALID_IDENTIFIER',
  );
});

test('canonical events project persisted outbox without changing legacy delivery data', async () => {
  const s = await matched();
  const before = (await db.query('SELECT envelope FROM lex.outbox ORDER BY id')).rows;
  const result = await call('GET', '/api/v1/events?limit=1');
  assert.equal(result.statusCode, 200, result.body);
  assert.ok(result.json().next_cursor);
  const all = await call('GET', '/api/v1/events');
  const events = all.json().items;
  assert.deepEqual(events.map((e: { event_type: string }) => e.event_type).sort(), [
    'shipment.assigned',
    'shipment.created',
  ]);
  for (const e of events) {
    assert.equal(e.entity.id, publicId('shipment', s.id));
    assert.equal(e.event_id, publicId('event', e.legacy_event_id));
    const single = await call('GET', '/api/v1/events/' + e.event_id);
    assert.deepEqual(single.json(), e);
  }
  assert.deepEqual((await db.query('SELECT envelope FROM lex.outbox ORDER BY id')).rows, before);
  const denied = await call('GET', '/api/v1/events', undefined, {
    id: 'merchant-1',
    role: 'merchant',
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.code, 'FORBIDDEN');
  assert.equal((await call('GET', '/api/v1/events/' + randomUUID())).statusCode, 404);
});

test('canonical endpoints require authentication and do not change legacy errors', async () => {
  const unauthenticated = await app.inject({ method: 'GET', url: '/api/v1/shipments' });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(typeof unauthenticated.json().error.code, 'string');
  const legacy = await app.inject({ method: 'GET', url: '/v1/shipments' });
  assert.equal(legacy.statusCode, 401);
  assert.equal(typeof legacy.json().error, 'string');
});

test('domain read feature defaults off and only accepts explicit boolean strings', () => {
  const env = {
    DATABASE_URL: 'postgresql://unused',
    API_CLIENTS_JSON: JSON.stringify(config.clients),
  };
  assert.equal(configFromEnv(env).domainReadApiEnabled, false);
  assert.equal(
    configFromEnv({ ...env, DOMAIN_READ_API_ENABLED: 'false' }).domainReadApiEnabled,
    false,
  );
  assert.equal(
    configFromEnv({ ...env, DOMAIN_READ_API_ENABLED: 'true' }).domainReadApiEnabled,
    true,
  );
  assert.throws(() => configFromEnv({ ...env, DOMAIN_READ_API_ENABLED: 'yes' }));
});

test('disabled domain reads leave legacy commands and webhook fanout operational', async () => {
  const legacyApp = await buildApp(db, { ...config, domainReadApiEnabled: undefined });
  try {
    const headers = { authorization: 'Bearer ' + (await token()) };
    const created = await legacyApp.inject({
      method: 'POST',
      url: '/v1/shipments',
      headers,
      payload: shipBody(),
    });
    assert.equal(created.statusCode, 201, created.body);
    for (const url of [
      '/api/v1/shipments',
      '/api/v1/shipments/' + created.json().id,
      '/api/v1/events',
      '/api/v1/events/' + randomUUID(),
    ]) {
      const disabled = await legacyApp.inject({ method: 'GET', url, headers });
      assert.equal(disabled.statusCode, 404, disabled.body);
    }
    const legacyRead = await legacyApp.inject({
      method: 'GET',
      url: '/v1/shipments/' + created.json().id,
      headers,
    });
    assert.equal(legacyRead.statusCode, 200);
    await destination();
    const legacyConfig = { ...config, domainReadApiEnabled: false };
    const worker = new DeliveryWorker(db, legacyConfig, async () => {
      throw new Error('Fanout must not send network requests');
    });
    await worker.fanout();
    assert.equal(await count('deliveries'), 1);
    const event = (
      await db.query<{ envelope: { schema_version: number; event_type: string; source: string } }>(
        'SELECT envelope FROM lex.outbox',
      )
    ).rows[0]!.envelope;
    assert.equal(event.schema_version, 1);
    assert.equal(event.event_type, 'ShipmentCreated');
    assert.equal(event.source, 'statelines-lex');
  } finally {
    await legacyApp.close();
  }
});

test('compatibility mapping reaches existing API with stable command, tracking, shipment ID and versions', async () => {
  const original = shipBody();
  const { weight_kg, package_size, ...fields } = original;
  const source = { ...fields, package: { weight_kg: String(weight_kg), size: package_size } };
  const prepared = prepareLexShipmentWeight(source);
  assert.ok(prepared.ok);
  assert.equal(prepared.payload.command_id, original.command_id);
  const first = await call('POST', '/v1/shipments', prepared.payload);
  assert.equal(first.statusCode, 201, first.body);
  const shipment = first.json();
  assert.equal(shipment.version, 1);
  assert.equal(Number(shipment.weight_kg), weight_kg);
  const retry = await call('POST', '/v1/shipments', prepared.payload);
  assert.deepEqual(retry.json(), shipment);
  assert.equal(await count('shipments'), 1);
  assert.equal(await count('outbox'), 1);
  assert.equal(await count('commands'), 1);
  const canonical = await call('GET', '/api/v1/shipments/' + publicId('shipment', shipment.id));
  assert.equal(canonical.json().shipment.shipment_id, publicId('shipment', shipment.id));
  assert.equal(canonical.json().shipment.tracking_id, shipment.tracking_id);
  const cancelled = await transition(shipment, 'cancelled');
  assert.equal(cancelled.id, shipment.id);
  assert.equal(cancelled.tracking_id, shipment.tracking_id);
  assert.equal(cancelled.version, 2);
  assert.deepEqual((await call('POST', '/v1/shipments', prepared.payload)).json(), shipment);
  const changed = await call('POST', '/v1/shipments', { ...prepared.payload, weight_kg: 9 });
  assert.equal(changed.statusCode, 409);
  const stale = await call('POST', '/v1/shipments/' + shipment.id + '/transitions', {
    command_id: randomUUID(),
    expected_version: 1,
    status: 'cancelled',
  });
  assert.equal(stale.statusCode, 409);
});

test('unknown weight stays outside Render and direct new shipment validation remains strict', async () => {
  const { weight_kg: _weight, ...payload } = shipBody();
  const prepared = prepareLexShipmentWeight(payload);
  assert.ok(!prepared.ok);
  assert.equal(prepared.code, 'WEIGHT_REVIEW_REQUIRED');
  assert.equal(prepared.render_attempted, false);
  const direct = await call('POST', '/v1/shipments', payload);
  assert.equal(direct.statusCode, 400);
  assert.equal(await count('shipments'), 0);
  assert.equal(await count('commands'), 0);
  assert.equal(await count('outbox'), 0);
});

test('entered package weight reaches the existing API without leaking source metadata', async () => {
  const { weight_kg: _weight, ...fields } = shipBody();
  const source = { ...fields, weight_override_kg: 3.25, weight_source: 'entered' };
  const before = structuredClone(source);
  const prepared = prepareLexShipmentWeight(source);
  assert.ok(prepared.ok);
  assert.equal(prepared.payload.command_id, source.command_id);
  assert.equal(prepared.payload.weight_override_kg, undefined);
  assert.equal(prepared.payload.weight_source, undefined);
  const response = await call('POST', '/v1/shipments', prepared.payload, {
    id: 'entered-weight-test-admin',
    role: 'admin',
  });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(Number(response.json().weight_kg), 3.25);
  assert.deepEqual(source, before);
});

test('Merchant domain API requires service JWT and role, while exposing only safe capabilities', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/capabilities' })).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/shipments',
        headers: { authorization: 'Bearer invalid' },
        payload: merchantShipmentBody(),
      })
    ).statusCode,
    401,
  );
  const capability = await call(
    'GET',
    '/api/v1/capabilities',
    undefined,
    merchantActor,
    'statelines-merchant',
  );
  assert.deepEqual(capability.json(), {
    api_version: 1,
    domain_reads: true,
    shipment_creation: true,
    shipment_cancellation: true,
    cancellation_preflight: true,
  });
  const denied = await call('POST', '/api/v1/shipments', merchantShipmentBody(), admin);
  assert.equal(denied.statusCode, 403);
});

test('Merchant creation stores external order references and is idempotent under concurrent retry', async () => {
  const body = merchantShipmentBody();
  const send = () => call('POST', '/api/v1/shipments', body, merchantActor, 'statelines-merchant');
  const [first, retry] = await Promise.all([send(), send()]);
  assert.equal(first.statusCode, 201, first.body);
  assert.equal(retry.statusCode, 201, retry.body);
  assert.deepEqual(retry.json(), first.json());
  const shipment = first.json().shipment;
  assert.match(shipment.shipment_id, /^SHP_[0-9a-f]{32}$/);
  assert.match(shipment.tracking_id, /^LEX-/);
  assert.equal(shipment.version, 1);
  assert.equal(shipment.status, 'created');
  assert.equal(shipment.merchant_id, 'statelines-merchant');
  assert.equal(shipment.order_id, body.order_id);
  assert.equal(shipment.external_shipment_id, body.external_shipment_id);
  assert.equal(shipment.correlation_id, body.correlation_id);
  assert.equal(Number(shipment.package.weight_kg), body.weight_kg);
  assert.equal(await count('shipments'), 1);
  assert.equal(await count('merchant_shipment_refs'), 1);
  assert.equal(await count('commands'), 1);
  assert.equal(await count('outbox'), 1);
  const event = (
    await db.query<{ envelope: Record<string, unknown> }>('SELECT envelope FROM lex.outbox')
  ).rows[0]!.envelope;
  assert.equal(event.event_type, 'ShipmentCreated');
  assert.equal(event.correlation_id, body.correlation_id);
});

test('Merchant creation validates strict logistics input, issuer scope, and unique order reference', async () => {
  const missingWeight = merchantShipmentBody();
  delete (missingWeight as Record<string, unknown>).weight_kg;
  assert.equal(
    (await call('POST', '/api/v1/shipments', missingWeight, merchantActor, 'statelines-merchant'))
      .statusCode,
    400,
  );
  const invalidRoute = merchantShipmentBody({ destination: { corridor: 'Lagos' } });
  assert.equal(
    (await call('POST', '/api/v1/shipments', invalidRoute, merchantActor, 'statelines-merchant'))
      .statusCode,
    400,
  );
  const wrongScope = merchantShipmentBody({ merchant_id: 'another-merchant' });
  assert.equal(
    (await call('POST', '/api/v1/shipments', wrongScope, merchantActor, 'statelines-merchant'))
      .statusCode,
    403,
  );
  const body = merchantShipmentBody();
  assert.equal(
    (await call('POST', '/api/v1/shipments', body, merchantActor, 'statelines-merchant'))
      .statusCode,
    201,
  );
  const duplicateOrder = { ...body, command_id: randomUUID() };
  const duplicate = await call(
    'POST',
    '/api/v1/shipments',
    duplicateOrder,
    merchantActor,
    'statelines-merchant',
  );
  assert.equal(duplicate.statusCode, 409);
  assert.equal(await count('shipments'), 1);
});

test('Merchant canonical reads return references and isolate shipment owners', async () => {
  const body = merchantShipmentBody();
  const created = await call(
    'POST',
    '/api/v1/shipments',
    body,
    merchantActor,
    'statelines-merchant',
  );
  const id = created.json().shipment.shipment_id;
  const own = await call(
    'GET',
    `/api/v1/shipments/${id}`,
    undefined,
    merchantActor,
    'statelines-merchant',
  );
  assert.equal(own.statusCode, 200);
  assert.equal(own.json().shipment.order_id, body.order_id);
  assert.equal(own.json().shipment.merchant_id, 'statelines-merchant');
  assert.equal(own.json().shipment.tracking_id, created.json().shipment.tracking_id);
  assert.equal(own.json().shipment.version, 1);
  const other = await call(
    'GET',
    `/api/v1/shipments/${id}`,
    undefined,
    { id: 'merchant-user-2', role: 'merchant' },
    'statelines-merchant',
  );
  assert.equal(other.statusCode, 404);
  const otherMerchant = await call(
    'GET',
    `/api/v1/shipments/${id}`,
    undefined,
    merchantActor,
    'statelines-other-merchant',
  );
  assert.equal(otherMerchant.statusCode, 404);
  const otherMerchantList = await call(
    'GET',
    '/api/v1/shipments?limit=10',
    undefined,
    merchantActor,
    'statelines-other-merchant',
  );
  assert.deepEqual(otherMerchantList.json().items, []);
  const list = await call(
    'GET',
    '/api/v1/shipments?limit=10',
    undefined,
    merchantActor,
    'statelines-merchant',
  );
  assert.equal(list.json().items[0].shipment_id, id);
  assert.equal(list.json().items[0].order_id, body.order_id);
});

test('Merchant cancellation enforces version/state, retries idempotently, and emits canonical event', async () => {
  const body = merchantShipmentBody();
  const created = await call(
    'POST',
    '/api/v1/shipments',
    body,
    merchantActor,
    'statelines-merchant',
  );
  const shipment = created.json().shipment;
  const preflight = await call(
    'GET',
    `/api/v1/shipments/${shipment.shipment_id}/cancellable`,
    undefined,
    merchantActor,
    'statelines-merchant',
  );
  assert.deepEqual(preflight.json(), {
    shipment_id: shipment.shipment_id,
    status: 'created',
    version: 1,
    cancellable: true,
    reason: null,
  });
  const stale = await call(
    'POST',
    `/api/v1/shipments/${shipment.shipment_id}/cancel`,
    {
      command_id: randomUUID(),
      expected_version: 2,
      correlation_id: 'cancel-stale',
      reason: 'Changed mind',
    },
    merchantActor,
    'statelines-merchant',
  );
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.code, 'VERSION_CONFLICT');
  const bodyCancel = {
    command_id: randomUUID(),
    expected_version: 1,
    correlation_id: 'cancel-correlation-1',
    reason: 'Customer requested cancellation',
  };
  const path = `/api/v1/shipments/${shipment.shipment_id}/cancel`;
  const cancelled = await call('POST', path, bodyCancel, merchantActor, 'statelines-merchant');
  const repeated = await call('POST', path, bodyCancel, merchantActor, 'statelines-merchant');
  assert.equal(cancelled.statusCode, 200);
  assert.deepEqual(repeated.json(), cancelled.json());
  assert.equal(cancelled.json().shipment.status, 'cancelled');
  assert.equal(cancelled.json().shipment.version, 2);
  const already = await call(
    'POST',
    path,
    { ...bodyCancel, command_id: randomUUID(), expected_version: 2 },
    merchantActor,
    'statelines-merchant',
  );
  assert.equal(already.statusCode, 409);
  assert.equal(already.json().error.code, 'ALREADY_CANCELLED');
  const outbox = (
    await db.query<{ envelope: Record<string, unknown> }>(
      'SELECT envelope FROM lex.outbox ORDER BY created_at',
    )
  ).rows;
  assert.equal(outbox.length, 2);
  assert.equal(outbox[1]!.envelope.event_type, 'ShipmentStatusChanged');
  assert.equal(outbox[1]!.envelope.correlation_id, bodyCancel.correlation_id);
  const canonicalEvents = await call('GET', '/api/v1/events', undefined, admin);
  assert.ok(
    canonicalEvents
      .json()
      .items.some((event: { event_type: string }) => event.event_type === 'shipment.cancelled'),
  );
});

test('Merchant cannot cancel collected/delivered shipments; cancellation gate is opt-in', async () => {
  const body = merchantShipmentBody();
  const created = await call(
    'POST',
    '/api/v1/shipments',
    body,
    merchantActor,
    'statelines-merchant',
  );
  const shipment = created.json().shipment;
  await db.query("UPDATE lex.shipments SET status='delivered',version=4 WHERE id=$1", [
    shipment.id,
  ]);
  const denied = await call(
    'POST',
    `/api/v1/shipments/${shipment.shipment_id}/cancel`,
    {
      command_id: randomUUID(),
      expected_version: 4,
      correlation_id: 'cancel-delivered',
      reason: 'Requested',
    },
    merchantActor,
    'statelines-merchant',
  );
  assert.equal(denied.statusCode, 409);
  assert.equal(denied.json().error.code, 'NOT_CANCELLABLE');
  const disabledApp = await buildApp(db, { ...config, merchantDomainApiEnabled: false });
  try {
    const headers = {
      authorization: 'Bearer ' + (await token(merchantActor, 'statelines-merchant')),
    };
    const capability = await disabledApp.inject({
      method: 'GET',
      url: '/api/v1/capabilities',
      headers,
    });
    assert.equal(capability.json().shipment_creation, false);
    assert.equal(capability.json().shipment_cancellation, false);
    const disabled = await disabledApp.inject({
      method: 'POST',
      url: '/api/v1/shipments',
      headers,
      payload: body,
    });
    assert.equal(disabled.statusCode, 404);
  } finally {
    await disabledApp.close();
  }
});

test('only GET health routes are public; root, LEX and domain APIs require authentication', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/health/live' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/shipments' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/shipments' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/health/live' })).statusCode, 401);
  const oldCreate = await call('POST', '/v1/shipments', shipBody());
  assert.equal(oldCreate.statusCode, 201, oldCreate.body);
});

const canonicalDestinationBody = (overrides = {}) => ({
  command_id: randomUUID(),
  name: 'LEX canonical projection',
  client_id: 'wallet', // Test platform-role client; independent from the webhook signing key.
  url: 'https://receiver.example.com/canonical',
  secret_ref: 'lex_canonical',
  envelope_format: 'canonical_v1',
  event_types: ['ShipmentCreated', 'ShipmentStatusChanged', 'ShipmentMatched', 'ShipmentDelivered'],
  ...overrides,
});
async function canonicalDestination(overrides = {}) {
  const result = await call('POST', '/v1/destinations', canonicalDestinationBody(overrides));
  assert.equal(result.statusCode, 201, result.body);
  return result.json();
}
async function createMerchant(body = merchantShipmentBody()) {
  const result = await call(
    'POST',
    '/api/v1/shipments',
    body,
    merchantActor,
    'statelines-merchant',
  );
  assert.equal(result.statusCode, 201, result.body);
  return result.json();
}

test('Merchant creation persists exactly one complete canonical snapshot beside the unchanged legacy event', async () => {
  const body = merchantShipmentBody();
  const created = await createMerchant(body);
  assert.deepEqual(await createMerchant(body), created);
  assert.equal(await count('shipments'), 1);
  assert.equal(await count('outbox'), 1);
  const row = (await db.query('SELECT id,envelope,canonical_envelope FROM lex.outbox')).rows[0]!;
  const legacy = row.envelope as Record<string, unknown>;
  const canonical = row.canonical_envelope as Record<string, unknown>;
  assert.deepEqual(legacy.payload, {
    shipment_id: created.shipment.id,
    tracking_id: created.shipment.tracking_id,
    status: 'created',
    version: 1,
  });
  assert.equal(legacy.event_type, 'ShipmentCreated');
  assert.equal(legacy.source, 'statelines-lex');
  assert.deepEqual(canonical, {
    event_id: publicId('event', row.id as string),
    event_type: 'shipment.created',
    event_version: 1,
    occurred_at: legacy.occurred_at,
    source: 'statelines-domain-platform',
    correlation_id: body.correlation_id,
    command_id: body.command_id,
    shipment: {
      shipment_id: created.shipment.shipment_id,
      tracking_id: created.shipment.tracking_id,
      merchant_id: body.merchant_id,
      order_id: body.order_id,
      external_shipment_id: body.external_shipment_id,
      status: 'created',
      version: 1,
      origin: { corridor: 'lagos' },
      destination: { corridor: 'abuja' },
      service_level: body.service_level,
      package_size: body.package_size,
      weight_kg: body.weight_kg,
      pickup_deadline: body.pickup_deadline,
      delivery_deadline: body.delivery_deadline,
    },
  });
  assert.equal(JSON.stringify(canonical).includes(secret), false);
});

test('canonical snapshot storage failure rolls back Merchant Shipment, reference, history and command', async () => {
  await db.query(
    "CREATE FUNCTION lex.reject_canonical() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.canonical_envelope IS NOT NULL THEN RAISE EXCEPTION 'snapshot storage failed'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_canonical BEFORE INSERT ON lex.outbox FOR EACH ROW EXECUTE FUNCTION lex.reject_canonical();",
  );
  try {
    const response = await call(
      'POST',
      '/api/v1/shipments',
      merchantShipmentBody(),
      merchantActor,
      'statelines-merchant',
    );
    assert.equal(response.statusCode, 500);
    for (const table of [
      'shipments',
      'merchant_shipment_refs',
      'shipment_history',
      'commands',
      'outbox',
    ])
      assert.equal(await count(table), 0, table);
  } finally {
    await db.query(
      'DROP TRIGGER reject_canonical ON lex.outbox; DROP FUNCTION lex.reject_canonical();',
    );
  }
});

test('canonical destinations are opt-in, default inactive, reject billing events and JWT signing keys', async () => {
  const body = canonicalDestinationBody();
  const response = await call('POST', '/v1/destinations', body);
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().active, false);
  assert.deepEqual((await call('POST', '/v1/destinations', body)).json(), response.json());
  assert.equal((await destination()).envelope_format, 'legacy_v1');
  const badType = await call(
    'POST',
    '/v1/destinations',
    canonicalDestinationBody({ event_types: ['WalletApprovalCreated'] }),
  );
  assert.equal(badType.statusCode, 422);
  const reusedKey = await call(
    'POST',
    '/v1/destinations',
    canonicalDestinationBody({ secret_ref: 'wallet' }),
  );
  assert.equal(reusedKey.statusCode, 422);
  assert.equal(reusedKey.json().error, 'shared_signing_secret');
  assert.equal(
    (await call('POST', '/v1/destinations', body, merchantActor, 'statelines-merchant')).statusCode,
    403,
  );
});

test('canonical retry preserves event-time snapshot and event ID while legacy destinations retain their envelope', async () => {
  const target = await canonicalDestination({ active: true });
  const legacyTarget = await destination();
  const body = merchantShipmentBody();
  const created = await createMerchant(body);
  const original = (await db.query('SELECT envelope,canonical_envelope FROM lex.outbox')).rows[0]!;
  const canonical = original.canonical_envelope as Record<string, unknown>;
  const sent: { envelope: Record<string, unknown>; id: string }[] = [];
  let fail = true;
  const worker = new DeliveryWorker(db, config, async (url, signingSecret, envelope, id) => {
    sent.push({ envelope: structuredClone(envelope), id });
    if (url.endsWith('/canonical')) {
      assert.equal(signingSecret, config.webhookSecrets.lex_canonical);
      return fail
        ? { ok: false, retryable: true, status: 503 }
        : { ok: true, retryable: false, status: 200 };
    }
    assert.equal(signingSecret, config.webhookSecrets.wallet);
    return { ok: true, processed: true, retryable: false, status: 200 };
  });
  assert.equal(sent.length, 0);
  await worker.tick();
  assert.equal(await count('shipments'), 1);
  assert.equal(await count('outbox'), 1);
  const delivery = (
    await db.query<{ id: string; status: string; attempts: number; next_attempt_at: Date }>(
      'SELECT * FROM lex.deliveries WHERE destination_id=$1',
      [target.id],
    )
  ).rows[0]!;
  assert.equal(delivery.status, 'retrying');
  assert.equal(delivery.attempts, 1);
  assert.ok(delivery.next_attempt_at.getTime() > Date.now());
  assert.deepEqual(sent.find((x) => x.id !== delivery.id)!.envelope, original.envelope);
  assert.equal(
    (await db.query('SELECT status FROM lex.deliveries WHERE destination_id=$1', [legacyTarget.id]))
      .rows[0]!.status,
    'processed',
  );
  const cancellation = await call(
    'POST',
    `/api/v1/shipments/${created.shipment.shipment_id}/cancel`,
    {
      command_id: randomUUID(),
      expected_version: 1,
      correlation_id: 'corr-cancel',
      reason: 'Test cancellation',
    },
    merchantActor,
    'statelines-merchant',
  );
  assert.equal(cancellation.statusCode, 200, cancellation.body);
  fail = false;
  await db.query('UPDATE lex.deliveries SET next_attempt_at=now()');
  await worker.tick();
  const retries = sent.filter((x) => x.id === delivery.id);
  assert.equal(retries.length, 2);
  assert.deepEqual(retries[0]!.envelope, canonical);
  assert.deepEqual(retries[1]!.envelope, canonical);
  const cancellationEvent = sent.find(
    (x) => x.envelope.event_type === 'shipment.cancelled',
  )!.envelope;
  assert.equal(cancellationEvent.correlation_id, 'corr-cancel');
  assert.equal((cancellationEvent.shipment as { version: number }).version, 2);
  assert.equal((canonical.shipment as { status: string }).status, 'created');
  assert.equal(
    (await db.query('SELECT status,version FROM lex.shipments')).rows[0]!.status,
    'cancelled',
  );
  assert.equal(await count('shipments'), 1);
  assert.equal(await count('outbox'), 2); // Creation + genuine cancellation, never retry events.
  assert.deepEqual(await createMerchant(body), created);
  assert.equal(await count('outbox'), 2);
  const outcome = (
    await db.query('SELECT status,attempts,accepted_at FROM lex.deliveries WHERE id=$1', [
      delivery.id,
    ])
  ).rows[0]!;
  assert.equal(outcome.status, 'accepted');
  assert.equal(outcome.attempts, 2);
  assert.ok(outcome.accepted_at);
  const attempts = (
    await db.query(
      'SELECT http_status,outcome FROM lex.delivery_attempts WHERE delivery_id=$1 ORDER BY attempt',
      [delivery.id],
    )
  ).rows;
  assert.deepEqual(attempts, [
    { http_status: 503, outcome: 'retrying' },
    { http_status: 200, outcome: 'accepted' },
  ]);
});

test('canonical lifecycle snapshots cover assignment, status changes and delivery with stable Merchant references', async () => {
  await canonicalDestination({ active: true });
  const created = await createMerchant();
  await createCarrier();
  const match = await call('POST', `/v1/shipments/${created.shipment.id}/match`, {
    command_id: randomUUID(),
    expected_version: 1,
  });
  assert.equal(match.statusCode, 200, match.body);
  let current = match.json();
  for (const status of ['picked_up', 'in_transit', 'out_for_delivery', 'delivered'])
    current = await transition(current, status);
  const received: Record<string, unknown>[] = [];
  const worker = new DeliveryWorker(db, config, async (_url, _key, envelope) => {
    received.push(envelope);
    return { ok: true, processed: true, retryable: false, status: 200 };
  });
  await worker.tick();
  received.sort(
    (a, b) =>
      (a.shipment as { version: number }).version - (b.shipment as { version: number }).version,
  );
  assert.deepEqual(
    received.map((e) => e.event_type),
    [
      'shipment.created',
      'shipment.assigned',
      'shipment.status_changed',
      'shipment.status_changed',
      'shipment.status_changed',
      'shipment.delivered',
    ],
  );
  for (const [i, event] of received.entries()) {
    const snapshot = event.shipment as Record<string, unknown>;
    assert.equal(snapshot.version, i + 1);
    assert.equal(snapshot.merchant_id, 'statelines-merchant');
    assert.equal(snapshot.order_id, 'STL-ORDER-1');
    assert.equal(event.correlation_id, i === 0 ? 'corr-merchant-1' : created.shipment.id);
    assert.equal(snapshot.shipment_id, created.shipment.shipment_id);
  }
});

test('canonical delivery dead-letters and explicit replay reuses the same event and Shipment', async () => {
  await canonicalDestination({ active: true });
  await createMerchant();
  const events: Record<string, unknown>[] = [];
  let succeed = false;
  const worker = new DeliveryWorker(db, config, async (_url, _key, envelope) => {
    events.push(structuredClone(envelope));
    return succeed
      ? { ok: true, processed: true, retryable: false, status: 200 }
      : { ok: false, retryable: true, status: 500 };
  });
  for (let i = 0; i < 4; i++) {
    await db.query('UPDATE lex.deliveries SET next_attempt_at=now()');
    await worker.tick();
  }
  const d = (await db.query('SELECT id,status FROM lex.deliveries')).rows[0]!;
  assert.equal(d.status, 'dead_letter');
  assert.equal(events.length, config.maxAttempts);
  succeed = true;
  assert.equal(
    (
      await call('POST', `/v1/deliveries/${d.id}/replay`, {
        command_id: randomUUID(),
        note: 'Test receiver recovered',
      })
    ).statusCode,
    200,
  );
  await worker.tick();
  for (const event of events) assert.deepEqual(event, events[0]);
  assert.equal(await count('shipments'), 1);
  assert.equal(await count('outbox'), 1);
  assert.equal(await count('deliveries'), 1);
  assert.equal(await count('delivery_attempts'), 4);
  assert.equal(
    (await db.query('SELECT status,replay_count FROM lex.deliveries')).rows[0]!.status,
    'processed',
  );
});

test('pre-upgrade events are not reconstructed or sent to canonical destinations, including explicit backfill', async () => {
  const target = await canonicalDestination({ active: true });
  await destination();
  const s = await createShipment();
  // Disposable fixture represents an event written by the previous application version.
  await db.query('UPDATE lex.outbox SET canonical_envelope=NULL WHERE aggregate_id=$1', [s.id]);
  const received: string[] = [];
  const worker = new DeliveryWorker(db, config, async (url) => {
    received.push(url);
    return { ok: true, retryable: false, status: 200 };
  });
  await worker.tick();
  assert.deepEqual(received, ['https://receiver.example.com/lex']);
  const backfill = await call('POST', `/v1/destinations/${target.id}/backfill`, {
    command_id: randomUUID(),
    from: inHours(-1),
    to: inHours(1),
  });
  assert.equal(backfill.statusCode, 200, backfill.body);
  assert.equal(backfill.json().created, 0);
  assert.equal(
    (
      await db.query('SELECT count(*)::int AS n FROM lex.deliveries WHERE destination_id=$1', [
        target.id,
      ])
    ).rows[0]!.n,
    0,
  );
  assert.equal(
    (await db.query('SELECT canonical_envelope FROM lex.outbox')).rows[0]!.canonical_envelope,
    null,
  );
  assert.equal((await db.query('SELECT status,version FROM lex.shipments')).rows[0]!.version, 1);
});
