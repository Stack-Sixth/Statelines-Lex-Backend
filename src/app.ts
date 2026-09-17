import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Database } from './db.js';
import { authenticate } from './auth.js';
import {
  AppError,
  audit,
  command,
  commandFields,
  requireRole,
  uuid,
  type Actor,
} from './domain.js';
import {
  shipmentService,
  createShipmentSchema,
  carrierSchema,
  carrierScheduleSchema,
  matchSchema,
  transitionSchema,
  walletSchema,
} from './shipments.js';
import { validateEndpoint } from './webhooks.js';
declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor;
  }
}
const paging = z.object({
  after: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export async function buildApp(db: Database, config: Config) {
  const app = Fastify({
    bodyLimit: 65536,
    logger:
      config.logLevel === 'silent'
        ? false
        : { level: config.logLevel, redact: ['req.headers.authorization', 'req.headers.cookie'] },
  });
  app.decorateRequest('actor');
  app.addHook('onRequest', async (req) => {
    if (req.url === '/health/live' || req.url === '/health/ready') return;
    req.actor = await authenticate(req.headers.authorization, config);
  });
  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    hook: 'preHandler',
    keyGenerator: (req) => (req.actor ? req.actor.clientId + ':' + req.actor.id : req.ip),
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: 'validation_error',
        issues: error.issues.map((i) => ({ path: i.path, message: i.message })),
        request_id: req.id,
      });
    if (error instanceof AppError)
      return reply
        .code(error.status)
        .send({ error: error.code, message: error.message, request_id: req.id });
    const code = (error as { code?: string }).code;
    if (code === '23505')
      return reply.code(409).send({
        error: 'conflict',
        message: 'A record with this identity already exists',
        request_id: req.id,
      });
    if (['23514', '23503', '22P02'].includes(code || ''))
      return reply.code(422).send({
        error: 'invalid_record',
        message: 'Data violates a database constraint',
        request_id: req.id,
      });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500)
      return reply.code(status).send({
        error: 'request_error',
        message: status === 429 ? 'Rate limit exceeded' : 'Invalid request',
        request_id: req.id,
      });
    req.log.error({ err: error }, 'Request failed');
    return reply.code(500).send({
      error: 'internal_error',
      message: 'Request failed; retry with the same command_id',
      request_id: req.id,
    });
  });
  app.get('/health/live', async () => ({ status: 'alive' }));
  app.get('/health/ready', async (_req, reply) => {
    try {
      await db.query('SELECT 1 FROM lex.commands LIMIT 1');
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
  const service = shipmentService(db);
  const idOf = (params: unknown) => z.object({ id: uuid }).parse(params).id;
  app.post('/v1/shipments', async (req, reply) =>
    reply.code(201).send(await service.create(req.actor, createShipmentSchema.parse(req.body))),
  );
  app.get('/v1/shipments', async (req) => {
    const p = paging.parse(req.query);
    const rows = await service.list(req.actor, p.after, p.limit);
    return { items: rows, next_cursor: rows.length === p.limit ? rows.at(-1)!.id : null };
  });
  app.get('/v1/shipments/:id', async (req) => service.get(req.actor, idOf(req.params)));
  app.post('/v1/shipments/:id/match', async (req) =>
    service.match(req.actor, idOf(req.params), matchSchema.parse(req.body)),
  );
  app.post('/v1/shipments/:id/transitions', async (req) =>
    service.transition(req.actor, idOf(req.params), transitionSchema.parse(req.body)),
  );
  app.post('/v1/shipments/:id/wallet-approval', async (req) =>
    service.approveWallet(req.actor, idOf(req.params), walletSchema.parse(req.body)),
  );
  app.post('/v1/carriers', async (req, reply) =>
    reply.code(201).send(await service.createCarrier(req.actor, carrierSchema.parse(req.body))),
  );
  app.post('/v1/carriers/:id/schedule', async (req) =>
    service.scheduleCarrier(req.actor, idOf(req.params), carrierScheduleSchema.parse(req.body)),
  );
  app.get('/v1/carriers', async (req) => {
    requireRole(req.actor, 'admin', 'operator');
    const p = paging.parse(req.query);
    const rows = (
      await db.query(
        'SELECT * FROM lex.carriers WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT $2',
        [p.after || null, p.limit],
      )
    ).rows;
    return { items: rows, next_cursor: rows.length === p.limit ? rows.at(-1)!.id : null };
  });
  const destinationSchema = z
    .object({
      ...commandFields,
      name: z.string().min(1).max(120),
      client_id: z.string().min(1),
      url: z.string().url(),
      secret_ref: z.string().min(1),
      event_types: z
        .array(
          z.enum([
            'ShipmentCreated',
            'ShipmentMatched',
            'ShipmentStatusChanged',
            'ShipmentDelivered',
            'WalletApprovalCreated',
          ]),
        )
        .min(1),
    })
    .strict();
  app.post('/v1/destinations', async (req, reply) => {
    requireRole(req.actor, 'admin');
    const b = destinationSchema.parse(req.body);
    validateEndpoint(b.url, config.allowedHosts);
    if (!config.webhookSecrets[b.secret_ref])
      throw new AppError(
        422,
        'missing_secret',
        'Configure this secret reference on API and worker first',
      );
    if (!config.clients.some((c) => c.id === b.client_id && c.roles.includes('platform')))
      throw new AppError(
        422,
        'missing_client',
        'Destination must map to a configured platform API client',
      );
    return reply.code(201).send(
      await command(db, req.actor, b.command_id, 'destination.create', b, async (sql) => {
        const row = (
          await sql.query(
            'INSERT INTO lex.destinations(id,name,client_id,url,secret_ref,event_types) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,client_id,url,event_types,active',
            [randomUUID(), b.name, b.client_id, b.url, b.secret_ref, b.event_types],
          )
        ).rows[0]!;
        await audit(sql, req.actor, 'destination.created', String(row.id), b.command_id);
        return row;
      }),
    );
  });
  app.get('/v1/destinations', async (req) => {
    requireRole(req.actor, 'admin');
    return {
      items: (
        await db.query(
          'SELECT id,name,client_id,url,event_types,active FROM lex.destinations ORDER BY created_at',
        )
      ).rows,
    };
  });
  app.post('/v1/destinations/:id/backfill', async (req) => {
    requireRole(req.actor, 'admin');
    const id = idOf(req.params);
    const b = z
      .object({
        ...commandFields,
        from: z.iso.datetime({ offset: true }),
        to: z.iso.datetime({ offset: true }),
        after: uuid.optional(),
        limit: z.number().int().min(1).max(100).default(100),
      })
      .strict()
      .refine((x) => Date.parse(x.to) > Date.parse(x.from), 'to must follow from')
      .parse(req.body);
    return command(
      db,
      req.actor,
      b.command_id,
      'destination.backfill',
      { id, ...b },
      async (sql) => {
        const destination = (
          await sql.query<{ active: boolean; event_types: string[] }>(
            'SELECT active,event_types FROM lex.destinations WHERE id=$1 FOR UPDATE',
            [id],
          )
        ).rows[0];
        if (!destination) throw new AppError(404, 'not_found', 'Destination not found');
        if (!destination.active)
          throw new AppError(409, 'inactive_destination', 'Destination must be active');
        const events = (
          await sql.query<{ id: string }>(
            'SELECT id FROM lex.outbox WHERE created_at >= $1 AND created_at < $2 AND ($3::uuid IS NULL OR id>$3) AND event_type=ANY($4::text[]) ORDER BY id LIMIT $5',
            [b.from, b.to, b.after || null, destination.event_types, b.limit],
          )
        ).rows;
        let created = 0;
        for (const event of events)
          created += (
            await sql.query(
              'INSERT INTO lex.deliveries(id,event_id,destination_id,max_attempts) VALUES($1,$2,$3,$4) ON CONFLICT(event_id,destination_id) DO NOTHING',
              [randomUUID(), event.id, id, config.maxAttempts],
            )
          ).rowCount;
        await audit(sql, req.actor, 'destination.backfill', id, b.command_id, {
          from: b.from,
          to: b.to,
          created,
        });
        return {
          created,
          scanned: events.length,
          next_cursor: events.length === b.limit ? events.at(-1)!.id : null,
        };
      },
    );
  });
  app.post('/v1/destinations/:id/status', async (req) => {
    requireRole(req.actor, 'admin');
    const id = idOf(req.params);
    const b = z
      .object({ ...commandFields, active: z.boolean() })
      .strict()
      .parse(req.body);
    return command(db, req.actor, b.command_id, 'destination.status', { id, ...b }, async (sql) => {
      const row = (
        await sql.query('UPDATE lex.destinations SET active=$2 WHERE id=$1 RETURNING id,active', [
          id,
          b.active,
        ])
      ).rows[0];
      if (!row) throw new AppError(404, 'not_found', 'Destination not found');
      await audit(sql, req.actor, 'destination.status', id, b.command_id, { active: b.active });
      return row;
    });
  });
  app.get('/v1/deliveries', async (req) => {
    requireRole(req.actor, 'admin', 'operator');
    const p = paging
      .extend({
        status: z
          .enum(['pending', 'running', 'retrying', 'accepted', 'processed', 'dead_letter'])
          .optional(),
      })
      .parse(req.query);
    const rows = (
      await db.query(
        'SELECT * FROM lex.deliveries WHERE ($1::uuid IS NULL OR id>$1) AND ($2::text IS NULL OR status=$2) ORDER BY id LIMIT $3',
        [p.after || null, p.status || null, p.limit],
      )
    ).rows;
    return { items: rows, next_cursor: rows.length === p.limit ? rows.at(-1)!.id : null };
  });
  app.post('/v1/deliveries/:id/replay', async (req) => {
    requireRole(req.actor, 'admin');
    const id = idOf(req.params);
    const b = z
      .object({ ...commandFields, note: z.string().min(1).max(2000) })
      .strict()
      .parse(req.body);
    return command(db, req.actor, b.command_id, 'delivery.replay', { id, ...b }, async (sql) => {
      const d = (
        await sql.query<{ status: string; active: boolean; subscribed: boolean }>(
          `SELECT d.status,p.active,(e.event_type=ANY(p.event_types)) AS subscribed FROM lex.deliveries d JOIN lex.destinations p ON p.id=d.destination_id JOIN lex.outbox e ON e.id=d.event_id WHERE d.id=$1 FOR UPDATE OF d`,
          [id],
        )
      ).rows[0];
      if (!d) throw new AppError(404, 'not_found', 'Delivery not found');
      if (!d.active || !d.subscribed)
        throw new AppError(409, 'inactive_destination', 'Destination is inactive or unsubscribed');
      if (!['dead_letter', 'accepted'].includes(d.status))
        throw new AppError(
          409,
          'not_replayable',
          'Only dead-letter or accepted/unconfirmed deliveries can be replayed',
        );
      const result = (
        await sql.query(
          `UPDATE lex.deliveries SET status='pending',attempts=0,replay_count=replay_count+1,lease_token=NULL,lease_until=NULL,last_error=NULL,next_attempt_at=now(),updated_at=now() WHERE id=$1 RETURNING *`,
          [id],
        )
      ).rows[0]!;
      await audit(sql, req.actor, 'delivery.replayed', id, b.command_id, { note: b.note });
      return result;
    });
  });
  app.post('/v1/deliveries/:id/processed', async (req) => {
    requireRole(req.actor, 'platform');
    const id = idOf(req.params);
    const b = z
      .object({ ...commandFields, event_id: uuid })
      .strict()
      .parse(req.body);
    return command(db, req.actor, b.command_id, 'delivery.processed', { id, ...b }, async (sql) => {
      const result = (
        await sql.query(
          `UPDATE lex.deliveries d SET status='processed',processed_at=COALESCE(processed_at,now()),accepted_at=COALESCE(accepted_at,now()),lease_token=NULL,lease_until=NULL,last_error=NULL,updated_at=now() FROM lex.destinations p WHERE d.id=$1 AND d.destination_id=p.id AND p.client_id=$2 AND d.event_id=$3 AND (d.attempts>0 OR d.replay_count>0) RETURNING d.*`,
          [id, req.actor.clientId, b.event_id],
        )
      ).rows[0];
      if (!result)
        throw new AppError(
          404,
          'not_found',
          'Delivery not found for this platform or not yet attempted',
        );
      await audit(sql, req.actor, 'delivery.processed', id, b.command_id);
      return result;
    });
  });
  app.get('/v1/operations/health', async (req) => {
    requireRole(req.actor, 'admin', 'operator');
    const heartbeat = (
      await db.query<{ last_seen_at: Date }>(
        'SELECT last_seen_at FROM lex.worker_heartbeats WHERE name=$1',
        ['delivery'],
      )
    ).rows[0];
    const totals = (
      await db.query<{ status: string; count: string }>(
        'SELECT status,count(*) FROM lex.deliveries GROUP BY status',
      )
    ).rows;
    const pending = (
      await db.query<{ count: string }>(
        'SELECT count(*) FROM lex.outbox WHERE dispatched_at IS NULL',
      )
    ).rows[0]!.count;
    const fresh = !!heartbeat && Date.now() - new Date(heartbeat.last_seen_at).getTime() < 120000;
    return {
      status:
        fresh && !totals.some((t) => t.status === 'dead_letter' && Number(t.count) > 0)
          ? 'healthy'
          : 'degraded',
      checked_at: new Date().toISOString(),
      database: 'available',
      worker_last_seen_at: heartbeat?.last_seen_at || null,
      worker: fresh ? 'active' : 'stale_or_not_started',
      outbox_pending: Number(pending),
      deliveries: totals,
    };
  });
  return app;
}
