# CARRIER integration handoff

Phase 2 changes are optional reads only. The external application remains independently deployed; this task has not changed it.

## Existing evidence

The repository contains a generic Base44 server adapter at integrations/base44-lex-api.entry.ts and a legacy Base44 publisher, not verified carrier production endpoint settings. Existing deployed URL, payload and subscriptions must be collected from the application owner. Do not guess them. Rork/mobile clients must call a trusted server adapter; signing secrets cannot be embedded in an app bundle.

## Optional adoption now

Recommended least-privilege role: carrier. Read assigned shipments; permitted operational transitions only. Acceptance/trips are deferred.

New reads: GET /api/v1/shipments and /api/v1/shipments/:id, accepting a UUID or SHP_ public ID. Same server JWT requirements as /v1; see api-contract.md. Request headers: Authorization: Bearer <server-signed JWT>; no body for GET. Response is {shipment, history} for a single shipment or {items,next_cursor} for a list. Existing /v1 read response remains available; do not replace parsing without changing the client deliberately. Capture the nested error correlation_id for support.

Existing mutation payloads stay unchanged: UUID command_id, expected_version where required, internal UUID shipment route ID and documented fields from API.md. A retry must reuse the complete logical command including its ID and original expected_version. A new decision after a version conflict gets a new command ID after refreshing state. Persist identifiers; never synthesize a shipment from an order or local record without reconciliation.

## Events

Existing outbound legacy types: ShipmentCreated, ShipmentMatched, ShipmentStatusChanged, ShipmentDelivered, WalletApprovalCreated. Subscribe only to necessary authorized data; current subscriptions do not enforce merchant tenancy and must never be used as an unfiltered browser/mobile feed. Canonical read aliases are in event-contract.md; /api/v1/events is admin/operator only. A canonical name is not yet a valid /v1/destinations event selector.

No new inbound events are accepted in this phase. /api/v1/webhooks/carrier is planned and must not receive production traffic. Event production/subscription requirements specific to this app remain unverified. Future adapters need signed real examples, confirmed user/entity mapping, source permission rules and retry behavior before activation.

## Independent migration checklist

Record existing URLs, exact body bytes/header names, authentication and acknowledgment semantics. Distinguish Base44 body-only sha256= from Node timestamped v1= signatures. Preserve existing delivery IDs and deduplication history. Test own/other-actor reads in staging, compare old/new shipment version and tracking values, then opt into new reads. Leave current writes and webhooks configured until the next phase passes source-specific contract tests. Roll back by using existing reads; no database or shared app deployment is required.

Canonical reads require DOMAIN_READ_API_ENABLED=true on the platform API. Initial deployment keeps this flag false; retain the existing /v1 reads until a separately approved rollout.
