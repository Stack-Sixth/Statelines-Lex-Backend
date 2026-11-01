import {secrets} from "base44:runtime";
import {transitionCustody,settleCustody} from "../../shared/custodyRecovery.ts";
import {claimResponse} from "../../shared/casBooking.ts";
import {operationalAuthority,arrayRows} from '../../shared/shipmentAuthority.ts';
import { createClientFromRequest } from "npm:@base44/sdk@0.8.52";
import { resolvePortalAccess } from "../../shared/portalMemberships.ts";
import {
  allowedPartnerTransitions, sanitizeShipment,
} from "../../shared/custodyRules.ts";

// Partner custody gate — the single server-side authority for VEP/PUDO
// scans, handoffs, and queue visibility. The client never touches partner
// shipment records directly (RLS hides other tenants' records from the
// partner's token anyway); every read and every status change goes through
// here: membership-gated, transition-validated, event-logged, and audited.

// Queue columns the partner dashboards render.
const QUEUE_STATUSES = {
  awaiting_dropoff: ["awaiting_dropoff"],
  ready_for_collection: ["ready_for_collection"],
  in_transit: ["received_at_origin", "carrier_assigned", "picked_up", "in_transit"],
  out_for_delivery: ["out_for_delivery"],
  recent_delivered: ["delivered", "collected"],
};
const ALL_ACTIONABLE = [
  ...QUEUE_STATUSES.awaiting_dropoff,
  ...QUEUE_STATUSES.ready_for_collection,
  ...QUEUE_STATUSES.in_transit,
  ...QUEUE_STATUSES.out_for_delivery,
];

