// Server-side custody rules shared by the partner custody gate.
// Defines the legal shipment status transitions (the lifecycle state
// machine) and the subset a partner may perform via scans/handoffs.
// The client never decides transitions — this map is the authority.

export const TRANSITIONS = {
  created: ["awaiting_payment", "awaiting_dropoff", "cancelled"],
  awaiting_payment: ["awaiting_dropoff", "cancelled"],
  awaiting_dropoff: ["received_at_origin", "exception"],
  received_at_origin: ["carrier_assigned", "in_transit", "exception"],
  carrier_assigned: ["picked_up", "in_transit", "exception"],
  picked_up: ["in_transit", "received_at_destination", "exception"],
  in_transit: ["received_at_destination", "delayed", "exception"],
  delayed: ["in_transit", "exception"],
  received_at_destination: ["ready_for_collection", "out_for_delivery", "exception"],
  ready_for_collection: ["out_for_delivery", "collected", "exception"],
  out_for_delivery: ["delivered", "exception"],
  delivered: [],
  collected: [],
  cancelled: [],
  exception: ["received_at_origin", "in_transit", "ready_for_collection", "out_for_delivery"],
};

// Statuses a partner may set through the custody gate. Senders keep their
// own flows (payment, cancellation); partners never cancel or pay here.
export const PARTNER_TARGETS = new Set([
  "received_at_origin", "carrier_assigned", "picked_up", "in_transit",
  "received_at_destination", "ready_for_collection", "out_for_delivery",
  "delivered", "collected",
]);

// The partner-legal next steps for a shipment's current status.
export function allowedPartnerTransitions(status) {
  const legal = TRANSITIONS[status] || [];
  return legal.filter((t) => PARTNER_TARGETS.has(t));
}

// Partner-facing projection of a shipment. Internal commercial fields
// (cost, declared value, insurance, domain/sync internals) never leave
// the server through the custody gate.
const SHIPMENT_PUBLIC_FIELDS = [
  "id", "created_date", "updated_date",
  "tracking_number", "tracking_id", "drop_off_code", "status",
  "current_location", "origin", "destination",
  "origin_city", "destination_city",
  "origin_address", "destination_address",
  "origin_location_name", "destination_location_name",
  "drop_off_deadline", "eta", "service_level",
  "intake_method", "delivery_method",
  "weight_lb", "package_size",
];

export function sanitizeShipment(shipment) {
  if (!shipment) return null;
  const out = {};
  for (const key of SHIPMENT_PUBLIC_FIELDS) {
    if (shipment[key] !== undefined) out[key] = shipment[key];
  }
  return out;
}