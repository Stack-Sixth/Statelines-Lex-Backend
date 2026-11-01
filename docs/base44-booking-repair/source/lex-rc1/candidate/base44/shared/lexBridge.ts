import {ordinaryEventCopy} from "./lexTrustedIsolation.ts";
import {eventIsolation} from "./lexEventIsolation.ts";
// LEX Platform Bridge — shared webhook delivery. Builds the versioned event
// envelope from an EventLog record, signs the COMPLETE envelope (including
// event identity and type) with HMAC-SHA256, and delivers it. Fails closed
// when signing configuration is absent.
import { nowIso } from "./lexUtils.ts";

export function isSubscribed(conn, eventName) {
  if (!conn.webhook_url) return false;
  if (!conn.enabled_events || conn.enabled_events.length === 0) return true;
  return conn.enabled_events.includes(eventName);
}

// Build the canonical versioned envelope from a persisted EventLog record.
export function buildEnvelope(ev) {
  return {
    event_id: ev.id,
    event_type: ev.event_name,
    schema_version: ev.schema_version || 1,
    source: ev.source || "statelines-lex",
    occurred_at: ev.occurred_at || ev.published_at,
    correlation_id: ev.correlation_id || null,
    causation_id: ev.causation_id || null,
    aggregate: {
      type: ev.aggregate_type || null,
      id: ev.aggregate_id || null,
      version: ev.aggregate_version ?? null,
    },
    payload: ev.payload || {},
  };
}

async function hmacSha256Hex(key, bodyText) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(bodyText));
  return "sha256=" + Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// deliver(conn, ev, signKey) — ev is an EventLog record. The full envelope is
// the signed body. Returns { ok, status, error, duration_ms }. Fails closed if
// no signing key is available.
export async function deliver(conn, ev, signKey, base44?:any) {
  // Every initial/retry/replay/DLQ path converges here. Never trust a supplied
  // queue/DLQ payload or a previous classification. Reload and reclassify now.
  if(!base44||!ev?.id)return {ok:false,status:409,error:'persisted_event_required',duration_ms:0,held:true};
  let persisted,state;
  try {
    if(!conn?.id)throw new Error('destination_required');
    conn=await base44.asServiceRole.entities.PlatformConnection.get(conn.id);
    if(!conn||conn.status!=='active'||!conn.webhook_url)throw new Error('destination_not_active_or_subscribed');
    persisted=await base44.asServiceRole.entities.EventLog.get(ev.id);
    if(!persisted||persisted.id!==ev.id)throw new Error('missing_event');
    if(!isSubscribed(conn,persisted.event_name))throw new Error('destination_not_subscribed');
    state=await eventIsolation(base44,persisted);
  } catch {return {ok:false,status:409,error:'isolation_unknown',duration_ms:0,held:true};}
  if(state.kind!=='ordinary')return {ok:false,status:state.kind==='isolated'?403:409,error:state.kind==='isolated'?'sandbox_isolated':'isolation_unknown',duration_ms:0,held:true};
  // An ordinary caller cannot suppress downstream processing using fake test
  // assertions. Preserve every benign wire field; normalize only such claims.
  const hadAssertions=/"(?:sandbox_isolated|sandbox|synthetic|is_sandbox|sandbox_record|test_harness)"\s*:/.test(JSON.stringify(persisted.payload||{}));
  ev=hadAssertions?ordinaryEventCopy(persisted,state):persisted;
  const envelope = buildEnvelope(ev);
  const bodyText = JSON.stringify(envelope);
  const key = signKey || conn.auth_secret;
  if (!key) return { ok: false, status: 0, error: "missing signing key", duration_ms: 0 };
  const headers = {
    "Content-Type": "application/json",
    "X-LEX-Event": envelope.event_type,
    "X-LEX-Event-Id": envelope.event_id,
    "X-LEX-Correlation-Id": envelope.correlation_id || "",
    "X-LEX-Schema-Version": String(envelope.schema_version),
    "X-LEX-Signature": await hmacSha256Hex(key, bodyText),
  };
  const t0 = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(conn.webhook_url, { method: "POST", headers, body: bodyText, signal: ctrl.signal });
    clearTimeout(t);
    return { ok: res.ok, status: res.status, error: res.ok ? null : "HTTP " + res.status, duration_ms: Date.now() - t0 };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, status: 0, error: e.message, duration_ms: Date.now() - t0 };
  }
}

// Record the first delivery attempt for an event+destination as a single
// authoritative PlatformDelivery record. Subsequent attempts UPDATE that record
// (see lexEventReliability), so there is one row per (event_id, connection_id).
export async function recordDelivery(base44, conn, eventId, eventName, correlationId, result) {
  if(result.held) {
    // Per-event hold, never poison/disable the shared destination or claim delivery.
    await base44.asServiceRole.entities.EventLog.update(eventId,{isolation_hold:result.error,isolation_checked_at:nowIso()});
    return;
  }
  await base44.asServiceRole.entities.PlatformDelivery.create({
    connection_id: conn.id, connection_name: conn.name,
    event_id: eventId, event_name: eventName, correlation_id: correlationId || null,
    status: result.ok ? "delivered" : "failed",
    http_status: result.status, attempts: 1,
    attempts_log: [{ at: nowIso(), status: result.ok ? "delivered" : "failed", http_status: result.status, error: result.error, duration_ms: result.duration_ms ?? null }],
    duration_ms: result.duration_ms ?? null, error: result.error,
    delivered_at: result.ok ? nowIso() : null,
    terminal: !!result.ok,
  });
  await base44.asServiceRole.entities.PlatformConnection.update(conn.id, {
    last_delivery_at: nowIso(),
    last_delivery_status: result.ok ? "ok" : "failed",
    last_error: result.error || null,
  });
}

export { nowIso };