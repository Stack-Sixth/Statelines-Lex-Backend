# Final acceptance status — 31 October 2026

Disposable-entity policy/CAS prerequisite: SATISFIED, including cleanup. This does not certify actual operational entity policies or hosted service-role handlers. The following operational matrix remains UNVERIFIED. Use an existing suitable isolated copy; do not create paid staging or substitute a destructive production suite. Later two-business live tests remain conditional on all release prerequisites.

# Operational hosted acceptance — not yet run

The separately authorized live **disposable probe entity** may run before operational application; see probes/README.md. Those results establish only its CAS/policy path. They do not authorize production Shipment/task/event/carrier mutation tests or prove those entities' policies.

Use an existing isolated app/database with synthetic destinations and no real Carrier, notifications, fulfillment or payment keys. Do not use production mutation tests as a substitute, create paid resources, enable general booking or execute a destructive suite against production. If no isolated environment is available, leave these steps unverified and have an owner provide one.

## Setup and policy checks

- Compare manifest baseline hashes against deployed source. Obtain the missing source/policy items first and compile with the app's actual SDK/runtime. A review-only shim compile is insufficient.
- Merge full EventLog/CrossAppPackage additions and missing-entity overlays without dropping existing properties/policies. Validate the supported admin-only authority schema in Base44. Configure operation signing key privately and a deliberate policy epoch. Do not set test-booking or retired sandbox variables to production credentials.
- As an ordinary owner, directly create/update/delete claims, signed receipts, pending flags, assignment/canonical pointers, capacity journals and outbox/job references: require denial. Then prove legitimate edits/admin tools/jobs use authorized handlers. A leaked caller flag or copied proof must not authorize a different record.
- Verify atomic storage using simultaneous handler calls against actual entities, including nested object predicates and absent fields; inspect `updated` numeric results. Unknown result/timeout must leave pending. No client becomes owner merely by rereading.
- Admin preview/confirm authority with independently reviewed ownership and current snapshot/epoch; exact fields are in `lexApproveOperationalAuthority`. Revoke and change epoch/target/assignment/tracking; require held/denied until reapproved. Duplicate active grants must fail closed. Confirm actual approved synthetic business cannot become ordinary.

## Boundary matrix

For one reviewed ordinary record, one backend-isolated synthetic record, one unknown, and one conflicting-link record, exercise all of: initial publication; event_publish job; webhook job; scheduled retry; explicit replay; DLQ replay; deleted EventLog; revoked destination. Ordinary sends once with unchanged versioned envelope/event ID/HMAC headers; synthetic/unknown/conflict sends zero. Inspect mock HTTP receiver and real stored EventLog/Delivery/DLQ/task rows, not just handler JSON. Held traffic must not disable a shared destination or advance checkpoint past unknowns. Verify unrelated ordinary jobs still deliver.

Repeat with UUID, canonical SHP, native local ID, engine tracking, source tracking and no caller marker; mismatching identities must hold. Payload `sandbox_isolated:false` cannot declassify synthetic; `true` cannot suppress an independently ordinary event. Shipment-less events require exact protected entity/field contracts. Missing event cannot be replayed from a caller/DLQ body.

Call direct engine create/match/transition and raw diagnostic paths, plus queued engine jobs: isolated/unknown/forged tasks must produce zero Render mutations. Reviewed ordinary linked jobs succeed with the existing JWT and UUID/body contract. External raw URLs and unsupported write routes are rejected. Re-read/frozen create after a simulated lost response must retain command, payload deadlines and canonical receipt; a 409 cannot adopt a merely similar shipment. Never fill missing weight/version with guessed values.

## Transition and recovery fault tests

- Two same-status commands starting from one version and no expected_version: one winner, one conflict/pending; exactly one increment/effect set. Repeat same command concurrently: one identity and one artifact set.
- Inject failures immediately before/after status CAS, Carrier CAS, each artifact insert, lifecycle result stamp and parent completion. Inspect saved intent, capacity token, artifact reference and remote state. Resume same command or admin recovery; committed effects must not repeat. Confirm pending prevents shared event dispatch and privileged engine jobs.
- A saved creating slot with zero visible rows is a hard reconciliation hold. Do not approve timed takeover; require proven termination/fencing of the old writer and definitive storage evidence or a real unique/idempotent insert primitive. Duplicate rows/payload mismatch hold for operator review.
- Fill carrier capacity between read and CAS; reservation rejection must revert only its exact version/assignment, preserving monotonic version. Deliver/release while Carrier is offline must not bring it online. Concurrent independent capacity commands must preserve every journal token.
- Bundle two already matched shipments at full capacity: no added reservation. Fail one member, bundle insert or acknowledgment. No active partial bundle; completed membership can recover one projection from retained plan. Partial groups remain explicitly held.
- Fraud scoped to synthetic IDs: no LLM, status, risk, alert, incident or outbound effects. Reviewed ordinary high-risk record: risk/status share CAS; artifact fault recovery produces no duplicates. Do not claim separate Carrier-only alert crash recovery fixed.
- Cancellation/return through unchanged authorized handlers: same-command retry/lost response must reconcile one version/effect set; capacity releases only verified reserved weight. Cross-user/Carrier must fail. Verify real submitted Carrier build can persist/reuse command ID; do not rebuild it to satisfy tests.

## Coordinated controlled-create acceptance (later, still gated)

Merchant normal booking calls Render directly; lexSandboxBooking is a distinct test harness. Test them separately. Before any controlled live create, validate backend server-derived merchant isolation is committed before outbox delivery and present on canonical reads after lost-response reconciliation; do not infer safety from a Base44 post-create check. Provision actual canonical MER IDs and protected local mappings, then four `/api/v1/merchant-context` identity checks. Only an explicitly verified business-scoped exception may later open, while general booking and LEX booking remain closed as agreed. Keep synthetic payments disabled. Backend isolation, authorization and restoration prerequisites are separate from these local tests.

Record actual hosted app/revision, sanitized commands/results, resulting ID/version/command linkage, HTTP captures, rejected SDK attempts, failure-point evidence and remaining holds. Passing local tests are not evidence this hosted matrix passed.
