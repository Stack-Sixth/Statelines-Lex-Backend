# LEX API v1

All paths except /health/live and /health/ready require an Authorization bearer token. Use Content-Type: application/json. Requests are limited to 64 KiB; the initial per-instance rate limit is 120 requests/minute per issuer/user.

## Authentication

Trusted server adapters issue HS256 JWTs with a configured API_CLIENTS_JSON secret. Required claims:

```json
{
  "iss": "base44",
  "aud": "statelines-lex",
  "sub": "verified-user-id",
  "role": "admin",
  "iat": 1700000000,
  "exp": 1700000120
}
```

The timestamps above illustrate structure; use current timestamps. Maximum lifetime is five minutes. Issuer roles are allowlisted. Keep keys and token generation out of browser code. The Base44 adapter verifies the Base44 session before constructing claims.

For an authenticated server script using the installed `jose` package:

```js
import { SignJWT } from 'jose';
const token = await new SignJWT({ role: 'admin' })
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuer(process.env.LEX_CLIENT_ID)
  .setAudience('statelines-lex')
  .setSubject('your-verified-operator-id')
  .setIssuedAt()
  .setExpirationTime('2m')
  .sign(new TextEncoder().encode(process.env.LEX_CLIENT_SECRET));
```

Do not expose that script as a public token-minting endpoint. A service secret grants its issuer the ability to assert its permitted roles.

## Commands and versions

Every POST body requires command_id, a UUID generated once per intended action. Retry the SAME payload with the SAME ID after a network failure. A different payload or identity using the same ID returns 409. Shipment mutations also require expected_version from the latest retrieved shipment.

## Endpoints

| Method/path                            | Roles                           | Purpose                                             |
| -------------------------------------- | ------------------------------- | --------------------------------------------------- |
| GET /health/live                       | public                          | Process is running                                  |
| GET /health/ready                      | public                          | Database/schema available                           |
| GET /v1/operations/health              | admin/operator                  | Actual worker and delivery health                   |
| POST /v1/shipments                     | admin/operator/merchant         | Create shipment                                     |
| GET /v1/shipments                      | admin/operator/merchant/carrier | List visible shipments                              |
| GET /v1/shipments/:id                  | same                            | Shipment and ordered history                        |
| POST /v1/shipments/:id/match           | admin/operator                  | Assign eligible carrier and reserve capacity        |
| POST /v1/shipments/:id/transitions     | restricted by state/ownership   | Advance workflow                                    |
| POST /v1/shipments/:id/wallet-approval | admin                           | Record one delivery compensation approval           |
| POST /v1/carriers                      | admin/operator                  | Register carrier user and trip                      |
| GET /v1/carriers                       | admin/operator                  | List carrier schedules and reservations             |
| POST /v1/destinations                  | admin                           | Register signed webhook receiver                    |
| GET /v1/destinations                   | admin                           | List receivers without secret values                |
| POST /v1/destinations/:id/status       | admin                           | Activate/deactivate receiver                        |
| POST /v1/destinations/:id/backfill     | admin                           | Queue a bounded historical event page               |
| GET /v1/deliveries                     | admin/operator                  | Inspect delivery state                              |
| POST /v1/deliveries/:id/replay         | admin                           | Replay dead-letter or accepted/unconfirmed delivery |
| POST /v1/deliveries/:id/processed      | owning platform client          | Confirm downstream processing                       |

List endpoints for shipments/carriers/deliveries accept limit (1–100, default 50) and after (previous next_cursor). Delivery lists also accept status. Results are `{items,next_cursor}`. A full final page may require one additional empty request. These are live keyset scans, not snapshot exports.

## Create shipment

```json
{
  "command_id": "<UUID>",
  "origin": "Lagos",
  "destination": "Abuja",
  "weight_kg": 2,
  "package_size": "small",
  "service_level": "standard",
  "pickup_deadline": "<future ISO timestamp>",
  "delivery_deadline": "<later ISO timestamp>"
}
```

Optional owner_user_id is available to operators/admins. Merchants can create only for themselves. Route names are trimmed, lowercased and whitespace-normalized, then compared exactly. Adopt consistent corridor identifiers across apps. Weight supports up to three decimal places. Services: standard, express, same_day, overnight. Packages: small, medium, large, xl.

## Register carrier

