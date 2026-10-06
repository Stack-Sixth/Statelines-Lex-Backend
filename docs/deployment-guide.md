# Foundation deployment

This task does not deploy to production or change external apps. Keep current API and worker available while validating staging.

1. Review current-architecture-audit.md, migration-plan.md and migration 002. Confirm the database is the intended environment and back up/verify restore using your provider. No destructive migration is supplied. Migration 002 deliberately fails if a target schema already exists: inventory that schema and review a compatible migration before proceeding; never delete it to make this migration pass.
2. Use Node 24. Run `npm ci`, `npm run check`. For real PostgreSQL testing use a disposable database ending in `/lex_test` via TEST_DATABASE_URL; tests drop their schemas. Never point tests at production.
3. In staging set existing secrets from environment-variables.md. Build with `npm run build`, then apply pending migrations with `npm run migrate:prod` (the Render API blueprint runs this as `preDeployCommand`). Migration 003 adds only the Merchant-to-Shipment external reference table. The runner uses an advisory lock and refuses checksum changes. Do not edit 001 or already-applied migrations.
4. Deploy API `npm start` and worker `npm run worker` from the reviewed commit. Existing render.yaml performs migration in API preDeployCommand; ensure it finishes before releasing a worker that depends on new migrations in later phases. Phase 2 worker code is unchanged.
5. Verify `/health/live` and `/health/ready`. With only `DOMAIN_READ_API_ENABLED=true`, test canonical shipment reads against `/v1/shipments/:uuid`; tracking/status/version must agree. Test cross-user and cross-client Merchant isolation and operator-only event reads.
6. Only after read checks pass, set `MERCHANT_DOMAIN_API_ENABLED=true` in staging. Use a trusted `role=merchant` JWT from the dedicated Merchant client. Create one test shipment twice with the same command ID and verify one Shipment, one Merchant reference, one history/audit operation and one outbox event. Test a duplicate `(merchant_id, order_id)`, stale cancellation version, capacity release after matching, and refusal to cancel after collection.
7. Confirm the existing `/v1` shipment create/mutation contract and a known legacy webhook subscriber still receive unchanged physical event types/envelopes and acknowledgments. Check protected `/v1/operations/health` for a fresh worker and no unexpected dead letters.
7. Promote only after review, staging checks and confirmed application compatibility. Do not automatically repoint Base44/Rork webhook URLs. Automatic Render deployment remains off in the blueprint.

Rollback: deploy previous API/worker commit and retain 002's extra schemas/views. No existing table or row changed. Do not drop production objects as an automated rollback. A migration failure rolls back transactionally; investigate and correct a new unapplied migration rather than altering checksummed history.

Canonical read endpoints work from existing tables; schema views provide database-side ID mappings. UUID/public IDs encode identity only and are not access tokens. /health and /health/database aliases are not introduced; existing probes satisfy those roles.

## Initial rollout feature gates

`DOMAIN_READ_API_ENABLED` and `MERCHANT_DOMAIN_API_ENABLED` default to `false` and accept only `true` or `false`. Keep them false in the initial deployment. Canonical reads and preflight routes require the read flag; Merchant Shipment create/cancel routes require the Merchant flag. `/api/v1/capabilities` stays authenticated and reports enabled features. Disabled feature routes return 404. These flags do not change existing `/v1` APIs, command execution, signing, subscriptions, or LEX outbox/worker behavior. New inbound event routing is not implemented or enabled by this integration.

Enable each interface only after its staging validation and rollout approval. Roll back by setting the relevant flag false and restarting the API. Migration 003 only adds references; it does not create Order records, switch shipment authority, or change webhook transport.
