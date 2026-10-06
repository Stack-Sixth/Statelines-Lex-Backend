import { eventProjection } from './projections.js';
import { publicId } from './identifiers.js';

export const canonicalShipmentTypes = [
  'ShipmentCreated',
  'ShipmentMatched',
  'ShipmentStatusChanged',
  'ShipmentDelivered',
];

/** A whitelisted event-time snapshot, persisted once alongside the legacy envelope. */
export function canonicalShipmentEvent(
  envelope: Record<string, unknown>,
  s: Record<string, unknown>,
) {
  const event = eventProjection(envelope);
  return {
    event_id: event.event_id,
    event_type: event.event_type,
    event_version: 1,
    occurred_at: event.occurred_at,
    source: event.source,
    correlation_id: event.correlation_id,
    command_id: envelope.causation_id,
    shipment: {
      shipment_id: publicId('shipment', s.id as string),
      tracking_id: s.tracking_id,
      merchant_id: s.merchant_id ?? null,
      order_id: s.order_id ?? null,
      external_shipment_id: s.external_shipment_id ?? null,
      status: s.status,
      version: s.version,
      origin: { corridor: s.origin },
      destination: { corridor: s.destination },
      service_level: s.service_level,
      package_size: s.package_size,
      weight_kg: Number(s.weight_kg),
      pickup_deadline: s.pickup_deadline,
      delivery_deadline: s.delivery_deadline,
    },
  };
}
