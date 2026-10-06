# Verification and release boundaries

Updated 6 October 2026 after recovering the local verification workspace.

## Workspace and runtime

Verification ran from a fresh clone of branch `codex/lex-weight-compatibility` at HEAD `0a0dad70b35d1510051f323a17b954f9d4ef0c7b`. The remote branch was confirmed to point to this commit before cloning. The clone's Git root/status/log/branch operations and required source reads completed normally.

The earlier checkout later became responsive and remains preserved separately. It has local changes: `package.json` is missing the `typecheck` script, the verification document is modified, and an empty untracked test file remains. No Git lock files were present. Process listing was unavailable on this host, so stale processes could not be conclusively ruled out or safely terminated. The exact cause of the earlier stalls is not proven; a clean clone resolved the verification blocker.

Node `v24.13.0` matches `package.json` (`>=24 <25`), `.nvmrc` (`24`), GitHub Actions (`24`), and Render's `NODE_VERSION` (`24`). The lockfile pins `@electric-sql/pglite` `0.5.8`; no dependency versions or lockfile entries were changed. `npm ci` succeeded using an isolated cache after the shared user cache failed with a root-owned-file permission error.

## Test infrastructure

The bare Node test passed: 1 passed, 0 failed, 0 skipped. Standalone PGlite `0.5.8` completed dynamic import, instance readiness, `SELECT 1`, and close. The equivalent isolated PGlite test under `node --test` also passed: 1 passed, 0 failed, 0 skipped. Node's test runner and PGlite therefore work in the clean clone on Node 24.13.0.

The first full suite exposed two domain-read compatibility failures. After those were fixed, repeated API injection hit the production rate limiter because every test shared one Fastify app and its in-memory bucket. The test setup now creates a fresh Fastify app per case while reusing the isolated database; production rate limits remain unchanged.

Final full suite result: `npm test` passed 50 tests, 0 failed, 0 cancelled, 0 skipped, in approximately 8.0 seconds. `npm run typecheck` and `npm run build` passed. Prettier passed on the changed source/test files. Repository-wide `npm run format:check` reports an existing formatting issue in `docs/deployment-guide.md`; that unrelated file was not changed.

## Migration and application verification

A disposable PGlite upgrade check applied migrations 001 and 002, inserted a representative pre-003 Shipment and command, then applied migration 003. It verified the Shipment ID, tracking ID, owner, status, version, and weight were unchanged; `core.shipment_identifiers` still resolved the Shipment; migration 003 added only `lex.merchant_shipment_refs` as a table; required uniqueness constraints and indexes exist; and no Order table was introduced. The database closed successfully.

The test suite passed the Merchant authentication/role checks, canonical shipment creation, generated IDs, tracking/version/status/weight and Merchant/order references, idempotency/conflict handling, Merchant isolation, reads, cancellation/state/version behavior, event projection, feature gates, health routes, and representative legacy `/v1` and weight-compatibility regressions.

One narrow compatibility correction in `src/api/domain-reads.ts` preserves owner-based reads of legacy shipments that have no Merchant reference, while continuing to enforce the Merchant client boundary whenever a Merchant reference exists. The test harness now isolates Fastify rate-limit state per test. Neither change alters the Merchant API contract or production rate-limit policy.

The production migration runner was not exercised against PostgreSQL. Docker is installed but its daemon did not respond, and no local PostgreSQL/`psql` binary was available. GitHub Actions is configured for PostgreSQL 17, but CI was not run from this local uncommitted checkout. Multi-connection PostgreSQL concurrency and Render staging behavior remain unverified.

## Security and release boundaries

A source scan found no secret-bearing logging locations in `src`, `scripts`, or `integrations`; Fastify continues to redact authorization and cookie headers. No production credentials were used. Feature gates remain disabled, and no production database, API, Render service, or deployment was touched.

**Application verification: passed for the local clean-clone test environment.**

**Test infrastructure: healthy in the clean clone.**

**Deployment recommendation: not ready for Render deployment until PostgreSQL 17 CI passes and the production migration runner is verified against an existing installation with migration 002 applied.** Keep `DOMAIN_READ_API_ENABLED=false` and `MERCHANT_DOMAIN_API_ENABLED=false` until those checks and controlled staging validation are complete.
