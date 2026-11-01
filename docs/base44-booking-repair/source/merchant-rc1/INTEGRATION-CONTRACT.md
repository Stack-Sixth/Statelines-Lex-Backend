# Coordinated identities and request paths

## Exact identity register (non-secret)

| Field | Alpha | Beta |
|---|---|---|
| Synthetic label | SYNTH-BIZ-0001 | SYNTH-BIZ-0002 |
| Merchant User | 6ae36074e14192b2f7f51dc7 | 6ae36bfacc7ef5a364d5403f |
| Merchant local record | 6ae36089acdf77499fbf16d5 | 6ae36c0f51cbdef3e3e7b3c7 |
| LEX business reference | SBX-BIZ-ALPHA-001 | SBX-BIZ-BETA-002 |
| LEX local mapping record | 6ae34e39a9b77923c0e445ab | 6ae34e396fbaac9f2498224f |
| Actual Merchant DomainMerchantLink ID | UNCONFIRMED / null | UNCONFIRMED / null |
| Canonical merchant | UNCONFIRMED / null | UNCONFIRMED / null |
| Proposed dedicated client | sbx-alpha-lex-01 | sbx-beta-lex-02 |
| Merchant JWT subject | sbx-alpha-lex-01 | sbx-beta-lex-02 |
| LEX JWT subject | 6ac144d7ba5eefb2dc02e410 | 6ad55271cafef064e29ff2dd |
| Merchant credential suffix | SYNTH_A | SYNTH_B |
| LEX credential reference | LEX_SANDBOX_ALPHA | LEX_SANDBOX_BETA |

`local_binding` is informational. Register labels, native app IDs, canonical MER IDs and dedicated client IDs are never inferred equal. The package now explicitly requires a real Merchant link ID; missing mapping is no longer a wildcard. Before activation, update only the reviewed registry's mapping_id/canonical_merchant_id values using actual provisioning evidence and rerun the local tests. Record the new source/package hash. Do not populate these fields with LEX mapping IDs.

## Credential/configuration names (no values)

Keep `BOOKING_RELEASE_ENABLED`, `BOOKING_EXCEPTION_ENABLED`, `EXCEPTION_ISOLATION_CONFIRMED` and `TEST_PAYMENT_ENABLED` false/unset now. Do not turn on LEX booking.

Merchant privately uses:

- `LEX_API_URL`
- `LEX_DOMAIN_SYNTH_A_CLIENT_ID`, `LEX_DOMAIN_SYNTH_A_CLIENT_SECRET`
- `LEX_DOMAIN_SYNTH_B_CLIENT_ID`, `LEX_DOMAIN_SYNTH_B_CLIENT_SECRET`
- `MERCHANT_RECORD_SIGNING_SECRET` (fresh private key after deny-write cutover is verified)
- `MERCHANT_AUTHORITY_POLICY_EPOCH` (operator-controlled version for verified legacy operational cohorts)

LEX separately uses `LEX_SANDBOX_ALPHA_CLIENT_ID`, `LEX_SANDBOX_ALPHA_CLIENT_SECRET`, `LEX_SANDBOX_BETA_CLIENT_ID`, `LEX_SANDBOX_BETA_CLIENT_SECRET` and `LEX_SANDBOX_BOOKING_ENABLED`. Those names are active in the LEX export, not obsolete configuration. The Merchant app does not read them. Keep LEX booking closed. Configure a dedicated pair only in its intended secure stores, never in chat, source or this package. Do not point an obsolete sandbox backend variable at production.

Render keeps existing clients and integrations. Append dedicated merchant-only clients to `API_CLIENTS_JSON` through secure configuration, preserving every existing admin/operator/Carrier/worker client. Provision both required subjects explicitly under each dedicated client through the admin API; a configured signing key alone does not provision SQL authorization. The backend isolation configuration is `SYNTHETIC_BUSINESS_IDS_JSON`, containing only the two approved external business references. Verify the server account actually reports isolation, not merely that a request contains a flag.

For Merchant, JWT iss is the dedicated client, sub is that client ID, aud is `statelines-lex`, role is `merchant`, with valid short-lived iat/exp. LEX uses the same client issuer for that business but its approved authenticated LEX user subject. Do not add caller-asserted merchant_id/sandbox scope to JWTs. Backend SQL resolves the merchant. Actual credentials, subject bindings and four context probes remain unverified/unprovisioned by this patch.

