import {createTrustedShipmentEvent} from './trustedShipmentEvent.ts';
import {resolveOperationalShipment} from './shipmentAuthority.ts';
import { secrets } from 'base44:runtime';

// Shared contract for cross-platform sync between Statelines, the Community
// Carriers platform, and the National Ops Center. Both receiver endpoints
// (carrierSyncReceiver, opsSyncReceiver) delegate here so the contract is
// identical regardless of which partner platform is calling.
//
// Payload shape (JSON body):
//   {
//     "event": "shipment_status_update" | "carrier_assigned" | "custody_event" | "network_alert",
//     "shipment_id": "…",            // optional, one of shipment_id / tracking_number
//     "tracking_number": "STL-…",    // optional
//     "token": "shared secret",      // alternative to ?token= query param
//     "data": { … }                  // event-specific fields
//   }

const SHIPMENT_STATUSES = ['created', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'cancelled'];

// Returns a Response when the request is unauthenticated or malformed, else null.
export function verifySyncRequest(req, payload) {
  if (req.method !== 'POST') {
    return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
  }
  const url = new URL(req.url);
  const token = url.searchParams.get('token') || payload.token;
  const secret = secrets.get('PLATFORM_SYNC_SECRET');
  if (!secret || token !== secret) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

// Apply one sync event; `source` is the calling platform's display label.
export async function applySyncEvent(base44, payload, source) {
  const event = String(payload.event || '');
  const data = payload.data || {};
  const sr = base44.asServiceRole;

  if (event === 'shipment_status_update') {
    const shipment = await resolveShipment(sr, payload);
    if (!shipment) return Response.json({ error: 'Shipment not found' }, { status: 404 });
    const status = String(data.status || '');
    if (!SHIPMENT_STATUSES.includes(status)) {
      return Response.json({ error: `Invalid status: ${status}` }, { status: 400 });
    }
    // A retried/duplicated event must not create a second transition or
    // timeline entry: the shipment is already in this state.
    if (shipment.status === status) {
      return Response.json({ ok: true, duplicate: true, shipment_id: shipment.id, status });
    }
    await sr.entities.Shipment.update(shipment.id, { status });
    await createTrustedShipmentEvent(sr,shipment,'platform_sync',{
      shipment_id: shipment.id,
      event: `Status set to ${status} by ${source}`,
      location: String(data.location || ''),
      custodian: source,
      verification_method: 'platform sync',
      occurred_at: new Date().toISOString(),
    });
    await sr.entities.Notification.create({
      merchant_id: shipment.merchant_id || '',
      title: 'Shipment status updated',
      body: `Tracking ${shipment.tracking_number || shipment.id} is now ${status.replace(/_/g, ' ')} (reported by ${source}).`,
      type: 'shipment',
    });
    return Response.json({ ok: true, shipment_id: shipment.id, status });
  }

  if (event === 'carrier_assigned') {
    const shipment = await resolveShipment(sr, payload);
    if (!shipment) return Response.json({ error: 'Shipment not found' }, { status: 404 });
    const carrierId = String(data.carrier_id || '');
    if (!carrierId) return Response.json({ error: 'data.carrier_id required' }, { status: 400 });
    if (shipment.carrier_id === carrierId) {
      return Response.json({ ok: true, duplicate: true, shipment_id: shipment.id, carrier_id: carrierId });
    }
    await sr.entities.Shipment.update(shipment.id, { carrier_id: carrierId });
    await createTrustedShipmentEvent(sr,shipment,'platform_sync',{
      shipment_id: shipment.id,
      event: `Assigned to Community Carrier ${carrierId} by ${source}`,
      location: String(data.location || ''),
      custodian: source,
      verification_method: 'platform sync',
      occurred_at: new Date().toISOString(),
    });
    await sr.entities.Notification.create({
      merchant_id: shipment.merchant_id || '',
      title: 'Carrier assigned',
      body: `Tracking ${shipment.tracking_number || shipment.id} was assigned to carrier ${carrierId}.`,
      type: 'shipment',
    });
    return Response.json({ ok: true, shipment_id: shipment.id, carrier_id: carrierId });
  }

  if (event === 'custody_event') {
    const shipment = await resolveShipment(sr, payload);
    if (!shipment) return Response.json({ error: 'Shipment not found' }, { status: 404 });
    const label = String(data.event || '');
    if (!label) return Response.json({ error: 'data.event required' }, { status: 400 });
    const occurredAt = String(data.occurred_at || '');
    if (occurredAt) {
      // Same custody event replayed by a retrying partner: record it once.
      const recent = await sr.entities.ShipmentEvent.filter({ shipment_id: shipment.id }, '-occurred_at', 20).catch(() => []);
      const seen = recent.some((row) => row.event === label && String(row.occurred_at || '') === occurredAt);
      if (seen) return Response.json({ ok: true, duplicate: true, shipment_id: shipment.id });
    }
    await createTrustedShipmentEvent(sr,shipment,'platform_sync',{
      shipment_id: shipment.id,
      event: label,
      location: String(data.location || ''),
      custodian: String(data.custodian || source),
      verification_method: String(data.verification_method || 'platform sync'),
      occurred_at: data.occurred_at || new Date().toISOString(),
    });
    return Response.json({ ok: true, shipment_id: shipment.id });
  }

  if (event === 'network_alert') {
    const title = String(data.title || '');
    if (!title) return Response.json({ error: 'data.title required' }, { status: 400 });
    await sr.entities.Notification.create({ title, body: String(data.body || ''), type: 'system' });
    return Response.json({ ok: true });
  }

  return Response.json({ error: `Unknown event: ${event}` }, { status: 400 });
}

async function resolveShipment(sr, payload) {
  const resolved = await resolveOperationalShipment(sr, payload, 'platform_sync');
  if (!resolved.ok) throw new Error(`Shipment operation held: ${resolved.code}`);
  return resolved.shipment;
}
