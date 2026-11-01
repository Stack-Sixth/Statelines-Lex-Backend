# Affected writer and effect inventory

Audited the full source tree, including dynamic `entities[name]` calls, helper aliases, workflow definitions and browser components. `call-sites.json` is a searchable source index, not a claim that a regex alone proves authorization.

| Owning path | Authority / replacement | Cutover treatment |
|---|---|---|
| useShipmentDraft | merchantDraft authenticated owner + unique immutable creator-business match; server create/update; edit_revision CAS | Verify real SDK null/absent comparisons, concurrent tab, timeout, reload and allowed customer fields |
| IncompleteShipments | merchantDraft discard CAS, retained history | No physical deletion; claimed/changed drafts stay visible |
| finalizeShipment / casBooking | authenticated owner + protected draft proof + explicit business; service create/stamp, quote reservation/consumption CAS | Verify real storage concurrency and every crash boundary; no blind retry of uncertain insert |
| requestLiveRate | authenticated sender + owned business, service quote create | No email-based authority fallback; suspended/revoked sender denied |
| Track | cancelOrderGate, cancelOrderOnDomain, archiveMerchantShipment | Pending is not success; archive only after supported terminal/cancel evidence; preserve canonical linkage |
| BulkImportModal / extractShipmentsCsv | parser only; rows passed to merchantDraft allowlist | Draft-only product change; uncertain create held; imports are not uniquely deduplicated across sessions |
| createOrderOnRender | owner/provenance, fresh DomainMerchantLink/backend authority, frozen CAS command, canonical read reconciliation | Same command on retry; no old browser-command adoption |
| cancelOrderOnDomain / cancelOrderGate | authorized read evidence + protected command state, CAS cancellation identity | Canonical ID, merchant, order, version and isolation evidence checked; ambiguous outcome pending |
| archiveMerchantShipment | parent owner, canonical terminal/cancel verification, local lifecycle CAS | Archive, never delete; ambiguous cancellation stays visible |
| createTestShipment | old harness closed with explicit denial | Do not revive it with production platform credentials |
| prepareTestShipment | admin-only read-only review | No generated command IDs or legacy mutation |
| reviewLegacyShipment / LegacyShipmentAuthority | admin preview, independently derived owner/business, current snapshot digest, policy epoch, explicit fixed principal grants | New protected entity; no command blessing; duplicates fail closed, revoke via CAS, serialized operator review |
| lexWebhookReceiver | unchanged raw-body HMAC verification; strict persisted reference/operation authority | Guard precedes shipment writes/events/notifications; failed isolation/lookup does not acknowledge successful application |
| carrierSyncReceiver / opsSyncReceiver / platformSync | unchanged shared secret; fixed platform_sync authority principal | Same token is same security principal; status/carrier/event effects need per-record authority; network_alert remains authenticated shipless contract |
| partnerCustody | protected approved PortalMembership, approved location, allowed transition + CAS + operational grant | Lookup scoped too; signed event/audit plans and receipt stored in status CAS; hosted recovery acceptance required |
| ShipmentEvent service writers / artifactProjection | fixed authorized entity allowlist, signed parent-bound plan; one CAS insert owner, lost-ack reconciliation; custody evidence atomic with status | New event policies; forged workflow source events cannot trigger signed forwarding; zero-match uncertain insert remains held |
| deleteMyAccount / DeleteAccount UI | authenticated audit request only, 202/requested; no auth or history deletion | Closure requests work while concurrent booking proceeds safely; irreversible closure is a later operator retention/freeze action |
| dispatchPlatformEvent / retryPlatformEvents / platformDispatch | authenticated owner/admin and trusted persisted classification before outbound; event retries re-resolve | Synthetic/unknown denied before signing/delivery; workflow source event must have server provenance |
| lexPushToHub | existing admin auth; trusted source-event lookup and classification | Never sign raw workflow body; no local ID supplied as tracking ID |
| notifyShipmentStatus | existing authenticated owner/admin + persisted classification | Hosted automation actor and repeated notification idempotency remain acceptance items |
| lexSyncEndpoint | existing shared-token/admin read gate; service polling filtered by operational classification | Synthetic/unknown never exported to operational platforms; bounded poll is not complete replication |
| pudoShipmentSync | existing approved membership, now approved-location read scope | A scan string alone is not cross-tenant authorization |
| awardShipmentRewards / requestLiveRate / finalizer / UI rewards | service owner check; no credit without trustworthy capture receipt; unverified rewards redemption denied | Balances/history retained; future paid reward-ledger implementation is independent of Alpha/Beta |
| validateShipmentCompliance / complianceBooking / declarationProjection | default finalizer screens stored declaration; frozen evidence plus signed once-only artifact projection; direct declaration action authorizes parent | Real-store/default runtime acceptance remains required; no caller decision is trusted |

