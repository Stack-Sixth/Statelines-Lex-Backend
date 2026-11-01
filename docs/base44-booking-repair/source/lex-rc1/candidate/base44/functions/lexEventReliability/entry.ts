import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import { secrets } from "base44:runtime";
import { nowIso } from "../../shared/lexUtils.ts";
import { deliver, isSubscribed } from "../../shared/lexBridge.ts";

// LEX Event Reliability — at-least-once webhook delivery with idempotent business
// effects and reconciliation. One authoritative PlatformDelivery per (event,
// destination). Attempt ceiling enforced BEFORE sending. Bounded exponential
// backoff with jitter. Active+subscribed destinations only. Atomic-ish lease
// claims prevent concurrent workers processing the same delivery; abandoned
// leases are recovered. Manual replay reconciles the original delivery + its
// dead-letter record without repeating downstream effects.
const DEFAULT_MAX_ATTEMPTS = 5;
const LEASE_TTL_MS = 30000;
const BACKOFF_BASE_MS = 60000;
const BACKOFF_CAP_MS = 3600000;

function workerId() { return "w-" + Math.random().toString(36).slice(2, 10); }
function jitter(ms) { return Math.round(ms * (0.5 + Math.random())); }
function nextAttempt(attempts) { return new Date(Date.now() + jitter(Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_CAP_MS))).toISOString(); }
function isRetryable(r) {
  // 5xx and network/timeout errors are retryable; 4xx (except 408/429) are permanent.
  if (r.ok) return false;
  const s = r.status || 0;
  return s === 0 || s === 408 || s === 429 || (s >= 500 && s < 600);
}

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const sharedSecret = secrets.get("LEX_WEBHOOK_SECRET") || "";
    if (!sharedSecret) return Response.json({ error: "LEX_WEBHOOK_SECRET not configured (fail closed)" }, { status: 500 });
    const op = body.op || "status";

    // Recover abandoned leases before any processing.
    await recoverLeases(base44);

    if (op === "status") {
      const deliveries = await base44.asServiceRole.entities.PlatformDelivery.list("-created_date", 1000);
      const conns = await base44.asServiceRole.entities.PlatformConnection.filter({});
      const byConn = (id) => deliveries.filter((d) => d.connection_id === id);
      return Response.json({
        totals: {
          delivered: deliveries.filter((d) => d.status === "delivered").length,
          pending: deliveries.filter((d) => d.status === "pending").length,
          failed: deliveries.filter((d) => d.status === "failed").length,
          dead_lettered: deliveries.filter((d) => d.status === "dead_lettered").length,
          exhausted: deliveries.filter((d) => !d.terminal && (d.attempts || 0) >= (d.max_attempts || DEFAULT_MAX_ATTEMPTS)).length,
        },
        connections: conns.map((c) => {
          const mine = byConn(c.id);
          return {
            id: c.id, name: c.name, platform_type: c.platform_type, status: c.status, webhook_url: c.webhook_url,
            active: c.status === "active", last_delivery_at: c.last_delivery_at, last_delivery_status: c.last_delivery_status, last_error: c.last_error,
            delivered: mine.filter((d) => d.status === "delivered").length,
            pending: mine.filter((d) => d.status === "pending").length,
            failed: mine.filter((d) => d.status === "failed").length,
            exhausted: mine.filter((d) => !d.terminal && (d.attempts || 0) >= (d.max_attempts || DEFAULT_MAX_ATTEMPTS)).length,
            dead_lettered: mine.filter((d) => d.status === "dead_lettered").length,
          };
        }),
      });
    }

    if (op === "retry") {
      const me = workerId();
      const deliveries = await base44.asServiceRole.entities.PlatformDelivery.list("-created_date", 1000);
      const conns = await base44.asServiceRole.entities.PlatformConnection.filter({});
      const connById = Object.fromEntries(conns.map((c) => [c.id, c]));
      let recovered = 0, stillFailing = 0, promoted = 0, skipped = 0, leased = 0;

      const due = deliveries.filter((d) =>
        !d.terminal && ["failed", "pending"].includes(d.status) &&
        (d.attempts || 0) < (d.max_attempts || DEFAULT_MAX_ATTEMPTS) &&
        (!d.next_attempt_at || new Date(d.next_attempt_at).getTime() <= Date.now())
      );

      for (const d of due.slice(0, 50)) {
        const conn = connById[d.connection_id];
        if (!conn || conn.status !== "active" || !isSubscribed(conn, d.event_name)) { skipped++; continue; }
        const ev = await base44.asServiceRole.entities.EventLog.get(d.event_id).catch(() => null);
        if (!ev) { skipped++; continue; }

        // Attempt ceiling BEFORE sending.
        if ((d.attempts || 0) >= (d.max_attempts || DEFAULT_MAX_ATTEMPTS)) { await promoteToDeadLetter(base44, d, conn, ev, "attempt ceiling reached"); promoted++; continue; }

        // Lease claim — skip if another worker holds an active lease.
        if (d.lease_owner && d.lease_expires_at && new Date(d.lease_expires_at).getTime() > Date.now() && d.lease_owner !== me) { leased++; continue; }
        await base44.asServiceRole.entities.PlatformDelivery.update(d.id, { lease_owner: me, lease_expires_at: new Date(Date.now() + LEASE_TTL_MS).toISOString() });
        const claimed = (await base44.asServiceRole.entities.PlatformDelivery.filter({ event_id: d.event_id, connection_id: d.connection_id }))[0];
        if (!claimed || (claimed.lease_owner !== me)) { leased++; continue; }

        const r = await deliver(conn, ev, sharedSecret, base44);
        if(r.held) {
          await base44.asServiceRole.entities.EventLog.update(ev.id,{isolation_hold:r.error,isolation_checked_at:nowIso()});
          await base44.asServiceRole.entities.PlatformDelivery.update(d.id,{lease_owner:null,lease_expires_at:null});
          continue;
        }
        const attempts = (d.attempts || 0) + 1;
        const log = d.attempts_log || [];
        log.push({ at: nowIso(), status: r.ok ? "delivered" : "failed", http_status: r.status, error: r.error, duration_ms: r.duration_ms ?? null });

        if (r.ok) {
          await base44.asServiceRole.entities.PlatformDelivery.update(d.id, {
            status: "delivered", http_status: r.status, attempts, attempts_log: log,
            duration_ms: r.duration_ms ?? null, error: null, delivered_at: nowIso(),
            terminal: true, lease_owner: null, lease_expires_at: null,
          });
          await base44.asServiceRole.entities.PlatformConnection.update(conn.id, { last_delivery_at: nowIso(), last_delivery_status: "ok", last_error: null });
          recovered++;
        } else {
          const exhausted = attempts >= (d.max_attempts || DEFAULT_MAX_ATTEMPTS);
          if (exhausted) {
            await base44.asServiceRole.entities.PlatformDelivery.update(d.id, {
              status: "dead_lettered", http_status: r.status, attempts, attempts_log: log,
              error: r.error, terminal: true, lease_owner: null, lease_expires_at: null,
            });
            await promoteToDeadLetter(base44, { ...d, status: "dead_lettered", terminal: true, attempts }, conn, ev, r.error || "exhausted");
            promoted++;
          } else {
            await base44.asServiceRole.entities.PlatformDelivery.update(d.id, {
              status: isRetryable(r) ? "failed" : "dead_lettered",
              http_status: r.status, attempts, attempts_log: log, error: r.error,
              next_attempt_at: isRetryable(r) ? nextAttempt(attempts) : null,
              terminal: !isRetryable(r), lease_owner: null, lease_expires_at: null,
            });
            if (!isRetryable(r)) { await promoteToDeadLetter(base44, d, conn, ev, "permanent failure: " + r.error); promoted++; }
            else stillFailing++;
          }
        }
      }
      return Response.json({ attempted: recovered + stillFailing, recovered, still_failing: stillFailing, promoted, skipped, leased_by_others: leased });
    }

    if (op === "replay") {
      // Manual replay by filter. Reconciles existing delivery records rather than
      // creating duplicates; preserves event_id and does not repeat downstream effects.
      const hasFilter = body.event_id || body.event_type || body.shipment_id || body.from || body.to || body.platform_id;
      if (!hasFilter) return Response.json({ error: "at least one replay filter required" }, { status: 400 });
      const events = await base44.asServiceRole.entities.EventLog.list("-published_at", 500);
      const matched = events.filter((ev) => {
        if (body.event_id && ev.id !== body.event_id) return false;
        if (body.event_type && ev.event_name !== body.event_type) return false;
        if (body.shipment_id) { const p = ev.payload || {}; if (p.shipment_id !== body.shipment_id && p.tracking_id !== body.shipment_id) return false; }
        const t = new Date(ev.published_at || 0).getTime();
        if (body.from && t < new Date(body.from).getTime()) return false;
        if (body.to && t > new Date(body.to).getTime()) return false;
        return true;
      });
      let conns = (await base44.asServiceRole.entities.PlatformConnection.filter({ status: "active" }));
      if (body.platform_id) conns = conns.filter((c) => c.id === body.platform_id);
      let deliveredCount = 0, failedCount = 0;
      for (const ev of matched.slice(0, 50)) {
        for (const c of conns) {
          if (!isSubscribed(c, ev.event_name)) continue;
          const existing = await base44.asServiceRole.entities.PlatformDelivery.filter({ event_id: ev.id, connection_id: c.id });
          if (existing.length && existing[0].status === "delivered") continue;
          const r = await deliver(c, ev, sharedSecret, base44);
          if(r.held){await base44.asServiceRole.entities.EventLog.update(ev.id,{isolation_hold:r.error,isolation_checked_at:nowIso()});continue;}
          if (existing.length) {
            const d = existing[0];
            const attempts = (d.attempts || 0) + 1;
            const log = d.attempts_log || []; log.push({ at: nowIso(), status: r.ok ? "delivered" : "failed", http_status: r.status, error: r.error, duration_ms: r.duration_ms ?? null });
            await base44.asServiceRole.entities.PlatformDelivery.update(d.id, { status: r.ok ? "delivered" : "failed", http_status: r.status, attempts, attempts_log: log, error: r.error, delivered_at: r.ok ? nowIso() : null, terminal: !!r.ok, lease_owner: null, lease_expires_at: null });
          } else {
            // create first-time record via bridge
            const { recordDelivery } = await import("../../shared/lexBridge.ts");
            await recordDelivery(base44, c, ev.id, ev.event_name, ev.correlation_id || null, r);
          }
          if (r.ok) deliveredCount++; else failedCount++;
        }
      }
      return Response.json({ events_matched: matched.length, delivered: deliveredCount, failed: failedCount });
    }

    if (op === "dlq_replay") {
      if (!body.id) return Response.json({ error: "id required" }, { status: 400 });
      const item = await base44.asServiceRole.entities.DeadLetterEvent.get(body.id);
      const conns = await base44.asServiceRole.entities.PlatformConnection.filter({});
      const conn = conns.find((c) => c.id === item.target_connection_id);
      if (!conn) return Response.json({ error: "target connection not found" }, { status: 404 });
      if (conn.status !== "active") return Response.json({ error: "target connection is not active — enable it before replay" }, { status: 409 });
      const ev = await base44.asServiceRole.entities.EventLog.get(item.event_id).catch(() => null);
      const payload = ev || { id: item.event_id, event_name: item.event_name, payload: item.payload || {}, correlation_id: item.correlation_id || null, schema_version: 1, source: "statelines-lex", occurred_at: item.last_attempt_at, aggregate_type: null, aggregate_id: item.aggregate_id || null, aggregate_version: item.aggregate_version ?? null };
      if(!ev)return Response.json({replayed:false,held:true,error:'persisted_event_required'},{status:409});
      const r = await deliver(conn, payload, sharedSecret, base44);
      if(r.held){await base44.asServiceRole.entities.DeadLetterEvent.update(item.id,{failure_reason:r.error,last_attempt_at:nowIso()});return Response.json({replayed:false,held:true,error:r.error},{status:r.status});}
      if (r.ok) {
        // Reconcile: mark the original delivery delivered+terminal and the dead-letter replayed.
        const orig = item.original_delivery_id ? await base44.asServiceRole.entities.PlatformDelivery.get(item.original_delivery_id).catch(() => null) : null;
        if (orig) await base44.asServiceRole.entities.PlatformDelivery.update(orig.id, { status: "delivered", http_status: r.status, error: null, delivered_at: nowIso(), terminal: true, lease_owner: null, lease_expires_at: null });
        else await base44.asServiceRole.entities.PlatformDelivery.create({ connection_id: conn.id, connection_name: conn.name, event_id: item.event_id, event_name: item.event_name, correlation_id: item.correlation_id || null, status: "delivered", http_status: r.status, attempts: 1, terminal: true, delivered_at: nowIso() });
        await base44.asServiceRole.entities.DeadLetterEvent.update(item.id, { status: "replayed", failure_reason: null, retry_count: (item.retry_count || 0) + 1, last_attempt_at: nowIso() });
      } else {
        await base44.asServiceRole.entities.DeadLetterEvent.update(item.id, { failure_reason: r.error, retry_count: (item.retry_count || 0) + 1, last_attempt_at: nowIso() });
      }
      return Response.json({ replayed: r.ok, http_status: r.status, error: r.error || null });
    }

    return Response.json({ error: "Unknown op" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

async function promoteToDeadLetter(base44, d, conn, ev, reason) {
  const existing = await base44.asServiceRole.entities.DeadLetterEvent.filter({ event_id: d.event_id, target_connection_id: conn.id });
  if (existing.length) return;
  await base44.asServiceRole.entities.DeadLetterEvent.create({
    event_id: d.event_id, event_name: ev?.event_name || d.event_name,
    target_connection_id: conn.id, target_platform: conn.name,
    original_delivery_id: d.id, payload: ev?.payload || {}, correlation_id: ev?.correlation_id || d.correlation_id || null,
    aggregate_id: ev?.aggregate_id || null, aggregate_version: ev?.aggregate_version ?? null,
    failure_reason: reason, retry_count: d.attempts || 0, status: "held", last_attempt_at: nowIso(),
  });
}

async function recoverLeases(base44) {
  const now = nowIso();
  const deliveries = await base44.asServiceRole.entities.PlatformDelivery.list("-created_date", 500);
  const stuck = deliveries.filter((d) => d.lease_owner && d.lease_expires_at && new Date(d.lease_expires_at).getTime() < Date.now() && !d.terminal);
  for (const d of stuck) {
    await base44.asServiceRole.entities.PlatformDelivery.update(d.id, { lease_owner: null, lease_expires_at: null, status: d.status === "pending" ? "failed" : d.status });
  }
}