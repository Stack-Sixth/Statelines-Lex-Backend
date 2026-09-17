// ============================================================================
//  LEX Platform Webhook Receiver — drop this into EACH sibling Statelines app.
//
//  In the target app:
//    1. Create a backend function named `lexWebhookReceiver` and paste this as
//       base44/functions/lexWebhookReceiver/entry.ts
//    2. In that app's Settings → Environment Variables, add a secret named
//       LEX_WEBHOOK_SECRET with the SAME value you put in the matching
//       PlatformConnection's `auth_secret` field inside the LEX console.
//    3. (Optional) Create an entity `IncomingLexEvent` (schema below) so events
//       persist. If the entity is absent, the function still ACKs with 200.
//    4. Back in the LEX console, set the connection's webhook_url to:
//       https://<that-app>.base44.app/api/functions/lexWebhookReceiver
//       add the shared auth_secret, and enable the connection.
//
//  IncomingLexEvent entity schema (create in the sibling app):
//  {
//    "name": "IncomingLexEvent",
//    "type": "object",
//    "properties": {
//      "event_name": { "type": "string" },
//      "correlation_id": { "type": "string" },
//      "source": { "type": "string" },
//      "payload": { "type": "object" },
//      "received_at": { "type": "string", "format": "date-time" },
//      "signature_valid": { "type": "boolean", "default": true }
//    },
//    "required": ["event_name"]
//  }
// ============================================================================

import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import { secrets } from "base44:runtime";

export default async function (req) {
  try {
    // Only POST is accepted.
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
      // Constant-time-ish comparison.
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

    // Best-effort persist to an IncomingLexEvent entity if it exists in this app.
    // Wrapped so a missing entity never blocks the ACK (delivery is still 200).
    try {
      const base44 = createClientFromRequest(req);
      await base44.asServiceRole.entities.IncomingLexEvent.create({
        event_name: eventName,
        correlation_id: correlationId || null,
        source: "LEX",
        payload,
        received_at: new Date().toISOString(),
        signature_valid: true,
      });
    } catch {
      // Entity not defined in this app — record nothing, still ACK.
    }

    return Response.json({
      received: true,
      event: eventName,
      correlation_id: correlationId,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}