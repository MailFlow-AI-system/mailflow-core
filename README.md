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
`GET /api/v1/workspaces/{slug}/mail/messages` provides paginated search scoped to an authorized workspace. Errors use Problem Details.

`bun run test` requires the local PostgreSQL from `bun run db:up`; no variable is needed.
Set `MAILFLOW_WORKSPACE_TEST_DATABASE_URL` only to use another local database.
Workspace suites apply Identity migrations and create the restricted
`workspace_test_app` role, so RLS is tested without `SUPERUSER` or `BYPASSRLS`.
Other integration tests opt in through:

- `MAILFLOW_AUTH_INTEGRATION_DATABASE_URL`
- `MAILFLOW_MAIL_INTEGRATION_DATABASE_URL`
- `MAILFLOW_MIGRATIONS_TEST_DATABASE_URL`

Use disposable test databases. Auth and Inbox require applied migrations; the migration
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

## Local workspace setup

Use the disposable PostgreSQL from `bun run db:up`. No shared database is supported by these commands.
With the pinned Node/Bun versions, run:

```bash
export DIRECT_URL=postgresql://mailflow:mailflow@localhost:5432/mailflow
bunx tsx src/entrypoints/migrate.ts
bun run db:setup:local
bun run dev:workspace-sample
export DATABASE_URL=postgresql://mailflow_app:mailflow_app_local_only@localhost:5432/mailflow
bunx tsx --conditions=development src/modules/mail/seed/run.ts --workspace-id <printed-workspaceId>
```

Setup is idempotent; each sample command creates a new verified user and workspace, without OTP or Resend.
It prints fictional local credentials and the workspace ID. Provisioning stays in `scripts/local/`, outside the production build.
Keep `DIRECT_URL` on the migration owner and `DATABASE_URL` on the restricted role.

Set `APP_ENV=development`, `WORKSPACE_READ_ENABLED=true`, `WORKSPACE_LOCAL_SWITCHING_ENABLED=true`,
`BETTER_AUTH_URL=http://localhost:8080`, `SITE_URL=http://workspace.test:3000`,
and `WEB_APP_URL=http://<printed-slug>.workspace.test:3000`. The exact Site/Web origins allow the base host and sample tenant locally.
Keep a local `BETTER_AUTH_SECRET` of at least 32 characters and the required Resend configuration; sample provisioning sends no email.
Start the API using `bunx tsx --conditions=development src/entrypoints/api.ts` with these environment variables.

Add `127.0.0.1 workspace.test <printed-slug>.workspace.test` to hosts. If the browser runs on Windows, edit the Windows hosts file even when the API runs in WSL.
The Web needs `VITE_API_BASE_URL=http://localhost:8080`, `VITE_WORKSPACE_BASE_HOST=workspace.test`
and `VITE_WORKSPACE_LOCAL_SWITCHING_ENABLED=true`. The generic host resolves membership before redirecting to a tenant; mail requires a tenant host.
