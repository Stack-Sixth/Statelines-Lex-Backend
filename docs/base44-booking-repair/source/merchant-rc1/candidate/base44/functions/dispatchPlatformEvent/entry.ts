import {requireTrustedEvent} from '../../shared/trustedShipmentEvent.ts';
import { secrets } from "base44:runtime";
import { recordAuthority, recordOwner } from "../../shared/serverRecord.ts";
import { createClientFromRequest } from "npm:@base44/sdk@0.8.52";
import { deliverEvent } from "../../shared/platformDispatch.ts";
import {
  evaluateOutboundContainment,
  evaluateOperationalEvent,
} from "../../shared/testContainment.ts";
import { resolveShipmentSubject } from "../../shared/containmentResolver.ts";

// Outbound: delivers a Statelines event to the canonical logistics backend
// (LEX), which owns canonical state and fans out.
//
// CONTAINMENT. The subject is resolved server-side (local id, canonical id or
// tracking number) and classified synthetic / production / unknown. Only a
// resolved production record is delivered. A caller flag, a SYNTH- prefix or an
// admin role never overrides an unknown classification.
//
// A shipment-less event is a DISTINCT allowlisted contract: an authenticated
// admin may send only `network_alert`, with no shipment/tracking/business
// reference at all. Every other event requires a resolved identity.

const ALLOWED_EVENTS = new Set([
  "shipment_created",
  "shipment_status_update",
  "status_request",
  "custody_event",
  "carrier_assigned",
  "network_alert",
]);

const AUDIENCES = {
  lex: "lex",
  carriers: "carrier",
  carrier: "carrier",
  ops: "noc",
  noc: "noc",
};

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    let body = await req.json().catch(() => ({}));
    body = await requireTrustedEvent(base44.asServiceRole,body) || body;
    const platform = String(body.platform || "lex");
    const audience = AUDIENCES[platform];
    if (!audience)
      return Response.json(
        { error: `Unknown platform: ${platform}` },
        { status: 400 },
      );

    const event = String(body.event || "").slice(0, 200);
    if (!event)
      return Response.json({ error: "event required" }, { status: 400 });
    if (!ALLOWED_EVENTS.has(event))
      return Response.json({ error: "event not allowed" }, { status: 400 });

    const sr = base44.asServiceRole;
    const shipmentId = body.shipment_id ? String(body.shipment_id) : null;
    const trackingNumber = body.tracking_number
      ? String(body.tracking_number)
      : null;

    // A regular user may only dispatch events for shipments they own; anything
    // else (or an event with no shipment reference) requires an admin.
    let ship = null;
    if (shipmentId) {
      ship = await sr.entities.Shipment.get(shipmentId).catch(() => null);
      if (!ship)
        return Response.json({ error: "Shipment not found" }, { status: 404 });
      const actualOwner = await recordOwner(
        "Shipment",
        ship,
        recordAuthority(secrets.get("MERCHANT_RECORD_SIGNING_SECRET")),
      );
      if (actualOwner !== user.id && user.role !== "admin")
        return Response.json(
          { error: "Forbidden: not shipment owner" },
          { status: 403 },
        );
    } else if (user.role !== "admin") {
      return Response.json(
        { error: "Forbidden: admin required" },
        { status: 403 },
      );
    }

    // Server-side classification. No reference at all is only acceptable through
    // the explicit shipment-less operational contract.
    let subject = null;
    if (shipmentId || trackingNumber) {
      subject = await resolveShipmentSubject(sr, {
        shipment_id: shipmentId,
        tracking_number: trackingNumber,
      });
    } else {
      const operational = evaluateOperationalEvent({
        event,
        actor: user,
        references: {
          business_id: body.business_id,
          merchant_id: body.merchant_id,
          tracking_id: body.tracking_id,
          canonical_shipment_id: body.canonical_shipment_id,
        },
      });
      if (!operational.allowed) {
        return Response.json(
          {
            error: "shipment_reference_required",
            code: operational.code,
            message: operational.message,
          },
          { status: 400 },
        );
      }
    }

    if (subject) {
      const containment = evaluateOutboundContainment({
        channel: "dispatch",
        subject,
      });
      if (!containment.allowed) {
        await sr.entities.AuditLog.create({
          actor_id: user.id,
          action: "outbound_contained",
          entity: "platform",
          entity_id: shipmentId || trackingNumber || "",
          detail:
            `${event} ${containment.decision} (${containment.code}; ${containment.reasons.join(", ")})`.slice(
              0,
              400,
            ),
        }).catch(() => {});
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
    }

    const resolvedTracking = ship?.tracking_number
      ? String(ship.tracking_number)
      : trackingNumber || null;

    // Shallow primitives only — never forward client objects under our signature.
    const cleanData = {};
    for (const [k, v] of Object.entries(body.data || {})) {
      if (k.length > 64 || Object.keys(cleanData).length >= 20) continue;
      if (
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean"
      )
        cleanData[k] = v;
    }

    const correlationId = body.correlation_id
      ? String(body.correlation_id).slice(0, 80)
      : crypto.randomUUID();

    const derivedKey = `${event}:${shipmentId || resolvedTracking || "network"}:${audience}`;
    const idempotencyKey = String(
      body.idempotency_key ||
        (event === "status_request"
          ? `${derivedKey}:${Date.now()}`
          : derivedKey),
    ).slice(0, 160);

    const existing = await sr.entities.PlatformEvent.filter(
      { idempotency_key: idempotencyKey },
      "-created_date",
      5,
    ).catch(() => []);
    const alreadyDelivered = existing.find((row) => row.status === "delivered");
    if (alreadyDelivered) {
      return Response.json({
        ok: true,
        duplicate: true,
        delivered: true,
        audience,
        event_id: alreadyDelivered.id,
        attempts: alreadyDelivered.attempts || 0,
      });
    }

    const payload = JSON.stringify({
      event,
      audience,
      shipment_id: shipmentId,
      tracking_number: resolvedTracking,
      correlation_id: correlationId,
      idempotency_key: idempotencyKey,
      data: cleanData,
    });

    const record =
      existing[0] ||
      (await sr.entities.PlatformEvent.create({
        shipment_id: shipmentId || "",
        tracking_number: resolvedTracking || "",
        event,
        audience,
        destination: "lex_ingest_webhook",
        idempotency_key: idempotencyKey,
        payload: cleanData,
        status: "pending",
        attempts: 0,
      }));

    const delivered = await deliverEvent(sr, record, payload);

    await sr.entities.AuditLog.create({
      actor_id: user.id,
      action: "platform_sync_dispatch",
      entity: "platform",
      entity_id: shipmentId || resolvedTracking || "",
      detail:
        `${event} -> lex/${audience} (${delivered.http_status})${delivered.ok ? "" : ` ${delivered.error}`}`.slice(
          0,
          400,
        ),
    }).catch(() => {});

    if (!delivered.ok) {
      return Response.json(
        {
          error: "sync_failed",
          message: `Delivery to LEX failed: ${delivered.error}`,
          delivered: false,
          retryable: true,
          audience,
          event_id: record.id,
          attempts: delivered.attempts,
          http_status: delivered.http_status,
        },
        { status: 502 },
      );
    }

    return Response.json({
      ok: true,
      delivered: true,
      duplicate: false,
      audience,
      event_id: record.id,
      attempts: delivered.attempts,
      http_status: delivered.http_status,
    });
  } catch (error) {
    console.error("dispatchPlatformEvent error:", error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