export default async function (req: Request): Promise<Response> {
  try {
    if (req.method !== "POST")
      return Response.json({ error: "Method not allowed" }, { status: 405 });

    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");

    // Access gate: an approved VEP or PUDO membership (server-resolved;
    // no client-submitted identity or portal is ever trusted).
    const { portals, merchant, memberships } = await resolvePortalAccess(base44, user);
    const portal =
      portals.pudo && portals.pudo.status === "approved"
        ? "pudo"
        : portals.vep && portals.vep.status === "approved"
          ? "vep"
          : null;
    if (!portal) {
      return Response.json(
        { error: "Custody operations require an approved Exchange Partner or PUDO membership." },
        { status: 403 }
      );
    }

    const sr = base44.asServiceRole;
    const facility = merchant?.company_name || "Partner facility";
    const custodian = merchant?.contact_name || user.full_name || "Partner";

    // Facility scoping: partners may only see and act on shipments whose
    // origin or destination is one of THEIR approved partner locations
    // (from their approved VEP/PUDO memberships). A partner with no linked
    // location gets an impossible scope — an empty $in matches nothing.
    const partnerLocationIds = [
      ...new Set(
        (memberships || [])
          .filter(
            (m) =>
              (m.portal_type === "vep" || m.portal_type === "pudo") &&
              m.status === "approved" &&
              m.location_id
          )
          .map((m) => m.location_id)
      ),
    ];
    const facilityScope = {
      $or: [
        { origin_location_id: { $in: partnerLocationIds } },
        { destination_location_id: { $in: partnerLocationIds } },
      ],
    };

    // ---- Scan / type-in lookup -------------------------------------------
    if (action === "lookup") {
      const q = String(body.query || "").trim();
      if (!q) return Response.json({ error: "query required" }, { status: 400 });
      const found = await sr.entities.Shipment.filter(
        { $and: [facilityScope, { $or: [{ tracking_number: q }, { drop_off_code: q }, { tracking_id: q }, { id: q }] }] },
        "-created_date", 5
      );
      const matches = arrayRows(found);
      const shipment = matches.length === 1 ? matches[0] : null;
      if (!shipment) return Response.json({ found: false });
      const authority = await operationalAuthority(sr, shipment, 'partner');
      if (!authority.ok) return Response.json({ found:false, held:true }, {status:409});
      return Response.json({
        found: true,
        shipment: sanitizeShipment(shipment),
        allowed: allowedPartnerTransitions(shipment.status),
      });
    }

    // ---- Status transition (scan / handoff) -------------------------------
    if (action === "transition") {
      const shipmentId = String(body.shipment_id || "");
      const to = String(body.to || "");
      if (!shipmentId || !to)
        return Response.json({ error: "shipment_id and to required" }, { status: 400 });

      const page = await sr.entities.Shipment.filter({ id: shipmentId }, "-created_date", 2);
      const shipment = page && page[0] ? page[0] : null;
      if (!shipment)
        return Response.json({ error: "Shipment not found" }, { status: 404 });

      const authority = await operationalAuthority(sr, shipment, 'partner');
      if (!authority.ok) return Response.json({error:'Shipment operation held',reason:authority.code},{status:409});
      const linked = partnerLocationIds.includes(shipment.origin_location_id) || partnerLocationIds.includes(shipment.destination_location_id);
      if(!linked)return Response.json({error:'Shipment not found'},{status:404});
      if(shipment.custody_receipt?.to===to && shipment.status===to) {
        const recovered=await settleCustody(sr.entities,shipment,secrets.get('MERCHANT_RECORD_SIGNING_SECRET')!);
        return Response.json({ok:true,duplicate:true,shipment:sanitizeShipment(recovered),allowed:allowedPartnerTransitions(recovered.status)});
      }
      const from = shipment.status;
      const allowed = allowedPartnerTransitions(from);
      if (!allowed.includes(to)) {
        return Response.json(
          { error: `Not a valid custody step: ${from || "unknown"} → ${to}.`, allowed },
          { status: 409 }
        );
      }

      const updated=await transitionCustody(sr.entities,shipment,{from,to,facility,custodian,actor_id:user.id,location_ids:partnerLocationIds},
        authority.ownership,secrets.get('MERCHANT_RECORD_SIGNING_SECRET')!);

      return Response.json({
        ok: true,
        shipment: sanitizeShipment(updated),
        allowed: allowedPartnerTransitions(to),
      });
    }

    // ---- Partner queues + status counts (Handoffs / VEP home) -------------
    if (action === "queue") {
      // Facility-scoped: only shipments tied to the partner's own locations
      // are returned — never other tenants' shipments.
      const [awaiting, ready, inTrans, outFor, recentDone, byStatus] = await Promise.all([
        sr.entities.Shipment.filter({ status: { $in: QUEUE_STATUSES.awaiting_dropoff }, ...facilityScope }, { sort: "-created_date", limit: 6 }),
        sr.entities.Shipment.filter({ status: { $in: QUEUE_STATUSES.ready_for_collection }, ...facilityScope }, { sort: "-created_date", limit: 6 }),
        sr.entities.Shipment.filter({ status: { $in: QUEUE_STATUSES.in_transit }, ...facilityScope }, { sort: "-created_date", limit: 6 }),
        sr.entities.Shipment.filter({ status: { $in: QUEUE_STATUSES.out_for_delivery }, ...facilityScope }, { sort: "-created_date", limit: 6 }),
        sr.entities.Shipment.filter({ status: { $in: QUEUE_STATUSES.recent_delivered }, ...facilityScope }, { sort: "-updated_date", limit: 10 }),
        sr.entities.Shipment.aggregate({ query: facilityScope, groupBy: "status" }),
      ]);
      return Response.json({
        awaiting_dropoff: (awaiting.items || []).map(sanitizeShipment),
        ready_for_collection: (ready.items || []).map(sanitizeShipment),
        in_transit: (inTrans.items || []).map(sanitizeShipment),
        out_for_delivery: (outFor.items || []).map(sanitizeShipment),
        recent_delivered: (recentDone.items || []).map(sanitizeShipment),
        status_counts: byStatus.rows || [],
      });
    }

    // ---- Chain-of-custody events for partner-actionable shipments --------
    if (action === "events") {
      const [queue, done] = await Promise.all([
        sr.entities.Shipment.filter({ status: { $in: ALL_ACTIONABLE }, ...facilityScope }, { sort: "-created_date", limit: 30 }),
        sr.entities.Shipment.filter({ status: { $in: QUEUE_STATUSES.recent_delivered }, ...facilityScope }, { sort: "-updated_date", limit: 15 }),
      ]);
      // The options form returns a page; the positional form returns a bare
      // array — normalize both before reading ids.
      const queueRows = Array.isArray(queue) ? queue : queue.items || [];
      const doneRows = Array.isArray(done) ? done : done.items || [];
      const ids = [...queueRows, ...doneRows].map((s) => s.id);
      if (ids.length === 0) return Response.json({ events: [] });
      const events = await sr.entities.ShipmentEvent.filter(
        { shipment_id: { $in: ids } },
        { sort: "-occurred_at", limit: 100 }
      );
      return Response.json({ events: events.items || [] });
    }

    return Response.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    const pending=claimResponse(error);if(pending)return pending;
    console.error("partnerCustody error:", (error as Error).message);
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}