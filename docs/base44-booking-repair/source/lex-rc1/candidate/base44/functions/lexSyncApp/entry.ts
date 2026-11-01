import {signPull,verifyPullResponse} from '../../shared/lexPullProtocol.ts';
import {resolveTrustedIsolation} from "../../shared/lexTrustedIsolation.ts";
// Cross-app pull sync. An admin triggers a pull from a connected app's sync
// endpoint; LEX HMAC-signs the request and ingests returned events into the
// canonical hub records. Convention: GET {connection.base_url}/lex/sync?since=ISO
// returns { events: [ { tracking_id, app, stage, event_type, ... } ] }.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.49";
import { secrets } from "base44:runtime";
import { normalizeEvent, ingestEvent } from "../../shared/lexIngest.ts";

export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const connId = body.connection_id;
    if (!connId) return Response.json({ error: "connection_id required" }, { status: 400 });

    const conns = await base44.asServiceRole.entities.PlatformConnection.filter({ id: connId }, null, 1);
    const conn = conns && conns[0];
    if (!conn) return Response.json({ error: "Connection not found" }, { status: 404 });

    // Activate only after this peer's receiver deploys v2 + atomic nonce claims.
    // An old peer is explicitly unavailable, never downgraded to empty-body HMAC.
    if(conn.status!=='active'||conn.pull_auth_version!=='v2'||!conn.ingress_v2_enabled||!conn.auth_secret)return Response.json({pulled:false,pull_unavailable:true,reason:'Coordinated pull v2 not enabled' });
    const secret=conn.auth_secret;
    const target=new URL('/functions/lexSyncEndpoint',conn.base_url);
    if(target.protocol!=='https:')return Response.json({error:'HTTPS receiver required'},{status:409});
    if(body.since)target.searchParams.set('since',String(body.since));
    const challenge=await signPull(target.href,conn.id,secret);
    const headers={Accept:'application/json',...challenge.headers};

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    let resp: Response;
    try {
      resp = await fetch(target, { method: "GET", headers, signal: ctrl.signal, redirect: "manual" });
    } finally {
      clearTimeout(t);
    }

    if (!resp.ok) {
      // The sibling's pull endpoint is auth-gated (HTTP 401/403) or unavailable.
      // This is expected for siblings that gate their own endpoints — live data
      // arrives via the push webhook (lexWebhookReceiver), which is the primary
      // channel. Do NOT poison the connection's push delivery status: those
      // fields reflect webhook delivery health, not pull availability. Return a
      // soft 200 so the console reports "pull n/a" instead of a scary 502.
      const errText = await resp.text().catch(() => "");
      return Response.json({
        connection: conn.name,
        pulled: false,
        pull_unavailable: true,
        status: resp.status,
        reason: `Pull endpoint returned HTTP ${resp.status} (sibling gates its own endpoint). Live data arrives via push webhook.`,
        body: errText.slice(0, 200),
      });
    }

    const rawResponse=await resp.text();
    const data:any=await verifyPullResponse(challenge,rawResponse,resp.headers.get('X-LEX-Response-Signature')||'',secret);
    const events = Array.isArray(data.events) ? data.events : Array.isArray(data) ? data : [];
    const results: any[] = [];
    for (const r of events) {
      const classification=await resolveTrustedIsolation(base44,r);
      if(classification.kind!=='ordinary'){results.push({ok:false,held:true,reason:classification.kind==='isolated'?'sandbox_isolated':'isolation_unknown'});continue;}
      const evt = normalizeEvent(r);
      if (!evt) {
        results.push({ ok: false, error: "missing tracking_id" });
        continue;
      }
      try {
        const res = await ingestEvent(base44, evt,{connection_id:conn.id,mode:'v2'});
        results.push({ ok: true, tracking_id: evt.tracking_id, ...res });
      } catch (e) {
        results.push({ ok: false, tracking_id: evt.tracking_id, error: (e as Error).message });
      }
    }

    if(!results.some(r=>r.held))await base44.asServiceRole.entities.PlatformConnection.update(conn.id, {
      last_delivery_status: "ok",
      last_delivery_at: new Date().toISOString(),
      last_error: null,
    });
    return Response.json({
      connection: conn.name,
      ingested: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}