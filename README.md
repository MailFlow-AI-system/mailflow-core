# MailFlow Core

MailFlow Core is the Node.js backend for the MailFlow MVP. It produces two processes from one codebase and release artifact:

- an HTTP API built with Hono;
- a worker that will execute Mail-owned asynchronous jobs.

The project was initialized from Hono's official `create-hono` Node.js template and then adapted to the MailFlow architecture.

The repository contains the executable foundation, authentication, and the first global Inbox listing slice. Worker handlers are added with their owning business capabilities.

## Stack

- Node.js 24 runtime
- Bun package manager and script runner
- TypeScript with native ESM
- Hono and `@hono/node-server`
- Better Auth with the Drizzle PostgreSQL adapter
- Zod and `@hono/zod-openapi`
- PostgreSQL, Drizzle ORM, Drizzle Kit, and `node-postgres`
- Pino structured logging
- OpenTelemetry SDK with an OTLP Collector boundary
- Vitest
- Biome for linting, formatting, and import organization
- Infisical for secret delivery

ESLint and Prettier are not installed. Biome owns both responsibilities.

## Prerequisites

- Node.js `24.20.0`
- Bun `1.4.1`
- Infisical CLI
- Docker with Docker Compose
- Access to the `MailFlow-AI` project in Infisical

## Local setup

Install dependencies from the committed lockfile:

```bash
bun install --frozen-lockfile
```

Authenticate and link this checkout to the existing Infisical project:

```bash
infisical login
infisical init
```

Select `MailFlow-AI` when prompted. Development commands read the `dev` environment and `/mailflow-core` secret path. `.infisical.json` contains project-link metadata, never secret values, and should be committed after the project is linked.

Start the local PostgreSQL database:

```bash
bun run db:up
```

Start the API:

```bash
bun run dev
```

Start the worker in another terminal:

```bash
bun run dev:worker
```

Bun manages dependencies and launches scripts. Application code always runs on Node.js and must not use Bun runtime APIs.

## Environment contract

Infisical injects environment variables before a process starts. Application code does not use the Infisical SDK or load `.env` files.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | Yes | — | PostgreSQL connection URL |
| `APP_ENV` | No | `development` | `development`, `staging`, or `production` |
| `HOST` | No | `0.0.0.0` | API bind address |
| `PORT` | No | `8080` | API port |
| `LOG_LEVEL` | No | `info` | Pino log level |
| `API_DOCS_ENABLED` | No | Enabled outside production | Enables `/docs` and `/openapi.json` |
| `SERVICE_VERSION` | No | `development` | Version exposed through logs and OpenAPI |
| `BETTER_AUTH_SECRET` | Yes for API | — | Core-only secret used to sign and encrypt Better Auth data; generate with `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | Yes for API | — | Exact API origin, locally `http://localhost:8080` |
| `SITE_URL` | Yes for API | — | Exact Site origin, locally `http://localhost:4321` |
| `WEB_APP_URL` | Yes for API | — | Exact Web origin, locally `http://localhost:3000` |
| `RESEND_API_KEY` | Yes for API | — | Core-only API key used to send authentication email |
| `RESEND_FROM_EMAIL` | Yes for API | — | Authentication email sender on a verified custom Resend domain. Core rejects `resend.dev` in every environment but does not query Resend to confirm domain status. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | — | Private Collector HTTP endpoint; absence disables telemetry safely |
| `OTEL_TRACE_SAMPLE_RATE` | No | `0.1` | Ratio for sampled successful traces |
| `OTEL_SERVICE_INSTANCE_ID` | No | Hostname and process ID | Stable process instance identity for telemetry |

`.env.example` documents the contract for tooling and local PostgreSQL experiments; it is not loaded by the application.

## Commands

| Command | Purpose |
| --- | --- |
| `bun run dev` | Run the API with Infisical and TypeScript watch mode |
| `bun run dev:worker` | Run the worker with Infisical and TypeScript watch mode |
| `bun run db:up` | Start PostgreSQL and wait until it is healthy |
| `bun run db:down` | Stop PostgreSQL while preserving its named volume |
| `bun run build` | Compile production JavaScript into `dist/` |
| `bun run start` | Run the compiled API on Node.js |
| `bun run start:worker` | Run the compiled worker on Node.js |
| `bun run lint` | Run Biome linting and import-organization checks |
| `bun run format:check` | Check formatting |
| `bun run format` | Apply formatting and import organization |
| `bun run typecheck` | Run TypeScript without emitting files |
| `bun run test` | Run the Vitest suite once |
| `bun run check` | Run the complete local CI gate |

Drizzle commands use the same Infisical environment and secret path:

```bash
bun run db:generate:identity-workspace
bun run db:generate:mail
bun run db:check:identity-workspace
bun run db:check:mail
bun run db:migrate:identity-workspace
bun run db:migrate:mail
bun run db:seed:mail
```

Identity and Mail own separate schema files and migration histories. Apply the Mail migration before using the Inbox endpoint or running its seed.
There is intentionally no `drizzle-kit push` script. Database changes use generated, reviewed, versioned SQL migrations.

## HTTP surface

