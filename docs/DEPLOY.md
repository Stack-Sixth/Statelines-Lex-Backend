# Render + Supabase deployment

Deploy a staging environment first. This package does not require buying infrastructure before inspecting the code. Review the provider's displayed service costs before creating resources.

## 1. Supabase

Create or select the intended Supabase PostgreSQL project. Use a separate staging database/project first. Keep the `lex` schema engine-owned; do not expose it to browser clients.

Copy a PostgreSQL connection string from Supabase's Connect panel. A session-pooler connection is suitable for a persistent Node.js service when direct IPv6 connectivity is unavailable. URL-encode special characters in the password. Do not use a Supabase public API key in place of a database password.

Set DATABASE_SSL=true in deployment. Certificate verification stays enabled. If necessary, place the database's documented root CA PEM in DATABASE_CA_CERT. Do not bypass TLS verification.

References: https://supabase.com/docs/guides/database/connecting-to-postgres

## 2. Create Render environment group `lex-secrets`

Set these values using Render's secret/environment UI:

| Name                  | Value                                                                         |
| --------------------- | ----------------------------------------------------------------------------- |
| DATABASE_URL          | Supabase PostgreSQL connection URL                                            |
| DATABASE_SSL          | true                                                                          |
| API_CLIENTS_JSON      | JSON list of issuer IDs, generated secrets and permitted roles                |
| WEBHOOK_SECRETS_JSON  | JSON map of destination secret references to generated secrets; start with {} |
| WEBHOOK_ALLOWED_HOSTS | Exact receiver hostnames separated by commas; leave empty until configured    |
| DATABASE_POOL_SIZE    | 5 initially                                                                   |
| DELIVERY_MAX_ATTEMPTS | 5                                                                             |
| WORKER_POLL_MS        | 2000                                                                          |
| WORKER_BATCH_SIZE     | 10                                                                            |
| LOG_LEVEL             | info                                                                          |

Generate each secret locally with `npm run keys`. An API client example (replace the placeholder):

```json
[
  {
    "id": "base44",
    "secret": "GENERATED_SECRET_HERE",
    "roles": ["admin", "operator", "merchant", "carrier"]
  }
]
```

When adding a wallet receiver, add a separate issuer permitting only `platform`, and a separate webhook secret. Deploy the same configuration to both API and worker. Do not put secrets in render.yaml or GitHub source.

## 3. Create the API web service

On the screen shown in your screenshot, choose **Web Services → New Web Service**. Connect GitHub and select **Stack-Sixth/Statelines-Lex-Backend**. An organisation owner may need to approve Render's GitHub integration.

Use:

| Setting            | Value                                        |
| ------------------ | -------------------------------------------- |
| Name               | statelines-lex-api                           |
| Branch             | main, after code is reviewed/merged          |
| Runtime            | Node                                         |
| Root directory     | blank when the backend is at repository root |
| Build command      | npm ci && npm run build                      |
| Pre-deploy command | npm run migrate:prod                         |
| Start command      | npm start                                    |
| Health check       | /health/ready                                |
| Node version       | 24 via NODE_VERSION                          |
| NODE_ENV           | production                                   |

Attach `lex-secrets`. Disable automatic deploys for the first controlled rollout. Choose a region close to the database. Review the plan's availability and charges in Render. Pre-deploy command availability depends on the selected service type/plan; if unavailable, run the same migration command from a trusted terminal with the correct staging environment before starting the API. Do not add schema migration to every worker startup.

The migration takes a lock, records checksums, and runs transactionally. Do not edit an already-applied SQL migration; add a new one.

## 4. Create the background worker

Choose **Background Workers → New Worker**, select the same repository and branch:

| Setting       | Value                   |
| ------------- | ----------------------- |
| Name          | statelines-lex-worker   |
| Build command | npm ci && npm run build |
| Start command | npm run worker          |
| NODE_VERSION  | 24                      |
| NODE_ENV      | production              |

Attach the same `lex-secrets` group. Start it after the database migration has succeeded. The API and worker are two processes from the same repository.

Alternatively, `render.yaml` declares both services for a Render Blueprint. It references the existing `lex-secrets` group. Review its proposed resources and charges before applying. Render documentation: https://render.com/docs/blueprint-spec

## 5. Verify before connecting the live dashboard

- `/health/ready` responds with ready.
- Unauthenticated `/v1/shipments` responds with 401.
- Authenticated `/v1/operations/health` shows a fresh worker heartbeat.
- Register test carriers, create a test shipment and complete its permitted journey.
- Configure a receiver and confirm accepted and processed states separately.
- Test a failing receiver and confirm retries stop in dead_letter.
- Run GitHub Actions and review the test results.

No destinations are preconfigured. Before real workflows, register each receiving platform and prove its consumer handles duplicates. Do not expose integration keys to the browser.

## 6. Cutover and rollback

Back up Base44 and Supabase records first. Map legacy shipment/carrier/user IDs explicitly. Import only after reviewing referential consistency and capacity totals. No importer is supplied because live data was not inspected.

Freeze legacy shipment mutations for the migrated cohort, connect the Base44 adapter, and route new writes through Lex. Keep legacy intelligence features from independently changing migrated shipment state. Reconcile totals and platform views before expanding rollout.

To roll back an application release, deploy the last compatible commit and pause the worker if needed. Do not drop the `lex` schema. Restoring legacy writers requires reconciling all commands accepted since cutover; simply switching the frontend URL back is not a safe data rollback.
