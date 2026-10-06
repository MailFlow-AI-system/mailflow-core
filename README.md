# MailFlow Core

MailFlow Core is the Node.js backend for the MailFlow MVP. It produces two processes from one codebase and release artifact:

- an HTTP API built with Hono;
- a worker that will execute Mail-owned asynchronous jobs.

The project was initialized from Hono's official `create-hono` Node.js template and then adapted to the MailFlow architecture.

The repository currently contains the executable foundation only. Business APIs and worker handlers are intentionally not stubbed ahead of their implementation.

## Stack

- Node.js 24 runtime
- Bun package manager and script runner
- TypeScript with native ESM
- Hono and `@hono/node-server`
- Zod and `@hono/zod-openapi`
- PostgreSQL, Drizzle ORM, Drizzle Kit, and `node-postgres`
- Pino structured logging
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
| `DATABASE_URL` | Yes | — | Application PostgreSQL connection URL |
| `DIRECT_URL` | Migrations only | — | Direct connection to the same database; no fallback |
| `APP_ENV` | No | `development` | `development`, `test`, `staging`, or `production` |
| `HOST` | No | `0.0.0.0` | API bind address |
| `PORT` | No | `8080` | API port |
| `LOG_LEVEL` | No | `info` | Pino log level |
| `API_DOCS_ENABLED` | No | Enabled outside production | Enables `/docs` and `/openapi.json` |
| `SERVICE_VERSION` | No | `development` | Version exposed through logs and OpenAPI |

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
bun run db:migrate
# Or migrate one module:
bun run db:migrate:identity-workspace
bun run db:migrate:mail
```

Migration histories for Identity Workspace and Mail are promoted from development without modifying SQL or journal timestamps. Generate new migrations on development and promote reviewed files with their consuming release.
There is intentionally no `drizzle-kit push` script. Database changes use generated, reviewed, versioned SQL migrations.

## HTTP surface

| Endpoint | Purpose |
| --- | --- |
| `GET /health/live` | Confirms only that the API process is alive |
| `GET /health/ready` | Confirms required configuration and PostgreSQL connectivity |
| `GET /openapi.json` | OpenAPI 3.1 document when API docs are enabled |
| `GET /docs` | Swagger UI when API docs are enabled |

Business endpoints will live below `/api/v1`.

HTTP failures use RFC 9457 Problem Details with `application/problem+json`. Responses include the standard fields plus stable `code` and `requestId` extensions. Unexpected errors never expose stacks or internal details to clients.

## Architecture

The executable structure is intentionally small:

```text
database/
└── configs/                  # One Drizzle Kit config per owning module
src/
├── entrypoints/              # API and worker process composition
├── modules/
│   └── system/
│       └── health/           # Executable health vertical slice
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

## Security decisions deferred by design

CORS is not enabled. The Web/API origin topology has not yet been selected, so a permissive policy would be both premature and unsafe.

CSRF protection is mandatory before authenticated browser routes are introduced, but its implementation depends on the Web and Better Auth integration spike. That spike must define exact origins, credentialed CORS if required, cookie scope, and CSRF strategy. Wildcard origins must never be combined with cookies.

## Testing and delivery automation

Tests execute on Node.js through Vitest. Current tests cover configuration validation, health behavior, RFC 9457 responses, and conditional OpenAPI/Swagger publication. PostgreSQL is represented by an injected readiness function in this foundation task; no remote database or secret is required by the test suite.

`bun run check` is the complete local quality gate:

1. lint and check formatting;
2. type-check and test;
3. compile the production output.

GitHub Actions runs the local gate, migration integration tests on disposable PostgreSQL, and a production-image smoke test. Railway waits for CI before deployment and applies migrations in the API pre-deploy command. CI uses only disposable database credentials; application secrets remain in Infisical and are never embedded in images.

## Future evolution

The MVP remains a modular Core with separate API and worker processes. Audience is the first planned bounded-context extraction. That milestone introduces a thin Gateway/BFF and RabbitMQ after its equivalence gate; Redis remains independently activated only for a proven low-latency ephemeral-state workload. Later services are extracted only for measured ownership, scaling, reliability, or release needs.

The complete architecture, decisions, trade-offs, and diagrams live in the [MailFlow Architecture Hub](https://mailflow-architecture-hub.vercel.app/).


## Railway migrations

Use `node dist/entrypoints/migrate.js` as the API service's pre-deploy command in
development, staging, and production. Set Pre-deploy Timeout to 300 seconds,
Healthcheck Path to `/health/ready`, and Healthcheck Timeout to 300 seconds. Keep
Wait for CI enabled. Configure these service settings in Railway; workers and
Collectors do not run migrations. The command runs from the deployment image and
reads the environment's Infisical-synced `DIRECT_URL` without a CLI login.

The runner holds one PostgreSQL session advisory lock across both modules. It
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
also applies and repeats migrations using the final Node-only image.

## Listening

Local and CD commands share the Drizzle ORM runner so they use the same ledgers,
ordering, and session lock. Drizzle Kit remains a development tool for generation
and metadata checks. Migrations require a separate direct connection because Neon
transaction pooling cannot preserve a session lock. Runtime database settings
remain independent of migration credentials and longer statement timeouts.

Migrations must remain compatible with the previous running application during
pre-deploy. Rolling back a Railway image does not revert database changes; use a
reviewed forward repair or the verified Neon recovery procedure when needed.
