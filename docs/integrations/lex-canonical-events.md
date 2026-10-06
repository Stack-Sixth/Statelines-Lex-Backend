# Render → LEX canonical Shipment events

## Confirmed code gap

Merchant `POST /api/v1/shipments` already executes the existing Shipment service and writes exactly one physical `ShipmentCreated` event to `lex.outbox` inside the same command transaction as Shipment, Merchant references, history and audit. Its legacy payload contains internal shipment UUID, tracking ID, status and version. It lacks Merchant references and the logistics snapshot required by a projection. Previously the worker sent that legacy envelope to every subscribed destination. No canonical-format destination existed in the implementation. The reported absence of a production LEX destination is supplied by the operator; this change does not inspect or change production configuration.

## Additive implementation

Migration `004_canonical_webhook_delivery.sql` adds nullable `lex.outbox.canonical_envelope` and `lex.destinations.envelope_format` (default `legacy_v1`). It does not rewrite legacy envelopes, change Shipment rows, manufacture historical snapshots, register destinations or schedule replay.

For new Shipment lifecycle events, `emit` captures a whitelist of Shipment and Merchant-reference fields in the existing transaction and stores a canonical snapshot beside the legacy envelope in the same outbox row. The legacy JSON and physical event UUID/type are unchanged. A snapshot/storage failure rolls back the entire command. Delivery starts only after commit through the existing worker; no external HTTP call is made by the command.

A destination can opt into `canonical_v1` using the existing admin-only `/v1/destinations` API. This destination format is the delivery feature gate. Canonical destinations default to inactive; existing destinations default to legacy format and retain their existing active status. API fields `envelope_format` and `active` are optional and have no parsing defaults, preserving the fingerprint of old destination-create command retries. There is no API for changing a destination's format in place: create a separate destination so outstanding legacy deliveries retain their contract.

`DOMAIN_READ_API_ENABLED` and `MERCHANT_DOMAIN_API_ENABLED` retain their current semantics. This delivery feature does not require canonical reads to be enabled. JWT authentication, `/api/v1/capabilities`, legacy `/v1` behavior and existing HTTP signing are unchanged.

## Wire schema (canonical_v1)

```json
{
  "event_id": "EVT_550e8400e29b41d4a716446655440000",
  "event_type": "shipment.created",
  "event_version": 1,
  "occurred_at": "2026-10-06T12:00:00.000Z",
  "source": "statelines-domain-platform",
  "correlation_id": "corr-example",
  "command_id": "550e8400-e29b-41d4-a716-446655440002",
  "shipment": {
    "shipment_id": "SHP_550e8400e29b41d4a716446655440001",
    "tracking_id": "LEX-550E8400-E29B-41D4-A716-446655440001",
    "merchant_id": "statelines-merchant",
    "order_id": "STL-ORDER-EXAMPLE",
    "external_shipment_id": "merchant-local-example",
    "status": "created",
    "version": 1,
    "origin": { "corridor": "lagos" },
    "destination": { "corridor": "abuja" },
    "service_level": "standard",
    "package_size": "small",
    "weight_kg": 0.45,
    "pickup_deadline": "2026-10-07T10:00:00.000Z",
    "delivery_deadline": "2026-10-07T18:00:00.000Z"
  }
}
```

IDs are deterministic aliases of the existing full UUIDs: the same event uses the same `EVT_` ID in canonical event reads and webhook delivery. The internal outbox and delivery foreign keys remain UUIDs. Legacy receivers continue receiving their original UUID event ID. `weight_kg` is a number, deadlines/occurrence are ISO timestamps, and origin/destination contain normalized corridors. Merchant/order/external IDs are null when absent (including legacy-originated Shipments). External shipment ID is otherwise preserved. Correlation is preserved from the original event, matching canonical event reads: creation uses the Merchant command correlation, Merchant cancellation uses its cancellation correlation, and existing legacy match/transition commands use the Shipment UUID.

Only explicitly listed fields are published. Credentials, JWTs, webhook keys, owner identities, audit notes and capacity/accounting internals are excluded. This is a trusted operational LEX projection feed, not a per-merchant feed: an admin must authorize the receiver to see all subscribed Shipments.

| Destination selector (physical type) | Canonical wire event                                                        |
| ------------------------------------ | --------------------------------------------------------------------------- |
| `ShipmentCreated`                    | `shipment.created`                                                          |
| `ShipmentStatusChanged`              | `shipment.status_changed`, or `shipment.cancelled` when status is cancelled |
| `ShipmentMatched`                    | `shipment.assigned`                                                         |
| `ShipmentDelivered`                  | `shipment.delivered`                                                        |

Cancellation emits one physical event and one canonical representation, not an extra logical event. `WalletApprovalCreated` remains available to legacy destinations and canonical event reads (`billing.delivery_approval_created`), but is rejected for this Shipment-only destination format. Existing `/api/v1/events` response shape remains unchanged; the webhook has its own complete `shipment` snapshot.

## Render configuration (prepare, do not activate yet)

Use [the inactive destination template](../../integrations/lex-canonical-destination.example.json). Replace only the placeholder URL and command UUID before sending it to `POST /v1/destinations` with a valid existing admin service JWT. There is no hard-coded Base44 production URL. The URL is stored in the destination row, following the existing convention; no new URL environment variable is read by this code. No production destination has been registered by this implementation.

