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

Apply both module-owned migration histories:

```bash
bun run db:migrate:identity-workspace
bun run db:migrate:mail
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
| `bun run test:architecture` | Enforce module import boundaries |
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
├── configs/                  # One Drizzle Kit config per owning module
└── migrations/               # Independent migration history per module
src/
├── entrypoints/              # API and worker process composition
├── modules/
│   ├── identityWorkspace/    # Identity/Workspace-owned database schema
│   ├── mail/                 # Mail-owned database schema
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
`#modules/<module>` only for another module's public `index.ts`. Deep module aliases,
relative imports across modules, aliases back into the owning module, and dependencies from
`shared` to business modules are rejected by `bun run test:architecture`. The package import
map resolves TypeScript source in development and compiled JavaScript in production.

Modules own their tables, PostgreSQL schema, migrations, repositories, and transactions. Cross-module joins, foreign keys, database access, and transactions are prohibited. Shared database code owns only the connection and Drizzle client construction.

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

Tests execute on Node.js through Vitest. Current tests cover configuration validation, health behavior, RFC 9457 responses, conditional OpenAPI/Swagger publication, and module import boundaries. PostgreSQL is represented by an injected readiness function in this foundation task; no remote database or secret is required by the test suite.

`bun run check` is the complete local quality gate:

1. lint and check formatting;
2. type-check and test;
3. compile the production output.

GitHub Actions configuration is intentionally deferred to the next delivery task. It should start by reproducing the local gate on pull requests, then grow with Testcontainers for disposable PostgreSQL integration tests, production-image smoke tests, immutable SHA-tagged image publication, homologation, and promotion of the same image digest to production. Infisical will authenticate GitHub Actions through OIDC; secrets will never be embedded in images.

## Future evolution

The MVP remains a modular Core with separate API and worker processes. Audience is the first planned bounded-context extraction. That milestone introduces a thin Gateway/BFF and RabbitMQ after its equivalence gate; Redis remains independently activated only for a proven low-latency ephemeral-state workload. Later services are extracted only for measured ownership, scaling, reliability, or release needs.

The complete architecture, decisions, trade-offs, and diagrams live in the [MailFlow Architecture Hub](https://mailflow-architecture-hub.vercel.app/).
