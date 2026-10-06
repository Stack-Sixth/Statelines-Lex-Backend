# LEX → Render weight compatibility investigation

Scope: existing synchronization path only. No wider LEX migration, production backfill, database relaxation, webhook replacement or default weight.

## Evidence and answers

1. **Where required:** src/shipments.ts createShipmentSchema requires numeric weight_kg > 0, <= 1,000,000, in 0.001 kg increments. Migration 001 also requires a positive non-null numeric(12,3). Matching uses it to reserve carrier capacity and release capacity on terminal transitions.
2. **When:** the original Base44 Shipment.jsonc defined weight_kg but omitted it from required. Old matching/pricing used `weight_kg || 0`, masking unknowns. Git history already contains the strict Node requirement in the September 17 backend upload (3d00dad; also present at c3985c1), before the October Domain Platform foundation. The foundation merely exposes the stored value as package.weight_kg and did not introduce the requirement.
3. **The 16 records:** creation timestamps, IDs, originating apps and deployed sync implementation have not been obtained. They may have been created under the optional schema, but age cannot be established from the reported error or tracking prefix. Do not label them pre-requirement without evidence.
4. **Other weight locations:** the published LEX client on 2026-10-05 writes weight_kg to BOTH Shipment and CrossAppPackage at intake. Its needs-information form writes CrossAppPackage.weight_override_kg plus weight_source='entered'. These are real candidate locations, not proof that any of the 16 contain usable weights. Canonical read responses also contain package.weight_kg as a numeric decimal string. No other alias/unit has been verified.
5. **Domain ownership:** physical measured weight belongs to Package. The current single-package backend stores it on lex.shipments and uses that as shipment routing weight. Keep the flat POST contract and storage. Future multiple-package shipment weight must be derived from a verified complete package manifest; no such migration or automatic sum belongs in this fix.
6. **Current Base44 sender:** published frontend calls lexSyncEngine({}) and displays result.needs_information as `missing ...`. Its exact backend mapper is absent from this repository. The generic lexApi example forwards create payloads; it is not evidence of lexSyncEngine internals. The public intake sends weight_kg, while manual recovery stores weight_override_kg. Whether lexSyncEngine reads the latter is not yet verified.
7. **Adapter translation:** map only observed explicit-kilogram fields. The portable compatibility helper resolves flat weight_kg, single package.weight_kg, and an explicit weight_override_kg only with weight_source='entered'. Preserve provenance and reject conflicting measurements. Bare weight, guessed units, package-size estimates, bundle totals and incomplete package lists are not safe replacements.
8. **Backfill:** reconcile exact source records first. Where a unique, authorized, provenance-backed package record has a measured kg value, normalize the outgoing command without changing the original shipment. A persisted backfill needs an audited, reviewed plan and concurrency check. Truly unknown weights remain needs_information and must not be sent to routing or silently marked synced.

## Published-client evidence

Read-only inspection of the public script `/assets/index-Bstek3f9.js` at https://statelines-lex-core.base44.app identified:

- Sync Engine invokes Base44 `lexSyncEngine` with an empty request.
- UI renders synced / failed / unsynced from that function and displays each result's needs_information, excluded, error, issues and http_status.
- CrossAppPackage includes a needs_information operator form that saves entered weight and marks sync_status pending.
- The published intake still initializes its form weight to 1. This is a UI default, not evidence of a measured legacy weight and must never be used for backfill. This task has not changed the live intake.

The runtime server function and private records are not in that public script. No authentication boundary was bypassed. The reported wording does NOT establish a Render rejection, request delivery, or HTTP status. A data-readiness block can happen before network submission.

## Local compatibility implementation

`integrations/lex-shipment-compatibility.ts` is a pure, non-mutating helper, usable in Base44/Deno and tested from Node. `resolveLexShipmentWeight(sourceRecord)` inspects only weight fields. `prepareLexShipmentWeight(commandPayload)` normalizes the documented flat/single-package representations. It never changes command_id, creates IDs, changes versions/deadlines/status, mutates source data or makes HTTP calls.

