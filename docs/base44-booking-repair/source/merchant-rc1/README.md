# Merchant policy compatibility and controlled-test patch

Implementation status: completed for the bounded Merchant compatibility/controlled-intake scope below. HOSTED ACCEPTANCE AND LIVE ACTIVATION ARE NOT APPROVED OR VERIFIED. General and test booking remain closed. No production resources, schemas, credentials, deployments, policies or client bindings were changed.

This package supersedes merchant-full-source-review for application. It was built against the full privately downloaded 339-entry Merchant export, ZIP SHA-256 `2d7497d9cc58dda83e62c98e1e34728f6ad0259976ee251b831ac8f666d0e593`. Its public copy can be deleted. The raw archive/source, customer data, backup contents, node_modules, credentials and environment configuration are excluded. Only changed/new files, diffs, hashes, tests and documentation are included. No changes were committed or pushed.

See [BLOCKER-ASSESSMENT.md](BLOCKER-ASSESSMENT.md), [HOSTED-ACCEPTANCE.md](HOSTED-ACCEPTANCE.md), [INTEGRATION-CONTRACT.md](INTEGRATION-CONTRACT.md) and [WRITER-INVENTORY.md](WRITER-INVENTORY.md).

Read POLICY-CORRECTION-2026-10-30.md first: false create/update policies were replaced locally with admin-only rules; the old admin-session denial claim is withdrawn. The disposable LEX probe verified that policy pattern; actual Merchant entity enforcement and handlers remain unverified.

## What is implemented

- Full-file Track/CreateShipment patches; no excerpt transforms. Explicit server customer-edit allowlists, protected command/frozen/cancellation/test fields, single-record CAS ownership (`updated === 1`), same-identity retry/reconciliation, safe quote reservation/consumption, archive instead of deletion, retained ambiguous state.
- All finalizer Draft/Shipment writes use service storage after authenticated owner/business authorization. Service-role capability never substitutes for authorization. Browser-created claims are untrusted; legacy canonical reconciliation is read-only until safe identity is established.
- Server compliance screening runs against the stored declaration, not the browser decision. Its accepted decision and declaration freeze in the shipment snapshot. Declaration and creation-notification projections use signed plans on the protected Shipment, one CAS insert owner and read reconciliation after a lost reply. A retry resumes without repeating card/compliance calls after a claim exists.
- A compliance approval bypass found in the full source is closed: owner-created 'approved' rows no longer confer authority. Review requests/decisions go through authorized server handlers; approvals are signed and bound to review ID, business, contents, quantity, battery details and policy version. Direct ordinary-user Review/Declaration mutations are denied; the admin review UI uses the authorized handler. Old approvals need explicit re-review, not blind blessing.
- Custody status CAS atomically saves receipt, history and signed event/audit plans. Recovery reuses those plans. It never repeats an uncertain insert or expires an owner's lease. Facility/operation authorization applies on retries too. Before-insert crashes with zero matches remain pending for review; that is a deliberate storage limitation, not a claimed transaction.
- Self-service closure records an authenticated audit request and returns 202. It no longer deletes User or shipping history after a racy preflight. The UI reports a request, not completed deletion. Irreversible closure remains an operator retention/freeze operation; the patch does not invent a global account-lock infrastructure.
- A dedicated `createControlledTestShipment` intake exists for the two exact synthetic businesses. It accepts only existing Draft/Quote IDs, requires the approved signed-in Merchant user, protected Merchant link, verified dedicated client, fresh backend-reported isolation and explicit test release. It freezes server-defined synthetic parcel data, consumes the existing quote via the same CAS boundary, and calls no payment, notification, Carrier or dispatch integration. `createOrderOnRender` performs its own fresh authority/isolation checks before the canonical command. The old platform-client harness stays disabled.
- Synthetic saved-card/setup/default/detach/deposit/withdraw flows are denied before provider access. Synthetic rewards are disabled. Ordinary production billing contracts remain in place; this agent made no real provider calls.
- The source has no trustworthy shipment-capture receipt writer. Reward issuance now returns a safe deferred result instead of creating withdrawable credit from mutable Payment rows. Caller-supplied rewards cannot discount new quotes/bookings. Existing balances/credits are retained; no financial history is deleted or repriced silently. A trustworthy payment/reward ledger is a separate project, not an Alpha/Beta dependency.
- Direct ordinary-user ShipmentEvent writes are denied, workflow event IDs resolve persisted server-issued events, invalid local-ID-as-tracking mapping is removed, inbound authentication mechanisms remain unchanged, and operational classification precedes effects. New service-created own reads/timelines/admin controls and dashboard refresh are accounted for. No authentication exemption was added for workflows.

