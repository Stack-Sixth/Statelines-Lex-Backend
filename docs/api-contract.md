# Domain read API, version 1

Implemented additive endpoints:

| Method / path                         | Result                                       | Access                                 |
| ------------------------------------- | -------------------------------------------- | -------------------------------------- |
| GET /api/v1/shipments                 | items and next_cursor                        | Existing shipment role/ownership scope |
| GET /api/v1/shipments/:id             | shipment and history                         | Existing shipment role/ownership scope |
| GET /api/v1/events                    | items and next_cursor                        | Admin/operator only                    |
| GET /api/v1/events/:id                | Canonical event envelope                     | Admin/operator only                    |
| GET /api/v1/shipments/:id/cancellable | Cancellation preflight                       | Shipment owner / authorized operator   |
| POST /api/v1/shipments                | Create logistics Shipment for external Order | Merchant service client                |
| POST /api/v1/shipments/:id/cancel     | Versioned Merchant cancellation command      | Owning Merchant user                   |
| GET /api/v1/capabilities              | Non-sensitive API capability flags           | Any authenticated client               |

Use the same server-issued Authorization: Bearer JWT as /v1: HS256, configured issuer, audience statelines-lex, subject, configured role, iat/exp with lifetime at most five minutes. Secrets must stay in trusted server adapters, never Base44 browser or Rork mobile bundles. Authenticated platform role has no general shipment/event read access.

IDs accept internal UUID or typed public ID (SHP_ for shipment, EVT_ for event). Public IDs use uppercase prefix and 32 lowercase hex digits. Tracking numbers are retained in responses but are not route identifiers. GET collections accept limit 1..100 (default 50), after UUID or typed public ID. Follow next_cursor until null. Cursor order is UUID order, not creation order: collections are browsing APIs, not reliable change feeds; use durable webhooks/backfill for synchronization.

Shipment fields: id (UUID), shipment_id (SHP_), original tracking_id, merchant_id/order_id/external_shipment_id/correlation_id when a Merchant reference exists (otherwise null), origin/destination {corridor}, current status, assigned_carrier_id (CAR_ or null), version, package {weight_kg,size}, service_level, deadlines and timestamps. Weight preserves existing decimal representation. Internal capacity and owner identity fields are omitted. History preserves current scoped history format.

Errors on implemented /api/v1 routes: `{ "error": { "code": "NOT_FOUND", "message": "Shipment not found", "correlation_id": "request ID" } }`. Codes include VALIDATION_ERROR, INVALID_IDENTIFIER, authentication/authorization codes from existing service (uppercase), NOT_FOUND, RATE_LIMIT_EXCEEDED, INTERNAL_ERROR. Correlation is local request ID in this phase; cross-app propagation is not implemented. No raw stack traces.

Legacy /v1 routes, payloads, flat errors and mutation APIs remain unchanged; see API.md. Create/match/transition/approval still use legacy UUIDs and stable command_id. Do not submit a public command ID to a UUID-only legacy route. `/api/v1/orders` is deliberately not implemented: Merchant owns Order; this API creates and owns the associated canonical Shipment. New carrier/assignment/trip/PUDO and inbound webhook routes remain deferred.

## Merchant Shipment handoff

`POST /api/v1/shipments` is available only when `MERCHANT_DOMAIN_API_ENABLED=true`. It requires a Merchant JWT (`role=merchant`). The body `merchant_id` must exactly equal the verified JWT issuer (`iss` / configured API client ID); the request body cannot choose a different merchant scope. The JWT `sub` becomes `owner_user_id`, and existing shipment reads remain scoped to that authenticated user. Until organization membership is implemented, users sharing one Merchant service client do not automatically share one another's shipments.

```json
{
  "command_id": "<UUID generated once per logical create>",
  "merchant_id": "statelines-merchant",
  "order_id": "STL-ORD-123",
  "external_shipment_id": "<optional Merchant-local shipment ID>",
  "correlation_id": "<caller correlation ID>",
  "origin": { "corridor": "Lagos" },
  "destination": { "corridor": "Abuja" },
  "service_level": "standard",
  "package_size": "small",
  "weight_kg": 0.45,
  "pickup_deadline": "<ISO timestamp with offset>",
  "delivery_deadline": "<later ISO timestamp with offset>"
}
```

`weight_kg` is required, positive, and limited to three decimal places. Package size, service level and deadlines follow the existing Shipment contract. `intake_method`, `delivery_method`, `declared_value`, and `insurance` are not represented by the existing Shipment model and are not accepted in this phase. Merchant's `order_id` and optional `external_shipment_id` are references, not a Render Order aggregate. Render generates UUID `id`, canonical `shipment_id` (`SHP_…`) and legacy `tracking_id`; initial status/version are `created`/1. The response is `{command_id,correlation_id,shipment}` and contains those identifiers, references, package weight, status and version.

Retry the exact request with the same UUID `command_id`; existing command fingerprinting returns the original Shipment. Reusing that command ID with changed input returns 409. A second command attempting to link the same `(merchant_id, order_id)` is rejected by a database unique constraint. A new command ID is for a new logical operation.

`GET /api/v1/shipments/:shipment_id` accepts UUID or `SHP_…`; for Merchant-created shipments it returns `merchant_id`, `order_id`, optional `external_shipment_id`, and the current `version`. Older shipments without a Merchant reference keep null reference fields. `GET /api/v1/shipments/:shipment_id/cancellable` is advisory only; the cancellation command independently checks state and version.

`POST /api/v1/shipments/:shipment_id/cancel` accepts `{ "command_id": "<UUID>", "expected_version": 1, "correlation_id": "<caller ID>", "reason": "Customer requested cancellation" }`. Only the creating Merchant user can cancel its own Shipment while it is `created` or `matched`. Matched capacity reservations are released transactionally. Collected, in-transit, delivered, exception, and returned states are not Merchant-cancellable. The command locks the row and checks `expected_version`; preflight cannot authorize a stale write. Errors use domain codes `VERSION_CONFLICT`, `NOT_CANCELLABLE`, `ALREADY_CANCELLED`, `NOT_FOUND`, or `FORBIDDEN`. Replaying the same command ID and exact payload returns the prior success; a new command ID on an already-cancelled Shipment returns `ALREADY_CANCELLED`.

Creation and cancellation use the existing transaction, history/audit, `lex.commands`, and outbox. Physical legacy event types remain `ShipmentCreated` and `ShipmentStatusChanged`; canonical event reads project a cancelled status as `shipment.cancelled`. The supplied correlation ID is recorded in audit details and the outbox event. Existing `/v1` payloads, command IDs, and event envelopes remain unchanged.

`GET /api/v1/capabilities` is authenticated and returns only feature booleans; it exposes no secrets or environment configuration.

## Initial rollout feature gate

`DOMAIN_READ_API_ENABLED` and `MERCHANT_DOMAIN_API_ENABLED` default to `false` and accept only `true` or `false`. Enable reads separately from Merchant create/cancel. `/api/v1/capabilities` remains an authenticated, non-sensitive feature-discovery endpoint. These gates do not change existing `/v1` APIs or LEX outbox/worker behavior.

Enable canonical reads and Merchant mutations separately after staging validation. Roll either interface back by setting its flag to false and restarting the API. Migration 003 adds only external shipment references; it does not create an Order aggregate or switch data authority.
