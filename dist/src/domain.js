import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
export class AppError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
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
];
export const transitions = {
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
export function requireRole(actor, ...roles) {
    if (!roles.includes(actor.role))
        throw new AppError(403, 'forbidden', 'This role cannot perform this operation');
}
export function canonical(value) {
    if (Array.isArray(value))
        return '[' + value.map(canonical).join(',') + ']';
    if (value !== null && typeof value === 'object')
        return ('{' +
            Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
                .join(',') +
            '}');
    return JSON.stringify(value);
}
export async function command(db, actor, id, action, input, fn) {
    const fingerprint = createHash('sha256')
        .update(canonical({ actor, action, input }))
        .digest('hex');
    return db.transaction(async (sql) => {
        // Transaction advisory lock serializes the same command across API instances.
        await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [id]);
        const prior = (await sql.query('SELECT fingerprint,result FROM lex.commands WHERE id=$1', [id])).rows[0];
        if (prior) {
            if (prior.fingerprint !== fingerprint)
                throw new AppError(409, 'command_conflict', 'command_id was already used with different input or identity');
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
export async function audit(sql, actor, action, entityId, commandId, details = {}) {
    await sql.query('INSERT INTO lex.audit_log(id,actor_id,action,entity_id,command_id,details) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), actor.id, action, entityId, commandId, JSON.stringify(details)]);
}
export async function emit(sql, eventType, shipment, commandId, payload) {
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
    await sql.query('INSERT INTO lex.outbox(id,event_type,aggregate_id,aggregate_version,envelope) VALUES($1,$2,$3,$4,$5)', [id, eventType, shipment.id, shipment.version, JSON.stringify(envelope)]);
    return id;
}
//# sourceMappingURL=domain.js.map