# Supplied writer paths and unresolved scope

This is the supplied-source inventory, not a claim that every app writer was exported.

| Path | Protected writes / transport | Change and rollout dependency |
|---|---|---|
| lexLifecycle, lexCarrierGateway, lexRecordCustodyEvent | Shipment transition, custody, history; notification | Common signed transition/recovery; existing role/key checks retained; custody notification skipped on idempotent replay. Notification delivery itself is not a new transactional outbox. Audit remaining notification producers. |
| lexTransitions / lexTransitionRecovery | Shipment status/version, assignment/risk/bundle; Carrier capacity; Audit/Lifecycle/Custody/EventLog/Task/Alert/Incident | Parent observed-version CAS and durable effects; protected fields mandatory; every capacity writer must use same ledger. |
| lexOptimizeBundles / lexBundleRecovery | Member transitions + SmartBundle projection | Scoped IDs supported; no duplicate capacity reserve; partial groups held; active projection only after all completed. |
| lexDetectFraud | Shipment flag/risk/alert/incident/outbox; independent Carrier alerts | Shipment artifacts owned by transition; Carrier-only legacy recovery limitation documented. Scoped invocation avoids unrelated Carrier effects. |
| lexMatchShipments | Eligibility/match/assignment | Classify before offer/autoassignment, pass actual expected version. Full entity protection and legitimate production cohort required. |
| lexRecommendNode | Smart-node recommendation write | Trusted shipment guard and Carrier owner-user check. Actual SmartNode/event producer policies still need app-level inventory. |
| lexQueue | EventLog creation, webhook task/send, orchestration state | Persisted event reload; queued publication requires protected exact task approval. All other task producers require inventory. |
| lexEventReliability | PlatformDelivery, EventLog replay state, DeadLetterEvent state, destination reliability | Shared send guard for retry/replay/DLQ; isolated/unknown hold does not poison destination or count as success. |
| lexPublishToPlatforms | EventLog/outbound delivery, checkpoint | Pre-insert identity + fresh shared delivery check; unknown blocks checkpoint. Existing tie-pagination limitation remains. |
| lexSyncApp | Pulled-event normalize/ingest and checkpoint | Sender/canonical authorization and durable activity plan now included; remote pull receiver cutover remains pending. |
| lexEngineSync | Direct Render match/status/raw diagnostics, orchestration tasks | Low-level fresh guard and signed task provenance, restricted mutation path and manual redirects. |
| lexSyncEngine / lexEngineCreateRecovery | Render shipment create; CrossAppPackage command/link/status; confirmation EventLog | Protected frozen payload/UUID, actual accepted receipt, resumed outbox; supplied lexPackageMapping reconciled. |
| lexSyncCarriers / supplied sweeps | Delegation to engine/reliability handlers | Shared boundary inherited only where delegation reaches checked handlers. Workflow actor/secret and other caller paths must be verified hosted. No new enabled workflow included. |
| lexSandbox / lexMerchantContext / lexSandboxBooking / lexApi | Canonical mapping, credential validation, separate test harness | Prior binding fixes retained; no bypass of general gate, no live activation. Supplied Render adapter reconciled; provisioned canonical IDs and hosted identity checks remain pending. |
| lexApproveOperationalAuthority / lexRecoverTransitions | Protected review ledger / saved-plan recovery | New admin-only, no schedule enabled. Operator approval is not automatic ownership discovery. |

## Policy-compatible rollout order

