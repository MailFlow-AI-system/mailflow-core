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
bun run db:migrate:identity-workspace
bun run db:migrate:mail
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
| `bun run db:migrate:<module>` | Apply migrations |
| `bun run db:seed:mail` | Explicitly insert 33 fictional Inbox messages |

Migration command suffixes are `identity-workspace` and `mail`. Modules share
`DATABASE_URL` but own separate schemas and migration histories. Apply the Mail
migration before using Inbox; its seed is idempotent and creates no users.

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
