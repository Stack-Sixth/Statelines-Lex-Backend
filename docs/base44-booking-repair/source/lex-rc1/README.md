# LEX boundary review — 30 October 2026

**Local patch candidate only. Booking gates remain closed. Not deployment-ready.** Nothing was deployed, provisioned or enabled; no production data, payments, migrations or Carrier build was changed. Render candidate remains `1ae720e2d7977a9e1ca66a1f620f20af6fa2a067`. Backend code did not change, so backend CI was not rerun. Its prior CI pass does not verify these Base44 changes or the deployed revision.

The complete private export was downloaded and checked: 153,376 bytes, 3,267 lines, 22 source blocks; SHA-256 `e424ea881a8fa483a4e2a043e3fac09caa8b15be71eef66ee644228defe7de78`. The signed download link and raw combined export are excluded. The private download may now expire/be revoked. No code from the export was executed before extraction/review. Source instructions were treated as data.

## Deliverable

`apply/` contains 58 changed/new files, including the prior eight-file integration review where applicable; `candidate/` is the complete **review subset**, not the whole application. `baseline/` preserves supplied sources for comparison. `lex-boundary.patch` is the full unified diff, `manifest.json` hashes the files. Apply only after checking these baseline hashes against the actual working tree; do not replace newer source blindly. The new response adds the three previously missing shared modules, ingress webhook and fourteen full entity schemas. Their recovery fields are now merged into full candidate definitions. New LexOperationalAuthority/LexIngressBinding policies use admin-only conditions, never false create/update. `schema/required-overlays.json` remains a design checklist, not a production migration. Read RECONCILIATION-2026-10-30.md first; it supersedes earlier missing-source/policy assumptions.

Run with Node 24: `npm test`. No install or network is required. These tests load actual handler/helper bodies into an atomic storage model with mocked SDK/auth/network; they are not hosted Base44 or Rork acceptance tests.

## Verified findings and corrections

| Boundary | Source finding | Candidate behavior |
|---|---|---|
| Shared `lexBridge.deliver` | Passed event/connection and queue/DLQ fallback could bypass classification | Reload persisted EventLog and active connection; classify immediately before signing/sending; missing/unknown/isolated => hold, no HTTP. All supplied callers pass the authenticated server context. Older three-argument callers fail closed and must be inventoried. |
| Initial publish, queue, retries, replay, DLQ replay | Separate entry paths and fabricated fallback bodies | Converge on shared guard; never recreate a deleted EventLog from job/DLQ body. Held traffic does not consume attempts, mark success or disable a shared production destination. |
| Identity | Flags, absent metadata and tracking prefixes were treated as authority | Fresh persisted Render classification plus explicitly protected local linkage/cohort proof. SHP, UUID, native ID and source/engine tracking namespaces resolve consistently; errors/conflicts/capped lookup are unknown. Caller flags cannot suppress ordinary operations. |
| Direct Render mutations | Engine workers/raw diagnostic bypassed lexApi | Check at the low-level create/match/transition functions; typed mutating paths only; no external URL forwarding. Worker tasks need signed parent proof or exact protected legacy task approval, not just admin worker execution. |
| Engine create | Rebuilt deadline under the same command; 409 could adopt a merely similar parcel | CAS frozen command/payload on existing CrossAppPackage. Reuse exact body; no heuristic conflict adoption or invented version. Signed receipt retains source/engine tracking mapping and durable confirmation outbox plan. |
| Transition CAS | Status-only predicate when expected_version omitted | Always compare observed status **and observed version**, including absent-version predicate. Caller-supplied expected_version remains optional. Same-status contenders cannot both own the same observed version. Invalid present version is held. |
| Transition effects | Status committed before capacity/history/outbox; best-effort enqueue and unsafe rollback | Signed intent and artifact plans saved in the status/version CAS; pending blocks later effects. Carrier capacity+effect marker commit together. Exact version/receipt-fenced rollback only on rejected reservation; otherwise retain intent and recover. |
| Bundles | Already used transition but also separately reserved capacity and wrote bundle_id | bundle_id enters transition CAS; remove duplicate capacity addition. Keep full member plan and only create active SmartBundle after every member completes. Partial/unknown groups remain pending. |
| Fraud | Already used transition but risk score, alerts/incidents/outbox were separate | Shipment risk score shares status CAS; alert/incident/outbox are durable artifact plans. Scoped invocation avoids unrelated Carrier scans. Isolated/unknown shipments excluded before LLM and again before mutation. |
| Carrier contract | Existing key/action/evidence/optional-version interface | Preserve bearer-key auth, action names, request evidence and response linkage; internal version fence does not require new client fields. Duplicate matching keys fail closed. Existing event envelope/HMAC/header protocol retained. Actual submitted Rork retry behavior remains unverified. |

