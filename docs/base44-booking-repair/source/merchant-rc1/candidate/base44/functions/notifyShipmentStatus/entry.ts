import { secrets } from "base44:runtime";
import { recordAuthority, recordOwner } from "../../shared/serverRecord.ts";
import { createClientFromRequest } from "npm:@base44/sdk@0.8.52";
import {
  evaluateOutboundContainment,
  evaluateOperationalEvent,
} from "../../shared/testContainment.ts";
import { resolveShipmentSubject } from "../../shared/containmentResolver.ts";

// Sends a shipment status alert email + in-app notification to the shipment's
// owner. Content derives only from the server-side Shipment record.
//
// CONTAINMENT. A subject that is synthetic OR cannot be classified produces no
// email and no notification. A failed lookup is not treated as an ordinary row.

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const shipmentId = body.shipment_id || body.id;
    const status = body.status;

    if (status !== "delivered" && status !== "delayed") {
      return Response.json({
        sent: false,
        reason: "Status not actionable for alerts",
      });
    }
    if (!shipmentId) {
      return Response.json(
        { sent: false, reason: "shipment_id is required" },
        { status: 400 },
      );
    }

    const sr = base44.asServiceRole;
    const shipment = await sr.entities.Shipment.get(shipmentId).catch(
      () => null,
    );
    if (!shipment) {
      return Response.json(
        { sent: false, reason: "Shipment not found" },
        { status: 404 },
      );
    }
    if(status!==shipment.status)return Response.json({sent:false,reason:'Persisted shipment status differs; stale or invalid alert request'},{status:409});
    const actualOwner = await recordOwner(
      "Shipment",
      shipment,
      recordAuthority(secrets.get("MERCHANT_RECORD_SIGNING_SECRET")),
    );
    const isOwner = actualOwner === user.id;
    const isAdmin = user.role === "admin";
    if (!isOwner && !isAdmin) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    const subject = await resolveShipmentSubject(sr, {
      shipment_id: shipment.id,
    });
    const containment = evaluateOutboundContainment({
      channel: "notification",
      subject,
    });
    if (!containment.allowed) {
      return Response.json({
        sent: false,
        contained: true,
        channel: containment.channel,
        classification: containment.classification,
        code: containment.code,
        message: containment.message,
        reasons: containment.reasons,
      });
    }

    // Strip URLs, control characters, and excessive length so user-writable
    // shipment fields cannot carry phishing payloads.
    const sanitize = (v, max = 60) =>
      String(v || "")
        .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, "")
        .replace(/(?:https?:\/\/|www\.)\S*/gi, "[link removed]")
        .slice(0, max)
        .trim();

    const originCity = sanitize(shipment.origin_city || shipment.origin || "");
    const destinationCity = sanitize(
      shipment.destination_city || shipment.destination || "",
    );
    const trackingNumber = sanitize(shipment.tracking_number || "", 40);

    // Resolve the recipient ONLY from the shipment creator's platform user
    // record; Merchant.contact_email is user-editable and must not be trusted.
    let recipientEmail = null;
    let merchantName = null;

    if (actualOwner) {
      try {
        const owner = await sr.entities.User.get(actualOwner);
        recipientEmail = owner?.email || null;
        merchantName = owner?.full_name || null;
      } catch (_) {
        /* user not found */
      }
    }
    if (shipment.merchant_id) {
      try {
        const merchant = await sr.entities.Merchant.get(shipment.merchant_id);
        merchantName = merchant?.company_name || merchantName;
      } catch (_) {
        /* merchant not found */
      }
    }

    if (!recipientEmail) {
      return Response.json({ sent: false, reason: "No merchant email found" });
    }

    const alertType = status === "delivered" ? "delivered" : "delayed";

    await sr.integrations.Core.SendEmail({
      to: recipientEmail,
      template_name: "ShipmentStatusAlert",
      variables: {
        merchant_name: sanitize(merchantName || "there"),
        alert_type: alertType,
        origin: originCity || "origin",
        destination: destinationCity || "destination",
        tracking_number: trackingNumber || "N/A",
        status: status,
      },
    });

    const title =
      status === "delivered"
        ? `Shipment delivered to ${destinationCity || "destination"}`
        : `Shipment to ${destinationCity || "destination"} is delayed`;

    const notifBody =
      status === "delivered"
        ? `Your shipment from ${originCity || "origin"} to ${destinationCity || "destination"}${trackingNumber ? ` (tracking: ${trackingNumber})` : ""} has been delivered.`
        : `Your shipment from ${originCity || "origin"} to ${destinationCity || "destination"}${trackingNumber ? ` (tracking: ${trackingNumber})` : ""} is delayed. Check your dashboard for details.`;

    try {
      await sr.entities.Notification.create({
        merchant_id: shipment.merchant_id || "",
        user_id: actualOwner || "",
        title,
        body: notifBody,
        type: "shipment",
        read: false,
      });
    } catch (notifErr) {
      console.error("Notification record failed:", notifErr.message);
    }

    // Do not echo the recipient email back — it is private data.
    return Response.json({ sent: true, alert_type: alertType });
  } catch (error) {
    console.error("notifyShipmentStatus error:", error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
