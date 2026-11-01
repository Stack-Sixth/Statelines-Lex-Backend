import {trustedEngineTask} from "../../shared/lexTaskAuthority.ts";
import {requireEngineMutation} from "../../shared/lexEngineBoundary.ts";
// lexEngineSync — durable worker that mirrors hub shipment transitions to the
// Render LEX engine for the paths that cannot mirror inline: carrier-gateway
// transitions (no Base44 session to sign the request) and bulk auto-match. Admin
// transitions are routed here too, so every engine-registered shipment gets the
// same durable, ordered, reconciled treatment.
//
// Mechanism: transitionShipment() enqueues an OrchestrationTask (task_type
// "engine_sync") carrying the engine_shipment_id, the hub command_id (UUID,
// preserved across retries), the target status, and the Render version known at
// enqueue time. This worker:
//   1. Claims queued/retrying tasks, grouped per engine shipment, in enqueue
//      order (created_date) — so a shipment's transitions apply sequentially.
//   2. Fetches the ACTUAL Render shipment to read its current version + status
//      (the enqueued version is only a hint).
//   3. Reconciles before applying: if Render is already at or past the target,
//      the task is confirmed as reconciled (never overwritten).
//   4. Applies the transition with expected_version = the actual Render version
//      and the preserved command_id. On 409 it re-fetches and reconciles again;
//      on 5xx/network it retries with backoff; on 400/422 it surfaces to admins.
//   5. Updates CrossAppPackage.engine_version to the confirmed Render version.
//
// Authentication: builds the Render JWT directly from server secrets with a
// fixed service identity ("lex-engine-sync", role "admin") — no driver or admin
// session is required. Secrets never leave the server.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.49";
import { signedRenderHeaders, renderBaseUrl } from "../../shared/lexRenderJwt.ts";

// Hub status -> Render status. The hub's "pending" is Render's "created".
const HUB_TO_RENDER_STATUS: Record<string, string> = {
  pending: "created", matched: "matched", picked_up: "picked_up",
  in_transit: "in_transit", at_node: "at_node", out_for_delivery: "out_for_delivery",
  delivered: "delivered", returned: "returned", cancelled: "cancelled", flagged: "exception",
};

// Render lifecycle order, used to detect "Render is already past the target".
const RENDER_ORDER = ["created", "matched", "picked_up", "in_transit", "at_node", "out_for_delivery", "delivered", "returned", "cancelled", "exception"];
const TERMINAL_RENDER = new Set(["delivered", "returned", "cancelled"]);

function renderRank(status: string): number {
  const i = RENDER_ORDER.indexOf(status);
  return i < 0 ? -1 : i;
}

async function renderGetShipment(engineId: string) {
  const base = renderBaseUrl();
  const headers = await signedRenderHeaders("lex-engine-sync", "admin");
  const res = await fetch(new URL(`/v1/shipments/${engineId}`, base), { method: "GET", headers, signal: AbortSignal.timeout(15000),redirect:"manual" });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) return { ok: false as const, status: res.status, error: typeof body === "string" ? body : body?.error || body?.message || text };
  const shipment = body?.shipment || body;
  return { ok: true as const, status: res.status, shipment };
}

async function renderTransition(base44:any,engineId: string, payload: { status: string; command_id: string; expected_version: number }) {
  engineId=await requireEngineMutation(base44,engineId);
  const base = renderBaseUrl();
  const headers = await signedRenderHeaders("lex-engine-sync", "admin");
  const res = await fetch(new URL(`/v1/shipments/${engineId}/transitions`, base), { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000),redirect:"manual" });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) return { ok: false as const, status: res.status, body, error: typeof body === "string" ? body : body?.error || body?.message || text };
  return { ok: true as const, status: res.status, body };
}

async function renderMatch(base44:any,engineId: string, payload: any) {
  engineId=await requireEngineMutation(base44,engineId);
  const base = renderBaseUrl();
  const headers = await signedRenderHeaders("lex-engine-sync", "admin");
  const res = await fetch(new URL(`/v1/shipments/${engineId}/match`, base), { method: "POST", headers, body: JSON.stringify(payload || {}), signal: AbortSignal.timeout(15000),redirect:"manual" });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) return { ok: false as const, status: res.status, body, error: typeof body === "string" ? body : body?.error || body?.message || text };
  return { ok: true as const, status: res.status, body };
}

