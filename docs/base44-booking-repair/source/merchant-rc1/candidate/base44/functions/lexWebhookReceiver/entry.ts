import {createTrustedShipmentEvent} from '../../shared/trustedShipmentEvent.ts';
import {resolveOperationalShipment} from '../../shared/shipmentAuthority.ts';
// LEX Platform Webhook Receiver — HMAC-SHA256 signature verification.
// Verifies the inbound event, persists the raw payload to IncomingLexEvent,
// and applies shipment-affecting events to the database (Shipment status,
// ShipmentEvent, Notification) so LEX feeds communicate accurately.

import { createClientFromRequest } from "npm:@base44/sdk@0.8.48";
import { secrets } from "base44:runtime";
import { promoteMerchantForApplication } from "../../shared/partnerPromotion.ts";

const SHIPMENT_STATUSES = [
  "created", "awaiting_payment", "awaiting_dropoff", "received_at_origin",
  "carrier_assigned", "picked_up", "in_transit", "received_at_destination",
  "ready_for_collection", "out_for_delivery", "delivered", "collected",
  "cancelled", "exception",
];

export default async function (req) {
  try {
    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const bodyText = await req.text();
    const signature = req.headers.get("X-LEX-Signature") || "";
    const eventName = req.headers.get("X-LEX-Event") || "";
    const correlationId = req.headers.get("X-LEX-Correlation-Id") || "";

    // Validate the HMAC-SHA256 signature against the shared secret.
    const secret = secrets.get("LEX_WEBHOOK_SECRET") || "";
    let signatureValid = false;
    if (secret && signature.startsWith("sha256=")) {
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );
      const computed = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(bodyText)
      );
      const expected =
        "sha256=" +
        Array.from(new Uint8Array(computed))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      signatureValid = signature === expected;
    }

    if (!signatureValid) {
      return Response.json({ error: "Invalid signature" }, { status: 401 });
    }

    // Parse payload (tolerate non-JSON bodies).
    let payload = {};
    try {
      payload = JSON.parse(bodyText);
    } catch {
      payload = { raw: bodyText };
    }

    const base44 = createClientFromRequest(req);
    const sr = base44.asServiceRole;

    // 1. Persist the raw inbound event accurately.
    let record = null;
    try {
      record = await sr.entities.IncomingLexEvent.create({
        event_name: eventName,
        correlation_id: correlationId || null,
        source: "LEX",
        event_type: String(payload.event || eventName || ""),
        payload,
        received_at: new Date().toISOString(),
        signature_valid: true,
        processed: false,
      });
    } catch {
      // Entity unavailable — continue, but we can't track processing.
    }

    // 2a. Partner-application decisions: LEX reviews an application we
    // forwarded and posts the outcome back. Update the local
    // PartnerApplication and skip shipment processing for these events.
    let processingNote = "stored";
    let shipmentId = null;
    const evtName = String(payload.event || eventName || "");
    if (evtName.startsWith("partner_application")) {
      try {
        const data = payload.data || {};
        const appId = data.application_id || payload.application_id;
        const decision = String(data.decision || payload.decision || "").toLowerCase();
        if (appId && (decision === "approved" || decision === "rejected")) {
          await sr.entities.PartnerApplication.update(String(appId), {
            status: decision,
            lex_decision_note: String(data.note || payload.note || "").slice(0, 500) || null,
          });
          // On approval, promote the applicant's merchant account so they
          // land on the partner dashboard on next login.
          if (decision === "approved") {
            const app = await sr.entities.PartnerApplication.get(String(appId)).catch(() => null);
            if (app) await promoteMerchantForApplication(sr, app);
          }
          processingNote = `partner_application:${decision}`;
        } else {
          processingNote = "partner_application:ignored";
        }
      } catch (e) {
        processingNote = `partner_application_error:${e.message}`;
      }
    } else {
    try {
      const data = payload.data || {};
      const tracking = payload.tracking_number || data.tracking_number;
      const sid = payload.shipment_id || data.shipment_id;
      const status = payload.status || data.status;
      const shipment = await resolveShipment(sr, sid, tracking);

      if (shipment) {
        shipmentId = shipment.id;
        const eventLabel = String(payload.event || data.event || "");
        const assignedCarrier = String(data.carrier_id || payload.carrier_id || "");

        // Carrier assignment decided by LEX (the network's authority). The
        // Merchant record follows it; a replayed assignment is a no-op.
        if (eventLabel === "carrier_assigned" && assignedCarrier) {
          if (shipment.carrier_id === assignedCarrier) {
            processingNote = "carrier_assigned:duplicate";
          } else {
            await sr.entities.Shipment.update(shipment.id, { carrier_id: assignedCarrier });
            await createTrustedShipmentEvent(sr,shipment,'lex',{
              shipment_id: shipment.id,
              event: `Assigned to carrier ${assignedCarrier} by LEX`,
              location: String(data.location || ""),
              custodian: "LEX",
              verification_method: "lex webhook",
              occurred_at: data.occurred_at || new Date().toISOString(),
            });
            await sr.entities.Notification.create({
              merchant_id: shipment.merchant_id || "",
              title: "Carrier assigned",
              body: `Tracking ${shipment.tracking_number || shipment.id} was assigned to carrier ${assignedCarrier}.`,
              type: "shipment",
            });
            processingNote = "carrier_assigned";
          }
        } else if (status && SHIPMENT_STATUSES.includes(String(status))) {
          // LEX retries deliveries. A replayed transition must not add a
          // second timeline entry or a second merchant notification.
          if (shipment.status === String(status)) {
            processingNote = `duplicate:${status}`;
          } else {
            await sr.entities.Shipment.update(shipment.id, { status: String(status) });
            await createTrustedShipmentEvent(sr,shipment,'lex',{
              shipment_id: shipment.id,
              event: `Status set to ${status} by LEX`,
              location: String(data.location || ""),
              custodian: "LEX",
              verification_method: "lex webhook",
              occurred_at: data.occurred_at || new Date().toISOString(),
            });
            await sr.entities.Notification.create({
              merchant_id: shipment.merchant_id || "",
              title: "Shipment status updated",
              body: `Tracking ${shipment.tracking_number || shipment.id} is now ${String(status).replace(/_/g, " ")} (reported by LEX).`,
              type: "shipment",
            });
            processingNote = `applied:${status}`;
          }
        } else if (eventLabel === "custody_event" || data.event) {
          const label = String(data.event || payload.event || "");
          const occurredAt = String(data.occurred_at || "");
          // The same custody event replayed by a retrying sender is recorded
          // once: identity is label + occurrence time.
          const recent = occurredAt
            ? await sr.entities.ShipmentEvent.filter({ shipment_id: shipment.id }, "-occurred_at", 20).catch(() => [])
            : [];
          if (occurredAt && recent.some((row) => row.event === label && String(row.occurred_at || "") === occurredAt)) {
            processingNote = "custody_event:duplicate";
          } else {
            await createTrustedShipmentEvent(sr,shipment,'lex',{
              shipment_id: shipment.id,
              event: label,
              location: String(data.location || ""),
              custodian: String(data.custodian || "LEX"),
              verification_method: String(data.verification_method || "lex webhook"),
              occurred_at: data.occurred_at || new Date().toISOString(),
            });
            processingNote = "custody_event_recorded";
          }
        } else {
          processingNote = "no_actionable_fields";
        }
      } else if (sid || tracking) {
        processingNote = "shipment_not_found";
      } else {
        processingNote = "no_shipment_reference";
      }
    } catch (e) {
      processingNote = `error:${e.message}`;
    }
    }

    // 3. Mark the stored event with the processing outcome.
    if (record) {
      try {
        await sr.entities.IncomingLexEvent.update(record.id, {
          processed:
            processingNote.startsWith("applied") ||
            processingNote.startsWith("partner_application:") ||
            processingNote.startsWith("duplicate") ||
            processingNote.startsWith("carrier_assigned") ||
            processingNote === "custody_event_recorded",
          processing_note: processingNote,
          shipment_id: shipmentId || null,
        });
      } catch {
        // best-effort
      }
    }

    return Response.json({
      received: true,
      event: eventName,
      correlation_id: correlationId,
      processed: processingNote,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

async function resolveShipment(sr, shipmentId, trackingNumber) {
  const resolved = await resolveOperationalShipment(sr, {shipment_id:shipmentId, tracking_number:trackingNumber}, 'lex');
  if (!resolved.ok) throw new Error(`Shipment operation held: ${resolved.code}`);
  return resolved.shipment;
}