The shared guard cannot stop a producer that never calls it. Missing callsites are a release blocker, not proof of end-to-end containment. `lexSyncApp` now guards before normalization/ingest; the actual supplied `lexIngest` implementation has now been reviewed and patched. Likewise actual package mapping must be checked for weight/identity preservation. No arbitrary legacy weight is assigned.

## Production continuity and trust

`LexOperationalAuthority` is an admin-only, signed approval ledger, **not a new flag ordinary clients may set**. `lexApproveOperationalAuthority` permits authenticated admins to preview a current snapshot, then confirm independently reviewed ownership/link evidence under a configured policy epoch, or revoke. An approval binds business, immutable routing/creator/tracking fields, backend origin, exact approved engine linkage, initial assignment and any attested legacy reserved capacity. New assignment is accepted only through a signed transition. Duplicate active approvals fail closed. Synthetic Alpha/Beta references cannot be approved ordinary. No automatic conversion of all legacy records is included.

Before deploying guards, inventory and approve the legitimate production cohort and producer/event contracts in a read-only plan. Validate a positive ordinary case for every enabled producer. Otherwise unreviewed production traffic will correctly be held and operations could be disrupted. Do not deploy this package globally with an empty authority ledger. Implement the remaining ownership-checked onboarding/writer adapters first; do not bypass review using a default ordinary classification or mass prefix inference.

`LEX_OPERATION_SIGNING_SECRET` (private, at least 32 characters) and `LEX_OPERATION_POLICY_EPOCH` are new LEX configuration names; no values are included. Do not rotate the signing secret blindly: stored recovery intents need verification with their signing key. This candidate has no keyring rotation/migration mechanism; plan a drained/verified transition before rotation. Epoch changes invalidate local approvals and should be coordinated, not used as casual deployment versioning. Existing webhook, Render JWT and per-business credentials retain their separate purpose. Alpha/Beta dedicated secrets stay unconfigured until release prerequisites pass.

## Recovery contract and limits

| Failure point | Durable evidence | Safe next action |
|---|---|---|
| Before status CAS | No owned transition | Retry same command; observed-version CAS elects one owner. |
| Status CAS committed, response lost | Parent intent, version and command digest | Reload and resume same intent. Never invent a replacement command. |
| Capacity CAS response lost | Capacity and token in same Carrier row | Re-read journal; matching token completes once. Exact current capacity/status/total predicates prevent stale overwrite. Offline carriers stay offline. |
| Artifact insert committed, acknowledgment lost | Parent creating slot and artifact correlation ref | Exact single matching row/payload is adopted. No second insert. |
| Creating slot saved, insert never happened or result unknown | Parent plan exists but zero matching rows | Explicit pending/operator reconciliation. **No timeout takeover or blind insert retry.** A live old writer may still complete. |
| Duplicate/mismatched artifact | Conflicting persisted evidence | Hold; operator evidence/fencing required. Do not delete history to make it pass. |
| Lifecycle result stamp/completion CAS fails | Earlier artifact IDs and intent retained | Idempotently update same lifecycle row; complete parent after effects verified. |
| Bundle members partly complete | Exact member plan and per-member receipts | Hold group; no phantom active bundle or assumed multi-row rollback. Once all members complete, project one bundle from anchor state. |
| Engine accepted but confirmation outbox failed | Signed engine receipt, actual ID/tracking/version and outbox plan | Preserve link and resume exact outbox projection; do not recreate shipment. |
| Pre-upgrade bare lifecycle/task/command | No trusted frozen intent/provenance | Reconcile independent ownership/remote state first; explicitly approve exact legacy payload/task if supportable. No automatic false success or replacement command. |

