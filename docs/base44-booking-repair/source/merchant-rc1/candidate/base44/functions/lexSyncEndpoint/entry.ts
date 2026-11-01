import {pullReceiver,claimPullNonce} from '../../shared/lexPullProtocol.ts';
import {operationalAuthority,arrayRows} from '../../shared/shipmentAuthority.ts';
import { createClientFromRequest } from "npm:@base44/sdk@0.8.49";
import { secrets } from "base44:runtime";

function mapStage(status: string): string {
  const m: Record<string, string> = {
    pending: "created", matched: "created", picked_up: "with_carrier",
    in_transit: "in_transit", at_node: "at_noc", out_for_delivery: "in_transit",
    delivered: "delivered", returned: "exception", cancelled: "exception", flagged: "exception",
  };
  return m[status] || "created";
}

function mapServiceLevel(level: string): string {
  const m: Record<string, string> = {
    priority: "express", saver: "standard", standard: "standard",
    express: "express", same_day: "same_day", overnight: "overnight",
  };
  return m[level] || "standard";
}

// Coerce to a positive number in kg. Prefer an explicit kg value if present;
// otherwise convert weight_lb (1 lb = 0.453592 kg). Falls back to 0.
function toKg(lb: any, kg: any): number {
  const k = Number(kg);
  if (Number.isFinite(k) && k > 0) return Math.round(k * 1000) / 1000;
  const l = Number(lb);
  if (Number.isFinite(l) && l > 0) return Math.round(l * 0.453592 * 1000) / 1000;
  return 0;
}

export default async function (req: Request): Promise<Response> {
  try {
    if (req.method !== "GET")
      return Response.json({ error: "Method not allowed" }, { status: 405 });

    const base44 = createClientFromRequest(req);
    const url = new URL(req.url);
    const token = url.searchParams.get("token");
    const syncSecret = secrets.get("PLATFORM_SYNC_SECRET");

    // Deploy receiver support before a peer switches. V2 never falls back to
    // the legacy query-token/admin contract if verification/storage fails.
    if(req.headers.get('X-LEX-Pull-Version')==='2'){
      const P=base44.asServiceRole.entities.LexPullPeer,connectionId=req.headers.get('X-LEX-Connection-Id')||'';
      const raw=await P.filter({connection_id:connectionId,status:'active'},'-created_date',2),peers=arrayRows(raw);
      if(peers.length!==1)return Response.json({error:'Unknown pull peer'},{status:401});const peer=peers[0];
      if(!/^LEX_PULL_[A-Z0-9_]+_SECRET$/.test(peer.secret_env||'')||!Array.isArray(peer.merchant_ids)||peer.merchant_ids.length===0)return Response.json({error:'Peer review required'},{status:401});
      const target=new URL(peer.target);if(target.protocol!=='https:'||target.search||target.hash||target.username||target.password)return Response.json({error:'Reviewed peer target required'},{status:401});
      const key=secrets.get(peer.secret_env);if(!key||key.length<32||key===syncSecret||key===secrets.get('LEX_WEBHOOK_SECRET'))return Response.json({error:'Dedicated peer key required'},{status:401});
      const since=url.searchParams.get('since');if(since&&!Number.isFinite(Date.parse(since)))return Response.json({error:'Invalid since'},{status:400});
      return pullReceiver(req,{secret:key,connection_id:peer.connection_id,target:peer.target+(url.search||'')},challenge=>claimPullNonce(P,peer.id,challenge),async()=>readEvents(base44,peer.merchant_ids,since));
    }
    if(secrets.get('LEX_PULL_LEGACY_DISABLED')==='true')return Response.json({error:'Legacy pull retired'},{status:401});

    // Authenticate: either the calling partner platform presenting the shared
    // sync secret (as carrierSyncReceiver/opsSyncReceiver require), or an
    // authenticated admin. Anonymous callers must not receive shipment data.
    let authorized = false;
    if (syncSecret && token && token === syncSecret) {
      authorized = true;
    } else {
      const user = await base44.auth.me().catch(() => null);
      if (user && user.role === "admin") authorized = true;
    }
    if (!authorized) return Response.json({ error: "Unauthorized" }, { status: 401 });

    return readEvents(base44);
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
async function readEvents(base44:any,merchantIds?:string[],since?:string|null):Promise<Response>{
    const shipments = [];
    for (const row of arrayRows(await base44.asServiceRole.entities.Shipment.list("-updated_date", 100))) {
      const authority = await operationalAuthority(base44.asServiceRole,row,'platform_sync');
      if (authority.ok && (!merchantIds || merchantIds.includes(authority.shipment.merchant_id)) && (!since || Date.parse(row.updated_date||row.created_date||'')>=Date.parse(since))) shipments.push(authority.shipment);
    }

    const events = (shipments || []).filter((s:any)=>!!(s.tracking_id||s.tracking_number)).map((s: any) => ({
      tracking_id: s.tracking_id || s.tracking_number, // actual tracking only; native id is not a tracking alias
      app: "merchant",
      stage: mapStage(s.status),
      event_type: `package.${s.status || "updated"}`,
      note: "synced from merchant app",
      location: s.current_location || s.origin || "",
      occurred_at: s.updated_date || s.created_date || new Date().toISOString(),
      package: {
        merchant_name: s.merchant_name || "",
        origin: [s.origin_address, s.origin_city].filter(Boolean).join(", ") || s.origin || "",
        destination: [s.destination_address, s.destination_city].filter(Boolean).join(", ") || s.destination || "",
        package_size: s.package_size || "small",
        weight_kg: toKg(s.weight_lb, s.weight_kg),
        service_level: mapServiceLevel(s.service_level),
        declared_value: s.declared_value || 0,
      },
    }));

    return Response.json({ events });
}
