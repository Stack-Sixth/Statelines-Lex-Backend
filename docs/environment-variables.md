# Environment variables

No new environment variables or secrets are required for this foundation. Existing names remain intact. Do not add planned gateway secrets until its implementation is deployed.

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
