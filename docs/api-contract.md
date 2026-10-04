# Domain read API, version 1

Implemented additive endpoints:

| Method / path             | Result                   | Access                                 |
| ------------------------- | ------------------------ | -------------------------------------- |
| GET /api/v1/shipments     | items and next_cursor    | Existing shipment role/ownership scope |
| GET /api/v1/shipments/:id | shipment and history     | Existing shipment role/ownership scope |
| GET /api/v1/events        | items and next_cursor    | Admin/operator only                    |
| GET /api/v1/events/:id    | Canonical event envelope | Admin/operator only                    |

Use the same server-issued Authorization: Bearer JWT as /v1: HS256, configured issuer, audience statelines-lex, subject, configured role, iat/exp with lifetime at most five minutes. Secrets must stay in trusted server adapters, never Base44 browser or Rork mobile bundles. Authenticated platform role has no general shipment/event read access.

IDs accept internal UUID or typed public ID (SHP_ for shipment, EVT_ for event). Public IDs use uppercase prefix and 32 lowercase hex digits. Tracking numbers are retained in responses but are not route identifiers. GET collections accept limit 1..100 (default 50), after UUID or typed public ID. Follow next_cursor until null. Cursor order is UUID order, not creation order: collections are browsing APIs, not reliable change feeds; use durable webhooks/backfill for synchronization.

Shipment fields: id (UUID), shipment_id (SHP_), original tracking_id, merchant_id/order_id null until verified links exist, origin/destination {corridor}, current status, assigned_carrier_id (CAR_ or null), version, package {weight_kg,size}, service_level, deadlines and timestamps. Weight preserves existing decimal representation. Internal capacity and owner identity fields are omitted. History preserves current scoped history format.

Errors on implemented /api/v1 routes: `{ "error": { "code": "NOT_FOUND", "message": "Shipment not found", "correlation_id": "request ID" } }`. Codes include VALIDATION_ERROR, INVALID_IDENTIFIER, authentication/authorization codes from existing service (uppercase), NOT_FOUND, RATE_LIMIT_EXCEEDED, INTERNAL_ERROR. Correlation is local request ID in this phase; cross-app propagation is not implemented. No raw stack traces.

Legacy /v1 routes, payloads, flat errors and mutation APIs remain unchanged; see API.md. Create/match/transition/approval still use legacy UUIDs and stable command_id. Do not submit a public command ID to a UUID-only legacy route. New /api/v1 mutation/order/carrier/assignment/trip/PUDO and inbound webhook routes are deferred; no empty CRUD placeholders are exposed.