Existing environment variables required on the API and delivery worker:

- `WEBHOOK_ALLOWED_HOSTS`: append the verified LEX receiver's exact hostname, preserving all existing entries.
- `WEBHOOK_SECRETS_JSON`: add a `lex_canonical` entry with a dedicated webhook signing secret. Preserve every existing entry. Configure the same webhook secret on the eventual receiver. Never use any service JWT secret for it; canonical destination registration rejects known JWT secret reuse.
- `API_CLIENTS_JSON`: preserve all clients and add a dedicated `lex-canonical-projection` client with `roles: ["platform"]` and its own independent service secret if no appropriate dedicated platform client exists. The secret is for authenticated processing receipts, not webhook HMAC. Parsing/signing semantics are unchanged. Destination registration itself requires an existing admin client.
- `DATABASE_URL`, `DATABASE_SSL`, optional `DATABASE_CA_CERT`: retain the existing production database/TLS settings. The API and delivery worker must use the same database.
- `WORKER_POLL_MS`, `WORKER_BATCH_SIZE`, `DELIVERY_MAX_ATTEMPTS`: existing worker settings, unchanged. No new polling of LEX or Merchant is introduced; the existing outbox worker continues its normal database dispatch loop.
- `DOMAIN_READ_API_ENABLED`, `MERCHANT_DOMAIN_API_ENABLED`: retain approved values; this task does not change them.

Before eventual activation: apply the additive migration through `npm run migrate:prod`, run the upgraded API **and** delivery worker, configure the receiver and signing keys, and verify its durable receipt/acknowledgment contract in staging. An old worker ignores destination format, so never activate the canonical destination while an old worker can process it. Keep `active: false` until the receiver is verified. Later, an explicitly approved admin call to `/v1/destinations/:id/status` with a new `command_id` and `active: true` enables future dispatch. This document does not execute those actions.

## Signing, acknowledgments and delivery

The unchanged sender uses HTTPS with exact hostname allowlisting, public IPv4 DNS checks/socket pinning, TLS verification and an eight-second timeout. Headers:

- `X-LEX-Timestamp`: Unix seconds.
- `X-LEX-Signature`: `v1=` plus HMAC-SHA256 over `timestamp + '.' + exact_raw_JSON_body`, using the dedicated webhook key.
- `X-LEX-Delivery-Id`: existing delivery UUID (stable across attempts).
- `Content-Type: application/json`.

The existing `integrations/receiver-example.mjs` / `src/inbox.ts` example validates the legacy UUID envelope only. It is unchanged and is not the new LEX canonical receiver; do not point this destination at it without a separately implemented canonical receiver.

Verify the exact raw bytes and five-minute clock tolerance before parsing or projecting. Do not substitute Base44's separate body-only `sha256=` protocol. No JWT is sent with this outbound webhook. `source` is part of the signed envelope.

Only acknowledge durable work: return a 2xx JSON body `{ "event_id": "<the exact EVT_ ID received>", "status": "accepted" }` after durable receipt, or `processed` after durable projection. The sender validates event identity and status. `accepted` is not proof that LEX has finished projection. The existing owning-platform processing receipt endpoint is available for asynchronous completion.

The same stored snapshot, event ID and delivery ID are reused for retries, even if the live Shipment has since changed. Only timestamp/signature are refreshed per HTTP attempt. `(event_id,destination_id)` uniqueness prevents duplicate delivery records; command idempotency prevents duplicate Shipments/events. At-least-once transport means LEX must deduplicate by source/event ID, detect conflicting contents, and use Shipment version to prevent out-of-order events overwriting a newer projection.

Network errors, timeouts, HTTP 408/429/5xx and malformed acknowledgments retry with the existing exponential backoff/jitter and attempt ceiling. Permanent errors or exhausted retries become `dead_letter`. Every attempt is recorded; successful acknowledgments record `accepted`/`processed` and timestamps. Admin replay reuses the same event/delivery and increments replay history. No domain event is emitted because a send fails. Destination disablement and lease recovery retain existing behavior.

## Historical records and the protected production Shipment

Do not mutate, recreate or automatically replay `SHP_a11e72b5d4b74bf9831fb588c6612c12`. This implementation does none of those actions. Its pre-upgrade event has no immutable full snapshot. The worker and canonical backfill skip events with a null canonical envelope, rather than loading today's Shipment state and falsely labelling it as the original creation event.

The existing legacy backfill contract remains available for legacy destinations. Canonical backfill can only select retained events that already have a canonical snapshot; registering/activating a destination does not automatically backfill anything. Events dispatched while the destination is inactive also require a separately authorized backfill if later needed. A controlled plan for the supplied production Shipment must be agreed after the LEX receiver is implemented and verified; this change does not attempt historical reconstruction.

## Verification

The full suite covers Merchant snapshot fields, transactional rollback, stable retry snapshots/IDs after cancellation, legacy and canonical destinations side by side, outcomes/attempt history, dead-letter/replay, lifecycle versions/references, and exclusion of pre-upgrade events. Existing Merchant create/read/cancel, auth, LEX compatibility, concurrency and signature tests remain enabled. PostgreSQL CI stages a 001–002 installation, records an existing Shipment/event/destination, runs the production runner through 003–004, verifies preservation and no replay, reruns migrations, then executes the full database suite.
