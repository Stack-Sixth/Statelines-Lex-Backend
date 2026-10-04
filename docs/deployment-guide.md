# Foundation deployment

This task does not deploy to production or change external apps. Keep current API and worker available while validating staging.

1. Review current-architecture-audit.md, migration-plan.md and migration 002. Confirm the database is the intended environment and back up/verify restore using your provider. No destructive migration is supplied. Migration 002 deliberately fails if a target schema already exists: inventory that schema and review a compatible migration before proceeding; never delete it to make this migration pass.
2. Use Node 24. Run `npm ci`, `npm run check`. For real PostgreSQL testing use a disposable database ending in `/lex_test` via TEST_DATABASE_URL; tests drop their schemas. Never point tests at production.
3. In staging set existing secrets from environment-variables.md. Build with `npm run build`, then apply migrations once with `npm run migrate:prod`. The runner uses an advisory lock and refuses checksum changes. Do not edit 001.
4. Deploy API `npm start` and worker `npm run worker` from the reviewed commit. Existing render.yaml performs migration in API preDeployCommand; ensure it finishes before releasing a worker that depends on new migrations in later phases. Phase 2 worker code is unchanged.
5. Verify /health/live and /health/ready. Using a trusted server JWT, compare /v1/shipments/:uuid against /api/v1/shipments/:SHP_id; tracking/status/version must agree. Check /api/v1/events against stored legacy event IDs. Test merchant isolation and operator-only events.
6. Run a staging shipment command twice with the same ID and confirm one shipment/event. Confirm a known existing subscriber receives the unchanged X-LEX envelope and acknowledgment workflow. Check protected /v1/operations/health for fresh worker and no unexpected dead letters.
7. Promote only after review, staging checks and confirmed application compatibility. Do not automatically repoint Base44/Rork webhook URLs. Automatic Render deployment remains off in the blueprint.

Rollback: deploy previous API/worker commit and retain 002's extra schemas/views. No existing table or row changed. Do not drop production objects as an automated rollback. A migration failure rolls back transactionally; investigate and correct a new unapplied migration rather than altering checksummed history.

Canonical read endpoints work from existing tables; schema views provide database-side ID mappings. UUID/public IDs encode identity only and are not access tokens. /health and /health/database aliases are not introduced; existing probes satisfy those roles.
