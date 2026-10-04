import { publicId } from './identifiers.js';

/** Explicit fields keep internal capacity/accounting details out of the new contract. */
export function shipmentProjection(s: Record<string, unknown>) {
  return {
    id: s.id,
    shipment_id: publicId('shipment', s.id as string),
    tracking_id: s.tracking_id,
    merchant_id: null,
    order_id: null,
    origin: { corridor: s.origin },
    destination: { corridor: s.destination },
    status: s.status,
    assigned_carrier_id: s.assigned_carrier_id
      ? publicId('carrier', s.assigned_carrier_id as string)
      : null,
    version: s.version,
    package: { weight_kg: s.weight_kg, size: s.package_size },
    service_level: s.service_level,
    pickup_deadline: s.pickup_deadline,
    delivery_deadline: s.delivery_deadline,
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}
export const eventNames: Record<string, string> = {
  ShipmentCreated: 'shipment.created',
  ShipmentMatched: 'shipment.assigned',
  ShipmentStatusChanged: 'shipment.status_changed',
  ShipmentDelivered: 'shipment.delivered',
  WalletApprovalCreated: 'billing.delivery_approval_created',
};
export function eventProjection(e: Record<string, unknown>) {
  const aggregate = e.aggregate as { type: string; id: string; version: number };
  return {
    event_id: publicId('event', e.event_id as string),
    legacy_event_id: e.event_id,
    event_type: eventNames[e.event_type as string],
    event_version: 1,
    occurred_at: e.occurred_at,
    source: 'statelines-domain-platform',
    correlation_id: e.correlation_id,
    causation_id: e.causation_id,
    entity: { type: 'shipment', id: publicId('shipment', aggregate.id) },
    entity_version: aggregate.version,
    data: e.payload,
  };
}
