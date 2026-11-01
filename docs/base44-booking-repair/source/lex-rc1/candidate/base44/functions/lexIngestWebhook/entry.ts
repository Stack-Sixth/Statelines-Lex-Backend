import {verifyPush,verifyLegacyScoped,claimPullNonce} from '../../shared/lexPullProtocol.ts';
// Cross-app push receiver. External Statelines apps (NOC, Merchant, Carrier)
// POST package/activity events here; LEX validates the HMAC signature against
// the shared LEX_WEBHOOK_SECRET and ingests them into the canonical hub records.
//
// Expected body (single event): { tracking_id, app, stage, event_type, note, actor, location, occurred_at, command_id, package }
// Or a batch: { events: [ ... ] }
//
// Response per event: { ok, tracking_id, package_id, activity_id, duplicate,
//   engine_state, engine_shipment_id, engine_version, command_id }.
//   engine_state is the current sync disposition (pending|needs_information|
//   synced|test_fixture). engine_shipment_id + engine_version are returned when
//   the engine operation has already completed (synced); otherwise null and the
//   confirmed fields arrive later via the outbound shipment.created webhook.
//   command_id is the source app's idempotency key, echoed back unchanged.
//
// Partner-application inbound: when X-LEX-Event: partner_application_submitted is
// set, the body is a Statelines partner application for LEX review (Statelines
// issues credentials on decision). The application is stored with source=
// "statelines" and external_application_id as the idempotency key.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.49";
import { secrets } from "base44:runtime";
import { normalizeEvent, ingestEvent } from "../../shared/lexIngest.ts";
import { nowIso } from "../../shared/lexUtils.ts";

export default async function (req: Request): Promise<Response> {
  try {
    if (req.method !== "POST")
      return Response.json({ error: "Method not allowed" }, { status: 405 });

    const bodyText = await req.text();
    const signature = req.headers.get("X-LEX-Signature") || "";
    const secret = secrets.get("LEX_WEBHOOK_SECRET") || "";

    let raw:any;try{raw=JSON.parse(bodyText);}catch{return Response.json({error:'Invalid JSON'},{status:400});}
    const base44=createClientFromRequest(req);
    const incomingEvent=req.headers.get('X-LEX-Event')||raw.event||'';
    let ingressContext:any=null;
    if(incomingEvent==='partner_application_submitted'){
      // Preserve the existing non-shipment application intake wire contract.
      if(!secret||!await verifyLegacyScoped(bodyText,signature,secret))return Response.json({error:'Invalid signature'},{status:401});
    } else {
      const connectionId=req.headers.get('X-LEX-Connection-Id');
      if(!connectionId)return Response.json({error:'sender_mapping_required',held:true},{status:409});
      const conn=await base44.asServiceRole.entities.PlatformConnection.get(connectionId).catch(()=>null);
      if(!conn||conn.status!=='active'||!conn.auth_secret||conn.auth_secret===secret)return Response.json({error:'Dedicated partner key required'},{status:401});
      if(req.headers.get('X-LEX-Push-Version')==='2'){
        if(!conn.ingress_v2_enabled)return Response.json({error:'sender_not_enabled'},{status:409});
        try{const challenge=await verifyPush(req,bodyText,conn.auth_secret,conn.id);if(!await claimPullNonce(base44.asServiceRole.entities.PlatformConnection,conn.id,challenge))throw new Error('replay');}catch{return Response.json({error:'Invalid or replayed sender authentication'},{status:401});}
        ingressContext={connection_id:conn.id,mode:'v2'};
      }else{
        if(!conn.ingress_legacy_scoped||!await verifyLegacyScoped(bodyText,signature,conn.auth_secret))return Response.json({error:'Invalid scoped sender authentication'},{status:401});
        ingressContext={connection_id:conn.id,mode:'legacy-scoped'};
      }
    }

    // --- Partner-application inbound: Statelines submits an application for LEX review ---
    const eventName = req.headers.get("X-LEX-Event") || raw.event || "";
    const correlationId = req.headers.get("X-LEX-Correlation-Id") || raw.correlation_id || "";
    if (eventName === "partner_application_submitted") {
      const data = (raw && raw.data) ? raw.data : {};
      const externalId = String(data.application_id || "").trim();
      if (!externalId) return Response.json({ error: "missing application_id" }, { status: 400 });
      const t = String(data.type || "").trim();
      const applicant_type = t === "pudo_partner" ? "pudo" : "exchange_partner";
      const organization_name = String(data.business_name || data.facility_name || "Statelines Application").trim();
      const extra = [
        data.business_type ? `business_type: ${data.business_type}` : "",
        data.facility_name ? `facility: ${data.facility_name}` : "",
        data.transportation_hub ? `hub: ${data.transportation_hub}` : "",
        data.operating_hours ? `hours: ${data.operating_hours}` : "",
        data.website ? `website: ${data.website}` : "",
      ].filter(Boolean).join(" Â· ");
      const notes = [extra, correlationId ? `correlation_id: ${correlationId}` : ""].filter(Boolean).join(" Â· ");
      // Idempotent: a replay with the same Statelines application_id returns the existing record.
      const existing = await base44.asServiceRole.entities.PartnerApplication.filter({ external_application_id: externalId }, null, 1);
      if (existing && existing.length) {
        return Response.json({ received: 1, event: eventName, application_id: externalId, duplicate: true, partner_application_id: existing[0].id });
      }
      const created = await base44.asServiceRole.entities.PartnerApplication.create({
        applicant_type,
        organization_name,
        contact_name: String(data.contact_name || "").trim(),
        contact_email: String(data.email || "").trim(),
        contact_phone: String(data.phone || "").trim(),
        address: String(data.address || "").trim(),
        notes,
        status: "pending",
        source: "statelines",
        external_application_id: externalId,
        submitted_at: data.submitted_at || nowIso(),
      });
      return Response.json({ received: 1, event: eventName, application_id: externalId, partner_application_id: created.id });
    }

    const events = Array.isArray(raw.events) ? raw.events : [raw];
    const results: any[] = [];
    for (const r of events) {
      const evt = normalizeEvent(r);
      if (!evt) {
        results.push({ ok: false, error: "missing tracking_id" });
        continue;
      }
      try {
        const res = await ingestEvent(base44, evt, ingressContext);
        results.push({ ok: true, tracking_id: evt.tracking_id, ...res });
      } catch (e) {
        results.push({ ok: false, tracking_id: evt.tracking_id, error: (e as Error).message });
      }
    }
    return Response.json({ received: results.length, results });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