```json
{
  "command_id": "<UUID>",
  "user_id": "<verified carrier user ID>",
  "name": "Carrier name",
  "origin": "Lagos",
  "destination": "Abuja",
  "service_levels": ["standard"],
  "package_sizes": ["small", "medium"],
  "departure_at": "<future ISO timestamp>",
  "arrival_at": "<later ISO timestamp>",
  "capacity_kg": 25
}
```

One carrier record per user. To plan another trip, POST to /v1/carriers/:id/schedule with command_id, origin, destination, service_levels, package_sizes, departure_at, arrival_at, capacity_kg and active. Schedule changes are rejected while capacity is reserved. Matching requires departure not in the past, departure by pickup_deadline, arrival by delivery_deadline, supported service/package, exact corridor and available capacity.

## Matching and transition

Match: `{"command_id":"<UUID>","expected_version":1}`. Optional carrier_id restricts selection, but does not bypass eligibility.

Transition: `{"command_id":"<UUID>","expected_version":2,"status":"picked_up"}`.

Exception, recovery and return commands require a note. See ARCHITECTURE.md for permissions and state rules. All returned shipment versions must replace stale UI versions.

## Wallet approval

```json
{ "command_id": "<UUID>", "expected_version": 6, "amount_minor": 250000, "currency": "NGN" }
```

250000 minor units is NGN 2,500.00. Supported currencies initially: NGN, USD, GBP, EUR, CAD. Use integer minor units, never floating-point money. This event authorizes the specified amount; it does not price the shipment, transfer funds or prove payment. The actual wallet must verify its own policy and enforce operation_key uniqueness.

## Destination and backfill

```json
{
  "command_id": "<UUID>",
  "name": "Travel Wallet",
  "client_id": "wallet",
  "url": "https://your-wallet-host.example/webhook",
  "secret_ref": "wallet_webhook",
  "event_types": ["WalletApprovalCreated"]
}
```

The hostname must appear in WEBHOOK_ALLOWED_HOSTS. The secret reference must exist in WEBHOOK_SECRETS_JSON on both processes. client_id must map to an API issuer allowing platform role. HTTPS port 443 and public IPv4 resolution are required.

Status: `{"command_id":"<UUID>","active":false}`.

Backfill: `{"command_id":"<UUID>","from":"<ISO timestamp>","to":"<ISO timestamp>","limit":100}`. The date interval is inclusive from, exclusive to. Follow next_cursor using after and a NEW command_id per page. Keep the date bounds fixed and historical to avoid concurrent inserts changing pagination. Existing delivery records are not duplicated or reset; use replay for failed existing deliveries.

Replay: `{"command_id":"<UUID>","note":"Receiver repaired"}`. Reuses event ID and delivery ID; receiver must deduplicate effects.

## Webhook protocol

The JSON body is a version-1 event envelope. Header X-LEX-Timestamp is current Unix seconds; X-LEX-Signature is `v1=` followed by HMAC-SHA256 hex of `timestamp + '.' + exactRawBody`. X-LEX-Delivery-Id identifies the sender delivery record for processing receipts. Receivers verify body signatures within five minutes and validate the schema. They must never use unsigned event-type headers for dispatch.

On durable acceptance return HTTP 200/202 with:

```json
{ "event_id": "<same event ID>", "status": "accepted", "duplicate": false }
```

Return status `processed` only if business effects actually committed. Storage failure must return a retryable error, typically 503. Invalid signatures return 401. Network errors, 408, 429, 5xx and invalid acknowledgments retry within the attempt ceiling. Other 4xx and redirects are terminal failures.

The durable inbox implementation is in src/inbox.ts. The standalone reference receiver is integrations/receiver-example.mjs, with its own schema SQL. It accepts events but intentionally does not invent your wallet or merchant application's business handler. Connect that handler and mark inbox state=processed in the same transaction as its effects. A received duplicate must not repeat those effects. For shipment projections, use aggregate version checks and reconciliation for out-of-order events; do not blindly overwrite a newer state. Non-projection events such as wallet approval require their business operation key even when they share a shipment version.

After processing, the configured owning platform can POST `{command_id,event_id}` to /v1/deliveries/:id/processed using its platform JWT. The service checks both destination ownership and event ID.

## Errors

400 validation_error; 401 unauthorized; 403 forbidden; 404 not_found; 409 stale_version/command_conflict/invalid_transition/no_eligible_carrier; 422 domain validation; 429 rate limit; 500 internal error. Responses include request_id for tracing and do not expose SQL errors or secrets. Preserve command_id when retrying an uncertain outcome.