async function renderListCarriers() {
  const base = renderBaseUrl();
  const headers = await signedRenderHeaders("lex-engine-sync", "admin");
  const res = await fetch(new URL(`/v1/carriers`, base), { method: "GET", headers, signal: AbortSignal.timeout(15000),redirect:"manual" });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) return { ok: false as const, status: res.status, body, error: typeof body === "string" ? body : body?.error || body?.message || text };
  return { ok: true as const, status: res.status, body };
}

// Flexible raw call — admin diagnostic against any Render endpoint, returning
// the full response body so the engine's contract can be inspected without the
// lexApi proxy (which loses non-2xx bodies).
async function renderRaw(base44:any,method: string, subpath: string, payload: any) {
  if(typeof subpath!=='string'||!subpath.startsWith('/v1/')||subpath.startsWith('//'))return {ok:false,status:409,error:'diagnostic_path_not_supported'};
  if(method!=='GET') {
    const match=/^\/v1\/shipments\/([^/?]+)\/(transitions|match)$/.exec(subpath);
    if(!match)return {ok:false,status:409,error:'mutation_contract_required'};
    const id=await requireEngineMutation(base44,match[1]);subpath='/v1/shipments/'+id+'/'+match[2];
  }
  const base = renderBaseUrl();
  const headers = await signedRenderHeaders("lex-engine-sync", "admin");
  const res = await fetch(new URL(subpath, base), { method, headers, body: method === "GET" ? undefined : JSON.stringify(payload || {}), signal: AbortSignal.timeout(15000),redirect:"manual" });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) return { ok: false as const, status: res.status, body, error: typeof body === "string" ? body : body?.error || body?.message || text };
  return { ok: true as const, status: res.status, body };
}

async function markConfirmed(base44: any, task: any, data: any, res: any) {
  await base44.asServiceRole.entities.OrchestrationTask.update(task.id, {
    status: "completed", completed_time: new Date().toISOString(),
    result: { ...res, ...data }, failure_reason: null,
  });
}
async function markFailed(base44: any, task: any, reason: string, res: any) {
  await base44.asServiceRole.entities.OrchestrationTask.update(task.id, {
    status: "failed", completed_time: new Date().toISOString(),
    failure_reason: reason, result: res,
  });
}
async function markRetry(base44: any, task: any, reason: string, res: any) {
  const rc = (task.retry_count || 0) + 1;
  const max = task.max_retries || 5;
  const backoff = Math.min(60, 5 * Math.pow(2, rc - 1)); // 5,10,20,40,60s
  const next = new Date(Date.now() + backoff * 1000).toISOString();
  const failed = rc >= max;
  await base44.asServiceRole.entities.OrchestrationTask.update(task.id, {
    status: failed ? "failed" : "retrying",
    retry_count: rc,
    failure_reason: failed ? `max retries reached: ${reason}` : reason,
    scheduled_time: next,
    result: res,
    ...(failed ? { completed_time: new Date().toISOString() } : {}),
  });
}
async function updateEngineVersion(base44: any, p: any, version: number) {
  if (!p?.tracking_id) return;
  try {
    const pkgs = await base44.asServiceRole.entities.CrossAppPackage.filter({ tracking_id: p.tracking_id });
    if (pkgs[0] && Number(pkgs[0].engine_version) !== Number(version)) {
      await base44.asServiceRole.entities.CrossAppPackage.update(pkgs[0].id, { engine_version: Number(version) });
    }
  } catch {
    // Version bookkeeping must never block the sync outcome.
  }
}

