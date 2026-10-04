import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '../db.js';
import { AppError, requireRole } from '../domain.js';
import { shipmentService } from '../shipments.js';
import { internalId } from '../domains/identifiers.js';
import { eventNames, eventProjection, shipmentProjection } from '../domains/projections.js';

const paging = z
  .object({
    after: z.string().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
const params = z.object({ id: z.string().min(1).max(100) });

/** Encapsulated additive read contract. Parent authentication/rate limiting still applies. */
export async function domainReads(app: FastifyInstance, db: Database) {
  app.setErrorHandler((error, req, reply) => {
    const frameworkStatus = (error as { statusCode?: number }).statusCode;
    const status =
      error instanceof AppError
        ? error.status
        : error instanceof z.ZodError
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus < 500
            ? frameworkStatus
            : 500;
    const code =
      error instanceof AppError
        ? error.code.toUpperCase()
        : status === 400
          ? 'VALIDATION_ERROR'
          : status === 429
            ? 'RATE_LIMIT_EXCEEDED'
            : status < 500
              ? 'REQUEST_ERROR'
              : 'INTERNAL_ERROR';
    if (status >= 500) req.log.error({ err: error }, 'Domain read failed');
    return reply
      .code(status)
      .send({
        error: {
          code,
          message:
            error instanceof AppError
              ? error.message
              : status < 500
                ? 'Invalid request'
                : 'Request failed',
          correlation_id: req.id,
        },
      });
  });
  const service = shipmentService(db);
  app.get('/api/v1/shipments', async (req) => {
    const q = paging.parse(req.query);
    const rows = await service.list(
      req.actor,
      q.after ? internalId('shipment', q.after) : undefined,
      q.limit + 1,
    );
    const more = rows.length > q.limit;
    const items = rows
      .slice(0, q.limit)
      .map((row) => shipmentProjection(row as Record<string, unknown>));
    return { items, next_cursor: more ? items.at(-1)!.shipment_id : null };
  });
  app.get('/api/v1/shipments/:id', async (req) => {
    const id = internalId('shipment', params.parse(req.params).id);
    const result = await service.get(req.actor, id);
    return {
      shipment: shipmentProjection(result.shipment as unknown as Record<string, unknown>),
      history: result.history,
    };
  });
  // Event payloads include operational/accounting data: never expose to general clients.
  app.get('/api/v1/events', async (req) => {
    requireRole(req.actor, 'admin', 'operator');
    const q = paging.parse(req.query);
    const rows = (
      await db.query<{ envelope: Record<string, unknown> }>(
        'SELECT envelope FROM lex.outbox WHERE ($1::uuid IS NULL OR id>$1) AND event_type=ANY($2::text[]) ORDER BY id LIMIT $3',
        [q.after ? internalId('event', q.after) : null, Object.keys(eventNames), q.limit + 1],
      )
    ).rows;
    const items = rows.slice(0, q.limit).map((row) => eventProjection(row.envelope));
    return { items, next_cursor: rows.length > q.limit ? items.at(-1)!.event_id : null };
  });
  app.get('/api/v1/events/:id', async (req) => {
    requireRole(req.actor, 'admin', 'operator');
    const id = internalId('event', params.parse(req.params).id);
    const row = (
      await db.query<{ envelope: Record<string, unknown> }>(
        'SELECT envelope FROM lex.outbox WHERE id=$1 AND event_type=ANY($2::text[])',
        [id, Object.keys(eventNames)],
      )
    ).rows[0];
    if (!row) throw new AppError(404, 'not_found', 'Event not found');
    return eventProjection(row.envelope);
  });
}