| Endpoint | Purpose |
| --- | --- |
| `GET /health/live` | Confirms only that the API process is alive |
| `GET /health/ready` | Confirms required configuration and PostgreSQL connectivity |
| `GET /openapi.json` | OpenAPI 3.1 document when API docs are enabled |
| `GET /docs` | Swagger UI when API docs are enabled |
| `POST /api/auth/sign-up/email` | Register a user with name, email, and password |
| `POST /api/auth/sign-in/email` | Start a persistent, revocable session |
| `POST /api/auth/request-password-reset` | Send a one-time, expiring password reset link |
| `POST /api/auth/reset-password` | Consume a reset link and revoke existing sessions |
| `GET /api/auth/get-session` | Read the current session |
| `POST /api/auth/sign-out` | Revoke the current session |
| `GET /api/v1/mail/messages` | List eight messages from the authenticated global Inbox |

Business endpoints live below `/api/v1`.

HTTP failures use RFC 9457 Problem Details with `application/problem+json`. Responses include the standard fields plus stable `code` and `requestId` extensions. Unexpected errors never expose stacks or internal details to clients.

## Inbox listing

`GET /api/v1/mail/messages` requires a valid Better Auth session. All authenticated users currently see the same global messages; messages have no user, owner, or workspace foreign key.

The response contains complete stored bodies and ISO timestamps:

```json
{
  "items": [
    {
      "id": "10000000-0000-4000-8000-000000000033",
      "senderName": "Maya Thompson",
      "subject": "October product planning notes",
      "body": "Hi team,\n\nThe complete stored message body...",
      "receivedAt": "2026-09-30T16:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

Pages contain at most eight messages, ordered by `receivedAt DESC, id DESC`. The query reads one extra row to determine whether another page exists. When `nextCursor` is present, pass it unchanged as `cursor`, retaining the same `q`. When it is `null`, pagination is complete. Empty inboxes return `items: []` and `nextCursor: null`. Malformed cursors return HTTP 400 with `code: invalid_message_cursor`; missing authentication returns HTTP 401.

`q` is trimmed and matches a case-insensitive literal substring across `senderName`, `subject`, and the entire `body`, before pagination. Empty or whitespace-only search lists the unfiltered Inbox. Percent signs, underscores, and backslashes are literal characters. SQL parameters bind both the search pattern and cursor values. This is the initial substring search behavior; lexical search remains a separate future capability.

The Mail migration creates `mail.message` and its descending timestamp/UUID index. Timestamps use millisecond precision so PostgreSQL ordering and JavaScript cursor values remain consistent. Migration history is stored separately in `mail_migrations`.

The explicit `bun run db:seed:mail` command adds 33 fictional English messages to the Development database. Deterministic IDs make repeated runs idempotent: existing IDs are preserved, and unrelated messages are never deleted or updated. It does not create users or run during API startup, migration, or ordinary tests. A clean database yields four full pages and one partial page. The oldest message includes `AuroraLedger` beyond its preview, and other messages include literal `%`, `_`, and backslash search examples. The seed CLI constructs and closes its own database pool and logger.

## Architecture

The executable structure is intentionally small:

```text
database/
├── configs/                  # One Drizzle Kit config per owning module
└── migrations/               # Separate module-owned migration histories
src/
├── entrypoints/              # API and worker process composition
├── modules/
│   ├── identityWorkspace/    # Authentication and account emails
│   ├── mail/
│   │   ├── inbox/listMessages/ # Inbox contract, use case, and route
│   │   ├── infrastructure/  # Mail repository and schema
│   │   └── seed/            # Explicit fictional-data seed
│   └── system/health/       # Executable health vertical slice
└── shared/                   # Technical configuration, HTTP, DB, logging, runtime
```

Each business module is a bounded context. A use case is implemented as a vertical slice inside its owning module:

```text
src/modules/mail/
└── inbox/
    └── listMessages/
        ├── contract.ts
        ├── route.ts
        ├── listMessages.ts
        └── listMessages.test.ts
```

Use relative imports inside a module. Use `#shared/*` for shared technical code and
`#modules/<module>` only for another module's public `index.ts`. Biome rejects deep module aliases.
The package import map resolves TypeScript source in development and compiled JavaScript in
production. Root-level tooling configuration may import source files relatively when it must run
before compiled output exists, as the Drizzle configuration does.

Modules own their tables, PostgreSQL schema, migrations, repositories, and transactions. Cross-module joins, foreign keys, database access, and transactions are prohibited. Shared database code owns only the connection and Drizzle client construction.

Process-scoped resources are created and closed only by entrypoints. Modules receive constructed
dependencies from their process composition root.

## MVP capability map

Planned `identityWorkspace` slices cover:

- signup and initial workspace creation;
- sessions, recovery, MFA, and trusted devices;
- workspace resolution and tenancy context;
- invitation creation, acceptance, revocation, and resend;
- member listing, role changes, and removal;
- owner, admin, member, and named-capability authorization.

Planned `mail` slices cover:

