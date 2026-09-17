import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Role } from './config.js';
import type { Database, Sql } from './db.js';
export interface Actor {
  id: string;
  role: Role;
  clientId: string;
}
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export const uuid = z.string().uuid();
export const commandFields = { command_id: uuid };
export const versionFields = { ...commandFields, expected_version: z.number().int().positive() };
export const corridor = z
  .string()
  .trim()
  .min(2)
  .max(120)
  .transform((s) => s.toLowerCase().replace(/\s+/g, ' '));
export const packageSize = z.enum(['small', 'medium', 'large', 'xl']);
export const serviceLevel = z.enum(['standard', 'express', 'same_day', 'overnight']);
export const statuses = [
  'created',
  'matched',
  'picked_up',
  'in_transit',
  'at_node',
  'out_for_delivery',
  'delivered',
  'cancelled',
  'exception',
  'return_in_transit',
  'returned',
] as const;
export type Status = (typeof statuses)[number];
export interface Shipment {
  id: string;
  tracking_id: string;
  owner_user_id: string;
  origin: string;
  destination: string;
  weight_kg: string;
  package_size: string;
  service_level: string;
  status: Status;
  version: number;
  pickup_deadline: string | Date;
  delivery_deadline: string | Date;
  assigned_carrier_id: string | null;
  capacity_reserved: boolean;
}
export const transitions: Record<Status, readonly Status[]> = {
  created: ['cancelled'],
  matched: ['picked_up', 'cancelled', 'exception'],
  picked_up: ['in_transit', 'at_node', 'exception', 'return_in_transit'],
  in_transit: ['at_node', 'out_for_delivery', 'exception', 'return_in_transit'],
  at_node: ['in_transit', 'out_for_delivery', 'exception', 'return_in_transit'],
  out_for_delivery: ['delivered', 'exception', 'return_in_transit'],
  delivered: ['return_in_transit'],
  cancelled: [],
  exception: [
    'matched',
    'picked_up',
    'in_transit',
    'at_node',
    'out_for_delivery',
    'return_in_transit',
    'cancelled',
  ],
  return_in_transit: ['returned', 'exception'],
  returned: [],
};
export function requireRole(actor: Actor, ...roles: Role[]) {
  if (!roles.includes(actor.role))
    throw new AppError(403, 'forbidden', 'This role cannot perform this operation');
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export async function command<T>(
  db: Database,
  actor: Actor,
  id: string,
  action: string,
  input: unknown,
  fn: (sql: Sql) => Promise<T>,
): Promise<T> {
  const fingerprint = createHash('sha256')
    .update(canonical({ actor, action, input }))
    .digest('hex');
  return db.transaction(async (sql) => {
    // Transaction advisory lock serializes the same command across API instances.
    await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [id]);
    const prior = (
      await sql.query<{ fingerprint: string; result: T }>(
        'SELECT fingerprint,result FROM lex.commands WHERE id=$1',
        [id],
      )
    ).rows[0];
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new AppError(
          409,
          'command_conflict',
          'command_id was already used with different input or identity',
        );
      return prior.result;
    }
    await sql.query('INSERT INTO lex.commands(id,actor_id,fingerprint) VALUES($1,$2,$3)', [
      id,
      actor.id,
      fingerprint,
    ]);
    const result = await fn(sql);
    await sql.query('UPDATE lex.commands SET result=$2 WHERE id=$1', [id, JSON.stringify(result)]);
    return result;
  });
}
export async function audit(
  sql: Sql,
  actor: Actor,
  action: string,
  entityId: string,
  commandId: string,
  details: unknown = {},
) {
  await sql.query(
    'INSERT INTO lex.audit_log(id,actor_id,action,entity_id,command_id,details) VALUES($1,$2,$3,$4,$5,$6)',
    [randomUUID(), actor.id, action, entityId, commandId, JSON.stringify(details)],
  );
}
export async function emit(
  sql: Sql,
  eventType: string,
  shipment: Pick<Shipment, 'id' | 'version'>,
  commandId: string,
  payload: unknown,
) {
  const id = randomUUID();
  const envelope = {
    event_id: id,
    event_type: eventType,
    schema_version: 1,
    source: 'statelines-lex',
    occurred_at: new Date().toISOString(),
    correlation_id: shipment.id,
    causation_id: commandId,
    aggregate: { type: 'shipment', id: shipment.id, version: shipment.version },
    payload,
  };
  await sql.query(
    'INSERT INTO lex.outbox(id,event_type,aggregate_id,aggregate_version,envelope) VALUES($1,$2,$3,$4,$5)',
    [id, eventType, shipment.id, shipment.version, JSON.stringify(envelope)],
  );
  return id;
}
