# Event contract

## Current implementation

The authoritative event is persisted in lex.outbox in the same transaction as the shipment mutation. Existing outbound envelopes are unchanged. GET /api/v1/events projects those same stored events; it neither emits a second event nor changes subscriptions.

```json
{
  "event_id": "EVT_550e8400e29b41d4a716446655440000",
  "legacy_event_id": "550e8400-e29b-41d4-a716-446655440000",
  "event_type": "shipment.status_changed",
  "event_version": 1,
  "occurred_at": "2026-10-04T12:00:00.000Z",
  "source": "statelines-domain-platform",
  "correlation_id": "550e8400-e29b-41d4-a716-446655440001",
  "causation_id": "550e8400-e29b-41d4-a716-446655440002",
  "entity": { "type": "shipment", "id": "SHP_550e8400e29b41d4a716446655440001" },
  "entity_version": 8,
  "data": { "shipment_id": "550e8400-e29b-41d4-a716-446655440001", "status": "in_transit" }
}
```

Data retains the original event payload, including legacy UUID references. Example data is illustrative; consult src/shipments.ts for event-specific payloads. Correlation remains the shipment UUID, causation the command UUID. Source names the platform projection; it does not identify the initiating app. Wallet approval retains the shipment entity/version and does not increment shipment version. Consumers must deduplicate event IDs, not assume all events have unique entity versions. These IDs alias the same event and must not be counted twice.

| Stored legacy type    | Canonical read type               |
| --------------------- | --------------------------------- |
| ShipmentCreated       | shipment.created                  |
| ShipmentMatched       | shipment.assigned                 |
| ShipmentStatusChanged | shipment.status_changed           |
| ShipmentDelivered     | shipment.delivered                |
| WalletApprovalCreated | billing.delivery_approval_created |

All other proposed shipment, order, assignment, carrier, trip, PUDO, routing and incident event types are reserved/planned, not currently emitted or accepted. Unknown stored types are excluded from this versioned projection, not mislabeled. The event API is operator/admin only because payloads can include operational and accounting data.

## Next phase contract gate

Inbound gateway must require globally unique event ID, known source, event version, timestamp, correlation, entity ID/version and validated data. Persist receipts keyed by source/event ID and content fingerprint; duplicate same data acknowledges without side effects, collision rejects. Source-specific event handlers must translate to authorized idempotent commands, never arbitrary state updates. Out-of-order events must not overwrite newer versions. At-least-once transport requires idempotent consumers; no exactly-once network promise.