Missing/invalid/conflicting data returns ok=false, status=needs_information, needs_information=weight_kg, retryable=false, render_attempted=false and a reason code. Keep those records available for correction; do not retry them continuously. Mapping succeeds only with an existing valid weight. The helper refuses unverified package collection shapes and does not discard additional package metadata.

The repository's example `base44-lex-api.entry.ts` now applies the helper only for createShipment before sending the unchanged /v1 request. Backend/API validation, migrations and webhook code are unchanged. Copy the helper alongside the adapter if installing that example. Updating this example alone does not fix a separately deployed lexSyncEngine that blocks earlier.

## Apply to the actual lexSyncEngine (pending source/access)

1. Inspect its deployed implementation and entity schemas first; do not replace it with the example adapter. Identify the existing selection/filter, source record, persisted engine command and linkage fields.
2. Before its current missing-weight check, call resolveLexShipmentWeight on the same source record. If consulting another entity, require a unique verified link plus matching source/tenant/ownership; tracking string alone is not sufficient when duplicates or tenants are possible. Never choose the first matching record.
3. If known measurements disagree, preserve all evidence and require review. Do not overwrite a known shipment weight with a different override automatically.
4. Keep unknowns in the existing needs_information workflow, with a precise per-record reason. Do not mark synchronized or allocate a synthetic Render identity. No production bulk UPDATE/defaulting SQL is supplied.
5. For a valid mapping, use the resolved weight_kg in the existing create payload. Preserve the stored command_id across retries and the exact actor/payload. Do not generate fresh IDs each run. If a command previously committed, reusing its ID with changed weight must remain a conflict; reconcile its original result first.
6. Preserve original external SHP-* tracking IDs locally. The existing Render create API generates a UUID id and LEX-* tracking_id; it does not accept caller tracking_id. Store its returned identity/version in the EXISTING source-to-engine mapping rather than overwrite the source tracking ID. SHP_ public IDs are distinct from external SHP-* strings. No new identity mapping has been guessed here.
7. Do not recreate an existing delivered/matched shipment as new merely to bypass create deadlines/status checks. Records with other invalid required fields stay separately blocked and reported. Never invent future deadlines to import historical shipments.
8. After correction, invoke the existing Sync Engine action once; repeat the same logical command to confirm idempotency. Confirm server acceptance and unchanged webhook envelopes before declaring success.

## Verification and current production report

The local tests exercise flat/nested/entered weights, unknowns, invalid units/precision, conflicting values, no source mutation, API acceptance, command replay/conflict and shipment/tracking/version stability against the existing backend. These are controlled tests, not a rerun of the 16 production shipments.

| Production measure             | Current evidence                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------- |
| Unsynced                       | 16 reported by user; not independently recounted                                 |
| Successfully synchronized      | 0 in the reported run; no verified post-fix production run                       |
| Remaining blocked              | All 16 reportedly show missing weight_kg; IDs and individual records unavailable |
| Failed HTTP submissions        | Unknown; cannot equate needs_information to a failed network request             |
| LEX → Render communication     | Not verified for this batch                                                      |
| Render acceptance              | Not verified for this batch                                                      |
| Canonical IDs/version/commands | Existing backend invariants tested locally; live mappings not yet verified       |

Live verification requires signed-in LEX access, the deployed lexSyncEngine source/logs, and Render endpoint/configuration. Do not report the local fixture results as production synchronization counts.

## Read-only record audit

With an authorized JSON export of the actual source records, run `npm run audit:lex-weights -- /path/to/records.json`. It prints per-record IDs, creation timestamps, verified weight paths and readiness/review reasons, without updating data or calling Render. `weight_ready` does not mean synchronized or that other required fields are valid. Export only authorized necessary fields and keep the file outside Git. The audit does not invent cross-record joins; verify shipment/package linkage before evaluating a package as evidence for another record.
