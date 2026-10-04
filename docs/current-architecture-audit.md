# Current architecture audit

Baseline: origin/main `2c2023a13a03c802eb1db3fb008d2397264b6f55`, inspected 2026-10-04 before implementation. This is a repository audit, not verification of live Render, database data, or independently deployed applications.

## Runtime and structure

The active backend is Node 24, TypeScript, Fastify 5, Zod, jose and node-postgres. No ORM. `src/server.ts` starts HTTP; `src/worker-main.ts` runs deliveries. `src/app.ts` defines routes; `shipments.ts` owns shipment mutations, capacity and approvals; `domain.ts` owns state rules, commands, audit and outbox. `db.ts` provides parameterized SQL and transactions. `scripts/migrate.ts` checks migration checksums under an advisory lock. `render.yaml` defines separate API and worker services, with automatic deployments off.

`base44/` contains retained Deno functions/entities/workflows, not the Node runtime. Root AGENTS/Vite configuration describes that older application; package.json and Render commands identify the executable backend. `integrations/base44-lex-api.entry.ts` is an example server-side Base44 adapter, not an installed external integration. `integrations/receiver-example.mjs` and receiver-schema.sql demonstrate an independent receiver.

## APIs

Existing public probes: GET `/health/live`, `/health/ready`.
All other routes require short-lived JWTs:

| Routes under /v1                    | Methods   | Authorization                                     |
| ----------------------------------- | --------- | ------------------------------------------------- |
| /shipments                          | GET, POST | Role-scoped reads; merchant/operator/admin create |
| /shipments/:id                      | GET       | Owner merchant, assigned carrier, operator/admin  |
| /shipments/:id/match                | POST      | Operator/admin                                    |
| /shipments/:id/transitions          | POST      | State- and ownership-dependent                    |
| /shipments/:id/wallet-approval      | POST      | Admin                                             |
| /carriers                           | GET, POST | Operator/admin                                    |
| /carriers/:id/schedule              | POST      | Operator/admin                                    |
| /destinations                       | GET, POST | Admin                                             |
| /destinations/:id/status, /backfill | POST      | Admin                                             |
| /deliveries                         | GET       | Operator/admin                                    |
| /deliveries/:id/replay              | POST      | Admin                                             |
| /deliveries/:id/processed           | POST      | Platform client owning destination                |
| /operations/health                  | GET       | Operator/admin                                    |

No inbound webhook route exists in the active HTTP app. No domain Order, Assignment, Trip or PUDO resource endpoint exists. Assignment is currently a shipment-to-carrier reference with reserved capacity, not an independently versioned entity.

## Storage and ownership

Migration `001_core.sql` creates schema lex: commands, carriers, shipments, shipment_history, outbox, destinations, deliveries, delivery_attempts, wallet_approvals, audit_log and worker_heartbeats. The migration runner separately maintains schema_migrations. UUID primary keys, foreign keys and constraints enforce basic integrity. All core tables have RLS enabled and grants revoked from PUBLIC and existing anon/authenticated roles; the backend owner performs application authorization. This is not organization-level tenancy. Pool default 5; verified TLS configurable, statement timeout 15 seconds.

Shipment origin/destination are normalized corridor strings, not address objects. owner_user_id is an external identity string, not a canonical merchant FK. Tracking is `LEX-` plus uppercase UUID. Existing statuses: created, matched, picked_up, in_transit, at_node, out_for_delivery, delivered, cancelled, exception, return_in_transit, returned. Matching locks capacity, checks corridor, package, service and deadlines; transitions enforce ownership and legal states, reserve/release capacity transactionally. Shipment history is unique per shipment/version. Wallet approvals record approval only; no payment execution.

## Commands and consistency

command_id is a caller-supplied UUID. Advisory locking serializes identical IDs. SHA-256 over canonicalized actor/action/input binds an ID to one logical request. Exact retries return the persisted original result; changed input/identity returns 409. Command insertion, state update, audit and outbox commit together. Failed transactions do not leave a processed command. expected_version is checked against a row-locked shipment and successful mutations increment version. Carriers have no version field; scheduling is blocked while capacity is reserved.

