import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import { secrets } from "base44:runtime";
import { nowIso } from "../../shared/lexUtils.ts";
import { deliver, isSubscribed, recordDelivery } from "../../shared/lexBridge.ts";

// LEX Orchestration Queue — internal resumable job queue for webhook redelivery and
// event publishing. Improves resiliency without changing any webhook contract.
// Op "run" processes due tasks (queued / retrying / prioritized) in priority order
// with bounded retries and failure reasons.
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    if ((body.op || "run") !== "run") return Response.json({ error: "Unknown op" }, { status: 400 });

    const sharedSecret = secrets.get("LEX_WEBHOOK_SECRET") || "";
    const queued = await base44.asServiceRole.entities.OrchestrationTask.filter({ status: "queued" });
    const retrying = await base44.asServiceRole.entities.OrchestrationTask.filter({ status: "retrying" });
    const prioritized = await base44.asServiceRole.entities.OrchestrationTask.filter({ status: "prioritized" });

    const now = Date.now();
    const due = [...prioritized, ...retrying, ...queued]
      .filter((t) => !t.scheduled_time || new Date(t.scheduled_time).getTime() <= now)
      .sort((a, b) => (a.priority ?? 5) - (b.priority ?? 5))
      .slice(0, 10);

    let completed = 0, failed = 0, retryScheduled = 0;
    for (const t of due) {
      await base44.asServiceRole.entities.OrchestrationTask.update(t.id, { status: "running", started_time: nowIso() });
      try {
        const result = await executeTask(base44, t, sharedSecret);
        await base44.asServiceRole.entities.OrchestrationTask.update(t.id, {
          status: "completed",
          completed_time: nowIso(),
          result,
        });
        completed++;
      } catch (e) {
        const retryCount = (t.retry_count || 0) + 1;
        const max = t.max_retries ?? 3;
        if (retryCount >= max) {
          await base44.asServiceRole.entities.OrchestrationTask.update(t.id, {
            status: "failed",
            completed_time: nowIso(),
            retry_count: retryCount,
            failure_reason: e.message,
          });
          failed++;
        } else {
          await base44.asServiceRole.entities.OrchestrationTask.update(t.id, {
            status: "retrying",
            retry_count: retryCount,
            failure_reason: e.message,
            // Exponential backoff so the queue doesn't hammer a failing platform.
            scheduled_time: new Date(
              Date.now() + Math.min(2 ** retryCount, 16) * 60000
            ).toISOString(),
          });
          retryScheduled++;
        }
      }
    }

    await base44.asServiceRole.entities.AuditLog.create({
      actor_id: user.id,
      actor_name: user.full_name || "LEX",
      actor_role: user.role,
      action: "queue.run",
      entity_type: "OrchestrationTask",
      entity_id: "-",
      details: `Processed ${due.length} tasks: ${completed} completed, ${retryScheduled} retrying, ${failed} failed`,
      severity: failed ? "warning" : "info",
    });

    return Response.json({ processed: due.length, completed, retrying: retryScheduled, failed });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

async function executeTask(base44, task, sharedSecret) {
  const payload = task.payload || {};

  if (task.task_type === "webhook_redeliver") {
    const conns = await base44.asServiceRole.entities.PlatformConnection.filter({});
    const conn = conns.find((c) => c.id === payload.connection_id);
    if (!conn) throw new Error("connection not found: " + payload.connection_id);
    let eventName = payload.event_name;
    let eventPayload = payload.payload || null;
    if (payload.event_id) {
      const ev = await base44.asServiceRole.entities.EventLog.get(payload.event_id).catch(() => null);
      if (ev) {
        eventName = ev.event_name;
        eventPayload = ev.payload || {};
      }
    }
    if (!eventName) throw new Error("event_name required for webhook_redeliver");
    const r = await deliver(conn, eventName, eventPayload || {}, payload.correlation_id || null, sharedSecret);
    if (!r.ok) throw new Error(r.error || "delivery failed");
    await recordDelivery(base44, conn, payload.event_id || eventName, eventName, payload.correlation_id || null, r);
    return { delivered: true, http_status: r.status };
  }

  if (task.task_type === "event_publish") {
    if (!payload.event_name) throw new Error("event_name required for event_publish");
    const ev = await base44.asServiceRole.entities.EventLog.create({
      event_name: payload.event_name,
      payload: payload.payload || {},
      correlation_id: payload.correlation_id || null,
      published_at: nowIso(),
    });
    const conns = await base44.asServiceRole.entities.PlatformConnection.filter({ status: "active" });
    let delivered = 0, failedDeliveries = 0;
    for (const c of conns) {
      if (!isSubscribed(c, ev.event_name)) continue;
      const r = await deliver(c, ev.event_name, ev.payload || {}, ev.correlation_id || null, sharedSecret);
      await recordDelivery(base44, c, ev.id, ev.event_name, ev.correlation_id || null, r);
      if (r.ok) delivered++;
      else failedDeliveries++;
    }
    return { event_id: ev.id, delivered, failed: failedDeliveries };
  }

  throw new Error("unsupported task_type: " + task.task_type);
}