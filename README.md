# MailFlow Core

Modular backend with a Hono API, a separate worker, and PostgreSQL.

## Local development

Requires Node.js 24.20.0, Bun 1.4.1, Infisical CLI, and access to `MailFlow-AI`.
Use Docker if you need local PostgreSQL.

```bash
bun install --frozen-lockfile
infisical login
infisical init
bun run db:migrate
bun run dev
```

Local service and migration commands load Infisical `dev` secrets from `/mailflow-core`.
See [.env.example](.env.example) for configuration; `.env` files are not loaded automatically.
The API defaults to `http://localhost:8080`, with `/docs` and `/openapi.json`
available outside production.

## Commands

| Command | Purpose |
| --- | --- |
| `bun run check` | Lint, formatting, types, tests, and build |
| `bun run test` | Run tests |
| `bun run build` | Compile production output |
| `bun run start` / `bun run start:worker` | Run compiled processes |
| `bun run dev:worker` | Start the development worker |
| `bun run db:up` / `bun run db:down` | Start or stop local PostgreSQL |
| `bun run db:generate:<module>` / `bun run db:check:<module>` | Generate or check migrations |
| `bun run db:migrate` / `bun run db:migrate:<module>` | Migrate all modules or one module |
| `bun run db:seed:mail` | Insert 33 fictional Inbox messages idempotently |

## Migrations

Module suffixes are `identity-workspace` and `mail`. The application uses
`DATABASE_URL`; migrations require non-pooled `DIRECT_URL` for the same database,
with no fallback. Apply migrations before using the API; seeding is explicit.

Register modules in `src/shared/database/migrationModules.ts` in execution order.
The runner and Drizzle configs share folder and ledger metadata. Each module owns
its schema and migration history; tests catch unregistered folders and missing files.

## Structure

Business slices live in `src/modules/`, infrastructure in `src/shared/`, process
commands in `src/entrypoints/`, and migration configs and SQL in `database/`.

Access other modules through public `index.ts` exports. Cross-module database access,
joins, foreign keys, and transactions are prohibited. Modules receive the process database client.
See the [Architecture Hub](https://mailflow-architecture-hub.vercel.app/) for design decisions.

## API and testing

Authentication uses `/api/auth`; routes under `/api/v1` require a session.
`GET /api/v1/mail/messages` provides paginated search. Inbox messages are currently
shared by all authenticated users. Errors use Problem Details.

`bun run test` needs no database by default. Integration tests opt in through:

- `MAILFLOW_AUTH_INTEGRATION_DATABASE_URL`
- `MAILFLOW_MAIL_INTEGRATION_DATABASE_URL`
- `MAILFLOW_MIGRATIONS_TEST_DATABASE_URL`

Use dedicated test databases. Auth and Inbox require applied migrations; the migration
suite requires a disposable instance with permissions to create/drop databases and
create event triggers. CI also runs `bash scripts/smokeImage.sh` against the final image.

Telemetry uses optional `OTEL_EXPORTER_OTLP_ENDPOINT`. With Docker, validate the
Collector using `bun run observability:collector:validate`.

## Railway deployment

Configure the API service in each environment:

- Pre-deploy: `node dist/entrypoints/migrate.js`, with a 300-second timeout.
- Healthcheck: `/health/ready`, with a 300-second timeout. Enable Wait for CI.

The image must include the runner and SQL files, with Infisical-synced `DIRECT_URL`.
Before activation, verify the Neon branch, connection targets, permissions, and ledgers.
Workers and Collectors do not run migrations.

Failures block deployment; rerunning resumes from committed module ledgers. Keep
migrations compatible with the running application. Image rollback does not revert SQL.