Outbox rows persist one UUID event and original envelope: schema_version 1, source statelines-lex, aggregate shipment UUID/version, correlation_id shipment UUID, causation_id command UUID. Types: ShipmentCreated, ShipmentMatched, ShipmentStatusChanged, ShipmentDelivered, WalletApprovalCreated. Even wallet events use the shipment aggregate. Never reinterpret existing IDs or silently replace these envelopes.

## Integrations and webhook protocols

Node outbound: HTTPS allowlisted host, public IPv4 DNS resolution pinned to request, no redirects; 8 second timeout. HMAC-SHA256 signs timestamp + dot + exact body; X-LEX-Timestamp, X-LEX-Signature `v1=...`, X-LEX-Delivery-Id. Response must acknowledge matching event_id with accepted or processed. Receiver example verifies signature with five-minute timestamp tolerance and deduplicates source/event_id; payload collisions reject.

Legacy Base44 `shared/lexBridge.ts` is a DISTINCT protocol: X-LEX-Event and X-LEX-Correlation-Id, optional `sha256=` HMAC of body only, six-second timeout and any 2xx treated as success. `lexPublishToPlatforms` publishes EventLog records to PlatformConnection subscribers and records PlatformDelivery. Empty enabled_events means all events. Its bounded recent-history sync is not the Node durable outbox. `lexUtils.publishEvent` is best effort and suppresses storage failures. Do not route that protocol to the Node verifier or claim timestamp replay protection for it.

The Base44 API adapter authenticates users with Base44, selects server-controlled roles, signs HS256 JWTs for existing /v1 routes and preserves caller command IDs. Actual deployed NOC, Merchant, Carrier/Rork and PUDO payloads, credentials and endpoint configurations are absent. PlatformConnection definitions prove generic integration support, not successful deployment. No external application is modified by this phase.

Retained Base44 entities cover Shipment, CommunityCarrier, MerchantProfile, ChainOfCustodyEvent, ShipmentLifecycleEvent, Incident, EventLog, AuditLog, PlatformConnection/Delivery, DeadLetterEvent, orchestration tasks, decisions, pricing, forecasts, reputation, fraud and wallet events. SmartNode exists in the legacy export; no new locker feature is introduced. These exports are not evidence of authoritative PostgreSQL copies or live synchronization.

## Security, retries and observability

JWT issuer selects configured key; verified HS256, audience statelines-lex, required subject/time claims, maximum five-minute lifetime and configured role allowlist. Roles: admin, operator, merchant, carrier, platform. No persisted users/organizations/memberships. Rate limit 120 requests/minute per client/user or IP. Fastify structured logs redact authorization/cookie; errors omit internal traces. API error shape is legacy flat error/message/request_id.

Fanout creates one delivery per event/destination. Worker uses SKIP LOCKED and 60-second token leases, bounded attempts, exponential backoff with jitter (up to one hour), retries timeout/408/429/5xx and rejects permanent errors. Exhaustion becomes dead_letter. Accepted and processed differ; late acknowledgments are checked against owning client. Replay preserves event identity and attempt history. Inactive destinations pause delivery. Undispatched events with no subscriber remain stored and can be backfilled. Worker heartbeats drive protected health reporting.

Environment: DATABASE_URL, DATABASE_SSL, DATABASE_CA_CERT, DATABASE_POOL_SIZE, API_CLIENTS_JSON, WEBHOOK_SECRETS_JSON, WEBHOOK_ALLOWED_HOSTS, HOST, PORT, LOG_LEVEL, WORKER_POLL_MS, WORKER_BATCH_SIZE, DELIVERY_MAX_ATTEMPTS; NODE_ENV/NODE_VERSION affect deployment. No credentials were copied into this audit.

## Tests and migration risks

Existing tests/core.test.ts contains 26 tests using PGlite locally and disposable PostgreSQL via TEST_DATABASE_URL in CI. They cover authentication, idempotency, version conflict, shipment lifecycle/capacity, approvals, webhook verification, subscriptions, retry/dead-letter and acknowledgment/replay. They do not demonstrate an end-to-end deployed multi-app workflow or assignment acceptance.

Breaking risks: moving lex tables; changing RETURNING * response fields; recomputing fingerprints; changing existing tracking IDs, statuses or event signatures; treating Order/Assignment/Trip as Shipment; accepting caller roles in webhooks; exposing broad event history to merchants; adding schemas without access controls; assuming organization ownership from external user strings. Preserve these contracts and introduce opt-in interfaces first.
