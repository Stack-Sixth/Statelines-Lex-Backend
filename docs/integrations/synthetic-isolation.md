# Controlled synthetic-merchant isolation

The prior candidate e3ead84 and both inspected live releases do not accept, persist or route by sandbox_isolated. Both create schemas were strict, so a caller marker failed400. Events and worker routing had no marker, and Base44 guards alone could not isolate backend paths. Normal Merchant booking calls Render directly. LEX lexSandboxBooking is a separate harness; passing it does not verify Merchant quoting/payment or normal booking.

## Server authority and provisioning

New nonsecret API configuration SYNTHETIC_BUSINESS_IDS_JSON is a JSON array of at most TWO exact approved business external-reference IDs; default []. It is not any of the superseded sandbox URL/payment/credential secrets. Those obsolete secrets stay unset. Do not configure the allowlist until actual approved IDs are supplied. This setting grants no user or client access by itself and does not enable booking.

Admin POST /api/v1/merchants with the approved external_reference automatically provisions sandbox_isolated=true, even if the body omits the marker or says false. An explicit true for an unapproved external_reference fails403. Ordinary merchants cannot call provisioning. Account isolation cannot be changed through the authorization/status APIs. Use newly provisioned, verified synthetic accounts; there is no auto-upgrade/backfill of existing accounts, shipments or events. Existing external_reference uniqueness and immutable bindings remain enforced.

Clients and subjects still require ordinary admin provisioning. Merchant uses sub=its dedicated client ID; LEX uses the approved authenticated user ID. Approve only actual required subjects for each account, never inferred names. Secrets belong only in API_CLIENTS_JSON and existing secure Base44 credential references. Merchant-context includes sandbox_isolated:true only for isolated accounts and must be checked with merchant_id/client_id/subject. No provision or live context test has occurred yet.

## Persistent isolation

Migration006 adds default-false immutable-by-API flags to accounts, shipments and outbox. New shipment flags derive from the authenticated merchant's stored account, regardless of the caller marker. Both create APIs optionally accept sandbox_isolated:true as an assertion; ordinary merchants get403 and false fails schema validation. A forged JWT claim does not grant isolation. Ordinary traffic remains normal when the allowlist is empty.

Only synthetic projections/events add true markers: Shipment projection, legacy envelope root and payload, canonical envelope root and shipment, and event read projection. Stored snapshots keep markers through command retries and cancellation. Existing ordinary event contracts and historical envelopes are unchanged. Legacy shipment rows include the added database field through the existing SELECT * contract.

Worker fanout consumes isolated outbox rows without creating deliveries. Claim excludes isolated events. Immediately before send, the worker rereads the persisted outbox flag (missing rows also fail closed); isolated stale jobs are dead-lettered without network I/O. Administrative destination backfill skips isolated events and delivery replay refuses them. Markers are retained as audit evidence, not dropped at the receiver. No isolated event is intentionally sent to any webhook, including a test receiver. Existing production destinations, subscriptions and workers are not paused globally.

Synthetic shipments cannot be matched to a real carrier, cannot transition except to cancelled and cannot create wallet approvals. Assigned-Carrier read/list excludes synthetic shipments. Admin/operator reads retain visibility with markers; external pollers must independently honor those markers. Direct database edits or unreviewed consumers are outside this API boundary and must not bypass it.

## Rollout hold and verification

This is a new candidate; e3ead84 alone cannot provide these protections. Apply006 after004–005 only after production backup/recovery verification. Deploy the matching API and ALL delivery worker instances before provisioning/testing. Old workers ignore flags and must never process synthetic events. Keep both global booking and LEX harness exception closed until all worker revisions and external dispatch/notification/Carrier guards are verified. Never roll back to an old worker while synthetic outbox records could be fanned out or replayed: retain the quarantine-capable worker or explicitly resolve that rollback risk first.

Tests use disposable databases: server allowlist enrollment, unauthorized ordinary flags, actual client-ID subject context, implicit legacy isolation, canonical marker persistence, same-command retries, scoped reconciliation, cancellation retry, assignment/Carrier blocking, no fanout/backfill/replay/claim/send, stale-job DB recheck, and normal merchant delivery. Production tests, actual Base44 flows, subscriber/polling guards, submitted Rork build and payment behavior remain unverified. No paid resources, production migrations or booking activation are part of this implementation.

## Coordination required

LEX operator must return the TWO actual business IDs, proposed dedicated client IDs and authenticated test-user subjects, along with source/export for lexSandboxBooking/lexSandbox and dispatch, notification and Carrier guards. Keep exception off. Merchant operator must separately verify direct booking, same-command retries and reconciliation; do not treat harness success as those results. Payment verification stays untested unless safely isolated facilities exist; no real charge and no live credential fallback.

Supabase backup verification is blocked by sign-in in the accessible browser. This does not establish absence of a suitable backup. Once signed in, inspect production backup timestamps, recovery windows/procedure; if absent, prepare a private logical export and verify restoration locally using compatible tooling. No export or restore has been attempted; backup contents/credentials must never enter repository or handoffs.