export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json().catch(() => ({}));

    // --- Probe mode: diagnostic against the Render engine (no queue). ---
    // Returns full Render response bodies so admins can inspect the engine's
    // actual state and contract. Supports: list_carriers, get, match, transition.
    if (body.action === "probe") {
      const call = body.call || "transition";
      const engineId = body.engine_shipment_id;
      if (call === "list_carriers") {
        const r = await renderListCarriers();
        return Response.json({ call, result: r }, { status: 200 });
      }
      if (call === "get") {
        const g = await renderGetShipment(engineId);
        return Response.json({ call, engine_id: engineId, result: g }, { status: 200 });
      }
      if (call === "match") {
        const g = await renderGetShipment(engineId);
        const r = await renderMatch(base44,engineId, body.payload || {});
        return Response.json({ call, engine_id: engineId, before: g.ok ? { status: g.shipment?.status, version: g.shipment?.version } : { error: g.error }, result: r }, { status: 200 });
      }
      if (call === "raw") {
        const r = await renderRaw(base44,body.method || "POST", body.path, body.payload || {});
        return Response.json({ call, method: body.method || "POST", path: body.path, result: r }, { status: 200 });
      }
      // default: transition
      const toStatus = body.to_status || "picked_up";
      const commandId = body.command_id || crypto.randomUUID();
      const g = await renderGetShipment(engineId);
      if (!g.ok) return Response.json({ call: "transition", engine_id: engineId, get: g }, { status: 200 });
      const renderStatus = g.shipment?.status;
      const renderVersion = g.shipment?.version;
      const target = HUB_TO_RENDER_STATUS[toStatus] || toStatus;
      const t = await renderTransition(base44,engineId, { status: target, command_id: commandId, expected_version: renderVersion });
      return Response.json({ call: "transition", engine_id: engineId, render_status: renderStatus, render_version: renderVersion, mapped_target: target, transition: t }, { status: 200 });
    }

    // --- Sweep mode: process queued/retrying engine_sync tasks in order ---
    const leaseOwner = "lex-engine-sync-" + Date.now();
    const nowMs = Date.now();
    const leaseExpiry = new Date(nowMs + 60000).toISOString();

    const candidates = await base44.asServiceRole.entities.OrchestrationTask.filter({
      task_type: "engine_sync",
      status: { $in: ["queued", "retrying"] },
    });
    // Enqueue order = created_date ascending, so a shipment's transitions apply sequentially.
    (candidates as any[]).sort((a, b) => (a.created_date || "").localeCompare(b.created_date || ""));

    const byEngine = new Map<string, any[]>();
    for (const t of candidates as any[]) {
      const eid = t.payload?.engine_shipment_id;
      if (!eid) continue;
      if (!byEngine.has(eid)) byEngine.set(eid, []);
      byEngine.get(eid)!.push(t);
    }

    const results: any[] = [];
    let processed = 0, confirmed = 0, reconciled = 0, failed = 0, retried = 0;

    for (const [engineId, tasks] of byEngine) {
      for (const task of tasks) {
        // Skip retrying tasks whose backoff window hasn't elapsed.
        if (task.status === "retrying" && task.scheduled_time && new Date(task.scheduled_time).getTime() > nowMs) continue;
        // Claim atomically so overlapping runs don't double-process.
        const claim = await base44.asServiceRole.entities.OrchestrationTask.updateMany(
          { id: task.id, status: { $in: ["queued", "retrying"] } },
          { $set: { status: "running", lease_owner: leaseOwner, lease_expires_at: leaseExpiry, started_time: new Date(nowMs).toISOString() } },
        );
        if (claim?.updated !== 1) continue;
        processed++;

        const p = task.payload || {};
        try {if(!await trustedEngineTask(base44,task))throw new Error('task_authority_required');await requireEngineMutation(base44,engineId,p);}catch {
          await base44.asServiceRole.entities.OrchestrationTask.update(task.id,{status:'retrying',failure_reason:'isolation_or_transition_hold',scheduled_time:new Date(Date.now()+60000).toISOString(),lease_owner:null,lease_expires_at:null});
          results.push({task_id:task.id,outcome:'held',reason:'isolation_or_transition_hold'});break;
        }
        const commandId = p.command_id;
        const targetHub = p.to_status;
        const targetRender = HUB_TO_RENDER_STATUS[targetHub] || targetHub;
        const res: any = { task_id: task.id, engine_shipment_id: engineId, tracking_id: p.tracking_id, command_id: commandId, target: targetRender, retry_count: task.retry_count || 0 };

        // 1. Fetch the actual Render state (the enqueued engine_version is only a hint).
        const g = await renderGetShipment(engineId);
        if (!g.ok) {
          const permanent = g.status === 404 || g.status === 400;
          if (permanent) {
            await markFailed(base44, task, `get_shipment failed (${g.status}): ${g.error}`, res);
            failed++; results.push({ ...res, outcome: "failed_get", get: g });
          } else {
            await markRetry(base44, task, `get_shipment transient (${g.status}): ${g.error}`, res);
            retried++; results.push({ ...res, outcome: "retrying_get", get: g });
          }
          break; // later transitions for this shipment must wait for this one to resolve
        }

        const renderStatus = g.shipment?.status;
        const renderVersion = g.shipment?.version;
        res.render_status = renderStatus; res.render_version = renderVersion;

        // 2. Reconcile: already at target.
        if (renderStatus === targetRender) {
          await markConfirmed(base44, task, { reconciled: true, reason: "already_at_target", render_status: renderStatus, render_version: renderVersion }, res);
          reconciled++; confirmed++; results.push({ ...res, outcome: "confirmed_already" });
          await updateEngineVersion(base44, p, renderVersion);
          continue;
        }
        // 3. Reconcile: Render is already past the target (target was superseded).
        if (TERMINAL_RENDER.has(renderStatus) && !TERMINAL_RENDER.has(targetRender)) {
          await markConfirmed(base44, task, { reconciled: true, reason: "render_ahead", render_status: renderStatus, render_version: renderVersion }, res);
          reconciled++; confirmed++; results.push({ ...res, outcome: "confirmed_ahead" });
          await updateEngineVersion(base44, p, renderVersion);
          continue;
        }

        // 4. Apply with the ACTUAL Render version and the preserved command_id.
        //    "matched" is Render's /match endpoint (auto-matches to an eligible
        //    Render carrier); all other statuses go through /transitions.
        const t = targetHub === "matched"
          ? await renderMatch(base44,engineId, { command_id: commandId, expected_version: renderVersion })
          : await renderTransition(base44,engineId, { status: targetRender, command_id: commandId, expected_version: renderVersion });
        res.transition_status = t.status;
        res.transition_body = t.body;

        if (t.ok) {
          const newVer = t.body?.version || t.body?.shipment?.version || (Number(renderVersion) + 1);
          const newStatus = t.body?.status || t.body?.shipment?.status || targetRender;
          await markConfirmed(base44, task, { render_status: newStatus, render_version: newVer }, res);
          confirmed++; results.push({ ...res, outcome: "confirmed" });
          await updateEngineVersion(base44, p, newVer);
          continue;
        }

        // 5. Conflict / failure handling.
        if (t.status === 409) {
          const g2 = await renderGetShipment(engineId);
          if (g2.ok) {
            const s2 = g2.shipment?.status, v2 = g2.shipment?.version;
            if (s2 === targetRender) {
              await markConfirmed(base44, task, { reconciled: true, reason: "conflict_resolved_at_target", render_status: s2, render_version: v2 }, res);
              reconciled++; confirmed++; results.push({ ...res, outcome: "confirmed_conflict" });
              await updateEngineVersion(base44, p, v2);
              continue;
            }
            if (TERMINAL_RENDER.has(s2) && !TERMINAL_RENDER.has(targetRender)) {
              await markConfirmed(base44, task, { reconciled: true, reason: "conflict_render_ahead", render_status: s2, render_version: v2 }, res);
              reconciled++; confirmed++; results.push({ ...res, outcome: "confirmed_conflict_ahead" });
              await updateEngineVersion(base44, p, v2);
              continue;
            }
            await markRetry(base44, task, `conflict; will retry with version ${v2} (same command_id)`, { ...res, render_version: v2 });
            retried++; results.push({ ...res, outcome: "retrying_conflict" });
          } else {
            await markRetry(base44, task, `conflict; re-fetch failed: ${g2.error}`, res);
            retried++; results.push({ ...res, outcome: "retrying_conflict_refetch" });
          }
          break; // preserve order: later transitions wait until this one lands
        }

        if (t.status === 400 || t.status === 422) {
          // Permanent: invalid payload or invalid transition — surface to admin.
          await markFailed(base44, task, `permanent failure (${t.status}): ${t.error}`, res);
          failed++; results.push({ ...res, outcome: "failed_permanent" });
          break; // a dependent later transition cannot be valid until this is resolved
        }

        // 5xx / network / other — temporary, retry with backoff.
        await markRetry(base44, task, `transient (${t.status}): ${t.error}`, res);
        retried++; results.push({ ...res, outcome: "retrying_transient" });
        break;
      }
    }

    return Response.json({ processed, confirmed, reconciled, failed, retried, results }, { status: 200 });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}