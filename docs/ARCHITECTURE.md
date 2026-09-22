# Architecture and implementation plan

## Purpose and vocabulary

The API accepts commands; PostgreSQL owns shipment state; the worker sends events to other platforms. A command is one requested business operation, identified by command_id. An event is an immutable description of a committed operation. A delivery is one event's progress to one destination. “Accepted” means durably stored by the receiver; “processed” means the receiver reports that its business handler succeeded.

## Decisions

- Node.js 24, TypeScript, Fastify and PostgreSQL; the existing Base44 interface remains separate.
- PostgreSQL stores the queue as well as business data, avoiding a separate Redis dependency initially.
- Base44 validates its own user session; a trusted server-side adapter signs a short-lived JWT for the backend.
- One transaction covers a command, shipment changes, capacity accounting, history, audit and outgoing event.
- Row locks serialize shipment/carrier changes. Command advisory locks and unique keys handle repeats.
- Delivery is at least once. A receiver must deduplicate event IDs and make business effects idempotent.
- No automated pricing or financial posting is inferred from the old application.

## State machine

Creation produces `created`. Only the matching operation enters `matched` and reserves capacity. A typical journey is:

`created → matched → picked_up → in_transit → out_for_delivery → delivered`

`at_node` is an optional intermediate status. Before collection, cancellation releases any reservation. Exceptions retain reservations until an operator explicitly recovers or cancels the shipment. Returns in transit retain the reservation. A post-delivery return is an explicit operator/admin command, requires a note and re-reserves the original carrier. `returned` releases that reservation without counting another delivery. Delivered shipments cannot return to normal forward transit states.

The full allowed transition map is in src/domain.ts. Merchants can only cancel their own uncollected shipments. Assigned carrier users can report operational progress but cannot initiate post-delivery returns or recover exceptions. Operators/admins handle exception recovery.

## Transaction and concurrency guarantees

A command_id is a UUID. Its fingerprint includes actor, issuer, role, action and validated input. Reusing an ID with different content produces 409. Successful results are persisted and reused. A failed transaction leaves no partial command record, allowing a retry with the same ID.

Shipment mutations lock their shipment row and require expected_version. Matching then selects/locks an eligible carrier. Capacity is updated under the same transaction, with database checks preventing overbooking. Concurrent requests can receive no_eligible_carrier while another transaction holds the candidate; callers may retry after refreshing.

Wallet approvals lock the shipment and have a unique shipment_id. Different command IDs with the same amount/currency return the existing approval; conflicting amounts/currencies are rejected. The wallet consumer must enforce operation_key uniqueness too. This service records approval, not payment.

## Outbox and deliveries

The worker claims undispatched outbox rows using `FOR UPDATE SKIP LOCKED`, creates unique event/destination delivery records, and marks fanout complete in one transaction. It walks the entire backlog, not only the newest records.

Subscriptions are evaluated at fanout time. Configure destinations before processing production shipments. Events with no active subscribed destination remain retained in the outbox but are marked dispatched; new destinations do not automatically receive historical events. See the explicit backfill endpoint in API.md.

Each delivery claim increments its attempt count, creates a 60-second lease, and uses a unique lease token. Claims stop at the configured ceiling. Expired claims can be recovered; a crash after receiver acceptance can repeat a send, which is why receiver deduplication is mandatory. A stale worker cannot overwrite a newer claim or a processing receipt.

A successful HTTP status alone is insufficient: acknowledgment must contain the same event_id and accepted/processed status. Dead-letter or accepted-but-unconfirmed events may be explicitly replayed; processed events cannot. Replay retains event identity and delivery identity, preserves attempt history, and starts a new bounded attempt cycle.

Disabling a destination prevents new eligible sends and is rechecked before I/O. It cannot recall a request already in flight. Worker instances must have identical secrets/configuration. An expired claim is visible via delivery state; a crash can omit its detailed attempt-history row, while its attempt count is retained.

## Security model

This is a single Statelines trust domain, not a multi-tenant SaaS. API client secrets belong only in backend environments. A trusted Base44 adapter can assert roles listed for its issuer, so it must derive identity and role from validated server-side user data. Each sibling application's issuer should normally permit only `platform`.

PostgreSQL `lex` tables have RLS enabled with no public policies. Browser roles must have no direct grants. The backend uses a database owner connection, so business authorization is enforced by the API. For stronger infrastructure isolation, provision a dedicated engine database and a least-privilege deployment/runtime role separation before a larger rollout.

Outbound endpoints must be HTTPS on an explicit hostname allowlist. DNS resolves to public IPv4 addresses only; the HTTPS socket is pinned to a validated address, verifies its certificate, has a total timeout, and does not follow redirects. IPv6-only receiver hosts are not supported in this release. Requests and responses are size-limited.

The rate limiter is per API instance; a multi-instance production deployment should add a shared ingress limiter. No browser CORS credentials are exposed because calls go through server adapters.

## Operations and migration limits

The operational health endpoint reports worker freshness and dead letters. Accepted events are not proof of completed downstream work; platforms must send processed receipts or operators must investigate/replay unconfirmed deliveries.

Command, history, outbox and delivery records are retained indefinitely in this release. Add a reviewed retention policy and backups appropriate to business requirements before sustained volume. Preserve idempotency records longer than the maximum replay window.

Do not run the old Base44 shipment writers alongside the new engine for the same shipments. Use a staged cutover and explicit ID mapping. A production data importer is deliberately not included because existing data relationships and deployment credentials have not been validated.
