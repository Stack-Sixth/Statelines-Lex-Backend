# MERCHANT integration handoff

The Merchant Domain API is an additive backend integration. The external Base44 application remains independently deployed and is not changed by this repository.

## Existing evidence

The repository contains a generic Base44 server adapter at integrations/base44-lex-api.entry.ts and a legacy Base44 publisher, not verified merchant production endpoint settings. Existing deployed URL, payload and subscriptions must be collected from the application owner. Do not guess them. Rork/mobile clients must call a trusted server adapter; signing secrets cannot be embedded in an app bundle.

## Optional adoption now

The new API uses the least-privilege `merchant` role. Merchant Shipment create/cancel are gated by `MERCHANT_DOMAIN_API_ENABLED`; canonical reads and cancellation preflight are gated separately by `DOMAIN_READ_API_ENABLED`. `/api/v1/capabilities` is available to any authenticated client. Exact schemas and responses are in `docs/api-contract.md`.

The new creation contract is `POST /api/v1/shipments`, not `/api/v1/orders`: Base44 retains Order ownership while Render creates the logistics Shipment and stores a unique `(merchant_id, order_id)` reference. Required values include UUID `command_id`, issuer-matching `merchant_id`, `order_id`, `correlation_id`, origin/destination corridors, service/package levels, positive `weight_kg`, and pickup/delivery deadlines. Render creates `shipment_id` and preserves its existing tracking ID. Do not pass unsupported commercial fields as if they were stored.

The API scopes `merchant_id` to the verified service-client issuer and scopes shipment reads/cancellation to the JWT subject that created the shipment. Merchant organization membership and shared team access are not implemented; use a stable trusted subject mapping and do not assume every user under one Base44 app client can see every other user's shipments. The body cannot set `owner_user_id`.

Merchant cancellation is a separate versioned command. It is permitted only before collection (`created` or `matched`); existing carrier capacity reservations are released in the transaction. Preflight is advisory. Use the exact same `command_id` and payload for a retry, and refresh state/use a new ID after a version conflict.

New reads: GET /api/v1/shipments and /api/v1/shipments/:id, accepting a UUID or SHP_ public ID. Same server JWT requirements as /v1; see api-contract.md. Request headers: Authorization: Bearer <server-signed JWT>; no body for GET. Response is {shipment, history} for a single shipment or {items,next_cursor} for a list. Existing /v1 read response remains available; do not replace parsing without changing the client deliberately. Capture the nested error correlation_id for support.

Existing mutation payloads stay unchanged: UUID command_id, expected_version where required, internal UUID shipment route ID and documented fields from API.md. A retry must reuse the complete logical command including its ID and original expected_version. A new decision after a version conflict gets a new command ID after refreshing state. Persist identifiers; never synthesize a shipment from an order or local record without reconciliation.

## Events

Existing outbound legacy types: ShipmentCreated, ShipmentMatched, ShipmentStatusChanged, ShipmentDelivered, WalletApprovalCreated. Subscribe only to necessary authorized data; current subscriptions do not enforce merchant tenancy and must never be used as an unfiltered browser/mobile feed. Canonical read aliases are in event-contract.md; /api/v1/events is admin/operator only. A canonical name is not yet a valid /v1/destinations event selector.

No new inbound events are accepted in this phase. /api/v1/webhooks/merchant is planned and must not receive production traffic. Event production/subscription requirements specific to this app remain unverified. Future adapters need signed real examples, confirmed user/entity mapping, source permission rules and retry behavior before activation.

## Independent migration checklist

Record existing URLs, exact body bytes/header names, authentication and acknowledgment semantics. Distinguish Base44 body-only sha256= from Node timestamped v1= signatures. Preserve existing delivery IDs and deduplication history. Test own/other-actor reads in staging, compare old/new shipment version and tracking values, then opt into new reads. Leave current writes and webhooks configured until the next phase passes source-specific contract tests. Roll back by using existing reads; no database or shared app deployment is required.

Configure Merchant's server-side adapter with `LEX_API_URL`, `LEX_SERVICE_CLIENT_ID`, and `LEX_SERVICE_CLIENT_SECRET`; values must match the deployed Render URL and the `statelines-merchant` entry in Render's `API_CLIENTS_JSON`. Keep secrets server-side. The service adapter must obtain its end-user subject/role from verified Base44 authentication; never accept a caller-selected role or subject.

Roll out in staging: deploy migration 003, enable `DOMAIN_READ_API_ENABLED` and test scoped reads, then enable `MERCHANT_DOMAIN_API_ENABLED` and test create, exact retries, duplicate Order references, cancellation/version conflicts, outbox events, and legacy `/v1` + webhook behavior. For production, enable each flag only after those checks pass. Disabling a flag and restarting the API removes the corresponding routes; it does not undo stored data.
