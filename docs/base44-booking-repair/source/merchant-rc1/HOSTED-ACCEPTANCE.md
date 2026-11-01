# Final acceptance status — 31 October 2026

Disposable-entity policy/CAS prerequisite: SATISFIED, including cleanup. This does not certify actual operational entity policies or hosted service-role handlers. The following operational matrix remains UNVERIFIED. Use an existing suitable isolated copy; do not create paid staging or substitute a destructive production suite. Later two-business live tests remain conditional on all release prerequisites.

# Hosted acceptance — UNVERIFIED, DO NOT ACTIVATE BOOKING

Use an existing disposable Base44 development copy with synthetic records only, no customer data, no production secrets, no paid integrations and all outgoing workflows/integrations disabled. Do not buy resources or substitute production tampering tests. If no copy is available, the exact blocker is owner-provided access to such a copy. No destructive CI database suite is involved.

## 1. Verify the patch and policy compatibility

- Verify manifest baseline hashes against the complete export. Review each changed-file patch. Apply to the disposable copy only; keep both general/test release flags off and test payments disabled.
- Confirm native SDK/app identity and the test account/owned business. Audit the exported six workflows plus any dashboard-only jobs, scripts and integrations. Do not assume the export inventories external writers.
- Exercise direct ordinary-owner, unrelated-user and admin SESSION SDK create/update/updateMany/delete/deleteMany/bulkCreate against Draft, Shipment, Quote, ShipmentEvent, ShipperDeclaration and ComplianceReview. Ordinary-owner and unrelated-user mutations must be denied. Platform-admin SDK access is expected to remain allowed and must be recorded as a separate trust boundary; do not report it as server-only storage. Especially test clearing claims, frozen payload edits, reopening quotes, primed IDs, false/true test markers, forged approved reviews and deleting linked records.
- Verify allowed customer edits/discard through merchantDraft; finalize creation/draft stamping through service storage; admin Review decisions through the explicit role/independent-owner checks; service-created own list/get/timeline and admin diagnostic reads. Service-role requests with the wrong caller must fail even though storage access itself is permitted.
- Configure a fresh record signing key privately only after deny-write rules are verified. Do not trust signatures minted before ordinary-user denial and authorized-writer cutover were verified. Admin/service-role mutation remains an explicit trust boundary. Verify schema preserves nested objects, numeric CAS counts, absent/null semantics, full-object claim predicates and `$set` updates. Run tests/base44-storage.contract.ts against its disposable-only probe entity.

## 2. Real storage and recovery harness

The development-only `tests/hosted/merchantCasAcceptance.entry.ts` may be installed as merchantCasAcceptance ONLY in the disposable copy. Review its guards before executing: admin session, copy app ID, explicit disposable confirmation, approved non-admin copy account, <=2 allowed merchants, closed booking gates, absent payment/backend/outbound credentials. Never deploy this file to production.

Configure only the copy's `MERCHANT_ACCEPTANCE_APP_ID`, `MERCHANT_ACCEPTANCE_DISPOSABLE`, `MERCHANT_ACCEPTANCE_MERCHANT_IDS_JSON` and private record signing key. Disable copy workflows independently. Invoke with `{disposable_app_id, test_user_id}`. Record actual redacted results/fixture IDs privately and remove the harness after acceptance; do not delete canonical/history records directly.

The harness covers real-store concurrent finalization, quote consumption, lost insert acknowledgment, crash before insert, browser priming and custody event lost-ack recovery with atomic receipt/event/audit projection. It deliberately stubs authorization/provider/compliance seams. A passing result proves storage/protocol behavior, not default runtime authorization, payment, LEX or Render acceptance.

Separately invoke default handlers as actual approved/unapproved users to verify their runtime checks. For declaration projection, simulate failure after insertion but before acknowledgment: recover the same row, not a second declaration. For custody, retry from the same approved facility; a different facility remains denied. A crash after 'creating' but before insert with zero matches remains pending and retains receipt/history; do not reset it after a timer. Resolve only after operator fencing/reconciliation or a storage uniqueness guarantee. Do not represent that case as automatic exactly-once completion.

## 3. Compliance, rewards, closure and UI

