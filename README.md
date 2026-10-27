# MailFlow Core

Hono/TypeScript backend with PostgreSQL, an API and a separate worker.
Email delivery uses Resend; private attachments use Cloudflare R2.

## Development

Requires Node.js 24.20.0, Bun 1.4.1 and Infisical CLI.

```bash
bun install --frozen-lockfile
infisical login
infisical init
bun run db:migrate
bun run dev
```

Infisical project: `MailFlow-AI`, environment `dev`, path `/mailflow-core`.
Configuration: [.env.example](.env.example). `.env` files are not loaded.
API: `http://localhost:8080`; API docs: `/docs` outside production.

## Commands

- `bun run check`: lint, formatting, types, tests and build.
- `bun run dev:worker`: start the worker.
- `bun run db:up`: start local PostgreSQL when needed.
- `bun run db:migrate`: apply migrations using non-pooled `DIRECT_URL`.
- `bun run db:seed:mail`: insert sample Inbox messages explicitly.
- `bun run db:setup:local` / `bun run dev:workspace-sample`: prepare local workspace fixtures.

Tests require disposable PostgreSQL; see [integration configuration](src/modules/identityWorkspace/workspaces/testDatabase.test-support.ts).
Railway validates migration history before API deployments; see [migration policy](infrastructure/database/migrations.md).
Sending and file access require valid workspace membership, even with workspace UI disabled.

[Architecture](https://mailflow-architecture-hub.vercel.app/) · [R2 setup](infrastructure/r2/README.md)

## Local workspaces

`bun run dev` selects `localhost:3000` and its tenant subdomains. The local runner verifies
restricted privileges and the current schema first; it never migrates or grants automatically.
Use `MAILFLOW_LOCAL_PROFILE=false` for an intentional custom profile. See the Web's local guide.
Shared rollout must apply migrations through 0007 before reviewing the disabled
[runtime role proposal](infrastructure/database/runtimeRole.sql). Provision its login secret
securely, update only `DATABASE_URL`, and retain the migration administrator in `DIRECT_URL`.

## Listening

The local runner selects local defaults explicitly because `development` also names a published
environment. Missing role/schema prerequisites fail startup before activation; RLS guards and
shared migration history remain authoritative.
