# Statelines LEX Backend

A Node.js 24 + TypeScript API and PostgreSQL-backed delivery worker for the operational core of Statelines LEX. Designed to sit behind the existing Base44 dashboard.

**Start here:** [Push to GitHub](docs/PUSH-TO-GITHUB.md) → [Deploy on Render](docs/DEPLOY.md) → [Connect Base44](docs/BASE44.md).

## Implemented

- Authenticated API with short-lived, issuer-scoped service JWTs and server-side user roles.
- Shipment creation, exact-route carrier assignment, a single state machine, shipment history and audit records.
- Explicit carrier-to-user mapping, capacity reservations, cancellation, delivery and return handling.
- Optimistic shipment versions, row locking, and durable command idempotency.
- Transactional outbox: a shipment change, capacity update, history and event commit together.
- Worker with durable fanout, atomic claims, expiring leases, bounded retries, dead-letter state and replay.
- Signed HTTPS events, DNS/IP checks, strict per-event acknowledgments, and separate accepted/processed delivery states.
- Wallet approval records and events with one approval per shipment; no money movement.
- Operational health, restricted read endpoints, a Base44 adapter, and a durable receiver example.
- SQL migration, automated tests, CI, local PostgreSQL configuration and Render configuration.

## Boundaries

This is an operational backend release, not full feature parity with every Base44 screen. Forecasting, fraud scoring, bundle optimization, dynamic pricing, ETA prediction, reputation, rewards and sustainability remain in the existing app until explicitly migrated. This API does not invent pricing or calculate wallet balances. Wallet approval amounts are supplied by an authenticated admin in minor currency units.

No production data has been migrated, no external application has been connected, and no Render or GitHub deployment is performed by these files. Carrier reassignment, multi-leg carrier handoffs, and partial wallet adjustments require additional domain workflows. The implemented post-delivery return reserves the original carrier; another return carrier requires a future reassignment workflow.

## Local development

Install Node.js 24 LTS and Docker Desktop, then:

```bash
npm ci
cp .env.example .env
npm run keys
```

Put the generated value in the `secret` field of `API_CLIENTS_JSON` in `.env`. Keep the client ID `base44`. For local tests only, the supplied Docker database credentials are sufficient. Never reuse them in deployment.

```bash
docker compose up -d
npm run migrate
npm run dev
```

In another terminal, from this directory:

```bash
npm run worker:dev
```

Check `http://localhost:3000/health/ready`. Business routes require a signed token; use the Base44 adapter or the [API guide](docs/API.md).

## Verification

```bash
npm run check
```

The default tests use PGlite, an embedded PostgreSQL engine. For genuine multi-connection locking tests, use a disposable PostgreSQL database named **lex_test**:

```bash
TEST_DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/lex_test npm run check
```

The test suite drops and recreates the `lex` schema in that disposable database. Never point it at production. GitHub Actions runs the suite against PostgreSQL 17. Tests cover API permissions, rollback, concurrency, duplicate commands, delivery completion, wallet approvals, retries, replay, leases, backlog fanout and receiver storage failures.

## Structure

```text
src/app.ts                 API routes and error handling
src/shipments.ts           Shipment, carrier and wallet operations
src/domain.ts              State rules, command idempotency and outbox events
src/auth.ts                Service JWT verification
src/delivery.ts            Outbox fanout, worker claims and delivery outcomes
src/webhooks.ts            HTTPS transport and signatures
src/inbox.ts               Receiver-side durable acceptance helper
migrations/                Versioned PostgreSQL schema
integrations/              Base44 adapter and receiving-platform example
docs/                      Push, deployment, API and integration instructions
```

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for invariants and operational limits, and [VERIFICATION.md](docs/VERIFICATION.md) for the checks performed on this delivery.