1. Inventory remaining writers and policies; freeze only reviewed deployment changes, not customer operations. Separate immutable/authority fields from legitimate customer edits. Add missing ownership-checked server adapters before denying their old SDK writes. Do not apply a blanket production policy denial from this review subset.
2. In an isolated existing test environment, add required fields and supported admin-only authority policy, verify actual CAS semantics and direct SDK denial, then install candidate helpers/handlers while booking stays closed. Never let an active old producer mutate new protected state outside the fenced contract.
3. Prepare a read-only cohort manifest linking actual owned local records, verified backend evidence and any real capacity reservation. Approve ordinary records and exact event/task contracts explicitly under the policy epoch. Unknown provenance of a command is distinct from verified parcel ownership: hold only the ambiguous effect; do not relabel all unrelated customers synthetic.
4. Exercise positive ordinary cases for each enabled writer and negative synthetic/unknown cases before replacing shared delivery in a live app. All additional three-argument delivery callers must be migrated first. Stop if policy denial breaks a legitimate writer.
5. Reconcile existing in-flight commands with remote state before changing IDs. Preserve old history/canonical links. Pre-upgrade ambiguous commands require exact payload/receipt evidence, not generated replacements or guessed parcel similarity.
6. Later production change requires an approved, complete rollout plan, recoverable backup/current API-worker rollback revisions and protected writer coverage. No such change occurred here. Rollback must preserve newly written intents/links; reverting to old non-fenced writers with pending intents is unsafe. Pause affected jobs/deliveries and drain/reconcile first; never roll back canonical data by deletion.

## 30 October missing-dependencies response — superseding updates

The supplied fourteen schemas and all three missing modules are now present. Earlier statements that these schemas/modules are missing are superseded by RECONCILIATION-2026-10-30.md and the current MISSING-DEPENDENCIES.md.

| Newly confirmed writer | Targeted treatment |
|---|---|
| lexIngestWebhook → lexIngest; lexSyncApp → lexIngest | Dedicated sender credential plus signed existing-package/canonical MER/engine binding and fresh backend scope/isolation verification. No arbitrary package upsert or source-pinned engine command. Durable observational activity plan. |
| QueuePanel create/retry/cancel/delete | Full-file candidate uses lexQueueControl and stable client request identity. Raw payload task creation and physical deletion removed; validated priority/schedule retained. Existing EventLog anchors submission; signed task and fresh guard required at execution. |
| ShipmentIntake direct Shipment/CrossAppPackage/Activity creation | Existing owner intake is preserved, but it grants no operational authority automatically. Caller-supplied claims are untrusted; new sender/package needs explicit reviewed linkage. Do not silently switch on automatic onboarding. |
| CrossAppWeightEntry override/sync change | Existing admin boundary remains. Routing/weight changes invalidate approved snapshot and require review/reconciliation; must not mutate a frozen already-submitted create payload. |
| CarrierKeyManager and gateway key issue/revoke | Existing admin boundary retained; normal users cannot modify Carrier capacity/keys. Authorized admin creation starts a new capacity record; subsequent operational capacity writes use the fenced ledger. |
| PlatformConnections destination/config editing | Remains a trusted platform-admin action. Ingress authority binds actual source key digest and target, so changing those requires fresh approval. Outbound shared delivery reloads current destination/subscriptions. |
| ReliabilityPanel archive/delete | Current direct writes remain admin-only and inside the explicit trusted-admin boundary. They cannot fabricate a missing EventLog through DLQ replay. Do not claim admin tamper-proof replay history. |
| Shipment owner deletion policy | Candidate changes delete to admin-only; no Shipment.delete producer appears in the supplied exhaustive inventory. Cancellation stays handler-mediated and preserves records. No production policy changed. |

Resolved: lexEngineCleanup is explicit-operation/fenced-transition only; testRenderDomainApi is GET-only; CrossAppActivity has supported admin-only policy. Merchant receiver v2 is packaged. Only other enabled remote pull receivers need coordinated owner confirmation before switching their connection. No broad source export is required.

The standalone probe-entity test may run in live LEX under the user's narrow authorization only after confirming no automations/integrations/relationships and a scoped creation/execution path. It is not permission to apply the operational package or change actual entity policies. Actual policy/positive-writer tests remain later acceptance.

## Final prerequisite closure

Disposable LexPatchProbe policy/CAS checks passed and were cleaned up; this is not operational acceptance. Actual workflow identity, service-role handler authorization, protected entity denial and positive ordinary writer compatibility remain unverified. All existing production schemas remained unchanged.