## Six exported workflows

1. Daily Learning Cycle → generateLearnings: no Draft/Shipment/Quote writes found; reads learning/activity inputs. Preserve scheduled actor permissions.
2. Notify Approved Partner Applicants → sendPartnerApprovalGmail: PartnerApplication approval effect; outside shipment-write deny rules. Verify no approval regression.
3. Route Partner Applications to LEX → forwardPartnerApplicationToLex: application integration; no target shipment writes. Preserve its existing transport contract.
4. Send Live Feed to LEX → dispatchPlatformEvent: ShipmentEvent create; corrected to custody_event + actual source_event_id, checked persisted event.
5. Push Package Events to LEX Hub → lexPushToHub: corrected local-ID/tracking mismatch, persisted source event and known event type. Preserve LEX echo-loop guard.
6. Shipment Status Alerts → notifyShipmentStatus: Shipment update delivered/delayed. Must prove hosted invocation identity and idempotency; containment uses stored classification.

No additional scheduled shipment writer was found in these exported definitions. This does not inventory external dashboard-only jobs, external apps or operator scripts. Owner must export/confirm those before production deny-write cutover.

## Legacy provenance treatment

Ownership is derived from immutable native creator + exactly one owned business, or the protected quote's consumed_by_shipment_id association with consistent owner/business. Mutable contact_email, merchant_id, command_id, caller flags, SYNTH prefixes and quote_id alone do not grant authority. Sender policy uses protected membership; approved partner access uses protected membership/location.

Operational grants freeze a reviewed routing/identity snapshot in an admin-only authority record. A changed snapshot, revoked grant, wrong principal, conflicting references, multiple approvals or failed lookup holds only that shipment/effect. Preserve records and protected evidence. Admin approval does not turn an old command into trusted creation history. Read-only canonical reconciliation must precede any attempt to change a possibly submitted identity.

Existing verified production traffic must be inventoried and approved in cohorts under a controlled policy cutover. Do not deploy the authority checks first and thereby unexpectedly hold every unsigned production row. Do not globally exempt unsigned rows either. Unknown cases remain in review; unaffected verified cohorts continue with explicit operation grants.


## Added/changed owners in the finished bounded patch

| Path | Authorization/effect boundary |
|---|---|
| createControlledTestShipment | Only approved authenticated synthetic owner, existing trusted Draft/owned Quote, fresh backend isolation, exact real Merchant link, explicit test exception. Server fixture only; normal Render command path remains separate. |
| prepareTestShipment / RenderTestShipmentControl | Read-only admin preview; legacy create button disabled; no command mutation or platform-client fallback. |
| ComplianceReview entity + request_review + approve/reject/request_info | Direct ordinary-user writes denied; admin/service role remains trusted; protected owner/business request, admin role plus independent review/business ownership, CAS decision, signed exact approval proof. ComplianceReviewPage uses controlled list/action handlers. |
| ShipperDeclaration entity + declarationProjection | Direct writes denied; protected parent evidence, once-only projection with original signed plan; no browser-paid/compliance authority. |
| artifactProjection | Dynamic entity access constrained to ShipmentEvent, ShipperDeclaration, Notification, AuditLog. Parent signature/document verification, protected slot, one insert winner. Unknown create acknowledgment is reconciled by nonce plus exact payload, never blindly repeated. |
| custodyRecovery | Parent status, immutable receipt/history and signed plans in one CAS; retry recovers event/audit, facility and operation authorization retained by handler. |
| syntheticPaymentGuard / stripeCustomer / listPaymentMethods / createCardSetupSession | Exact registered business guard runs before provider access. Shared authorization covers setup intent, detach and default changes. |
| walletDeposit / walletWithdraw | Account-scoped calls have no business selector; approved synthetic wallet requests denied before provider/debit effects. Other users' wallet logic is unchanged. |
| stripeWebhook | Existing signature/auth contract preserved. Authenticated synthetic wallet events are held/audited before credit or notification; no automatic charge/refund is introduced. |
| notifyShipmentStatus | Persisted status must match requested status; original owner/admin authentication and containment remain. Exactly-once ordinary email delivery is not claimed. |
| own dashboard / admin diagnostic reads | Server-owned rows visible through authorized own/admin handlers; own dashboard polling refreshes service rows rather than relying on old creator-only SDK subscriptions. |

All six exported workflows retain their existing authenticated invocation requirements. No new schedule, anonymous hook or global event-routing bypass was added. Actual workflow actor and external dashboard-only writers still need hosted inventory/acceptance.