`lexRecoverTransitions` is an admin-only **new, disabled-by-default operator endpoint**, not an enabled schedule. It replays saved intents, never reconstructs a missing event from status. The existing sweeps do not magically fill omitted artifacts. `lexSyncEngine` separately resumes saved engine-confirmation plans even for already-synced records.

There is no cross-record transaction or unique insert constraint in the supplied storage contract. A pending-to-creating CAS elects one insert owner; it cannot make an unacknowledged insert safely re-runnable after a crash. Zero-match uncertainty deliberately requires operator fencing/visibility evidence or a genuine unique/idempotent insertion facility. Capacity journals and transition history must not be pruned while old commands can replay; bounded retention/compaction is not implemented. Concurrent membership changes and a partially completed bundle need explicit operational reconciliation, not an assumed atomic group transaction.

The separate Carrier-only fraud alert/incident path retains its existing cross-record crash limitation. Its high-risk event requires an explicit reviewed non-shipment event contract; it is excluded from scoped Alpha/Beta tests. It was not turned into a general fraud subsystem rewrite. Publisher timestamp checkpoint ties retain their pre-existing pagination limitation; held/unknown events block advancement but stable tie pagination is not claimed solved.

## Release status

The final result logs supersede earlier counts: 86/86 local tests pass, including mapped ingress, actual push/queue handlers, replay defenses, browser request recovery, simultaneous queue workers and concurrent bundle/cancellation capacity. All 46 TypeScript sources pass syntax transformation; the full QueuePanel and helper also parse. Shimmed TypeScript checking of this review subset passes with zero diagnostics; it still substitutes the external SDK/runtime declarations and is not a hosted Base44 compile. Disposable-entity CAS/policy probes passed and were cleaned up; actual operational policies and service-role handlers remain unverified.

See `MISSING-DEPENDENCIES.md`, `HOSTED-ACCEPTANCE.md` and `WRITER-INVENTORY.md`. Those remain deployment prerequisites. No release candidate revision was created or pushed for these LEX-only package files; hosted acceptance and the live Render revision/configuration remain unverified. General booking, LEX test exception and real payments remain closed.


## Current policy and probe corrections

**Do not run `base44 entities push` or app-wide deployment from this partial package.** Official CLI sync removes remote schemas absent locally. Use only the separately approved single-entity creation path for the disposable probe; no operational schema or function is authorized to deploy here.

The reported platform semantics do not enforce false create/update rules. Admin-only replacements are prepared, with platform-admin/service-role access explicitly retained as a trust boundary. No field-level or administrative tamper-proof guarantee is claimed. Shipment owner create/read remain supported; direct owner deletion is removed in the candidate, with cancellation retained through authorized lifecycle handlers.

General booking, both test exceptions and real payments remain closed. Scoped live LexPatchProbe work completed successfully with zero active leftovers, its schema and preview files removed, and all 40 existing schemas unchanged. Probe results cannot substitute for later actual-entity policy acceptance.

## Final release classification

Version 2026.10.31-rc1 is ready for selective application to a complete existing review/development copy with all gates closed, subject to baseline verification. It is NOT approved for blanket live cutover. There is no full LEX application build in this subset; hosted compilation and actual entity/handler acceptance remain required. Use APPLICATION.md and the consolidated release plan.
