import {trustedBrowserTask} from '../../shared/lexQueueSubmission.ts';
import {cas,expect} from '../../shared/lexEffectProof.ts';
import {trustedQueuePublication} from "../../shared/lexTaskAuthority.ts";
import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import { secrets } from "base44:runtime";
import { nowIso, appendToOutbox } from "../../shared/lexUtils.ts";
import { deliver, isSubscribed, recordDelivery } from "../../shared/lexBridge.ts";

// LEX Orchestration Queue — internal resumable job queue. Op "run" processes due
// tasks with bounded retries, exponential backoff, and atomic-ish lease claims so
// concurrent workers do not process the same task. Abandoned running tasks are
// recovered after lease expiry.
const LEASE_TTL_MS = 30000;
function workerId() { return "q-" + Math.random().toString(36).slice(2, 10); }

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    if ((body.op || "run") !== "run") return Response.json({ error: "Unknown op" }, { status: 400 });

    const sharedSecret = secrets.get("LEX_WEBHOOK_SECRET") || "";

    // Recover abandoned running tasks (lease expired).
    await recoverStuckTasks(base44);

    const me = workerId();
    const queued = await base44.asServiceRole.entities.OrchestrationTask.filter({ status: "queued" });
    const retrying = await base44.asServiceRole.entities.OrchestrationTask.filter({ status: "retrying" });
    const prioritized = await base44.asServiceRole.entities.OrchestrationTask.filter({ status: "prioritized" });
    const now = Date.now();
    const due = [...prioritized, ...retrying, ...queued]
      .filter((t) => ["event_publish","webhook_redeliver"].includes(t.task_type))
      .filter((t) => !t.scheduled_time || new Date(t.scheduled_time).getTime() <= now)
      .sort((a, b) => (a.priority ?? 5) - (b.priority ?? 5))
      .slice(0, 10);

    let completed = 0, failed = 0, retryScheduled = 0, leased = 0,held=0;
    for (const t of due) {
      // Lease claim.
      if (t.lease_owner && t.lease_expires_at && new Date(t.lease_expires_at).getTime() > now && t.lease_owner !== me) { leased++; continue; }
      if(!await cas(base44.asServiceRole.entities.OrchestrationTask,t.id,{status:t.status,lease_owner:expect(t,'lease_owner'),lease_expires_at:expect(t,'lease_expires_at')},{status:"running",started_time:nowIso(),lease_owner:me,lease_expires_at:new Date(now+LEASE_TTL_MS).toISOString()})){leased++;continue;}
      const claimed = await base44.asServiceRole.entities.OrchestrationTask.get(t.id).catch(() => null);
      if (!claimed || claimed.lease_owner !== me) { leased++; continue; }
      try {
        const result = await executeTask(base44, claimed, sharedSecret);
        if(result?.held) {
          await cas(base44.asServiceRole.entities.OrchestrationTask,t.id,{status:"running",lease_owner:me},{status:'retrying',failure_reason:result.reason,scheduled_time:new Date(Date.now()+60000).toISOString(),lease_owner:null,lease_expires_at:null});held++;continue;
        }
        await cas(base44.asServiceRole.entities.OrchestrationTask,t.id,{status:"running",lease_owner:me},{status: "completed", completed_time: nowIso(), result, lease_owner: null, lease_expires_at: null });
        completed++;
      } catch (e) {
        const retryCount = (t.retry_count || 0) + 1;
        const max = t.max_retries ?? 3;
        if (retryCount >= max) {
          await cas(base44.asServiceRole.entities.OrchestrationTask,t.id,{status:"running",lease_owner:me},{status: "failed", completed_time: nowIso(), retry_count: retryCount, failure_reason: e.message, lease_owner: null, lease_expires_at: null });
          failed++;
        } else {
          await cas(base44.asServiceRole.entities.OrchestrationTask,t.id,{status:"running",lease_owner:me},{status: "retrying", retry_count: retryCount, failure_reason: e.message, scheduled_time: new Date(now + Math.min(2 ** retryCount, 16) * 60000).toISOString(), lease_owner: null, lease_expires_at: null });
          retryScheduled++;
        }
      }
    }

    return Response.json({ processed: due.length, completed, retrying: retryScheduled, failed,held, leased_by_others: leased });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

async function recoverStuckTasks(base44) {
  const now = Date.now();
  const running = await base44.asServiceRole.entities.OrchestrationTask.filter({ status: "running" });
  const stuck = running.filter((t) => t.lease_expires_at && new Date(t.lease_expires_at).getTime() < now);
  for (const t of stuck) {
    await cas(base44.asServiceRole.entities.OrchestrationTask,t.id,{status:"running",lease_owner:t.lease_owner,lease_expires_at:t.lease_expires_at},{status:"retrying",lease_owner:null,lease_expires_at:null,failure_reason:"lease expired (worker crashed)"});
  }
}

async function executeTask(base44, task, sharedSecret) {
  const payload = task.payload || {};
  const browserOwned=await trustedBrowserTask(base44,task);
  const legacyApproved=browserOwned?false:await trustedQueuePublication(base44,task);
  if(!browserOwned&&!legacyApproved)return {held:true,reason:'validated_task_authority_required'};
  if (task.task_type === "webhook_redeliver") {
    const conns = await base44.asServiceRole.entities.PlatformConnection.filter({});
    const conn = conns.find((c) => c.id === payload.connection_id);
    if (!conn) throw new Error("connection not found: " + payload.connection_id);
    const ev = payload.event_id ? await base44.asServiceRole.entities.EventLog.get(payload.event_id).catch(() => null) : null;
    const eventName = ev?.event_name || payload.event_name;
    const eventPayload = ev?.payload || payload.payload || {};
    if (!eventName) throw new Error("event_name required for webhook_redeliver");
    if(!ev)throw new Error("persisted_event_required");
    const evRecord = ev || { id: payload.event_id, event_name: eventName, payload: eventPayload, correlation_id: payload.correlation_id || null, schema_version: 1, source: "statelines-lex", occurred_at: nowIso() };
    const r = await deliver(conn, evRecord, sharedSecret, base44);
    if(r.held) {await base44.asServiceRole.entities.EventLog.update(ev.id,{isolation_hold:r.error,isolation_checked_at:nowIso()});return {delivered:false,held:true,reason:r.error};}
    if (!r.ok) throw new Error(r.error || "delivery failed");
    await recordDelivery(base44, conn, payload.event_id || eventName, eventName, payload.correlation_id || null, r);
    return { delivered: true, http_status: r.status };
  }
  if (task.task_type === "event_publish") {

    if(!browserOwned&&!payload.event_name)throw new Error('event_name required for event_publish');
    const ev=browserOwned?await base44.asServiceRole.entities.EventLog.get(payload.event_id):await appendToOutbox(base44,{event_type:payload.event_name,payload:payload.payload||{},correlation_id:payload.correlation_id||null,causation_id:null,aggregate:payload.aggregate||null});
    const conns = await base44.asServiceRole.entities.PlatformConnection.filter({ status: "active" });
    let delivered = 0, failedDeliveries = 0;
    for (const c of conns) {
      if (!isSubscribed(c, ev.event_name)) continue;
      const r = await deliver(c, ev, sharedSecret, base44);
      await recordDelivery(base44, c, ev.id, ev.event_name, ev.correlation_id || null, r);
      if (r.ok) delivered++; else failedDeliveries++;
    }
    return { event_id: ev.id, delivered, failed: failedDeliveries };
  }
  throw new Error("unsupported task_type: " + task.task_type);
}