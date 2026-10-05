# Environment variables

One optional feature flag, DOMAIN_READ_API_ENABLED, is introduced; no new secrets are required. Existing names remain intact. Do not add planned gateway secrets until its implementation is deployed.

| Name                    | Purpose / default                                                         |
| ----------------------- | ------------------------------------------------------------------------- |
| DATABASE_URL            | Required PostgreSQL connection, server only                               |
| DATABASE_SSL            | Verified TLS, true by default and required in production                  |
| DATABASE_CA_CERT        | Optional trusted PEM CA                                                   |
| DATABASE_POOL_SIZE      | 5 default, 1..50                                                          |
| API_CLIENTS_JSON        | Required distinct client IDs, secrets >=32 characters and role allowlists |
| WEBHOOK_SECRETS_JSON    | Secret-reference map, default empty object                                |
| WEBHOOK_ALLOWED_HOSTS   | Comma-separated exact outbound DNS hostnames                              |
| PORT / HOST             | 3000 / 0.0.0.0                                                            |
| LOG_LEVEL               | Existing configured Fastify level                                         |
| WORKER_POLL_MS          | 2000 default                                                              |
| WORKER_BATCH_SIZE       | 10 default                                                                |
| DELIVERY_MAX_ATTEMPTS   | 5 default                                                                 |
| NODE_ENV / NODE_VERSION | Deployment production / 24                                                |
| TEST_DATABASE_URL       | Disposable test DB named lex_test only; never production                  |

The external Base44 server adapter separately uses LEX_API_URL, LEX_API_CLIENT_ID, LEX_API_CLIENT_SECRET, LEX_USER_ROLES_JSON. These are not browser environment variables. Retained Base44 publisher uses LEX_WEBHOOK_SECRET. Do not confuse that source-specific legacy setting with the Node outbound secret-reference map.

## Initial rollout feature gate

`DOMAIN_READ_API_ENABLED` defaults to `false` and accepts only `true` or `false`. Keep it unset or false in the initial deployment. The new `/api/v1/shipments` and `/api/v1/events` read routes are registered only when explicitly true; authenticated requests otherwise receive 404. This gate does not change existing `/v1` APIs, command execution, signing, subscriptions, or LEX outbox/worker behavior. New event routing is not implemented or enabled by this foundation.

Enable canonical reads only after staging validation and explicit rollout approval; this merge/deployment leaves them disabled. Roll back the read interface by setting false and restarting the API. Migration 002 only adds namespaces/views and does not switch data authority or webhook transport.
