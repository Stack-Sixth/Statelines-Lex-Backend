import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import { pct, round2 } from "../../shared/lexPhase3.ts";
import { nowIso } from "../../shared/lexUtils.ts";

// LEX Phase 3 — API Gateway Dashboard. Read-only operational view of the
// Platform Bridge: connected platforms, webhook deliveries, success rate,
// retries, failed deliveries, average response time, live availability.
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    const [connections, deliveries] = [
      await base44.asServiceRole.entities.PlatformConnection.filter({}),
      await base44.asServiceRole.entities.PlatformDelivery.list("-delivered_at", 500),
    ];

    const delivered = deliveries.filter((d) => d.status === "delivered");
    const failed = deliveries.filter((d) => d.status === "failed");
    const pending = deliveries.filter((d) => d.status === "pending");
    const durations = deliveries.filter((d) => d.duration_ms != null).map((d) => d.duration_ms);
    const attempts = deliveries.reduce((a, d) => a + (d.attempts || 1), 0);

    // live availability pings (read-only — no connection state is modified)
    const platforms = [];
    for (const c of connections) {
      let available = null;
      let http_status = null;
      if (c.base_url) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 6000);
        try {
          const res = await fetch(c.base_url, { method: "GET", signal: ctrl.signal });
          http_status = res.status;
          available = res.ok;
        } catch {
          available = false;
        }
        clearTimeout(t);
      }
      const mine = deliveries.filter((d) => d.connection_id === c.id);
      const myDelivered = mine.filter((d) => d.status === "delivered").length;
      platforms.push({
        id: c.id,
        name: c.name,
        platform_type: c.platform_type,
        status: c.status,
        webhook_url: c.webhook_url || null,
        available,
        http_status,
        deliveries: mine.length,
        delivered: myDelivered,
        failed: mine.filter((d) => d.status === "failed").length,
        success_rate_pct: mine.length ? pct(myDelivered, mine.length) : null,
        avg_response_ms: myDelivered
          ? round2(
              myDelivered.filter((d) => d.duration_ms != null).reduce((a, d) => a + d.duration_ms, 0) /
                Math.max(1, myDelivered.filter((d) => d.duration_ms != null).length)
            )
          : null,
        last_delivery_at: c.last_delivery_at,
        last_error: c.last_error,
      });
    }

    return Response.json({
      generated_at: nowIso(),
      totals: {
        connected_platforms: connections.length,
        active_platforms: connections.filter((c) => c.status === "active").length,
        deliveries: deliveries.length,
        delivered: delivered.length,
        failed: failed.length,
        pending: pending.length,
        retries: Math.max(0, attempts - deliveries.length),
        success_rate_pct: deliveries.length ? pct(delivered.length, deliveries.length) : null,
        avg_response_ms: durations.length
          ? round2(durations.reduce((a, d) => a + d, 0) / durations.length)
          : null,
      },
      platforms,
      recent_failed: failed.slice(0, 20).map((d) => ({
        id: d.id,
        platform: d.connection_name,
        event_name: d.event_name,
        attempts: d.attempts,
        error: d.error,
        delivered_at: d.delivered_at,
      })),
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}