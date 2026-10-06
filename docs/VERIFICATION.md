# Verification and release boundaries

Prepared 16 September 2026.

The deliverable implements the operational backend described in ARCHITECTURE.md. It contains no production credentials and has not been pushed, deployed or connected to live Statelines records.

## Checks

For the Merchant integration change, TypeScript strict checking (`npm run typecheck`) passed, production compilation (`npm run build`) passed, and Prettier checks passed for all changed source/config/documentation files. `git diff --check` reported no whitespace errors.

The full `npm test` run did not complete in this environment. The seven standalone LEX weight-compatibility tests passed, then Node cancelled `tests/core.test.ts` after about 138 seconds with `Promise resolution is still pending but the event loop has already resolved`. Its `before` hook awaits PGlite startup; the core suite produced no test results, so the new Merchant integration tests are unverified here. The earlier 26-test result applied to the pre-Merchant baseline only and must not be treated as verification of this change.

Tests use synthetic records and fake webhook transports, not real sibling applications. No live production mutation or deployment test was performed.

## Remaining deployment verification

The Merchant implementation is not ready for Render deployment until the full test suite completes successfully in a working PGlite or disposable PostgreSQL 17 environment. Real multi-connection PostgreSQL tests are still required to prove row-lock concurrency; PGlite serializes transactions. GitHub Actions is configured to run the suite against PostgreSQL 17; require it to pass before deployment.

The Base44 server adapter must be installed and tested in the user's actual workspace. Supabase TLS, Render builds and worker startup, real HTTPS receivers, platform business consumers and production ID/data migration require staging verification. No such live verification is claimed.

## Scope review

The shipped core covers shipment commands, carrier scheduling, durable delivery and wallet approvals. It does not replace every old intelligence feature or implement downstream wallet posting. Reference receiver code provides durable acceptance; each receiving app still needs its own transactional business consumer and aggregate-version reconciliation.

Do not activate this as a complete drop-in replacement for the original Base44 application. Follow the staged integration and cutover instructions in DEPLOY.md and BASE44.md.
