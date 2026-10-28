# Merchant authorization: coordinated integration handoff

## Confirmed cause and authority

The previous canonical create route compared `body.merchant_id` directly with the JWT issuer (`actor.clientId`). That conflated a service credential such as `statelines-merchant` with a merchant identity. Legacy reads/mutations used `owner_user_id === sub`, which did not establish a consistent tenant boundary. This repository had no merchant provisioning/membership registry. The exact scope error originated in `/api/v1/shipments`, not the flat `/v1/shipments` route described in the LEX handoff.

This change establishes a dedicated credential per merchant, an explicit immutable client-to-merchant binding, and an allowlist of authenticated user/service subjects. Render generates a stable `MER_<32 lowercase hex>` ID. Multiple clients can belong to one merchant, but a client cannot be rebound to another merchant. Approved members share that merchant's shipments; `owner_user_id` remains creator attribution, not authorization. Admin/operator retain operational access; carriers retain assigned-shipment access. Platform credentials do not gain shipment access. Tracking IDs are identifiers, not public access tokens; no public tracking or quote endpoint is added. Event reads and wallet approvals retain their existing privileged policies.

Migration `005_merchant_authorization.sql` adds accounts, service clients, client subjects and authoritative shipment scopes, with foreign keys, indexes and RLS. Existing shipments, canonical references, commands, snapshots and outbox events are not reassigned or rewritten. Both shipment APIs now use the same tenant boundary. Authenticated merchant creates insert their scope in the shipment transaction. Caller-provided merchant identity cannot grant access.

**Compatibility qualification:** shipment payload shapes, canonical IDs, tracking, transitions, CAS, delivery signing and nonmerchant authorization remain supported. Merchant authorization now deliberately fails closed without provisioning. Existing merchant traffic needs the coordinated setup below before reopening booking. Do not describe this as a configuration-free rollout.

## Configuration and provisioning

1. Keep booking gated in Merchant's `DomainMerchantLink`. Apply migration 005 with the existing migration runner before starting the new code. Deploy both API and worker code against the migrated database. Keep existing domain feature flag values; provisioning/context endpoints require authentication but are available independently of those flags.
2. Generate a separate secret privately for each merchant client. Append an entry to the existing Render `API_CLIENTS_JSON` array, preserving EVERY existing LEX/NOC/Carrier/client entry:

   ```json
   { "id": "merchant-acme", "secret": "<MERCHANT_ACME_SECRET>", "roles": ["merchant"] }
   ```

   This is one entry, not a replacement array. The existing JSON parsing semantics are unchanged; there is no separate dynamically stored secret registry. The configured secret must satisfy the existing minimum 32-character validation. Do not reuse webhook signing keys. Restart/redeploy all API instances after configuration changes. A shared mixed-role client remains usable for its existing nonmerchant roles, but cannot act as a merchant.

3. Using an existing authorized **admin** service JWT, provision the merchant:

   ```http
   POST /api/v1/merchants
   Authorization: Bearer <ADMIN_JWT>
   Content-Type: application/json

   {"command_id":"<NEW_UUID>","name":"Acme","external_reference":"<VERIFIED_BASE44_BUSINESS_ID>"}
   ```

   Returns 201 `{"merchant":{"merchant_id":"MER_...","name":"Acme","external_reference":"...","active":true,"version":1}}`. Save this returned ID in the admin-managed DomainMerchantLink. External reference is unique. Repeat the exact command/payload/identity after a timeout; do not issue a new ID for the same attempt.

4. Bind the configured client and verified server-authenticated subjects:

   ```http
   POST /api/v1/merchants/MER_<RETURNED_ID>/service-clients
   Authorization: Bearer <ADMIN_JWT>
   Content-Type: application/json

   {"command_id":"<NEW_UUID>","client_id":"merchant-acme","subjects":["<BASE44_AUTHENTICATED_USER_ID>","<APPROVED_RECONCILIATION_SERVICE_SUBJECT>"]}
   ```

   Returns 201 `{client_id,merchant_id,active:true,version:1,subjects}`. The client must already exist in Render config with ONLY the merchant role. Register subjects only after verifying business membership; never accept them from an untrusted booking body. There is no public/self-service enrollment. No secret is stored in the database or returned by these endpoints.

5. `GET /api/v1/merchants/MER_<ID>` with admin JWT returns `{merchant,clients}` for inspection. Merchant JWT `GET /api/v1/merchant-context` returns `{merchant_id,client_id,subject,authorization:"active"}`. Check it against DomainMerchantLink before enabling booking.
6. Admin membership/revocation uses `POST /api/v1/merchant-service-clients/<CLIENT_ID>/authorization` with `{command_id,expected_version,active,subjects}`. This replaces the complete subject list (1–500 unique IDs), increments version and cannot change merchant identity. Admin `POST /api/v1/merchants/MER_<ID>/status` accepts `{command_id,expected_version,active}`. Missing/stale versions return 409. Retrying the exact successful command is safe. Every provisioning/change command is audited. Revocation is checked on each new authenticated request; already executing requests may complete.