## Actual local verification

- **84 handler/storage-model/crypto tests passed, 0 failed** at final verification.
- **3 full-file UI handler tests passed, 0 failed**: pending finalization retains the draft; cancellation retains pending selection; archive retains blocked rows.
- **83 backend TypeScript syntax transforms passed**; development-only hosted harness syntax passed. These are not hosted runtime/type checks.
- Full Vite production build passed, with large-bundle warnings.
- Full frontend typecheck failed with 367 diagnostics versus 370 in the untouched export using the same dependency installation. Zero new normalized diagnostic signatures. Existing unrelated failures were left alone.
- ESLint is blocked by the export's missing ESLint 9 flat configuration.
- Hosted Base44 policies/CAS/workflow identity/default runtime, Render live revision/settings/isolation, four merchant-context probes, payments, LEX and Carrier end-to-end behavior are **UNVERIFIED**. No live tests are claimed.

Render source candidate `1ae720e2d7977a9e1ca66a1f620f20af6fa2a067` was inspected: isolation derives from the server merchant account and is excluded from operational delivery/Carrier reads. Backend source was not changed, so no new backend CI run was triggered. Its deployment and actual configuration still require the coordinated release checks.

## Remaining activation blockers

1. Run hosted acceptance in an existing isolated Base44 development copy: real deny-write policies, real conditional/nested CAS, actual SDK creator metadata, artifact recovery and default handler authorization. Do not substitute destructive production probes or buy resources.
2. Confirm the actual Merchant DomainMerchantLink IDs and canonical MER IDs for Alpha/Beta. LEX-local mapping IDs are preserved separately and do not satisfy Merchant link identity. Configure dedicated secrets privately; register each exact subject. Do not remove existing clients.
3. Verify/deploy the isolation-capable backend API and matching worker only through the separately authorized coordinated rollout after migration/backup/compatibility prerequisites. No current live revision/configuration is certified by this package. Verify all four contexts and backend isolation before enabling even a test exception.
4. Superseded source request (these LEX files are now supplied and reviewed; use the current LEX missing-dependencies list instead): `base44/shared/lexBridge.ts`, `base44/shared/lexTransitions.ts`, `base44/shared/lexUtils.ts` (appendToOutbox) and their scheduled retry/sweep entrypoints. Complete that separate source/hosted containment acceptance; distinguish LEX harness evidence from Merchant direct booking evidence. Actual workflow actor identity remains a hosted operational cutover check. Synthetic canonical tests must not trigger operational workflows; prove denial with real authorized actors before opening their exception.
5. Resolve the external production-writer inventory and protected legacy operation-grant cohorts before production deny-write cutover. Do not blanket-protect old rows without preparing their legitimate operational handlers/grants.

Independent paid-reward/capture, repeated ordinary status-email delivery, general wallet-settlement idempotency and unlimited-history pagination are documented, not claimed fixed or tested. They are outside the isolated intake; synthetic money paths are blocked. This is not approval to open general paid booking.

## Reproduce the local review

In a private disposable directory, place a complete reviewed export at `candidate/`; verify manifest baseline hashes and overlay the changed-file subset. Place `tests/` beside it. Do not build the subset alone. With Node 24.22.1 and the app's reviewed dependencies installed with lifecycle scripts disabled:

```sh
node --experimental-transform-types --test tests/handlers.test.ts tests/storage-probe.test.ts
node --test tests/full-ui.test.mjs
```

The full-UI tests use esbuild 0.25.12 from the app's dependencies. Run `npm run build` and `npm run typecheck` inside the complete candidate. Real-store acceptance files under tests/hosted are development-only and must never be deployed to production.


Merchant pull v2 receiver is now prepared in the existing lexSyncEndpoint, using the same challenge/response protocol as LEX and a pre-provisioned admin-only LexPullPeer nonce record. Existing legacy token/admin reads remain available until explicit coordinated retirement. V2 scopes to approved local Merchant IDs, requires a dedicated private key, and never substitutes a native row ID for tracking. Receiver support and hosted URL/proxy semantics must be verified before LEX switches; no configuration or key was changed.

## Final release classification

Version 2026.10.31-rc1 is ready for selective application to a complete existing review/development copy with gates closed and outbound/payment credentials absent. It is NOT approved for blanket production policy cutover. No paid copy is required or authorized; if no suitable existing copy exists, application/hosted acceptance remains blocked. Use APPLICATION.md.
