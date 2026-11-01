# Merchant null-state CAS follow-up

Version 2026.11.01-cas-nullfix1, applied AFTER 2026.10.31-rc1. The sealed rc1 ZIP remains unchanged. This is four runtime files and tests, not another application rewrite. No operational application occurred.

The disposable probe showed that optional declared fields can materialize as null. rc1 still used absent-only predicates for some draft, quote, booking/cancellation and editable-draft state. Match the observed null OR genuinely missing field only when vacant; an existing non-null command still cannot be overwritten. IDs, frozen payloads, authorization, JWT and API contracts are unchanged. Follow-up tests elect one owner among concurrent null-state callers and confirm existing identities cannot be replaced.

90 complete-source handler/storage tests pass, including the new null-state cases. Native Base44 compilation accepted the follow-up through the temporary Merchant compile-only function importing all 28 reviewed handlers. No business handler was invoked; no service-role authorization acceptance is claimed. Full frontend builds were verified separately inside the hosted sandbox. Actual operational policy and handler acceptance remains gated.

Validate/apply with apply-reviewed.py against a complete private candidate AFTER rc1. The baseline hashes here refer to rc1, not the original app export. Run the tests beside the complete candidate tree, not this partial subset. Keep all booking/payment switches closed. Scoped live application must protect the two actual merchant contexts without denying unrelated owners; use the selective rollout record in coordinated-release. Do not globally apply old permissive policies as rollback once claims exist. Preserve pending state and reconcile the same commands.
