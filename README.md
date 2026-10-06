# MailFlow Core

Modular backend for MailFlow: a Hono HTTP API and a separate worker process.
Built with Node.js, TypeScript, Better Auth, PostgreSQL, and Drizzle.

## Local development

Requires Node.js 24.20.0, Bun 1.4.1, Infisical CLI, and access to the
`MailFlow-AI` project. Docker is optional for running local PostgreSQL.

```bash
bun install --frozen-lockfile
infisical login
infisical init
bun run db:migrate
bun run dev
```

Development commands load Infisical `dev` secrets from `/mailflow-core`.
The API runs at `http://localhost:8080`; `/docs` and `/openapi.json` expose its
contracts outside production. Use `bun run db:up` for local PostgreSQL and
`bun run dev:worker` to start the worker separately.

Configuration is documented in [.env.example](.env.example). Infisical injects
values at process startup; the application does not load `.env` files.

## Commands

| Command | Purpose |
| --- | --- |
| `bun run check` | Lint, formatting, types, tests, and build |
| `bun run test` | Run Vitest |
| `bun run build` | Compile production output |
| `bun run start` / `bun run start:worker` | Run compiled processes |
| `bun run db:generate:<module>` | Generate a reviewed migration |
| `bun run db:check:<module>` | Validate migration metadata |
| `bun run db:migrate` | Apply Identity Workspace, then Mail |
| `bun run db:migrate:<module>` | Apply migrations for one module |
| `bun run db:seed:mail` | Explicitly insert 33 fictional Inbox messages |

Migration command suffixes are `identity-workspace` and `mail`. The application uses
`DATABASE_URL`; migration commands require `DIRECT_URL` for a direct connection to
the same database, with no fallback. Modules own separate schemas and migration
histories. Apply the Mail migration before using Inbox; its seed is idempotent
and creates no users.

Register each migration module in `src/shared/database/migrationModules.ts`, in
execution order. The runner and Drizzle Kit configs share its folder and ledger
metadata. The test suite rejects unregistered migration folders and missing
journals; adding a module does not require changing the runner.

## Structure

- `src/modules/`: business capabilities organized as vertical slices.
- `src/shared/`: configuration, database client, HTTP, logging, and telemetry.
- `src/entrypoints/`: process composition and resource lifecycle.
- `database/`: module-owned migration configuration and SQL histories.

Modules own their tables, migrations, repositories, and transactions. Access
other modules only through their public `index.ts`; cross-module database access,
joins, foreign keys, and transactions are prohibited. Entrypoints inject the
shared database client rather than creating a pool for each module.

## API and testing

Authentication lives under `/api/auth`; business routes under `/api/v1` require
a session. `GET /api/v1/mail/messages` provides paginated Inbox search. Messages
are currently shared by all authenticated users. API failures use Problem Details.

The default test suite needs no database. PostgreSQL integration tests opt in
through `MAILFLOW_AUTH_INTEGRATION_DATABASE_URL` and
`MAILFLOW_MAIL_INTEGRATION_DATABASE_URL`, using dedicated migrated test databases
only. Never point these test variables at shared application databases.

Telemetry is optional through `OTEL_EXPORTER_OTLP_ENDPOINT`. Validate the
Collector with `bun run observability:collector:validate` when Docker is available.
See the [Architecture Hub](https://mailflow-architecture-hub.vercel.app/) for
system-wide decisions.

## Railway migrations

Use `node dist/entrypoints/migrate.js` as the API service's pre-deploy command in
development, staging, and production. Set Pre-deploy Timeout to 300 seconds,
Healthcheck Path to `/health/ready`, and Healthcheck Timeout to 300 seconds. Keep
Wait for CI enabled. Configure these service settings in Railway; workers and
Collectors do not run migrations. The command runs from the deployment image and
reads the environment's Infisical-synced `DIRECT_URL` without a CLI login.

The runner holds one PostgreSQL session advisory lock across all selected modules. It
allows 10 seconds to connect, 15 seconds to acquire locks, and 120 seconds per
statement; the process deadline is 280 seconds. Each module commits separately.
A failed module rolls back its transaction and stops the pre-deploy; rerunning
resumes from the existing ledgers. Do not automatically retry or seed databases.

Before enabling pre-deploy, compare each Neon branch's schemas and migration
ledger hashes/timestamps with the SQL and journals shipped in that branch's image.
Existing schemas without matching ledgers require investigation before activation.
Confirm `DATABASE_URL` and non-pooled `DIRECT_URL` address the same Neon endpoint
and database, migration permissions, and the available restore window. Promote
through reviewed PRs in development, staging, and main order. Configure pre-deploy
only after the target image includes the runner and migrations.

CI runs migration installation, upgrade, repetition, rollback, recovery, and
concurrency tests against disposable PostgreSQL. To run those tests locally, set
`MAILFLOW_MIGRATIONS_TEST_DATABASE_URL` to a disposable instance whose role can
create/drop test databases and event triggers, then run `bun run test`. Never use
a shared application database for this test variable. `scripts/smokeImage.sh`
also applies and repeats migrations using the final Node-only image, checking
ledger hashes and timestamps against the shipped journals instead of fixed counts.

## Listening

Local and CD commands share the Drizzle ORM runner so they use the same ledgers,
ordering, and session lock. Drizzle Kit remains a development tool for generation
and metadata checks. Migrations require a separate direct connection because Neon
transaction pooling cannot preserve a session lock. Runtime database settings
remain independent of migration credentials and longer statement timeouts.

An explicit shared registry keeps execution order reviewable and prevents
generation and deployment metadata from diverging. Runtime directory discovery
was rejected because folder names alone do not define ledger schemas or ordering.
Migration failure logs retain safe diagnostic fields from nested PostgreSQL errors
without printing connection strings, SQL statements, parameters, or raw messages.

Migrations must remain compatible with the previous running application during
pre-deploy. Rolling back a Railway image does not revert database changes; use a
reviewed forward repair or the verified Neon recovery procedure when needed.
