import { createClientFromRequest } from "npm:@base44/sdk@0.8.52";
import { sanitizeShipment } from "../../shared/custodyRules.ts";
import { resolvePortalAccess } from "../../shared/portalMemberships.ts";

// PUDO ↔ LEX cross-reference. Given a tracking number, drop-off code, or
// shipment id, resolves the local shipment and reads the LEX-reported events
// cached in IncomingLexEvent (the LEX→merchant inbound feed). The newest of
// those is the live LEX view: LEX owns canonical state and pushes to
// lexWebhookReceiver, and exposes no merchant lookup route to pull from.
// Returns a reconciliation so the PUDO partner can see whether the local
// record and LEX agree. Outbound sync (merchant→LEX) is handled by the "Push
// Package Events to LEX Hub" workflow when a ShipmentEvent is created, so this
// function only reads.

const SHIPMENT_STATUSES = new Set([
  "created", "awaiting_payment", "awaiting_dropoff", "received_at_origin",
  "carrier_assigned", "picked_up", "in_transit", "received_at_destination",
  "ready_for_collection", "out_for_delivery", "delivered", "collected",
  "cancelled", "exception",
]);

export default async function (req: Request): Promise<Response> {
  try {
    if (req.method !== "POST")
      return Response.json({ error: "Method not allowed" }, { status: 405 });

    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    // Access gate: cross-referencing other tenants' shipments requires an
    // approved Exchange Partner or PUDO membership, resolved server-side.
    const { portals, memberships } = await resolvePortalAccess(base44, user);
    const partnerApproved =
      (portals.pudo && portals.pudo.status === "approved") ||
      (portals.vep && portals.vep.status === "approved");
    if (!partnerApproved) {
      return Response.json(
        { error: "Cross-reference requires an approved Exchange Partner or PUDO membership." },
        { status: 403 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const q = String(body.query || "").trim();
    if (!q) return Response.json({ error: "query required" }, { status: 400 });

    // 1. Resolve the shipment locally. Service role: partners cross-reference
    //    shipments owned by other tenants; the scanned tracking/drop-off code
    //    is the partner's proof of possession, and the response is sanitized.
    const matches = await base44.asServiceRole.entities.Shipment.filter(
      { $or: [
        { tracking_number: q }, { drop_off_code: q },
        { tracking_id: q }, { id: q },
      ] },
      "-created_date", 5
    );
    const shipment = matches && matches[0] ? matches[0] : null;
    if (!shipment) return Response.json({ found: false });
    const locations=(memberships||[]).filter(m=>['vep','pudo'].includes(m.portal_type)&&m.status==='approved').map(m=>m.location_id).filter(Boolean);
    if(!locations.includes(shipment.origin_location_id)&&!locations.includes(shipment.destination_location_id))return Response.json({found:false},{status:404});

    // 2. LEX-reported events cached locally (admin-only entity → service role).
    let lexEvents: any[] = [];
    try {
      lexEvents = await base44.asServiceRole.entities.IncomingLexEvent.filter(
        { shipment_id: shipment.id },
        "-received_at", 10
      ) || [];
    } catch { lexEvents = []; }

    // 3. LEX-owned live state, read from the inbound feed. LEX pushes events
    //    to lexWebhookReceiver and owns canonical state; it does not expose a
    //    merchant lookup route (GET /functions/shipmentLookup on the hub
    //    answers 404 "not found or not deployed"), so the newest inbound LEX
    //    event is the authoritative live view available to this app.
    let lexLive: any = null;
    if (lexEvents.length > 0) {
      const latest: any = lexEvents[0];
      const payload: any = latest.payload || {};
      const eventData = payload.data && typeof payload.data === "object" ? payload.data : payload;
      lexLive = {
        source: "lex_inbound_event",
        event: latest.event_type || latest.event_name || null,
        status: eventData.status || eventData.stage || null,
        location: eventData.location || eventData.current_location || null,
        occurred_at: eventData.occurred_at || latest.received_at || null,
        received_at: latest.received_at || null,
      };
    } else {
      lexLive = { source: "none", status: null, note: "no_lex_events_cached" };
    }

    // 4. Reconcile: does the local status agree with the LEX-reported status?
    let reconciliation = "unknown";
    if (lexLive && lexLive.status) {
      const lexStatus = String(lexLive.status);
      if (SHIPMENT_STATUSES.has(lexStatus)) {
        reconciliation = lexStatus === shipment.status ? "in_sync" : "diverged";
      } else {
        reconciliation = "unmapped";
      }
    } else if (lexEvents.length > 0) {
      reconciliation = "cached_only";
    }

    return Response.json({
      found: true,
      shipment: sanitizeShipment(shipment),
      lexEvents: lexEvents.map((e: any) => ({
        id: e.id, event_name: e.event_name, event_type: e.event_type,
        received_at: e.received_at, processed: e.processed,
        processing_note: e.processing_note, payload: e.payload,
      })),
      lexLive,
      reconciliation,
    });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}