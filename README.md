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
| `bun run deploy:check` / `bun run deploy:configure` | Check or apply Railway API migration policy |

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

The API must run migrations before every deployment. The versioned policy in
`src/shared/deployment/railwayMigrations.ts` maps `development` to development,
`staging` to staging, and `main` to production using explicit environment and API
service ids. It configures the pre-deploy command `node dist/entrypoints/migrate.js`
with a 300-second timeout, and `/health/ready` with a 300-second timeout.
Workers and Collectors do not run migrations.

With a Railway account API token available as `RAILWAY_API_TOKEN`, run:

```bash
bun run deploy:check
bun run deploy:configure
bun run deploy:check
```

The check is read-only and exits nonzero on drift. Configuration validates every
API destination before changing anything, updates only migration and healthcheck
settings, and verifies them afterward. It does not deploy or execute SQL. Enable
Wait for CI on each API service. CI checks migrations against a disposable database;
the Railway pre-deploy command applies them to the deployed environment.

The image must include the runner and SQL files, with Infisical-synced `DIRECT_URL`
pointing to that environment's database. Before activation, verify the Neon branch,
connection targets, permissions, and ledgers. Failures block deployment; rerunning
resumes from committed module ledgers. Keep migrations compatible with the running
application. Image rollback does not revert SQL.

## Outgoing email

Apply the Mail migration before enabling this version. `POST /api/v1/mail/send`
uses the existing `RESEND_API_KEY` and verified `RESEND_FROM_EMAIL` configuration.
The sender is controlled by Core; clients cannot choose a From address. Requests
require a session, a trusted Origin, and JSON with a UUID `id`, `to`, `cc`, `bcc`,
`subject`, `html`, `text`, and attachment references (`id` and optional `contentId`).
The optional `recipientName` is trimmed, limited to 200 characters, and stored
with the sent copy. Missing or blank names preserve legacy retry hashes.
Inline images use a `contentId` and verified image content. At least one To recipient
is required by Resend. Limits are 50 recipients, 10 attachments including inline
images, 10,000,000 bytes per file, and 20,000,000 bytes per message.

Keep the same id and content when retrying an uncertain request. Core reserves
an owner-scoped record before calling Resend and records success only after
Resend returns an email id. Retrying a confirmed message returns the existing
result. A changed payload with the same id returns 409. Pending reservations
older than 23 hours also return 409, preventing a duplicate after Resend's
24-hour idempotency retention expires; inspect the provider before starting a
new send in that case. Attachment bytes remain in private object storage, and
sent metadata references the immutable scanned objects.

`GET /api/v1/mail/sent?offset=0` returns only the authenticated user's confirmed
messages, in pages of twenty with `nextOffset`. Sent means provider acceptance;
later delivery, bounce, and complaint events require a separate webhook feature.
The existing workspace guard continues to block these endpoints in workspace
mode until tenant-scoped mail is implemented.

The outgoing repository integration tests use
`MAILFLOW_MAIL_INTEGRATION_DATABASE_URL`. Real provider smoke tests should use
`delivered@resend.dev`, never an arbitrary recipient.

## Listening

Outgoing delivery uses the existing Resend SDK and a synchronous API response
so the Composer can report the provider result immediately. A separate queue
and worker were unnecessary for this interactive flow. Durable reservations
and provider idempotency protect retries, including failure to persist after
provider acceptance. Sent copies have their own owner-scoped table because the
legacy Inbox table is global; inserting outgoing messages there would expose
private recipients to other users. Workspace mail remains unavailable rather
than weakening its existing isolation guard. Follow-up work is tenant-scoped
mail and provider webhook reconciliation for final delivery and old uncertain
attempts.

Development authentication accepts HTTP and HTTPS origins on any port for the
exact loopback hosts `localhost`, `127.0.0.1`, and `[::1]`. The same policy covers
credentialed CORS, Better Auth requests, and recovery callbacks (including the
callback GET without an Origin header). Staging and production retain their
configured origin policy. Do not replace host validation with `localhost*`:
that pattern can include unrelated domains such as `localhost.example.com`.

## Attachment storage

The browser requests a short-lived upload URL through authenticated
`POST /api/v1/mail/attachments`, uploads directly with the returned headers, and
calls `POST /api/v1/mail/attachments/{id}/complete`. Completion copies the upload
to an immutable private key, verifies the byte count, metadata and SHA-256, and
scans it with ClamAV. `GET /api/v1/mail/attachments/{id}` returns its state;
only clean attachments can be sent or downloaded. Inline image references carry
an optional content ID and are validated against the image signature. Unscannable
files fail closed and can be retried. Legacy requests containing Base64 attachment
bytes are rejected. All operations remain owner-scoped; workspace mail is blocked.

Set the R2 and ClamAV variables in `.env.example` for each environment. Bucket
CORS must permit the exact Web origin to issue PUT requests with Content-Type;
never publish the bucket. Apply lifecycle expiration only to `pending/`, not to
`objects/`. Scanner access must remain private and its signatures must stay fresh.
The service rejects signatures older than 48 hours. Production must configure
ClamAV archive and resource limits and monitor scanning failures.

The default local development command uses the development R2 bucket and a
local scanner: start `docker compose up -d clamav` before sending files. Wait for
ClamAV to load current signatures. For offline object storage, the optional MinIO
service in `compose.yaml` requires its own private bucket, CORS policy, local-only
credentials, and an explicit `R2_ENDPOINT` override.

Versioned bucket policies and environment mapping are in `infrastructure/r2/`.
Private Railway scanner configuration is in `infrastructure/clamav/`. Runtime
credentials are distinct for each environment and never reach Web Workers.

The API starts cleanup asynchronously and repeats it hourly without overlapping
local runs. Each run handles at most ten expired-metadata batches and ten orphan
object pages; the pagination cursor continues on the next run. Shutdown stops
new batches and awaits current work before closing the database. Referenced send
attachments are excluded through database locks and a fresh association check.

`bun run attachments:cleanup` remains an operator command for one bounded batch
and one orphan-object page with runtime configuration. Pass a returned
`nextCursor` as its argument to continue pagination. The staging promotion must
still validate the combined deployed application and migration pipeline.

The migration policy uses Railway's API rather than a shared root deployment file
that could also affect worker services. Native config-as-code is deprecated with
removal announced for December 1, 2026; a full IaC adoption would require broader
resource ownership and CI changes. The explicit, idempotent policy fixes the three
existing API instances without that migration. Re-run the policy check when service
ids or deployment settings change. Actual SQL execution must be validated during
the next staging promotion.

Recipient names are optional display metadata for the Composition, separate from
the validated To/Cc/Bcc delivery addresses. The additive Mail migration gives
existing messages an empty name so clients can fall back to their email addresses.
A single display-name field does not infer contacts or names for individual
addresses in a multi-recipient message.
