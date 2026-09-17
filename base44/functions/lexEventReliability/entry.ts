import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import { secrets } from "base44:runtime";
import { nowIso } from "../../shared/lexUtils.ts";
import { deliver, recordDelivery } from "../../shared/lexBridge.ts";

// LEX Event Reliability — extends the Platform Bridge with automatic retry (exponential
// backoff), dead-letter promotion, replay (by shipment / platform / event type / date
// range), and delivery metrics. Webhook contracts are unchanged.
const MAX_ATTEMPTS = 5;

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const sharedSecret = secrets.get("LEX_WEBHOOK_SECRET") || "";
    const op = body.op || "status";

    if (op === "status") {
      const deliveries = await base44.asServiceRole.entities.PlatformDelivery.list("-delivered_at", 500);
      const dlq = await base44.asServiceRole.entities.DeadLetterEvent.filter({ status: "held" });
      const conns = await base44.asServiceRole.entities.PlatformConnection.filter({});
      const delivered = deliveries.filter((d) => d.status === "delivered").length;
      const failed = deliveries.filter((d) => d.status === "failed").length;
      const pending = deliveries.filter((d) => d.status === "pending").length;
      const timed = deliveries.filter((d) => d.status === "delivered" && d.duration_ms != null);
      const avgMs = timed.length
        ? Math.round(timed.reduce((s, d) => s + (d.duration_ms || 0), 0) / timed.length)
        : 0;
      return Response.json({
        totals: {
          delivered,
          failed,
          pending,
          success_rate: delivered + failed > 0 ? Math.round((delivered / (delivered + failed)) * 100) : null,
          avg_delivery_ms: avgMs,
          dlq_held: dlq.length,
        },
        connections: conns.map((c) => {
          const mine = deliveries.filter((d) => d.connection_id === c.id);
          const ok = mine.filter((d) => d.status === "delivered").length;
          const bad = mine.filter((d) => d.status === "failed").length;
          return {
            id: c.id,
            name: c.name,
            platform_type: c.platform_type,
            status: c.status,
            webhook_url: c.webhook_url,
            last_delivery_at: c.last_delivery_at,
            last_delivery_status: c.last_delivery_status,
            last_error: c.last_error,
            delivered: ok,
            failed: bad,
            success_rate: ok + bad > 0 ? Math.round((ok / (ok + bad)) * 100) : null,
          };
        }),
        dlq: dlq.slice(0, 20),
      });
    }

    if (op === "retry") {
      // Retry failed deliveries still under MAX_ATTEMPTS whose backoff window has elapsed.
      const failed = await base44.asServiceRole.entities.PlatformDelivery.filter({ status: "failed" });
      const conns = await base44.asServiceRole.entities.PlatformConnection.filter({});
      let recovered = 0, stillFailing = 0, promoted = 0, skipped = 0;

      for (const d of failed.slice(0, 25)) {
        const conn = conns.find((c) => c.id === d.connection_id);
        if (!conn || !d.event_id) { skipped++; continue; }
        const ev = await base44.asServiceRole.entities.EventLog.get(d.event_id).catch(() => null);
        if (!ev) { skipped++; continue; }

        const attempts = d.attempts || 1;
        const backoffMs = Math.min(2 ** (attempts - 1) * 60000, 3600000);
        if (d.delivered_at && new Date(d.delivered_at).getTime() + backoffMs > Date.now()) { skipped++; continue; }

        const r = await deliver(conn, ev.event_name, ev.payload || {}, ev.correlation_id || null, sharedSecret);
        await base44.asServiceRole.entities.PlatformDelivery.update(d.id, {
          status: r.ok ? "delivered" : "failed",
          http_status: r.status,
          attempts: attempts + 1,
          duration_ms: r.duration_ms ?? null,
          error: r.error,
          delivered_at: nowIso(),
        });

        if (r.ok) {
          recovered++;
        } else {
          stillFailing++;
          if (attempts + 1 >= MAX_ATTEMPTS) {
            const existing = await base44.asServiceRole.entities.DeadLetterEvent.filter({
              event_id: ev.id,
              target_connection_id: conn.id,
            });
            if (!existing.length) {
              await base44.asServiceRole.entities.DeadLetterEvent.create({
                event_id: ev.id,
                event_name: ev.event_name,
                target_connection_id: conn.id,
                target_platform: conn.name,
                payload: ev.payload || {},
                correlation_id: ev.correlation_id || null,
                failure_reason: r.error,
                retry_count: attempts + 1,
                status: "held",
                last_attempt_at: nowIso(),
              });
            }
            promoted++;
          }
        }
      }

      await base44.asServiceRole.entities.AuditLog.create({
        actor_id: user.id, actor_name: user.full_name || "LEX", actor_role: user.role,
        action: "bridge.retry", entity_type: "PlatformDelivery", entity_id: "-",
        details: `Retry pass: ${recovered} recovered, ${stillFailing} still failing, ${promoted} dead-lettered, ${skipped} skipped`,
        severity: promoted ? "warning" : "info",
      });

      return Response.json({ attempted: recovered + stillFailing, recovered, still_failing: stillFailing, promoted, skipped });
    }

    if (op === "replay") {
      // Replay events by shipment, platform, event type, and/or date range.
      // Requires at least one filter; original payloads are preserved.
      const hasFilter = body.event_id || body.event_type || body.shipment_id || body.from || body.to || body.platform_id;
      if (!hasFilter) return Response.json({ error: "at least one replay filter required" }, { status: 400 });

      const events = await base44.asServiceRole.entities.EventLog.list("-published_at", 200);
      const matched = events.filter((ev) => {
        if (body.event_id && ev.id !== body.event_id) return false;
        if (body.event_type && ev.event_name !== body.event_type) return false;
        if (body.shipment_id) {
          const p = ev.payload || {};
          if (p.shipment_id !== body.shipment_id && p.tracking_id !== body.shipment_id) return false;
        }
        const t = new Date(ev.published_at || 0).getTime();
        if (body.from && t < new Date(body.from).getTime()) return false;
        if (body.to && t > new Date(body.to).getTime()) return false;
        return true;
      });

      let conns = await base44.asServiceRole.entities.PlatformConnection.filter({ status: "active" });
      if (body.platform_id) conns = conns.filter((c) => c.id === body.platform_id);

      let deliveredCount = 0, failedCount = 0;
      for (const ev of matched.slice(0, 50)) {
        for (const c of conns) {
          if (!c.webhook_url) continue;
          if (c.enabled_events && c.enabled_events.length && !c.enabled_events.includes(ev.event_name)) continue;
          const r = await deliver(c, ev.event_name, ev.payload || {}, ev.correlation_id || null, sharedSecret);
          await recordDelivery(base44, c, ev.id, ev.event_name, ev.correlation_id || null, r);
          if (r.ok) deliveredCount++;
          else failedCount++;
        }
      }

      await base44.asServiceRole.entities.AuditLog.create({
        actor_id: user.id, actor_name: user.full_name || "LEX", actor_role: user.role,
        action: "bridge.replay", entity_type: "EventLog", entity_id: "-",
        details: `Replayed ${matched.length} events: ${deliveredCount} delivered, ${failedCount} failed`,
        severity: failedCount ? "warning" : "info",
      });

      return Response.json({ events_matched: matched.length, delivered: deliveredCount, failed: failedCount });
    }

    if (op === "dlq_replay") {
      if (!body.id) return Response.json({ error: "id required" }, { status: 400 });
      const item = await base44.asServiceRole.entities.DeadLetterEvent.get(body.id);
      const conns = await base44.asServiceRole.entities.PlatformConnection.filter({});
      const conn = conns.find((c) => c.id === item.target_connection_id);
      if (!conn) return Response.json({ error: "target connection not found" }, { status: 404 });

      const r = await deliver(conn, item.event_name, item.payload || {}, item.correlation_id || null, sharedSecret);
      await base44.asServiceRole.entities.DeadLetterEvent.update(item.id, {
        status: r.ok ? "replayed" : "held",
        failure_reason: r.ok ? null : r.error,
        retry_count: (item.retry_count || 0) + 1,
        last_attempt_at: nowIso(),
      });
      if (r.ok) {
        await recordDelivery(base44, conn, item.event_id, item.event_name, item.correlation_id || null, r);
      }

      await base44.asServiceRole.entities.AuditLog.create({
        actor_id: user.id, actor_name: user.full_name || "LEX", actor_role: user.role,
        action: "bridge.dlq_replay", entity_type: "DeadLetterEvent", entity_id: item.id,
        details: `${item.event_name} replayed to ${conn.name}: ${r.ok ? "ok" : "failed"}`,
        severity: r.ok ? "info" : "warning",
      });

      return Response.json({ replayed: r.ok, http_status: r.status, error: r.error || null });
    }

    return Response.json({ error: "Unknown op" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}