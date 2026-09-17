import { randomUUID } from 'node:crypto';
import type { Database } from './db.js';
import type { Config } from './config.js';
import type { Sender } from './webhooks.js';
export interface DeliveryJob {
  id: string;
  event_id: string;
  destination_id: string;
  attempts: number;
  max_attempts: number;
  replay_count: number;
  lease_token: string;
  url: string;
  secret_ref: string;
  envelope: Record<string, unknown>;
}
export class DeliveryWorker {
  constructor(
    private db: Database,
    private config: Pick<Config, 'maxAttempts' | 'batchSize' | 'webhookSecrets'>,
    private send: Sender,
  ) {}
  async fanout() {
    return this.db.transaction(async (sql) => {
      const events = (
        await sql.query<{ id: string; event_type: string }>(
          `SELECT id,event_type FROM lex.outbox WHERE dispatched_at IS NULL ORDER BY created_at,id LIMIT $1 FOR UPDATE SKIP LOCKED`,
          [this.config.batchSize],
        )
      ).rows;
      for (const event of events) {
        const targets = (
          await sql.query<{ id: string }>(
            'SELECT id FROM lex.destinations WHERE active AND $1=ANY(event_types)',
            [event.event_type],
          )
        ).rows;
        for (const target of targets)
          await sql.query(
            'INSERT INTO lex.deliveries(id,event_id,destination_id,max_attempts) VALUES($1,$2,$3,$4) ON CONFLICT(event_id,destination_id) DO NOTHING',
            [randomUUID(), event.id, target.id, this.config.maxAttempts],
          );
        await sql.query('UPDATE lex.outbox SET dispatched_at=now() WHERE id=$1', [event.id]);
      }
      return events.length;
    });
  }
  async claim(): Promise<DeliveryJob | undefined> {
    return this.db.transaction(async (sql) => {
      await sql.query(
        `UPDATE lex.deliveries SET status='dead_letter',lease_token=NULL,lease_until=NULL,last_error=COALESCE(last_error,'Attempt limit reached'),updated_at=now() WHERE attempts>=max_attempts AND (status IN ('pending','retrying') OR (status='running' AND lease_until<now()))`,
      );
      const row = (
        await sql.query<Omit<DeliveryJob, 'envelope'>>(
          `SELECT d.*,p.url,p.secret_ref FROM lex.deliveries d JOIN lex.destinations p ON p.id=d.destination_id JOIN lex.outbox e ON e.id=d.event_id WHERE p.active AND e.event_type=ANY(p.event_types) AND d.attempts<d.max_attempts AND ((d.status IN ('pending','retrying') AND d.next_attempt_at<=now()) OR (d.status='running' AND d.lease_until<now())) ORDER BY d.next_attempt_at,d.id LIMIT 1 FOR UPDATE OF d SKIP LOCKED`,
        )
      ).rows[0];
      if (!row) return;
      const token = randomUUID();
      await sql.query(
        `UPDATE lex.deliveries SET status='running',attempts=attempts+1,lease_token=$2,lease_until=now()+interval '60 seconds',updated_at=now() WHERE id=$1`,
        [row.id, token],
      );
      const event = (
        await sql.query<{ envelope: Record<string, unknown> }>(
          'SELECT envelope FROM lex.outbox WHERE id=$1',
          [row.event_id],
        )
      ).rows[0]!;
      return { ...row, attempts: row.attempts + 1, lease_token: token, envelope: event.envelope };
    });
  }
  async process(job: DeliveryJob) {
    // Recheck immediately before I/O; an already in-flight request cannot be recalled.
    const active = (
      await this.db.query(
        'SELECT id FROM lex.destinations WHERE id=$1 AND active AND $2=ANY(event_types)',
        [job.destination_id, String(job.envelope.event_type)],
      )
    ).rowCount;
    if (!active) {
      await this.db.query(
        `UPDATE lex.deliveries SET status='retrying',attempts=GREATEST(attempts-1,0),lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2`,
        [job.id, job.lease_token],
      );
      return;
    }
    const secret = this.config.webhookSecrets[job.secret_ref];
    let result;
    try {
      result = secret
        ? await this.send(job.url, secret, job.envelope, job.id)
        : { ok: false, retryable: false, status: 0, error: 'Webhook secret is not configured' };
    } catch {
      result = { ok: false, retryable: true, status: 0, error: 'Unexpected transport failure' };
    }
    await this.db.transaction(async (sql) => {
      const current = (
        await sql.query<{ status: string }>(
          'SELECT status FROM lex.deliveries WHERE id=$1 AND lease_token=$2 FOR UPDATE',
          [job.id, job.lease_token],
        )
      ).rows[0];
      if (!current || current.status !== 'running') return; // A newer lease or processing receipt owns the outcome.
      const status = result.ok
        ? result.processed
          ? 'processed'
          : 'accepted'
        : !result.retryable || job.attempts >= job.max_attempts
          ? 'dead_letter'
          : 'retrying';
      const delay =
        Math.min(3600000, 1000 * 2 ** Math.min(job.attempts, 12)) +
        Math.floor(Math.random() * 1000);
      await sql.query(
        `UPDATE lex.deliveries SET status=$3,lease_token=NULL,lease_until=NULL,last_error=$4,next_attempt_at=$5,accepted_at=CASE WHEN $6 THEN now() ELSE accepted_at END,processed_at=CASE WHEN $7 THEN now() ELSE processed_at END,updated_at=now() WHERE id=$1 AND lease_token=$2`,
        [
          job.id,
          job.lease_token,
          status,
          result.error || null,
          new Date(Date.now() + delay),
          result.ok,
          !!result.processed,
        ],
      );
      await sql.query(
        'INSERT INTO lex.delivery_attempts(id,delivery_id,attempt,replay_count,http_status,outcome,error) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          randomUUID(),
          job.id,
          job.attempts,
          job.replay_count,
          result.status,
          status,
          result.error || null,
        ],
      );
    });
  }
  async tick() {
    await this.fanout();
    let count = 0;
    for (let i = 0; i < this.config.batchSize; i++) {
      const job = await this.claim();
      if (!job) break;
      await this.process(job);
      count++;
    }
    await this.db.query(
      "INSERT INTO lex.worker_heartbeats(name,last_seen_at) VALUES('delivery',now()) ON CONFLICT(name) DO UPDATE SET last_seen_at=now()",
    );
    return count;
  }
}