- Server finalization must refuse missing declaration acceptance, restricted/unknown/prohibited screening and stale/customer-supplied decisions before shipment creation. Test mismatched owner/business/quantity/battery/policy approval proofs. New Review creation/approval requires authorized handlers; old unsigned approval rows must not auto-clear booking.
- Direct record_declaration must verify ownership and use stored finalization evidence, ignoring caller-supplied decision/contents. A legacy row without evidence returns review/pending, never a newly invented declaration.
- Positive rewards redemption must be rejected at quote and finalization; never silently reprice an accepted quote. No reward credit is issued from a mutable Payment row. Existing balance/history remains intact. These are denial/safety tests, not payment acceptance.
- Race account closure against finalization/draft creation: endpoint records 202/requested, UI stays signed in and reports a request, no User/Shipment/Quote/history deletion occurs. Actual irreversible closure requires an operator retention review and stopped producers; do not test auth deletion against the approved live accounts.
- Full UI: save flushes an existing draft; 202 retains it without side effects; reopening cannot clear the frozen claim; same-command retry/reconcile preserves identity. Bulk cancellation supplies reason and retains pending items; archive mixed results retain blocked/pending selections/history. CSV creates drafts only; unknown insert acknowledgment stops re-import. Verify bounded array/page shapes, timeline sort and service-row dashboard refresh/admin preview.

## 4. Workflow identity and effects

Record actual Base44 workflow invocation identity and whether owner/admin/session auth succeeds. No anonymous exception or invented platform header is supported. A hosted workflow failing auth is a blocker for operational policy cutover, not a reason to weaken checks.

Test both event workflows with a real service-created signed event. They must load actual source_event_id and send custody_event, without putting a local ID in tracking_id. Forged/legacy unsigned events must not be signed/delivered. Preserve LEX echo-loop checks. Test status alerts using stored status; a conflicting request status is denied.

For synthetic/unknown records, exercise each boundary with a genuinely authorized actor (not merely a 401): dispatchPlatformEvent, retryPlatformEvents, lexPushToHub, notifyShipmentStatus, inbound LEX HMAC/platform sync, partner custody and LEX polling. Require zero dispatch, Carrier, notification/email, fulfillment or provider calls. Source inspection/local stubs alone do not establish live containment.

## 5. Coordinated live prerequisites (later, not authorized by this procedure)

The prior application-schema backup restore prerequisite remains limited to its private report; this package does not reverify a current live backup or migration state. Use the separately approved release handoff before any live change. Confirm current recovery, migration checksums, API/worker revisions/settings and a tested isolation-capable release. Do not update main while a production worker auto-deploy can run.

Provision only after those prerequisites pass. Obtain actual canonical MER IDs and Merchant link IDs, preserve LEX-local identifiers separately, configure each dedicated credential securely, and approve BOTH subjects for each client. Verify four merchant-context combinations separately: Alpha Merchant client subject; Alpha LEX user subject; Beta Merchant client subject; Beta LEX user subject. Each must report its own canonical merchant/client/subject and server isolation. Record non-secret evidence only.

Update/retest the reviewed register with actual IDs. Keep general booking and LEX booking off. A separately approved test-only switch may be enabled only after all relevant hosted policy/authorization/isolation checks pass. This package does not flip it.

LEX lexBridge/lexTransitions/lexUtils and scheduled retry/sweep sources are now supplied and reviewed. Use only the current LEX missing-dependencies list; do not request those exports again.

## 6. Alpha/Beta canonical tests after explicit activation

Use actual approved owner sessions and the controlled intake requests in INTEGRATION-CONTRACT.md. Test cross-business Draft/Quote/local/canonical reads and mutations, wrong/revoked subject/client, pagination and exact-order reconciliation, concurrent same-intent create, same-command retry after lost response, cancellation and lost-cancel response, and supported archive. No replacement commands/drafts to hide ambiguity.

Check local fixture classification before canonical create; require Render acceptance plus exact shipment_id/tracking_id/version/command_id and sandbox_isolated evidence after read/reconciliation. Confirm backend outbox isolation persists through worker delivery attempts, retries and replay, and that operational/Carrier access stays compatible for unrelated authorized records. Use read-only comparisons for real customer traffic, never customer mutation probes.

Report normal Merchant checkout, controlled Merchant intake and LEX lexSandboxBooking separately. Synthetic payment tests remain DISABLED even if canonical tests pass. No real card/setup/deposit/withdrawal/charge/refund/capture is allowed. A signed webhook to a synthetic wallet must be held without credit or notification. Cancel/archive only synthetic rows through supported handlers; retain history.

## Cutover/rollback controls

Production deny-write policies still need an owner-approved coordinated writer cutover. Prepare verified legacy operation cohorts and all affected server handlers first. Freeze affected producers while changing policies/handlers/workflows/key/verified epoch; avoid any interval where signed records are browser-writable. Do not blanket-hold every unsigned production record without prepared grants, and do not globally exempt old rows.

Rollback closes test/general gates and affected producers first. Keep immutable claims, quote reservations/consumption, canonical IDs, signed plans, receipts and history. Do not clear pending state, reopen quotes, regenerate IDs or loosen RLS to make the old UI work. A compatible server-handler rollback/forward repair is required; redeploying older browser-write code alone is unsafe.
