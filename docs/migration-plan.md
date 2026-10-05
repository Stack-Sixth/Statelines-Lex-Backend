# Migration plan

## Delivery boundary

This iteration implements Phase 1 audit/documentation and the safest Phase 2 foundation: deterministic public identifiers and read-only canonical projections/API. It does not switch external applications, replace mutation services, or enable a new ingress protocol. This follows the request's starting instruction to stage major changes.

1. **Audit**: record baseline APIs, storage, protocols and unknown deployment facts. No runtime change.
2. **Canonical foundation (this iteration)**: add logical domain schemas and read-only projection views through migration 002. Keep all original tables, fields, tracking IDs, command fingerprints and outbox envelopes. Add authenticated canonical shipment/event reads, sharing existing authorization. Prefix full UUIDs rather than truncate them; no probabilistic ID mapping or bulk data rewrite.
3. **Gateway/event contracts (next)**: obtain signed sample payloads from each external app. Build independently credentialed gateway handlers with exact-byte verification, bounded timestamps, durable receipts, collision detection, retries/dead letters and explicit event-to-command authorization. Record acceptance only after receipt commit; record processing only after idempotent command commit. Unknown events must not mutate state. Canary each source; retain old endpoints. Add opt-in outbound contract negotiation while legacy subscriptions stay unchanged.
4. **Shipment authority**: reconcile external shipments and ownership with platform UUIDs. Resolve duplicates and cross-org access before cutover. Introduce typed addresses/packages/order links only after actual data analysis. Keep lex.shipments storage until a separately reviewed migration is necessary.
5. **LEX**: keep local decisions/routing; commands target canonical shipments via trusted server adapter. Run shadow comparisons before switching writes.
6. **NOC**: consume domain state and use audited operator commands, not independent shipment writes.
7. **Carrier**: introduce independently versioned Assignment and Trip, acceptance/rejection and proof-of-delivery ownership checks. Do not infer acceptance from legacy matched status.
8. **Merchant**: introduce Order and one-to-many Shipment links with verified merchant membership. Never turn existing shipments into synthetic orders.
9. **PUDO**: validate handover identity/capacity semantics; add operational events. No locker scope.
10. **Audit/billing**: expand actor/source/correlation context without changing command fingerprints. Billing interfaces only until payment requirements are explicitly defined.

## Gates and reversibility

For each phase: migrate a disposable database; run legacy regression and new contract tests; verify backup restore; deploy staging API and worker from the same commit; exercise timeouts, repeated commands and stale versions; canary one integration; compare event/state counts; then expand. External app owners must confirm actual formats and authentication before a write cutover.

002 is additive and transactional; no existing table is altered or moved. Roll back application code while leaving added schemas/views in place. Do not run automated down migrations or drop production objects. Apply migrations through the checksum/advisory-lock runner. Production migration/deployment is not performed by this task.

## Outstanding tests for later phases

Assignment creation/acceptance, canonical webhook source/signature/duplicate/out-of-order handling, and Merchant → Render → LEX → Carrier → NOC/Merchant network simulation require the corresponding later-phase implementation. Do not describe existing shipment matching as these tests. Current regression tests remain the safety baseline.

## Initial rollout feature gate

`DOMAIN_READ_API_ENABLED` defaults to `false` and accepts only `true` or `false`. Keep it unset or false in the initial deployment. The new `/api/v1/shipments` and `/api/v1/events` read routes are registered only when explicitly true; authenticated requests otherwise receive 404. This gate does not change existing `/v1` APIs, command execution, signing, subscriptions, or LEX outbox/worker behavior. New event routing is not implemented or enabled by this foundation.

Enable canonical reads only after staging validation and explicit rollout approval; this merge/deployment leaves them disabled. Roll back the read interface by setting false and restarting the API. Migration 002 only adds namespaces/views and does not switch data authority or webhook transport.
