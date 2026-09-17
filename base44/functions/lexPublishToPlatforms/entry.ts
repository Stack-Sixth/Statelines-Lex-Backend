import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import { secrets } from "base44:runtime";
import { nowIso } from "../../shared/lexUtils.ts";
import { deliver, isSubscribed, recordDelivery } from "../../shared/lexBridge.ts";

// LEX Platform Bridge — the "brain" outbound integration layer.
// Publishes EventLog events to every subscribed Statelines platform via signed webhooks.
// Modes: "sync" (deliver recent undelivered events), "publish" (deliver a single event),
// "ping" (health-check each platform base_url).
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const sharedSecret = secrets.get("LEX_WEBHOOK_SECRET") || "";
    const mode = body.mode || "sync";

    if (mode === "ping") {
      const conns = await base44.asServiceRole.entities.PlatformConnection.filter({});
      const results = [];
      for (const c of conns) {
        let ok = false, status = 0, err = null;
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 6000);
        try {
          const res = await fetch(c.base_url, { method: "GET", signal: ctrl.signal });
          ok = res.ok; status = res.status;
        } catch (e) { err = e.message; }
        clearTimeout(t);
        await base44.asServiceRole.entities.PlatformConnection.update(c.id, {
          last_delivery_status: ok ? "ok" : "failed",
          last_error: err || (ok ? null : "HTTP " + status),
        });
        results.push({ id: c.id, name: c.name, ok, status, error: err });
      }
      await base44.asServiceRole.entities.AuditLog.create({
        actor_id: user.id, actor_name: user.full_name || "LEX", actor_role: user.role,
        action: "platform.ping", entity_type: "PlatformConnection", entity_id: "-",
        details: "Pinged " + results.length + " platforms",
        severity: results.some((r) => !r.ok) ? "warning" : "info",
      });
      return Response.json({ pinged: results.length, results });
    }

    if (mode === "publish") {
      const eventName = body.event_name;
      const payload = body.payload || {};
      if (!eventName) return Response.json({ error: "event_name required" }, { status: 400 });
      const log = await base44.asServiceRole.entities.EventLog.create({
        event_name: eventName, payload, correlation_id: body.correlation_id || null, published_at: nowIso(),
      });
      const conns = await base44.asServiceRole.entities.PlatformConnection.filter({ status: "active" });
      const subscribed = conns.filter((c) => isSubscribed(c, eventName));
      let delivered = 0, failed = 0;
      for (const c of subscribed) {
        const r = await deliver(c, eventName, payload, body.correlation_id || null, sharedSecret);
        await recordDelivery(base44, c, log.id, eventName, body.correlation_id || null, r);
        if (r.ok) delivered++; else failed++;
      }
      return Response.json({ event_id: log.id, delivered, failed });
    }

    // sync mode
    const events = await base44.asServiceRole.entities.EventLog.list("-published_at", 100);
    const conns = await base44.asServiceRole.entities.PlatformConnection.filter({ status: "active" });
    const deliveries = await base44.asServiceRole.entities.PlatformDelivery.list("-delivered_at", 200);
    const deliveredKeys = new Set(deliveries.map((d) => d.event_id + "|" + d.connection_id));

    let totalDelivered = 0, totalFailed = 0;
    for (const ev of events) {
      const subscribed = conns.filter((c) => isSubscribed(c, ev.event_name));
      for (const c of subscribed) {
        const key = ev.id + "|" + c.id;
        if (deliveredKeys.has(key)) continue;
        const r = await deliver(c, ev.event_name, ev.payload || {}, ev.correlation_id || null, sharedSecret);
        await recordDelivery(base44, c, ev.id, ev.event_name, ev.correlation_id || null, r);
        deliveredKeys.add(key);
        if (r.ok) totalDelivered++; else totalFailed++;
      }
    }

    const recent = await base44.asServiceRole.entities.PlatformDelivery.list("-delivered_at", 20);
    const allConns = await base44.asServiceRole.entities.PlatformConnection.filter({});
    await base44.asServiceRole.entities.AuditLog.create({
      actor_id: user.id, actor_name: user.full_name || "LEX", actor_role: user.role,
      action: "platform.sync", entity_type: "PlatformConnection", entity_id: "-",
      details: "Synced events: " + totalDelivered + " delivered, " + totalFailed + " failed",
      severity: totalFailed ? "warning" : "info",
    });

    return Response.json({
      scanned: events.length,
      delivered: totalDelivered,
      failed: totalFailed,
      connections: allConns.map((c) => ({
        id: c.id, name: c.name, platform_type: c.platform_type, status: c.status,
        webhook_url: c.webhook_url, last_delivery_status: c.last_delivery_status,
        last_delivery_at: c.last_delivery_at, last_error: c.last_error,
      })),
      recent_deliveries: recent,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}