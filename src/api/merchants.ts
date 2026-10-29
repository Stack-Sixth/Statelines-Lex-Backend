import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import type { Config } from '../config.js';
import { AppError, audit, command, commandFields, requireRole, versionFields } from '../domain.js';
import { publicId } from '../domains/identifiers.js';
import { merchantScope } from '../merchant-authorization.js';
const label = z.string().trim().min(1).max(200);
const subjects = z
  .array(z.string().min(1).max(200))
  .min(1)
  .max(500)
  .refine((ids) => new Set(ids).size === ids.length, 'Duplicate subjects');
const merchantId = z.string().regex(/^MER_[0-9a-f]{32}$/);

/** Admin-only provisioning; credentials remain in server configuration, never in database/API responses. */
export async function merchantApi(app: FastifyInstance, db: Database, config: Config) {
  app.get('/api/v1/merchant-context', async (req) => {
    requireRole(req.actor, 'merchant');
    return {
      merchant_id: merchantScope(req.actor),
      client_id: req.actor.clientId,
      subject: req.actor.id,
      authorization: 'active',
      ...((
        await db.query<{ sandbox_isolated: boolean }>(
          'SELECT sandbox_isolated FROM merchant.accounts WHERE merchant_id=$1',
          [merchantScope(req.actor)],
        )
      ).rows[0]?.sandbox_isolated
        ? { sandbox_isolated: true }
        : {}),
    };
  });
  app.post('/api/v1/merchants', async (req, reply) => {
    requireRole(req.actor, 'admin');
    const b = z
      .object({
        ...commandFields,
        name: label,
        external_reference: label,
        sandbox_isolated: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    if (b.sandbox_isolated && !config.syntheticBusinessIds?.includes(b.external_reference))
      throw new AppError(
        403,
        'synthetic_business_not_approved',
        'Synthetic business is not server-approved',
      );
    const result = await command(
      db,
      req.actor,
      b.command_id,
      'merchant.provision',
      b,
      async (sql) => {
        const id = publicId('merchant', randomUUID());
        const merchant = (
          await sql.query(
            'INSERT INTO merchant.accounts(merchant_id,name,external_reference,sandbox_isolated) VALUES($1,$2,$3,$4) RETURNING merchant_id,name,external_reference,active,version,sandbox_isolated',
            [
              id,
              b.name,
              b.external_reference,
              config.syntheticBusinessIds?.includes(b.external_reference) === true,
            ],
          )
        ).rows[0]!;
        await audit(sql, req.actor, 'merchant.provisioned', id, b.command_id);
        return { merchant };
      },
    );
    return reply.code(201).send(result);
  });
  app.get('/api/v1/merchants/:id', async (req) => {
    requireRole(req.actor, 'admin');
    const id = merchantId.parse((req.params as { id: string }).id);
    const merchant = (
      await db.query(
        'SELECT merchant_id,name,external_reference,active,version,sandbox_isolated FROM merchant.accounts WHERE merchant_id=$1',
        [id],
      )
    ).rows[0];
    if (!merchant) throw new AppError(404, 'merchant_not_found', 'Merchant not found');
    const clients = (
      await db.query(
        'SELECT client_id,active,version FROM merchant.service_clients WHERE merchant_id=$1 ORDER BY client_id',
        [id],
      )
    ).rows;
    return { merchant, clients };
  });
  app.post('/api/v1/merchants/:id/service-clients', async (req, reply) => {
    requireRole(req.actor, 'admin');
    const id = merchantId.parse((req.params as { id: string }).id);
    const b = z
      .object({ ...commandFields, client_id: label, subjects })
      .strict()
      .parse(req.body);
    const client = config.clients.find((c) => c.id === b.client_id);
    if (!client || client.roles.length !== 1 || client.roles[0] !== 'merchant')
      throw new AppError(
        422,
        'invalid_merchant_client',
        'Configure a dedicated client with only the merchant role first',
      );
    const result = await command(
      db,
      req.actor,
      b.command_id,
      'merchant.client.bind',
      { id, ...b },
      async (sql) => {
        const account = (
          await sql.query<{ active: boolean }>(
            'SELECT active FROM merchant.accounts WHERE merchant_id=$1 FOR SHARE',
            [id],
          )
        ).rows[0];
        if (!account) throw new AppError(404, 'merchant_not_found', 'Merchant not found');
        if (!account.active)
          throw new AppError(403, 'merchant_inactive', 'Merchant account is inactive');
        const binding = (
          await sql.query(
            'INSERT INTO merchant.service_clients(client_id,merchant_id) VALUES($1,$2) RETURNING client_id,merchant_id,active,version',
            [b.client_id, id],
          )
        ).rows[0]!;
        for (const subject of b.subjects)
          await sql.query(
            'INSERT INTO merchant.client_subjects(client_id,subject_id) VALUES($1,$2)',
            [b.client_id, subject],
          );
        await audit(sql, req.actor, 'merchant.client.bound', id, b.command_id, {
          client_id: b.client_id,
          subjects: b.subjects,
        });
        return { ...binding, subjects: b.subjects };
      },
    );
    return reply.code(201).send(result);
  });
  app.post('/api/v1/merchant-service-clients/:clientId/authorization', async (req) => {
    requireRole(req.actor, 'admin');
    const clientId = label.parse((req.params as { clientId: string }).clientId);
    const b = z
      .object({ ...versionFields, active: z.boolean(), subjects })
      .strict()
      .parse(req.body);
    return command(
      db,
      req.actor,
      b.command_id,
      'merchant.client.authorize',
      { clientId, ...b },
      async (sql) => {
        const result = (
          await sql.query(
            'UPDATE merchant.service_clients SET active=$2,version=version+1 WHERE client_id=$1 AND version=$3 RETURNING client_id,merchant_id,active,version',
            [clientId, b.active, b.expected_version],
          )
        ).rows[0];
        if (!result)
          throw new AppError(
            409,
            'version_conflict',
            'Client binding is missing or its version changed',
          );
        await sql.query('DELETE FROM merchant.client_subjects WHERE client_id=$1', [clientId]);
        for (const subject of b.subjects)
          await sql.query(
            'INSERT INTO merchant.client_subjects(client_id,subject_id) VALUES($1,$2)',
            [clientId, subject],
          );
        await audit(
          sql,
          req.actor,
          'merchant.client.authorization_changed',
          String(result.merchant_id),
          b.command_id,
          { client_id: clientId, active: b.active, subjects: b.subjects },
        );
        return { ...result, subjects: b.subjects };
      },
    );
  });
  app.post('/api/v1/merchants/:id/status', async (req) => {
    requireRole(req.actor, 'admin');
    const id = merchantId.parse((req.params as { id: string }).id);
    const b = z
      .object({ ...versionFields, active: z.boolean() })
      .strict()
      .parse(req.body);
    return command(db, req.actor, b.command_id, 'merchant.status', { id, ...b }, async (sql) => {
      const result = (
        await sql.query(
          'UPDATE merchant.accounts SET active=$2,version=version+1 WHERE merchant_id=$1 AND version=$3 RETURNING merchant_id,active,version',
          [id, b.active, b.expected_version],
        )
      ).rows[0];
      if (!result)
        throw new AppError(409, 'version_conflict', 'Merchant is missing or its version changed');
      await audit(sql, req.actor, 'merchant.status_changed', id, b.command_id, {
        active: b.active,
      });
      return result;
    });
  });
}
