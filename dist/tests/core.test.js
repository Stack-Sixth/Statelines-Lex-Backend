import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { SignJWT } from 'jose';
import { buildApp } from '../src/app.js';
import { postgres } from '../src/db.js';
import { DeliveryWorker } from '../src/delivery.js';
import { publicAddress, signature, verifySignature, validateEndpoint } from '../src/webhooks.js';
const secret = 'test-only-secret-'.repeat(4);
const config = {
    databaseUrl: process.env.TEST_DATABASE_URL || 'postgresql://unused',
    databaseSsl: false,
    poolSize: 5,
    port: 3000,
    host: '127.0.0.1',
    logLevel: 'silent',
    clients: [
        { id: 'test', secret, roles: ['admin', 'operator', 'carrier', 'merchant'] },
        { id: 'wallet', secret: secret + 'wallet', roles: ['platform'] },
    ],
    webhookSecrets: { wallet: secret },
    allowedHosts: ['receiver.example.com'],
    pollMs: 100,
    batchSize: 10,
    maxAttempts: 3,
};
let db;
let app;
const admin = { role: 'admin', id: 'admin-1' };
async function token(actor = admin, client = 'test') {
    const cfg = config.clients.find((c) => c.id === client);
    return new SignJWT({ role: actor.role })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(client)
        .setAudience('statelines-lex')
        .setSubject(actor.id)
        .setIssuedAt()
        .setExpirationTime('2m')
        .sign(new TextEncoder().encode(cfg.secret));
}
async function call(method, url, body, actor = admin, client = 'test') {
    return app.inject({
        method,
        url,
        headers: { authorization: 'Bearer ' + (await token(actor, client)) },
        ...(body === undefined ? {} : { payload: body }),
    });
}
const inHours = (h) => new Date(Date.now() + h * 3600000).toISOString();
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
async function transition(s, status, extra = {}) {
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
const count = async (table) => Number((await db.query(`SELECT count(*) AS n FROM lex.${table}`)).rows[0].n);
before(async () => {
    if (process.env.TEST_DATABASE_URL) {
        const url = new URL(process.env.TEST_DATABASE_URL);
        if (!url.pathname.endsWith('/lex_test'))
            throw Error('Tests only accept a disposable database named lex_test');
        db = postgres(config);
        await db.query('DROP SCHEMA IF EXISTS lex CASCADE');
    }
    else {
        const pg = new PGlite();
        await pg.waitReady;
        const wrap = (target) => ({
            async query(sql, values = []) {
                if (!values.length && sql.includes(';')) {
                    const results = await target.exec(sql);
                    const r = results.at(-1);
                    return { rows: (r?.rows || []), rowCount: r?.affectedRows || 0 };
                }
                const result = await target.query(sql, values);
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
    app = await buildApp(db, config);
});
after(async () => {
    await app?.close();
    await db?.close();
});
beforeEach(async () => {
    await db.query('TRUNCATE lex.delivery_attempts,lex.deliveries,lex.destinations,lex.outbox,lex.audit_log,lex.wallet_approvals,lex.shipment_history,lex.shipments,lex.carriers,lex.commands,lex.worker_heartbeats CASCADE');
});
test('health is available, business endpoints require authentication', async () => {
    assert.equal((await app.inject('/health/ready')).statusCode, 200);
    assert.equal((await app.inject('/v1/shipments')).statusCode, 401);
    const r = await call('GET', '/v1/operations/health');
    assert.equal(r.json().status, 'degraded');
});
test('rejects role escalation by a platform client', async () => {
    assert.equal((await call('GET', '/v1/operations/health', undefined, admin, 'wallet')).statusCode, 401);
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
    assert.equal((await call('POST', '/v1/shipments', { ...shipBody(), weight_kg: -1 })).statusCode, 400);
    assert.equal((await call('POST', '/v1/shipments', shipBody(), { role: 'merchant', id: 'other' })).statusCode, 403);
});
test('outbox storage failure rolls back shipment, history and command', async () => {
    await db.query("CREATE FUNCTION lex.reject_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated disk failure'; END $$; CREATE TRIGGER reject_event BEFORE INSERT ON lex.outbox FOR EACH ROW EXECUTE FUNCTION lex.reject_event();");
    try {
        assert.equal((await call('POST', '/v1/shipments', shipBody())).statusCode, 500);
        assert.equal(await count('shipments'), 0);
        assert.equal(await count('commands'), 0);
        assert.equal(await count('shipment_history'), 0);
    }
    finally {
        await db.query('DROP TRIGGER reject_event ON lex.outbox; DROP FUNCTION lex.reject_event();');
    }
});
test('matching rejects wrong destination, unsupported packages and late arrival', async () => {
    const c = await createCarrier({ destination: 'Kano' });
    const s = await createShipment();
    const match = () => call('POST', `/v1/shipments/${s.id}/match`, { command_id: randomUUID(), expected_version: 1 });
    assert.equal((await match()).statusCode, 409);
    await db.query("UPDATE lex.carriers SET destination='abuja',package_sizes=ARRAY['xl'] WHERE id=$1", [c.id]);
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
    const results = await Promise.all([a, b].map((s) => call('POST', `/v1/shipments/${s.id}/match`, {
        command_id: randomUUID(),
        expected_version: 1,
    })));
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
    assert.equal(Number((await db.query('SELECT reserved_kg FROM lex.carriers')).rows[0]
        .reserved_kg), 5);
});
test('assigned carrier authorization uses explicit user mapping', async () => {
    const s = await matched();
    const body = { command_id: randomUUID(), expected_version: 2, status: 'picked_up' };
    assert.equal((await call('POST', `/v1/shipments/${s.id}/transitions`, body, {
        role: 'carrier',
        id: 'wrong-user',
    })).statusCode, 403);
    assert.equal((await call('POST', `/v1/shipments/${s.id}/transitions`, body, {
        role: 'carrier',
        id: 'carrier-user',
    })).statusCode, 200);
    assert.equal((await call('GET', `/v1/shipments/${s.id}`, undefined, { role: 'merchant', id: 'stranger' }))
        .statusCode, 404);
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
    const c = (await db.query('SELECT reserved_kg,total_deliveries FROM lex.carriers')).rows[0];
    assert.equal(Number(c.reserved_kg), 0);
    assert.equal(c.total_deliveries, 1);
    assert.equal((await call('POST', `/v1/shipments/${s.id}/transitions`, {
        command_id: randomUUID(),
        expected_version: s.version,
        status: 'in_transit',
    })).statusCode, 409);
    assert.equal((await call('POST', `/v1/shipments/${s.id}/transitions`, {
        command_id: randomUUID(),
        expected_version: 1,
        status: 'cancelled',
    })).json().error, 'stale_version');
});
test('return workflow reserves capacity and releases it on returned', async () => {
    let s = await delivered();
    s = await transition(s, 'return_in_transit', { note: 'Recipient requested return' });
    assert.equal(Number((await db.query('SELECT reserved_kg FROM lex.carriers')).rows[0]
        .reserved_kg), 5);
    await transition(s, 'returned');
    const c = (await db.query('SELECT reserved_kg,total_deliveries FROM lex.carriers')).rows[0];
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
    assert.equal((await call('POST', `/v1/shipments/${pending.id}/wallet-approval`, body)).statusCode, 409);
    const s = await delivered();
    const responses = await Promise.all([1, 2].map(() => call('POST', `/v1/shipments/${s.id}/wallet-approval`, {
        ...body,
        command_id: randomUUID(),
        expected_version: s.version,
    })));
    assert.ok(responses.every((r) => r.statusCode === 200));
    assert.equal(responses[0].json().id, responses[1].json().id);
    assert.equal(await count('wallet_approvals'), 1);
    assert.equal(Number((await db.query("SELECT count(*) AS n FROM lex.outbox WHERE event_type='WalletApprovalCreated'")).rows[0].n), 1);
    assert.equal((await call('POST', `/v1/shipments/${s.id}/wallet-approval`, {
        ...body,
        command_id: randomUUID(),
        expected_version: s.version,
        amount_minor: 1,
    })).statusCode, 409);
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
    const d = (await db.query('SELECT * FROM lex.deliveries'))
        .rows[0];
    assert.equal(d.status, 'dead_letter');
    succeed = true;
    assert.equal((await call('POST', `/v1/deliveries/${d.id}/replay`, {
        command_id: randomUUID(),
        note: 'Receiver repaired',
    })).statusCode, 200);
    await worker.tick();
    assert.equal(await count('deliveries'), 1);
    assert.equal((await db.query('SELECT status FROM lex.deliveries')).rows[0].status, 'accepted');
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
    const received = [];
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
        await db.query('INSERT INTO lex.outbox(id,event_type,aggregate_id,aggregate_version,envelope) VALUES($1,$2,$3,1,$4)', [
            id,
            'ShipmentCreated',
            randomUUID(),
            JSON.stringify({ event_id: id, event_type: 'ShipmentCreated' }),
        ]);
    }
    const worker = new DeliveryWorker(db, config, async () => ({
        ok: true,
        retryable: false,
        status: 200,
    }));
    while (await worker.fanout()) { }
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
    const d = (await db.query('SELECT * FROM lex.deliveries'))
        .rows[0];
    assert.equal((await call('POST', `/v1/deliveries/${d.id}/processed`, {
        command_id: randomUUID(),
        event_id: d.event_id,
    })).statusCode, 403);
    const r = await call('POST', `/v1/deliveries/${d.id}/processed`, { command_id: randomUUID(), event_id: d.event_id }, { id: 'wallet-worker', role: 'platform' }, 'wallet');
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
    const envelope = (await db.query('SELECT envelope FROM lex.outbox')).rows[0].envelope;
    const body = JSON.stringify(envelope);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = signature(secret, timestamp, body);
    const first = await acceptEvent(db, secret, body, timestamp, sig);
    const duplicate = await acceptEvent(db, secret, body, timestamp, sig);
    assert.equal(first.status, 'accepted');
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    const changed = JSON.stringify({ ...envelope, event_type: 'DifferentEvent' });
    await assert.rejects(() => acceptEvent(db, secret, changed, timestamp, signature(secret, timestamp, changed)), /identity was reused/);
    await db.query("CREATE FUNCTION lex_receiver.reject_inbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'storage failure'; END $$; CREATE TRIGGER reject_inbox BEFORE INSERT ON lex_receiver.inbox FOR EACH ROW EXECUTE FUNCTION lex_receiver.reject_inbox();");
    try {
        const failed = JSON.stringify({ ...envelope, event_id: randomUUID() });
        await assert.rejects(() => acceptEvent(db, secret, failed, timestamp, signature(secret, timestamp, failed)), /storage failure/);
    }
    finally {
        await db.query('DROP TRIGGER reject_inbox ON lex_receiver.inbox; DROP FUNCTION lex_receiver.reject_inbox();');
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
    assert.equal((await call('POST', `/v1/carriers/${s.assigned_carrier_id}/schedule`, schedule)).statusCode, 409);
    await transition(s, 'cancelled');
    assert.equal((await call('POST', `/v1/carriers/${s.assigned_carrier_id}/schedule`, schedule)).statusCode, 200);
});
test('return exception cannot be recovered into a second outbound delivery', async () => {
    let s = await delivered();
    s = await transition(s, 'return_in_transit', { note: 'Return requested' });
    s = await transition(s, 'exception', { note: 'Road closure' });
    assert.equal((await call('POST', `/v1/shipments/${s.id}/transitions`, {
        command_id: randomUUID(),
        expected_version: s.version,
        status: 'out_for_delivery',
        note: 'Invalid recovery',
    })).statusCode, 409);
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
    assert.equal((await db.query('SELECT status FROM lex.deliveries')).rows[0].status, 'dead_letter');
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
    await db.query("UPDATE lex.deliveries SET attempts=max_attempts,lease_until=now()-interval '1 minute'");
    await worker.tick();
    assert.equal(sent, 0);
    assert.equal((await db.query('SELECT status FROM lex.deliveries')).rows[0].status, 'dead_letter');
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
    assert.equal((await app.inject({ url: '/v1/shipments', headers: { authorization: 'Bearer ' + expired } }))
        .statusCode, 401);
});
test('database RLS prevents a browser role from directly writing engine tables', async () => {
    await db.query('CREATE ROLE lex_browser_test NOLOGIN; GRANT USAGE ON SCHEMA lex TO lex_browser_test; GRANT SELECT,UPDATE ON lex.shipments TO lex_browser_test;');
    try {
        await createShipment();
        await db.transaction(async (sql) => {
            await sql.query('SET LOCAL ROLE lex_browser_test');
            assert.equal((await sql.query('SELECT * FROM lex.shipments')).rows.length, 0);
            assert.equal((await sql.query("UPDATE lex.shipments SET status='delivered'")).rowCount, 0);
        });
    }
    finally {
        await db.query('DROP OWNED BY lex_browser_test; DROP ROLE lex_browser_test;');
    }
});
//# sourceMappingURL=core.test.js.map