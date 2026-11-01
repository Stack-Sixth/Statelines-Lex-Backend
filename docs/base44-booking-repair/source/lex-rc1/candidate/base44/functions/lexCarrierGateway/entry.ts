// LEX Carrier Gateway — the secure external entry point for the Community Carrier
// mobile app (built on Rork). The mobile app holds ONLY a per-carrier API key
// (issued by an admin via the `issueApiKey` action). LEX_API_CLIENT_SECRET,
// LEX_WEBHOOK_SECRET and all other privileged credentials stay on this backend.
//
// Auth model:
//   - Carrier actions: `Authorization: Bearer <carrier_api_key>`. The key is
//     SHA-256-hashed and matched to one CommunityCarrier.api_key_hash → carrier_id.
//     No client ever supplies or trusts a carrier_id in the body.
//   - Key management (issueApiKey / revokeApiKey): Base44 admin session
//     (base44.auth.me() role admin), NOT the carrier key.
//
// Scope: every read/mutation asserts the target shipment's assigned_carrier_id
// equals the resolved carrier_id (403 otherwise). Mutations route through
// transitionShipment() (CAS on status + optional expected_version, command_id
// idempotency, capacity effects, audit + lifecycle + custody + outbox).
//
// Engine fields: engine_shipment_id / engine_version live on CrossAppPackage (by
// tracking_id), NOT on Shipment — reads join the two.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.52";
import { transitionShipment, CUSTODY_TO_STATUS, STAGE_TO_STATUS } from "../../shared/lexTransitions.ts";
import {resolveTrustedIsolation, isolationDenied, operationalLocal} from "../../shared/lexTrustedIsolation.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Base44 entity ids are 24-char hex (NOT UUIDs). UUID is reserved for command_id and engine ids.
const BASE44_ID_RE = /^[a-f0-9]{16,}$/i;
const CARRIER_CUSTODY = ["picked_up", "in_transit", "transfer", "out_for_delivery", "delivered", "deposited_at_node", "bundled"];
const EVIDENCE_EVENTS = ["picked_up", "delivered", "deposited_at_node"];

