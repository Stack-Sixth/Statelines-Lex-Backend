# Webhook contract

For the additive canonical Shipment delivery implemented after the foundation phase, see [Render → LEX canonical events](integrations/lex-canonical-events.md). The foundation-phase notes below describe the original legacy behavior.

Phase 2 does not change outbound delivery or introduce inbound endpoints. `/api/v1/webhooks/{noc,lex,merchant,carrier,pudo}` are planned, not operational. Do not point existing webhooks at them.

## Existing Node outbound contract

Register exact legacy event names via POST /v1/destinations with admin JWT, command_id, name, client_id, HTTPS url, secret_ref and event_types. Secrets are resolved from WEBHOOK_SECRETS_JSON; never stored in destination rows. WEBHOOK_ALLOWED_HOSTS is an exact hostname allowlist. A destination client must have platform role.

Headers: Content-Type application/json; X-LEX-Timestamp seconds; X-LEX-Signature `v1=` plus lowercase hex HMAC-SHA256(secret, timestamp + '.' + exact JSON body); X-LEX-Delivery-Id UUID. Receiver verifies before parsing/processing and applies a five-minute timestamp tolerance. Response: `{ "event_id": "original UUID", "status": "accepted" }` only after durable receipt, or `processed` after durable business processing. Accepted is not proof of processing. Use /v1/deliveries/:id/processed with owning platform JWT and stable command_id for asynchronous completion.

Every delivery has a durable record, bounded attempts, token lease and retained attempt history. Network failures, timeout, 408/429/5xx and invalid acknowledgments retry; permanent client failures dead-letter. Backoff currently grows exponentially from about two seconds with jitter to one hour; max attempts/poll/batch are configured. Retry timing is not newly configurable in this phase. Admin replay preserves event_id; receiver must keep deduplication state. Disabled destinations pause. Backfill selects retained event ranges.

## Retained Base44 outbound protocol

base44/shared/lexBridge.ts signs BODY ONLY with `sha256=` and supplies X-LEX-Event / X-LEX-Correlation-Id; signature may be absent if no configured key. Any 2xx is success. This is not the Node v1 protocol. No existing sender or verifier is replaced here. Gateway compatibility requires real deployed payload samples, source identity verification and an explicit legacy policy; do not silently disable timestamp checks in a new protocol.

## Planned gateway

Use independent per-source secrets (names to be finalized in Phase 3), X-Statelines-Source/Timestamp/Signature/Event-Id, exact-byte HMAC and bounded timestamps. Validate source route/header agreement and event schema; persist receipts before acknowledging. Route only explicitly permitted events through domain services. Include bounded retries/dead-letter and authorized replay. New signing headers are design targets only; no new secrets are required now.

## Initial rollout feature gate

`DOMAIN_READ_API_ENABLED` defaults to `false` and accepts only `true` or `false`. Keep it unset or false in the initial deployment. The new `/api/v1/shipments` and `/api/v1/events` read routes are registered only when explicitly true; authenticated requests otherwise receive 404. This gate does not change existing `/v1` APIs, command execution, signing, subscriptions, or LEX outbox/worker behavior. New event routing is not implemented or enabled by this foundation.

Enable canonical reads only after staging validation and explicit rollout approval; this merge/deployment leaves them disabled. Roll back the read interface by setting false and restarting the API. Migration 002 only adds namespaces/views and does not switch data authority or webhook transport.
