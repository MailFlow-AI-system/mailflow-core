# MailFlow Core

MailFlow Core is the Node.js backend for the MailFlow MVP. It produces two processes from one codebase and shared container recipe:

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

## Deployment

Railway is the selected compute platform for the MailFlow Core MVP. It runs the API and worker as
separate services from the `MailFlow-AI-system/mailflow-core` repository while keeping the three
delivery environments isolated. The complete deployment decision and validation boundary are
recorded in
[`docs/deployment.md`](docs/deployment.md).

| Environment | Branch | API service and URL | Worker service | `APP_ENV` |
| --- | --- | --- | --- | --- |
| Development | `development` | `dev-api-core` — `https://mailflow-core-api-dev.up.railway.app` | `dev-api-worker` | `development` |
| Staging | `staging` | `staging-api-core` — `https://mailflow-core-api-staging.up.railway.app` | `staging-api-worker` | `staging` |
| Production | `main` | `api-core` — `https://mailflow-core-api.up.railway.app` | `api-worker` | `production` |

Only the API services have public HTTP domains. The workers are private background processes and
do not need public networking or an HTTP health check. All six services use the repository root and
the root `Dockerfile`; Railway's automatic Dockerfile detection requires that exact filename. The
image builds with Bun `1.4.1` and runs on Node.js `24.20.0`. The target dashboard Config File path
is empty: the repository does not ship legacy `railway.json` or `railway.toml` manifests. Railway's
Config as Code is deprecated for new services and reaches its legacy-service cutoff on
2026-12-01; the existing services therefore keep their settings in the dashboard. Compare each
existing service with the target settings and change only mismatches; do not recreate or re-enable
the removed manifest path. See the
[Railway Dockerfile](https://docs.railway.com/builds/dockerfiles) and
[Config as Code](https://docs.railway.com/config-as-code) documentation.

The target API start command is `node --enable-source-maps dist/entrypoints/api.js` and the target
worker start command is `node --enable-source-maps dist/entrypoints/worker.js`. These commands
invoke Node.js directly. Target API settings use `/health/ready` as the deploy-time health check;
target worker settings clear healthchecks and public domains. Both service types target `On Failure`
with a maximum of 10 retries and 15 seconds of deployment draining; Railway's default draining is
0 seconds, so 15 seconds is an explicit target that exceeds the API's 10-second graceful-shutdown
timeout. These are target panel settings, not proof that every current service matches them. Virginia
is the reported region; the exact Railway region identifier remains pending independent capture.

Railway auto-deploys are reported enabled for all six services, with `Wait for CI` enabled. The
promotion flow is `development` → `staging` → `main` through reviewed branch changes. Native
Railway builds rebuild the selected branch in each environment; the MVP does not publish to GHCR or
claim strict build-once image-digest promotion.

Infisical remains the secret delivery boundary. Six service-specific Secret Syncs (API and worker
per environment) use the existing connections `railway-mailflow-core-development`,
`railway-mailflow-core-staging`, and `railway-mailflow-core-production`; the exact Infisical slugs
and current bindings remain pending capture. Each sync uses the `/mailflow-core` path, and the
matching Railway services receive only their environment's `DATABASE_URL`. `APP_ENV` is public
environment configuration kept in Railway;
it is not a secret and is not embedded in the image. Set `SERVICE_VERSION` to
`${{RAILWAY_GIT_COMMIT_SHA}}` so GitHub-triggered deployments expose the triggering commit. Railway
provides that variable only for GitHub-triggered deployments, so a manual dashboard or CLI deploy
must verify that its rendered value is non-empty before it is treated as versioned evidence. The
application does not use the Infisical SDK at runtime.

Railway is the cost-accepted MVP choice because it provides the required persistent API and worker
processes without forcing the project to operate a VPS before product scale justifies it. When
traffic, reliability, resource control, or operating requirements justify the change, the same
containerized services can move to a paid VPS. That migration changes compute operations; database,
secret delivery, and other managed dependencies remain separate decisions.

## Environment contract

Infisical injects environment variables before a process starts. Application code does not use the Infisical SDK or load `.env` files.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | Yes | — | PostgreSQL connection URL |
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
bun run db:migrate:identity-workspace
bun run db:migrate:mail
```

Schema files and migration histories are created with the first database-backed business slice.
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

`.github/workflows/ci.yml` reproduces this gate on pull requests and pushes to `development`,
`staging`, and `main`. Its single `CI Required` job uses pinned action revisions, no path filters,
no repository secrets, no dependency cache, and `persist-credentials: false`. Pull request runs
cancel superseded runs for the same PR; push runs use unique run IDs so a later push does not cancel
an earlier delivery check. `Wait for CI` is reported enabled, but its remote behavior and the
`CI Required` check still need confirmation after the first PR creates the check suite. Skipped and
neutral checks do not block Railway; a cancelled workflow blocks only when no other workflow for the
same commit succeeds. Do not interpret a non-failure as proof that every check ran successfully.

Local CI and image smoke results do not prove remote CI, Railway deployment settings, Secret Sync,
worker liveness, database identity, or promotion behavior. Capture those facts per deployment in the
operational runbook before calling an environment healthy.

The current Railway flow builds from the selected branch for each service. That does not prove that
API and worker deployments, or successive environment deployments, share one immutable image digest.
Strict build-once and digest promotion remains a future release-process decision. If adopted, it
must replace or coordinate with Railway's native source build so that two competing deployment
paths cannot publish the same service.

## Future evolution

The MVP remains a modular Core with separate API and worker processes. Audience is the first planned bounded-context extraction. That milestone introduces a thin Gateway/BFF and RabbitMQ after its equivalence gate; Redis remains independently activated only for a proven low-latency ephemeral-state workload. Later services are extracted only for measured ownership, scaling, reliability, or release needs.

The complete architecture, decisions, trade-offs, and diagrams live in the [MailFlow Architecture Hub](https://mailflow-architecture-hub.vercel.app/).