function asArray(r) {
  return Array.isArray(r) ? r : (r && r.items ? r.items : []);
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function err(status, error, code?:any, extra?:any) {
  const body:any = { error };
  if (code) body.code = code;
  if (extra) Object.assign(body, extra);
  return Response.json(body, { status });
}

async function findShipment(base44, body) {
  const classification = await resolveTrustedIsolation(base44,body);
  const denied = isolationDenied(classification);
  if (denied) throw {isolationResponse:denied};
  return await operationalLocal(base44,classification);
}

async function onePkg(base44, tracking_id) {
  if (!tracking_id) return null;
  const found = asArray(await base44.asServiceRole.entities.CrossAppPackage.filter({ tracking_id }));
  return found[0] || null;
}

function serializeShip(s, p) {
  return {
    shipment_id: s.id,
    tracking_id: s.tracking_id,
    engine_shipment_id: (p && p.engine_shipment_id) || null,
    engine_version: p ? p.engine_version : null,
    version: s.version ?? 1,
    status: s.status,
    origin: s.origin,
    destination: s.destination,
    origin_lat: s.origin_lat,
    origin_lng: s.origin_lng,
    destination_lat: s.destination_lat,
    destination_lng: s.destination_lng,
    package_size: s.package_size,
    weight_kg: s.weight_kg,
    service_level: s.service_level,
    pickup_deadline: s.pickup_deadline,
    delivery_deadline: s.delivery_deadline,
    merchant_name: s.merchant_name,
  };
}

export default async function (req) {
  try {
    if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
    const body = await req.json().catch(() => ({}));
    const action = body.action;
    if (!action) return err(400, "action required");

    const base44 = createClientFromRequest(req);

    // ---- Admin-only key management (Base44 admin session) ----
    if (action === "issueApiKey" || action === "revokeApiKey") {
      const user = await base44.auth.me();
      if (!user) return err(401, "admin auth required");
      if (user.role !== "admin") return err(403, "admin only");
      if (!body.carrier_id || !BASE44_ID_RE.test(body.carrier_id)) return err(400, "carrier_id required");
      const carrier = await base44.asServiceRole.entities.CommunityCarrier.get(body.carrier_id).catch(() => null);
      if (!carrier) return err(404, "carrier not found");
      if (action === "revokeApiKey") {
        await base44.asServiceRole.entities.CommunityCarrier.update(body.carrier_id, { api_key_hash: null });
        return Response.json({ carrier_id: body.carrier_id, revoked: true });
      }
      const raw = "lexc_" + crypto.randomUUID().replace(/-/g, "") + Math.random().toString(36).slice(2, 10);
      const keyHash = await sha256Hex(raw);
      await base44.asServiceRole.entities.CommunityCarrier.update(body.carrier_id, { api_key_hash: keyHash });
      return Response.json({ carrier_id: body.carrier_id, carrier_name: carrier.name, api_key: raw });
    }

    // ---- Carrier actions (api_key auth) ----
    const auth = req.headers.get("Authorization") || "";
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (!m) return err(401, "missing bearer api key");
    const apiKey = m[1].trim();
    if (!apiKey) return err(401, "missing bearer api key");
    const keyHash = await sha256Hex(apiKey);
    const carriers = asArray(await base44.asServiceRole.entities.CommunityCarrier.filter({ api_key_hash: keyHash }));
    const carrier = carriers.length===1?carriers[0]:null;
    if (!carrier) return err(401, "invalid api key");
    if (carrier.status === "offline") return err(403, "carrier offline");
    const carrierId = carrier.id;

    if (action === "listMyShipments") {
      const q:any = { assigned_carrier_id: carrierId };
      if (body.status) {
        const statuses = String(body.status).split(",").map((s) => s.trim()).filter(Boolean);
        if (statuses.length === 1) q.status = statuses[0];
        else if (statuses.length > 1) q.status = { $in: statuses };
      }
      const page = await base44.asServiceRole.entities.Shipment.filter(q, {
        sort: "-last_transition_at",
        limit: Math.min(Number(body.limit) || 100, 200),
      });
      const ships = asArray(page);
      const tids = ships.map((s) => s.tracking_id).filter(Boolean);
      const pkgByTid = {};
      if (tids.length) {
        const pkgs = asArray(await base44.asServiceRole.entities.CrossAppPackage.filter({ tracking_id: { $in: tids } }));
        for (const p of pkgs) if (p.tracking_id) pkgByTid[p.tracking_id] = p;
      }
      const shipments = [];
      for (const s of ships) {
        const classification = await resolveTrustedIsolation(base44,{shipment_id:s.id,tracking_id:s.tracking_id});
        if (classification.kind === "ordinary") shipments.push(serializeShip(s,pkgByTid[s.tracking_id]));
      }
      return Response.json({ carrier_id: carrierId, carrier_name: carrier.name, shipments });
    }

    if (action === "getShipment") {
      const ship = await findShipment(base44, body);
      if (!ship) return err(404, "shipment not found");
      if (ship.assigned_carrier_id !== carrierId) return err(403, "not your shipment");
      return Response.json({ shipment: serializeShip(ship, await onePkg(base44, ship.tracking_id)) });
    }

    if (action === "getTimeline") {
      const ship = await findShipment(base44, body);
      if (!ship) return err(404, "shipment not found");
      if (ship.assigned_carrier_id !== carrierId) return err(403, "not your shipment");
      const events = asArray(
        await base44.asServiceRole.entities.ShipmentLifecycleEvent.filter({ shipment_id: ship.id })
      );
      events.sort((a, b) => new Date(a.timestamp || a.created_date).getTime() - new Date(b.timestamp || b.created_date).getTime());
      return Response.json({
        stages: Object.keys(STAGE_TO_STATUS),
        events,
        shipment: serializeShip(ship, await onePkg(base44, ship.tracking_id)),
      });
    }

    if (action === "updateStatus" || action === "acceptAssignment" || action === "declineAssignment") {
      const cmd = body.command_id;
      if (!cmd || !UUID_RE.test(String(cmd))) return err(400, "command_id must be a UUID");
      const ship = await findShipment(base44, body);
      if (!ship) return err(404, "shipment not found");
      if (ship.assigned_carrier_id !== carrierId) return err(403, "not your shipment");

      let toStatus, custody, note;
      if (action === "declineAssignment") {
        if (ship.status !== "matched") return err(409, "can only decline an assignment in matched status");
        toStatus = "cancelled";
        custody = null;
        note = "Carrier declined assignment: " + (body.reason || "unspecified");
      } else {
        const eventType = action === "acceptAssignment" ? "picked_up" : body.event_type;
        if (!eventType) return err(400, "event_type required");
        if (!CARRIER_CUSTODY.includes(eventType)) return err(400, "event_type not permitted for carriers: " + eventType);
        toStatus = CUSTODY_TO_STATUS[eventType];
        if (!toStatus) return err(400, "unsupported event_type: " + eventType);
        if (EVIDENCE_EVENTS.includes(eventType)) {
          if (!body.location || !body.signature) return err(400, "missing_evidence: location and signature required for " + eventType);
        }
        custody = {
          event_type: eventType,
          location: body.location || null,
          lat: body.lat,
          lng: body.lng,
          signature: body.signature || null,
          notes: body.notes || null,
          actor_name: carrier.name,
        };
        note = body.notes || body.location || eventType;
      }

      const res = await transitionShipment(base44, {
        shipment_id: ship.id,
        tracking_id: ship.tracking_id,
        command_id: String(cmd),
        to_status: toStatus,
        expected_version: body.expected_version != null && body.expected_version !== "" ? Number(body.expected_version) : undefined,
        custody,
        trigger_source: "carrier",
        responsible_entity: carrier.name,
        actor: { id: "carrier:" + carrierId, role: "admin", full_name: carrier.name, email: null },
        note,
      });
      if (!res.ok) {
        return Response.json(
          { error: res.error, code: res.code, current_version: res.current_version, current_status: res.current_status },
          { status: res.code || 500 }
        );
      }
      const p = await onePkg(base44, ship.tracking_id);
      return Response.json({
        shipment_id: res.shipment_id,
        tracking_id: ship.tracking_id,
        status: res.status,
        version: res.version,
        engine_shipment_id: (p && p.engine_shipment_id) || null,
        engine_version: p ? p.engine_version : null,
        lifecycle_event_id: res.lifecycle_event_id,
        custody_event_id: res.custody_event_id,
        idempotent: !!res.idempotent,
      });
    }

    return err(400, "unknown action: " + action);
  } catch (error) {
    if (error?.isolationResponse instanceof Response) return error.isolationResponse;
    return Response.json({ error: error.message }, { status: 500 });
  }
}