- inbox, threads, message viewing, and lexical search;
- per-user read and favorite state;
- shared archive, trash, and purge state;
- draft creation and optimistic autosave;
- send requests and delivery-state tracking;
- inbound webhooks, provider fetch, and reconciliation;
- attachment upload, completion, scanning, and access;
- Server-Sent Events used only to invalidate client queries.

Directories are added only with executable behavior. The capability map guides placement without creating empty speculative layers.

## Authentication foundation

Better Auth is mounted at `/api/auth` with its Drizzle adapter in the
`identity_workspace` PostgreSQL schema. The initial capability is deliberately
limited to email/password registration, login, persistent database sessions,
session lookup, logout, account email verification, and password recovery.
Workspaces, memberships, and MFA are not configured in this foundation.

`SITE_URL` and `WEB_APP_URL` are validated as exact origins and are the only
credentialed CORS origins for `/api/*`; the same values are Better Auth's
`trustedOrigins`. `BETTER_AUTH_URL` is the API origin. Wildcards, paths,
credentials, and non-HTTPS origins in staging and production are
rejected. API resources under `/api/v1/*` require a valid Better Auth session.

Password recovery reports whether an account exists and whether the provider
accepted delivery, with per-account and trusted-IP rate limits. Responses omit
the submitted email, reset token, and provider details.

Only the API process loads `BETTER_AUTH_SECRET` through authentication
configuration. The worker does not load or use authentication configuration.

## Security decisions deferred by design

Better Auth validates trusted origins for its browser authentication endpoints.
Application-specific CSRF requirements remain mandatory before adding any
state-changing `/api/v1/*` browser resource. Wildcard origins must never be
combined with cookies.

## Testing and delivery automation

Tests execute on Node.js through Vitest. The default suite needs no database and visibly skips opt-in PostgreSQL tests. Set `MAILFLOW_AUTH_INTEGRATION_DATABASE_URL` for authentication lifecycle tests and `MAILFLOW_MAIL_INTEGRATION_DATABASE_URL` for Inbox integration tests, each pointing at a dedicated migrated test database. Never point these variables at Development, Staging, or Production databases.

Mail integration tests run their fixtures inside rolled-back transactions. They verify pagination and timestamp ties, partial and empty pages, full-body search beyond the first page, literal SQL wildcard characters, malformed cursors, authentication, database failures, and seed idempotency without changing unrelated records. The HTTP authentication dependency is controlled in these tests; real Better Auth session lifecycle coverage uses the separate authentication integration suite.

To run Inbox tests against an isolated PostgreSQL database without Infisical, inject its URL into the tool process:

```bash
DATABASE_URL="$MAILFLOW_MAIL_INTEGRATION_DATABASE_URL" bunx drizzle-kit migrate --config=database/configs/mail.ts
bun run test src/modules/mail
```

`bun run check` is the complete local quality gate:

1. lint and check formatting;
2. type-check and test;
3. compile the production output.

## Observability

The API and worker initialize OpenTelemetry before composing their process resources. They expose
distinct service identities (`mailflow-core-api` and `mailflow-core-worker`) and send traces,
metrics, and Pino logs to a private OTLP HTTP Collector only when
`OTEL_EXPORTER_OTLP_ENDPOINT` is present. Local tests and development remain no-op safe when the
endpoint is absent.

The Collector uses `GRAFANA_CLOUD_OTLP_ENDPOINT` and `GRAFANA_CLOUD_OTLP_AUTH_HEADER` to export
telemetry. Configure these on the Collector service; API and worker processes need only its private
`OTEL_EXPORTER_OTLP_ENDPOINT`.
In `dev`, Railway Collector secrets are entered manually because Collector Secret Sync is not
configured. Isolate these secrets from API and worker processes before production.

Validate the built Collector image and its configuration with Docker, without Grafana credentials:

```bash
bun run observability:collector:validate
```

HTTP request duration is recorded in seconds with method, bounded route, and status dimensions.
The worker records startup and shutdown; job metrics await actual job handlers.

## Future evolution

The MVP remains a modular Core with separate API and worker processes. Audience is the first planned bounded-context extraction. That milestone introduces a thin Gateway/BFF and RabbitMQ after its equivalence gate; Redis remains independently activated only for a proven low-latency ephemeral-state workload. Later services are extracted only for measured ownership, scaling, reliability, or release needs.

The complete architecture, decisions, trade-offs, and diagrams live in the [MailFlow Architecture Hub](https://mailflow-architecture-hub.vercel.app/).

## Listening

The first Inbox slice intentionally uses a temporary global message model: every authenticated user sees the same records. User ownership, workspace membership filtering, and cross-module foreign keys were not introduced because the agreed scope requires shared visibility. Tenant isolation must be designed explicitly before changing this contract.

Literal case-insensitive substring search was selected for a predictable initial search across sender, subject, and full body. Lexical ranking and tokenization were deferred because they change matching behavior and require a separate product decision. The ordered timestamp/UUID cursor replaces offset pagination to preserve deterministic boundaries when timestamps tie. Millisecond timestamp precision keeps those boundaries representable by the application's Date values.

The opt-in seed inserts deterministic fictional messages and preserves existing rows on conflict. It is an explicit operational command so loading examples remains separate from applying schema migrations and starting the service.
