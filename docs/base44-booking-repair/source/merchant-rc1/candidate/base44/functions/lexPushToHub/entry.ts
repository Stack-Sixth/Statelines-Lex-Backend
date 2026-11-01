import {requireTrustedEvent} from '../../shared/trustedShipmentEvent.ts';
import { createClientFromRequest } from "npm:@base44/sdk@0.8.52";
import { secrets } from "base44:runtime";
import { evaluateOutboundContainment, evaluateOperationalEvent } from "../../shared/testContainment.ts";
import { resolveShipmentSubject } from "../../shared/containmentResolver.ts";

// Forwards a custody/status event to the LEX hub ingest webhook, HMAC-signed
// with LEX_WEBHOOK_SECRET. Admin only. Only a known, validated shape is signed
// and forwarded — never the raw request body.
//
// CONTAINMENT. This is a dispatch boundary, so the subject is ALWAYS resolved
// before signing — by shipment id or tracking id. A failed lookup is unknown and
// denied; a tracking-only request is resolved rather than passed through. Only a
// shipment-less `network_alert` may bypass the shipment lookup, and only with an
// authenticated admin and no references.

export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user || user.role !== "admin")
      return Response.json({ error: "Forbidden: admin required" }, { status: 403 });

    let body = await req.json().catch(() => ({}));
    body = await requireTrustedEvent(base44.asServiceRole,body) || body;
    const event = String(body.event || "");
    if (!event) return Response.json({ error: "event required" }, { status: 400 });
    if (!/^[a-z0-9_.-]{3,60}$/i.test(event))
      return Response.json({ error: "event not allowed" }, { status: 400 });

    const sr = base44.asServiceRole;
    const shipmentId = body.shipment_id ? String(body.shipment_id) : null;
    const trackingId = body.tracking_id ? String(body.tracking_id) : null;
    const trackingNumber = body.tracking_number ? String(body.tracking_number) : null;

    let subject = null;
    if (shipmentId || trackingId || trackingNumber) {
      subject = await resolveShipmentSubject(sr, {
        shipment_id: shipmentId,
        tracking_id: trackingId,
        tracking_number: trackingNumber,
      });
      const containment = evaluateOutboundContainment({ channel: "dispatch", subject });
      if (!containment.allowed) {
        return Response.json({
          ok: true,
          contained: true,
          delivered: false,
          channel: containment.channel,
          classification: containment.classification,
          code: containment.code,
          message: containment.message,
          reasons: containment.reasons,
        });
      }
    } else {
      const operational = evaluateOperationalEvent({
        event,
        actor: user,
        references: { business_id: body.business_id, merchant_id: body.merchant_id },
      });
      if (!operational.allowed) {
        return Response.json(
          { error: "shipment_reference_required", code: operational.code, message: operational.message },
          { status: 400 },
        );
      }
    }

    // Only forward the known custody-event fields the workflow emits.
    const ALLOWED_DATA = ["location", "custodian", "verification_method", "occurred_at"];
    const data = {};
    for (const k of ALLOWED_DATA) {
      const v = body.data?.[k];
      if (typeof v === "string" || typeof v === "number") data[k] = String(v);
    }

    const lexUrl = secrets.get("LEX_HUB_URL");
    const secret = secrets.get("LEX_WEBHOOK_SECRET");
    if (!lexUrl || !secret)
      return Response.json({ error: "LEX_HUB_URL or LEX_WEBHOOK_SECRET not set" }, { status: 500 });

    const payload = JSON.stringify({
      event,
      shipment_id: subject?.shipment_id || null,
      tracking_id: trackingId,
      data,
    });
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
    const signature = "sha256=" + Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0")).join("");

    const resp = await fetch(`${lexUrl}/functions/lexIngestWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-LEX-Signature": signature },
      body: payload,
      signal: AbortSignal.timeout(10000),
    });
    return new Response(await resp.text(), {
      status: resp.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}