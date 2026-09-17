// LEX Platform Bridge — shared webhook delivery logic used by the publisher,
// reliability, and orchestration queue services. Webhook contract (headers,
// HMAC signing) is unchanged.
import { nowIso } from "./lexUtils.ts";

export function isSubscribed(conn, eventName) {
  if (!conn.webhook_url) return false;
  if (!conn.enabled_events || conn.enabled_events.length === 0) return true;
  return conn.enabled_events.includes(eventName);
}

export async function deliver(conn, eventName, payload, correlationId, signKey) {
  const bodyText = JSON.stringify(payload || {});
  const headers = {
    "Content-Type": "application/json",
    "X-LEX-Event": eventName,
    "X-LEX-Correlation-Id": correlationId || "",
  };
  const key = signKey || conn.auth_secret;
  if (key) {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(bodyText));
    headers["X-LEX-Signature"] =
      "sha256=" + Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
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

export async function recordDelivery(base44, conn, eventId, eventName, correlationId, result) {
  await base44.asServiceRole.entities.PlatformDelivery.create({
    connection_id: conn.id,
    connection_name: conn.name,
    event_id: eventId,
    event_name: eventName,
    correlation_id: correlationId || null,
    status: result.ok ? "delivered" : "failed",
    http_status: result.status,
    attempts: 1,
    duration_ms: result.duration_ms ?? null,
    error: result.error,
    delivered_at: nowIso(),
  });
  await base44.asServiceRole.entities.PlatformConnection.update(conn.id, {
    last_delivery_at: nowIso(),
    last_delivery_status: result.ok ? "ok" : "failed",
    last_error: result.error || null,
  });
}