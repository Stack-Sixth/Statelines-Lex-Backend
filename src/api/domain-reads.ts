import { merchantApi } from './merchants.js';
import { merchantScope } from '../merchant-authorization.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '../db.js';
import type { Config } from '../config.js';
import {
  AppError,
  corridor,
  packageSize,
  requireRole,
  serviceLevel,
  statuses,
  uuid,
} from '../domain.js';
import { createShipmentSchema, shipmentService } from '../shipments.js';
import { internalId, publicId } from '../domains/identifiers.js';
import { eventNames, eventProjection, shipmentProjection } from '../domains/projections.js';

const paging = z
  .object({
    after: z.string().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
const params = z.object({ id: z.string().min(1).max(100) });
const locationSchema = z.object({ corridor }).strict();
const merchantShipmentSchema = z
  .object({
    command_id: uuid,
    sandbox_isolated: z.literal(true).optional(),
    merchant_id: z.string().trim().min(1).max(200).optional(),
    order_id: z.string().trim().min(1).max(200),
    external_shipment_id: z.string().trim().min(1).max(200).optional(),
    correlation_id: z.string().trim().min(1).max(200),
    origin: locationSchema,
    destination: locationSchema,
    service_level: serviceLevel,
    package_size: packageSize,
    weight_kg: z.number().positive().max(1_000_000).multipleOf(0.001),
    pickup_deadline: z.iso.datetime({ offset: true }),
    delivery_deadline: z.iso.datetime({ offset: true }),
  })
  .strict()
  .refine((x) => x.origin.corridor !== x.destination.corridor, 'Origin and destination must differ')
  .refine(
    (x) => Date.parse(x.delivery_deadline) > Date.parse(x.pickup_deadline),
    'Delivery must follow pickup',
  );
const cancelSchema = z
  .object({
    command_id: uuid,
    expected_version: z.number().int().positive(),
    correlation_id: z.string().trim().min(1).max(200),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();

/** Encapsulated additive domain contract. Parent authentication/rate limiting still applies. */
export async function domainApi(app: FastifyInstance, db: Database, config: Config) {
  app.setErrorHandler((error, req, reply) => {
    const frameworkStatus = (error as { statusCode?: number }).statusCode;
    const pgCode = (error as { code?: string }).code;
    const status =
      error instanceof AppError
        ? error.status
        : error instanceof z.ZodError
          ? 400
          : pgCode === '23505'
            ? 409
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
            : status === 409
              ? 'CONFLICT'
              : status < 500
                ? 'REQUEST_ERROR'
                : 'INTERNAL_ERROR';
    if (status >= 500) req.log.error({ err: error }, 'Domain read failed');
    return reply.code(status).send({
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
  const referenceMap = async (ids: string[]) => {
    if (!ids.length) return new Map<string, Record<string, unknown>>();
    const rows = (
      await db.query<{ shipment_id: string } & Record<string, unknown>>(
        `SELECT s.id AS shipment_id,COALESCE(ms.merchant_id,r.merchant_id) AS merchant_id,r.order_id,r.external_shipment_id,r.correlation_id FROM lex.shipments s LEFT JOIN lex.merchant_shipment_refs r ON r.shipment_id=s.id LEFT JOIN merchant.shipment_scopes ms ON ms.shipment_id=s.id WHERE s.id=ANY($1::uuid[])`,
        [ids],
      )
    ).rows;
    return new Map(rows.map((row) => [row.shipment_id, row]));
  };
  await merchantApi(app, db, config);
  app.get('/api/v1/capabilities', async () => ({
    api_version: 1,
    domain_reads: config.domainReadApiEnabled === true,
    shipment_creation: config.merchantDomainApiEnabled === true,
    shipment_cancellation: config.merchantDomainApiEnabled === true,
    cancellation_preflight: config.domainReadApiEnabled === true,
  }));
  if (config.domainReadApiEnabled === true) {
    app.get('/api/v1/shipments', async (req) => {
      const q = paging
        .extend({
          status: z.enum(statuses).optional(),
          order_id: z.string().min(1).max(200).optional(),
          merchant_id: z.string().min(1).max(200).optional(),
        })
        .parse(req.query);
      const after = q.after ? internalId('shipment', q.after) : undefined;
      const rows = await service.list(req.actor, after, q.limit + 1, q);
      const page = rows.slice(0, q.limit);
      const references = await referenceMap(page.map((row) => String(row.id)));
      const items = page.map((row) =>
        shipmentProjection(
          row as Record<string, unknown>,
          req.actor.role === 'carrier' ? undefined : references.get(String(row.id)),
        ),
      );
      return { items, next_cursor: rows.length > q.limit ? items.at(-1)!.shipment_id : null };
    });
    app.get('/api/v1/shipments/:id', async (req) => {
      const id = internalId('shipment', params.parse(req.params).id);
      const result = await service.get(req.actor, id);
      const references = await referenceMap([id]);
      const reference = references.get(id);
      return {
        shipment: shipmentProjection(
          result.shipment as unknown as Record<string, unknown>,
          req.actor.role === 'carrier' ? undefined : reference,
        ),
        history: result.history,
      };
    });
    app.get('/api/v1/shipments/:id/cancellable', async (req) => {
      const id = internalId('shipment', params.parse(req.params).id);
      const result = await service.get(req.actor, id);
      const status = result.shipment.status;
      const cancellable = ['created', 'matched'].includes(status);
      return {
        shipment_id: publicId('shipment', id),
        status,
        version: result.shipment.version,
        cancellable,
        reason: cancellable
          ? null
          : status === 'cancelled'
            ? 'already_cancelled'
            : 'not_cancellable',
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
  if (config.merchantDomainApiEnabled === true) {
    app.post('/api/v1/shipments', async (req, reply) => {
      const b = merchantShipmentSchema.parse(req.body);
      requireRole(req.actor, 'merchant');
      const scope = merchantScope(req.actor);
      if (b.merchant_id && b.merchant_id !== scope)
        throw new AppError(
          403,
          'merchant_scope_mismatch',
          'Merchant does not match the authorized scope',
        );
      const created = await service.create(
        req.actor,
        createShipmentSchema.parse({
          command_id: b.command_id,
          sandbox_isolated: b.sandbox_isolated,
          owner_user_id: req.actor.id,
          origin: b.origin.corridor,
          destination: b.destination.corridor,
          service_level: b.service_level,
          package_size: b.package_size,
          weight_kg: b.weight_kg,
          pickup_deadline: b.pickup_deadline,
          delivery_deadline: b.delivery_deadline,
        }),
        {
          merchant_id: scope,
          order_id: b.order_id,
          external_shipment_id: b.external_shipment_id,
          correlation_id: b.correlation_id,
        },
      );
      const references = await referenceMap([created.id]);
      return reply.code(201).send({
        command_id: b.command_id,
        correlation_id: b.correlation_id,
        shipment: shipmentProjection(
          created as unknown as Record<string, unknown>,
          references.get(created.id),
        ),
      });
    });
    app.post('/api/v1/shipments/:id/cancel', async (req) => {
      const id = internalId('shipment', params.parse(req.params).id);
      const b = cancelSchema.parse(req.body);
      let cancelled;
      try {
        cancelled = await service.cancelMerchant(req.actor, id, b);
      } catch (error) {
        if (error instanceof AppError && error.code === 'stale_version')
          throw new AppError(409, 'version_conflict', error.message);
        throw error;
      }
      const references = await referenceMap([id]);
      return {
        command_id: b.command_id,
        correlation_id: b.correlation_id,
        shipment: shipmentProjection(
          cancelled as unknown as Record<string, unknown>,
          references.get(id),
        ),
      };
    });
  }
}