## Three distinct flows

1. **Normal Merchant booking**: customer UI → merchantDraft / requestLiveRate → finalizeShipment → createOrderOnRender → Render canonical API. General release stays closed. Server compliance and saved-card checks are preserved for a future authorized normal release. No normal payment acceptance is claimed.
2. **Controlled Merchant intake**: approved signed-in test user → existing server-owned Draft + test Quote → createControlledTestShipment → same createOrderOnRender → Render canonical API. This is a payment-free, nonphysical test fixture. It is a Merchant harness using the Merchant direct Render command path, not proof that ordinary checkout/payment UI passed.
3. **LEX lexSandboxBooking**: a separate external LEX harness. It is not invoked or enabled by this package and does not establish Merchant-flow correctness.

The new controlled handler accepts only `{draft_id, quote_id}`. Both must belong to the authenticated owner/business. The quote must be standard, 1 lb, declared value 0, no insurance or rewards. The parcel/contacts are fixed synthetic literals, not customer payload. One existing Draft is the shared intent; one existing Quote is the cross-draft consumption boundary. Separate drafts/quotes remain separate intents. Never recover by generating new ones.

After prerequisites and a separately reviewed test-only exception activation, the approved user can use the same app's authenticated SDK:

```js
const draft = await base44.functions.invoke('merchantDraft', {
  action: 'save', step: 0, options: {},
  data: { origin_address: 'Synthetic origin', destination_address: 'Synthetic destination',
          origin_city: 'Synthetic Alpha/Beta', destination_city: 'Synthetic Alpha/Beta',
          weight_lb: 1, declared_value: 0, service_level: 'standard', insurance: false }
});
const quote = await base44.functions.invoke('requestLiveRate', {
  weight_lb: 1, declared_value: 0, service_level: 'standard', insurance: false, rewards_points: 0
});
// Retain these exact IDs before the next request; an ambiguous reply is not permission to make replacements.
const test = await base44.functions.invoke('createControlledTestShipment', {
  draft_id: draft.data.draft.id, quote_id: quote.data.quote_id
});
// Only proceed with a confirmed returned shipment. A pending response requires same-intent reconciliation.
const canonical = await base44.functions.invoke('createOrderOnRender', {
  shipment_id: test.data.shipment.id
});
```

These are post-approval requests, NOT commands to execute now. Use an actual approved owner session. An admin function tester supplying that user's ID is not equivalent. No secret is supplied in any body. If response is 202/pending, keep the same draft, quote, local shipment and canonical command. `merchantShipmentRead` provides owned reads; create/cancel handlers reconcile lost replies with exact merchant/order/isolation/version evidence.

## Effect boundaries

- Local synthetic classification comes from the protected record plus exact registered local/canonical identities. Payload flags and SYNTH prefixes do not grant isolation or let ordinary merchants suppress processing.
- Default finalization cannot book a synthetic payment path. Controlled intake proves fresh backend isolation before local insertion. Canonical create independently re-probes authority, checks the test exception and asserts isolated evidence in the accepted/read-back shipment. A lost response uses the persisted command and read reconciliation, not a new command.
- Backend candidate derives isolation from the server merchant account, persists it on canonical shipment/outbox and excludes dispatch/retry/replay/Carrier paths. This was inspected in source, not verified on the live service in this step.
- Synthetic status/custody, notifications, Carrier/fulfillment and financial endpoints are denied. Canonical create/read/cancel do not confer operational dispatch authority.
- Cancellation stays on supported canonical/local contracts. Archive requires confirmed terminal/cancel state and retains linkage. No direct canonical record deletion is supported.
- Requests without a local/canonical/tracking reference, failed lookups and contradictory references remain contained. Existing authenticated shipless network alerts retain their separate contract.


## Specific external LEX input still required

The Merchant ZIP does not supply LEX's low-level delivery/transition/outbox implementation. The existing LEX review still lists `base44/shared/lexBridge.ts`, `base44/shared/lexTransitions.ts`, `base44/shared/lexUtils.ts` (appendToOutbox), and their scheduled retry/sweep callers as missing. Obtain those exact source files/entrypoints before declaring the separate LEX containment prerequisite complete. Do not request another Merchant export or substitute filename lists for the actual code.
