# Booking repair preservation — stopped, not release-ready

This commit preserves selected Merchant/LEX code, tests and sanitized execution evidence. It does not deploy or resume live work. The application repair is incomplete. Source snapshots are review material, not a wholesale installation instruction.

## Shared Draft restoration

**The original shared `ShipmentDraft` policy was not restored by this work before the stop.** The last successful live/source readback is the modified two-business scoped policy in `records/draft/ShipmentDraft.after.json`. The exact original is preserved in `records/draft/ShipmentDraft.before.json`. There is no successful restoration receipt. Do not assume an external operator has restored it; no fresh live query was performed for this preservation commit.

The scoped rule blocked edits to an already protected draft but allowed an unbound owner draft to be retagged into the cohort. Therefore it is NOT an accepted claims-protection boundary. Its earlier owner-denial results do not close this ingress failure. No rollback, cleanup, policy change or probe was performed while preparing this commit.

## Last recorded applied state

| Area                      | Last recorded state                                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shared `ShipmentDraft`    | Additive fields and scoped create/update/delete rules remain the last verified state. Original read rule and unrelated owner rules were retained. Restoration has not been completed.                                                                                                                                                                        |
| `ControlledMerchantDraft` | New separate entity and source definition were applied. Mutations are admin-only regardless of input merchant ID; owner reads use the stored server owner. Native schema readback matched. Runtime acceptance is pending.                                                                                                                                    |
| `controlledMerchantDraft` | New restricted handler and five namespaced dependencies remain. Latest compiled version uses `ControlledMerchantDraft`, not the shared Draft table. It accepts only the approved Alpha/Beta user/business pairs and scopes record lookup/listing to that business. Native compilation passed; this latest private-store version has not been exercised live. |
| Earlier handler tests     | The earlier shared-store version passed Alpha load/create/edit/archive, rejected caller command fields and denied an admin caller. These results MUST NOT be represented as acceptance of the later private-store version.                                                                                                                                   |
| Signing configuration     | Two internal record-signing configuration names were added during the work. Neither value is included. No pre-existing secret was overwritten. External dedicated service-client credentials were not issued. Preserve signing configuration until recovery/rollback is reviewed.                                                                            |
| Render                    | No candidate deployment, production migration or main-branch update was performed. Last observed API: `ee59800aab31ac39adf5727bcdbfac1eb60ec5e7`; worker: `2c2023a13a03c802eb1db3fb008d2397264b6f55`. Applied migrations 001–003 matched candidate checksums; 004–006 remained outstanding. These are recorded observations, not a new live inspection.      |
| Provisioning and booking  | No canonical Alpha/Beta MER IDs or DomainMerchantLink rows were provisioned. Four authenticated context checks and actual booking/retry/tracking/cancellation tests remain unrun. No Shipment or Quote was created by this test work; no payment or dispatch call occurred. General booking and test exceptions were not enabled.                            |
| LEX/Carrier               | Global LEX guards were not activated. Existing production writers and the submitted Carrier build/contract were not replaced.                                                                                                                                                                                                                                |

## Temporary records and resources

| Item                                                   | Last recorded cleanup status                                                                                                                                                            |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared owner-policy draft `6ae732eab19092591ae66206`   | Deleted; absence independently confirmed.                                                                                                                                               |
| Shared server-created draft `6ae73af24e8fb3cd86a1bd09` | Archived through the authorized handler and retained. No canonical link or booking claim; stored edit revision 2.                                                                       |
| Ingress-test draft `6ae7593104bdaf74e4047d06`          | Retained at stop; retag into the Alpha cohort unexpectedly succeeded. No cleanup receipt, shipment or command.                                                                          |
| New private-store drafts                               | No such record was created by this work after the store switch; live empty-count verification was not run.                                                                              |
| Compile-only functions/namespaces                      | Removed and absence recorded before the later restricted handler was installed.                                                                                                         |
| Earlier disposable LEX entities/fixtures               | Cleanup recorded; these are distinct from the remaining Merchant resources.                                                                                                             |
| Merchant browser test assets                           | Identity, owner-policy, handler and ingress pages plus SDK bundles remain under `public/` in the app. They are excluded from Git. Do not click mutation controls while work is stopped. |
| Restricted handler/private entity                      | Remain applied as described above. They are not merely proposed files.                                                                                                                  |

## What is preserved

- `source/merchant-rc1`: selected changed Merchant files, necessary TypeScript dependencies and tests. The original full export, attachments and baselines are excluded.
- `source/lex-rc1`: the reviewed LEX source subset, tests and original package metadata. It is not the entire app.
- `source/merchant-null-fix`: four-file follow-up and tests matching the verified null-versus-missing CAS behavior.
- `source/controlled-draft-slice`: the latest six-file restricted private-store implementation plus its entity schema. This is the latest applied draft-only direction, not a completed booking implementation.
- `records`: sanitized receipts, migration/CI observations, explicit test identifiers, provisioning manifest and rollback schema definitions. No raw API app documents, credential values, backup contents or customer payload exports are included.
- `CONTENT-MANIFEST.json`: per-file SHA-256 inventory and exclusions.

Historical package READMEs and test counts describe their respective snapshots. This document supersedes their readiness/application language. Full hosted frontend builds produced artifacts; frontend typechecks still had diagnostics. Native compilation is not live operational acceptance. Local test results are not a booking result.

## Resume constraints — do not execute automatically

First reconcile and restore the shared Draft source/model using the exact preserved snapshot, checking for intervening operator changes. Preserve the retained test records and audit history until an explicitly authorized cleanup. Do not restore permissive policies over active claims; no canonical commands were accepted in this work.

Complete private-store SDK denial and real-handler ownership tests, including inbound retag/copy attacks and Beta. Finish protected quote/shipment state and producer containment before any synthetic Shipment. Independently verify current backup freshness, migration checksums, rollback revisions and all worker deployment controls before the already-authorized controlled backend rollout. Retain a quarantine-capable worker whenever synthetic events exist.

Then securely provision exact clients/subjects and canonical mappings, verify all four contexts directly, and run the isolated direct Merchant-to-Render booking tests. Any alternate controlled storage/harness results must remain distinct from normal paid Merchant UI, external quote/payment, LEX harness and submitted Rork acceptance. General booking must stay closed pending review.
