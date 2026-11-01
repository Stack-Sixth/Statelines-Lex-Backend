import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import { secrets } from "base44:runtime";
import { nowIso, appendToOutbox } from "../../shared/lexUtils.ts";
import { deliver, isSubscribed, recordDelivery } from "../../shared/lexBridge.ts";
import {eventIsolation} from "../../shared/lexEventIsolation.ts";
import {isolationDenied,ordinaryEventCopy} from "../../shared/lexTrustedIsolation.ts";

// LEX Platform Bridge — outbound integration layer. Publishes outbox events to
// every subscribed, active Statelines platform via signed versioned envelopes.
// Modes: "sync" (deliver undelivered events using a checkpoint, not a newest-N
// scan), "publish" (append one event and deliver), "ping" (health-check).
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json().catch(() => ({}));

    const sharedSecret = secrets.get("LEX_WEBHOOK_SECRET") || "";
    if (!sharedSecret) return Response.json({ error: "LEX_WEBHOOK_SECRET not configured — signing is required (fail closed)" }, { status: 500 });
    const mode = body.mode || "sync";

    if (mode === "ping") {
      const conns = await base44.asServiceRole.entities.PlatformConnection.filter({});
      const results = [];
      for (const c of conns) {
        let ok = false, status = 0, err = null;
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 6000);
        try { const res = await fetch(c.base_url, { method: "GET", signal: ctrl.signal }); ok = res.ok; status = res.status; } catch (e) { err = e.message; }
        clearTimeout(t);
        await base44.asServiceRole.entities.PlatformConnection.update(c.id, { last_delivery_status: ok ? "ok" : "failed", last_error: err || (ok ? null : "HTTP " + status) });
        results.push({ id: c.id, name: c.name, ok, status, error: err });
      }
      return Response.json({ pinged: results.length, results });
    }

    if (mode === "publish") {
      const eventName = body.event_name;
      if (!eventName) return Response.json({ error: "event_name required" }, { status: 400 });
      const classification=await eventIsolation(base44,{event_name:eventName,payload:body.payload||{},aggregate_type:body.aggregate?.type||null,aggregate_id:body.aggregate?.id||null});
      const blocked=isolationDenied(classification);if(blocked)return blocked;
      const hadAssertions=/"(?:sandbox_isolated|sandbox|synthetic|is_sandbox|sandbox_record|test_harness)"\s*:/.test(JSON.stringify(body));
      const safe=hadAssertions?ordinaryEventCopy(body,classification):body;
      const log = await appendToOutbox(base44, {
        event_type: eventName, payload: safe.payload || {},
        correlation_id: body.correlation_id || null, causation_id: body.command_id || null,
        aggregate: body.aggregate || null,
      });
      const conns = (await base44.asServiceRole.entities.PlatformConnection.filter({ status: "active" })).filter((c) => isSubscribed(c, eventName));
      let delivered = 0, failed = 0;
      for (const c of conns) {
        const r = await deliver(c, ordinaryEventCopy(log,classification), sharedSecret, base44);
        await recordDelivery(base44, c, log.id, eventName, body.correlation_id || null, r);
        if (r.ok) delivered++; else failed++;
      }
      return Response.json({ event_id: log.id, delivered, failed });
    }

    // sync — deliver undelivered events using a checkpoint (durable pagination).
    // One batch per run; the scheduled sweep advances the checkpoint so old
    // backlogs are processed without re-scanning already-delivered events.
    const conns = await base44.asServiceRole.entities.PlatformConnection.filter({ status: "active" });
    const checkpoint = await getCheckpoint(base44);
    const query = checkpoint ? { created_date: { $gt: checkpoint } } : {};
    const events = await base44.asServiceRole.entities.EventLog.filter(query, "created_date", 100);
    let totalDelivered = 0, totalFailed = 0, scanned = 0,isolated=0,blocked=0;
    let lastSeen = checkpoint;
    for (const ev of events) {
      scanned++;
      const classification=await eventIsolation(base44,ev);
      if(classification.kind!=='ordinary') {
        await base44.asServiceRole.entities.EventLog.update(ev.id,{isolation_hold:classification.kind==='isolated'?'sandbox_isolated':'isolation_unknown',isolation_checked_at:nowIso()});
        if(classification.kind==='unknown'){blocked++;break;}
        isolated++;
        lastSeen=ev.created_date||ev.published_at||lastSeen;continue;
      }
      let eventHeld=false;
      const subscribed = conns.filter((c) => isSubscribed(c, ev.event_name));
      for (const c of subscribed) {
        const existing = await base44.asServiceRole.entities.PlatformDelivery.filter({ event_id: ev.id, connection_id: c.id });
        if (existing.length && (existing[0].status === "delivered" || existing[0].terminal)) continue;
        const r = await deliver(c, ev, sharedSecret, base44);
        if(r.held){await base44.asServiceRole.entities.EventLog.update(ev.id,{isolation_hold:r.error,isolation_checked_at:nowIso()});eventHeld=true;break;}
        if (existing.length) await updateDelivery(base44, existing[0], r);
        else await recordDelivery(base44, c, ev.id, ev.event_name, ev.correlation_id || null, r);
        if (r.ok) totalDelivered++; else totalFailed++;
      }
      if(eventHeld)break;
      lastSeen = ev.created_date || ev.published_at || lastSeen;
    }
    if (lastSeen && lastSeen !== checkpoint) await setCheckpoint(base44, user, lastSeen);

    const recent = await base44.asServiceRole.entities.PlatformDelivery.list("-delivered_at", 20);
    return Response.json({ scanned,isolated,blocked, delivered: totalDelivered, failed: totalFailed, checkpoint: lastSeen, recent_deliveries: recent });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

async function getCheckpoint(base44) {
  const rows = await base44.asServiceRole.entities.PlatformConfig.filter({ config_key: "lex_outbox_checkpoint" });
  return rows[0]?.values?.last_event_created_at || null;
}
async function setCheckpoint(base44, user, value) {
  const rows = await base44.asServiceRole.entities.PlatformConfig.filter({ config_key: "lex_outbox_checkpoint" });
  if (rows[0]) await base44.asServiceRole.entities.PlatformConfig.update(rows[0].id, { values: { last_event_created_at: value }, version: (rows[0].version || 1) + 1, updated_by: user.id });
  else await base44.asServiceRole.entities.PlatformConfig.create({ config_key: "lex_outbox_checkpoint", category: "other", label: "LEX outbox sweep checkpoint", values: { last_event_created_at: value } });
}
async function updateDelivery(base44, d, r) {
  const attempts = (d.attempts || 0) + 1;
  const log = d.attempts_log || [];
  log.push({ at: nowIso(), status: r.ok ? "delivered" : "failed", http_status: r.status, error: r.error, duration_ms: r.duration_ms ?? null });
  await base44.asServiceRole.entities.PlatformDelivery.update(d.id, {
    status: r.ok ? "delivered" : "failed", http_status: r.status, attempts,
    attempts_log: log, duration_ms: r.duration_ms ?? null, error: r.error,
    delivered_at: r.ok ? nowIso() : null, terminal: !!r.ok,
  });
}