## JWT and Base44 changes

There is no Render token issuance endpoint. The trusted Base44 server signs HS256 using the selected merchant client's secret:

```json
{
  "iss": "merchant-acme",
  "aud": "statelines-lex",
  "sub": "<APPROVED_AUTHENTICATED_SUBJECT>",
  "role": "merchant",
  "iat": 1700000000,
  "exp": 1700000120
}
```

The timestamps above illustrate a 120-second lifetime; generate current Unix seconds at request time. Existing validation remains HS256, exact configured issuer, audience `statelines-lex`, required sub/iat/exp/iss/aud, allowed role, maximum 300-second lifetime/token age, 5-second clock tolerance. Send `Authorization: Bearer <JWT>`. No merchant/tenant/scope/permissions/delegation claim is needed or trusted; recognized scope-assertion claims are rejected. Invalid signatures remain 401.

Base44 secrets: `LEX_API_URL=https://statelines-lex-backend.onrender.com`; each credential-key reference in DomainMerchantLink must resolve server-side to its dedicated client ID and secret. For a single configured pair, the existing names remain `LEX_SERVICE_CLIENT_ID=merchant-acme` and `LEX_SERVICE_CLIENT_SECRET=<MERCHANT_ACME_SECRET>`. For multiple merchants, use separate secret pairs with distinct names selected only through the verified admin mapping. Do not overwrite the shared pair and route all merchants through it. Exact secret-key naming in the external credential resolver needs its source; Render does not prescribe those names.

Merchant must derive its app merchant from the authenticated session and verified business membership, resolve the approved DomainMerchantLink, select that credential server-side, and sign with an approved actual user/service `sub`. Do not use request merchant IDs to select credentials. Retain the existing gate. LEX's merchant user proxy must use this same trusted resolution, or Merchant may call Render directly from its server. Keep rejecting caller scope overrides. LEX admin/operator workers keep their existing explicit roles/credentials; do not convert them into unrestricted merchant credentials.

## Shipment and reconciliation contracts

- Canonical create: `POST /api/v1/shipments` (requires `MERCHANT_DOMAIN_API_ENABLED=true`). Retain current logistics fields: UUID command_id, order_id, correlation_id, optional external_shipment_id, origin/destination objects with corridor, service_level, package_size, positive weight_kg, pickup_deadline/delivery_deadline ISO timestamps. `merchant_id` may be omitted; if supplied it is only an equality assertion against the server binding. No owner override or pricing/quote fields are accepted. Response remains 201 `{command_id,correlation_id,shipment}` with canonical shipment_id, tracking_id, version and resolved merchant_id.
- Legacy `POST /v1/shipments` retains its flat logistics schema and required deadlines. Its authenticated merchant owner restriction remains; merchant_id is not a new body field. Newly created merchant shipments are scoped automatically. No quote implementation is introduced here.
- Canonical list/read/preflight need `DOMAIN_READ_API_ENABLED=true`. Reconcile with `GET /api/v1/shipments?order_id=<URL_ENCODED_ORDER_ID>&limit=50`. Optional `merchant_id` must match the binding; it cannot choose another tenant. `GET /api/v1/shipments/<SHP_ID>` returns `{shipment,history}`. `/cancellable` remains supported.
- Both `/v1/shipments` and `/api/v1/shipments` accept `limit` (default50, 1–100), `after`, `status`, `order_id`, `merchant_id`, returning `{items,next_cursor}`. Canonical cursors are SHP IDs (UUID accepted); legacy cursors are UUIDs. Follow next_cursor until null. A cursor from another merchant returns 404. Filters always intersect authorization; order IDs can be reused by different merchants safely. Legacy listing retains its existing unknown-query-field stripping behavior; unknown fields cannot expand access. Canonical listing remains strict. Status is one of the existing shipment lifecycle enum values; an invalid value fails400.
- Canonical cancel remains `POST /api/v1/shipments/<SHP_ID>/cancel` with command_id, expected_version, correlation_id, reason. Legacy transitions retain their existing shape and allowed states. Other-tenant IDs return404 before exposing version information.
- Command UUIDs remain globally unique. Same identity, action and input replay returns the same result; tenant/client/subject changes conflict409 rather than disclose another result. Do not change subject/client or payload on retries. Canonical `(merchant_id,order_id)` uniqueness prevents a second booking with a new command; reconcile on that merchant/order after an ambiguous response. Do not retry through the other API generation with a fresh command: `/v1` has no order-based deduplication contract. Merchant must retain the original command ID across network retries and preserve the existing quote/charge state machine.

