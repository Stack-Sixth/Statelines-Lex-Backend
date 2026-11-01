import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import { nowIso } from "../../shared/lexUtils.ts";
import { transitionShipment, CUSTODY_TO_STATUS } from "../../shared/lexTransitions.ts";
import { requireInternalSecret } from "../../shared/lexInternalGate.ts";

// LEX Custody Service — records a chain-of-custody event as a validated,
// idempotent shipment transition. Authorization and capacity effects are
// delegated to the unified transition service; this function persists the
// merchant notification and returns the transition result.
export default async function (req) {
  try {
    const internalDenied = await requireInternalSecret(req);
    if (internalDenied) return internalDenied;
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { shipment_id, tracking_id, event_type, location, notes, recipient_type } = body;
    if (!shipment_id && !tracking_id) return Response.json({ error: "shipment_id or tracking_id required" }, { status: 400 });
    if (!event_type) return Response.json({ error: "event_type required" }, { status: 400 });

    const toStatus = CUSTODY_TO_STATUS[event_type];
    if (!toStatus) return Response.json({ error: "Unsupported custody event_type: " + event_type }, { status: 400 });

    const command_id = body.command_id || `custody:${shipment_id || tracking_id}:${event_type}:${body.timestamp || nowIso()}`;
    // Security: actor_name and responsible_entity are derived server-side from
    // the authenticated user — never from client-supplied body fields, which
    // could forge attribution in the chain-of-custody ledger (CWE-345).
    // transitionShipment's writeCustody ignores custody.actor_name and uses
    // actor.full_name; responsible_entity is also derived from the actor there.
    const res = await transitionShipment(base44, {
      shipment_id, tracking_id, command_id, to_status: toStatus,
      custody: { event_type, location, lat: body.lat, lng: body.lng, signature: body.signature, notes },
      trigger_source: body.trigger_source || "carrier",
      actor: user, note: notes || location || null,
      correlation_id: body.correlation_id,
    });

    if (!res.ok) return Response.json({ error: res.error, code: res.code }, { status: res.code || 500 });

    if(res.idempotent)return Response.json({transition:res,notification:null});
    // Merchant notification (best-effort; transition already durably recorded).
    const notif = await base44.asServiceRole.entities.Notification.create({
      recipient_type: recipient_type || "merchant",
      recipient_id: res.shipment_id ? (await base44.asServiceRole.entities.Shipment.get(res.shipment_id).catch(() => null))?.created_by_id : null,
      channel: "in_app",
      subject: "Shipment " + (tracking_id || res.shipment_id) + " — " + event_type.replace(/_/g, " "),
      body: "Status update: " + event_type + (location ? " at " + location : "") + (notes ? ". " + notes : ""),
      status: "sent",
      related_entity_id: res.shipment_id,
    }).catch(() => null);

    return Response.json({ transition: res, notification: notif });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}