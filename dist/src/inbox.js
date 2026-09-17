import { z } from 'zod';
import { AppError, canonical } from './domain.js';
import { verifySignature } from './webhooks.js';
const eventSchema = z
    .object({
    event_id: z.string().uuid(),
    event_type: z.string().min(1).max(120),
    schema_version: z.literal(1),
    source: z.literal('statelines-lex'),
    occurred_at: z.iso.datetime(),
    correlation_id: z.string().min(1),
    causation_id: z.string().uuid(),
    aggregate: z
        .object({
        type: z.literal('shipment'),
        id: z.string().uuid(),
        version: z.number().int().positive(),
    })
        .strict(),
    payload: z.record(z.string(), z.unknown()),
})
    .strict();
// Durable acceptance only. The receiving application's business consumer is separate.
export async function acceptEvent(db, secret, body, timestamp, sig) {
    if (!verifySignature(secret, timestamp, sig, body))
        throw new AppError(401, 'invalid_signature', 'Invalid or expired webhook signature');
    let envelope;
    try {
        envelope = eventSchema.parse(JSON.parse(body));
    }
    catch {
        throw new AppError(400, 'invalid_event', 'Unsupported or malformed event envelope');
    }
    return db.transaction(async (sql) => {
        const inserted = await sql.query('INSERT INTO lex_receiver.inbox(source,event_id,envelope) VALUES($1,$2,$3) ON CONFLICT(source,event_id) DO NOTHING RETURNING event_id', [envelope.source, envelope.event_id, JSON.stringify(envelope)]);
        const saved = (await sql.query('SELECT state,envelope FROM lex_receiver.inbox WHERE source=$1 AND event_id=$2', [envelope.source, envelope.event_id])).rows[0];
        if (canonical(saved.envelope) !== canonical(envelope))
            throw new AppError(409, 'event_conflict', 'Event identity was reused with different content');
        return {
            event_id: envelope.event_id,
            status: saved.state === 'processed' ? 'processed' : 'accepted',
            duplicate: inserted.rowCount === 0,
        };
    });
}
//# sourceMappingURL=inbox.js.map