Domain errors are `{error:{code,message,correlation_id}}` with uppercase codes; legacy errors retain their flat lowercase contract. Relevant domain errors: 401 UNAUTHORIZED (token), 403 INVALID_MERCHANT_CLIENT (mixed-role credential), MERCHANT_NOT_PROVISIONED, MERCHANT_SUBJECT_FORBIDDEN, MERCHANT_CLIENT_REVOKED, MERCHANT_INACTIVE, MERCHANT_SCOPE_MISMATCH; 404 NOT_FOUND for inaccessible shipments; 409 COMMAND_CONFLICT, CONFLICT (duplicate binding/order/external reference), VERSION_CONFLICT; 422 INVALID_MERCHANT_CLIENT during binding of an unconfigured/non-dedicated client. Keep booking blocked on auth/mapping errors; do not fall back to an admin token.

## Legacy data, deployment and rollback

No automatic legacy backfill is safe from `owner_user_id` or the string `statelines-merchant` alone. Old unscoped rows remain readable by authorized operations and assigned carriers but not by merchant credentials. Existing snapshots are immutable. Before migrating any legacy row, obtain verified app business/order-to-shipment evidence, resolve ambiguous/shared records, review collision risks and prepare an audited per-record migration separately. Existing legacy commands predating derived scope must be reconciled by operations; do not generate replacement bookings after their retries fail. This change does not perform that migration.

Staging order: migrate, deploy, configure credentials, provision bindings/subjects, verify context, update trusted Base44 credential selection, run isolated booking/retry/reconciliation/cancel tests, then enable the mapping gate for verified merchants. Keep domain feature flags under existing release control. API and worker must build TypeScript (`npm run build`) before start; stale tracked dist files are not deployment inputs after the build.

Rollback: close Merchant booking gates and suspend affected merchant clients/traffic first. Preserve additive migration tables and all shipment/command/event data. Do not blindly roll back to owner-only authorization while merchant traffic remains enabled. Coordinate credential removal/rotation across API instances and Base44; do not delete existing clients belonging to other integrations. No production changes or deployment were performed for this fix.

## Required external verification

Repository tests can verify JWT scope, authorization, command retries, scoped reconciliation, shipment transitions, assigned-carrier access and delivery-worker contracts. They cannot establish that the submitted Rork binary or external quote/payment implementation uses them correctly.

Provide these LEX sources for coordinated verification: `base44/shared/lexRenderJwt.ts`, `base44/functions/lexApi/entry.ts`, and the actual source files for `lexSyncEngine`, `lexEngineSync`, `lexSyncCarriers`, `lexEngineCleanup`, `testRenderDomainApi`. Verify which deployed proxy route produced the original403; the reported flat create payload is not the canonical create contract.

Provide Merchant's DomainMerchantLink model/admin provisioning handlers; authenticated business-membership and credential resolver; JWT signer; quote issuance, validation, reservation/consumption, price/parcel integrity checks; payment/charge idempotency; booking submission and retry persistence; reconciliation handlers. Exact filenames/function names are not yet known. Test tampered prices/parcels, missing/consumed quotes, retries after charge/Render timeouts, exactly-once charge/consumption and isolated order recovery there. These protections remain **unverified**, not reimplemented in Render.

Provide the Rork gateway's token/credential adapter, shipment list/read/transition requests and response/error parsing, plus the submitted build/version contract. Backend regression tests preserve its existing assigned-carrier path; actual Rork integration remains **unverified**. Production booking is not claimed fixed until the coordinated deployed flow passes.

## Verification for this change

Local verification: `npm run typecheck` passed; `npm run build` passed; `npm test` passed **61/61**, with zero failures/skips, using isolated PGlite. Coverage includes concurrent retries, two tenants sharing a subject/order, both API generations, cross-tenant cursors and mutations, forged credentials/claims, provisioning, membership, revocation, suspension, pagination, existing carrier access and delivery workers. `git diff --check` passed. Repository-wide `npm run format:check` fails only on the pre-existing unrelated `docs/deployment-guide.md`; that file was not modified.

The PostgreSQL 17 upgrade/production-runner verification harness and CI workflow were extended for migration005, including an assertion that it does not infer merchant bindings or legacy shipment scopes. That PostgreSQL17 job has **not been executed for this change** locally (no PostgreSQL server executable available). Run it before production rollout. External Base44 quote/payment tests, submitted Rork integration and production booking remain unverified. No deploy, production shipment creation or charge was performed.
