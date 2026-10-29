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
- `bun run db:seed:mail --workspace-id <existing-workspace-id> --workspace-owner-id <existing-owner-id>`:
  insert development QA Inbox messages and validated image/PDF attachments for that workspace only.
- `bun run db:setup:local` / `bun run dev:workspace-sample`: prepare local workspace fixtures.

Tests require disposable PostgreSQL; see [integration configuration](src/modules/identityWorkspace/workspaces/testDatabase.test-support.ts).
Railway validates migration history before API deployments; see [migration policy](infrastructure/database/migrations.md).
Sending and file access require valid workspace membership, even with workspace UI disabled.

[Architecture](https://mailflow-architecture-hub.vercel.app/) · [R2 setup](infrastructure/r2/README.md)

## Local workspaces

`bun run dev` selects `localhost:3000` and its tenant subdomains. The local runner verifies
restricted privileges and the current schema first; it never migrates or grants automatically.
Use `MAILFLOW_LOCAL_PROFILE=false` for an intentional custom profile. See the Web's local guide.
Shared rollout must apply the current migrations before reviewing the disabled
[runtime role proposal](infrastructure/database/runtimeRole.sql). Provision its login secret
securely, update only `DATABASE_URL`, and retain the migration administrator in `DIRECT_URL`.

## Message reader

Inbox details use `GET /api/v1/workspaces/:slug/mail/messages/:id`; Sent details use
`GET /api/v1/mail/sent/:id`. Both require workspace membership. Sent messages and
stored file access also require their authenticated owner. Details include HTML,
plain text, available sender metadata, recipients, timestamp, and clean attachment metadata.
Unknown historical sender addresses remain null.

Apply Mail migrations through 0010 before starting the reader. The existing runtime role
needs SELECT, INSERT, UPDATE, and DELETE privileges on `mail.inbox_message_attachment`,
as with the other Mail tables; migrations do not provision or change runtime roles.
Inline image access validates stored bytes and MIME before returning a private response;
other attachments retain an authenticated download with the original filename.

The explicit QA seed requires `APP_ENV=development` and verifies the existing owner
membership before writing. Its 33 subjects start with `[MailFlow QA]`; reruns preserve
existing messages and verify existing file associations instead of creating duplicates.
Files go through the same upload/completion/content verification as the Composer.
The seed never delivers emails or creates workspaces or users.

Select exactly one workspace by its ID, DNS slug, or exact display name:

```bash
bun run db:seed:mail --workspace-id <existing-workspace-id> --workspace-owner-id <existing-owner-id>
bun run db:seed:mail --workspace-slug acme --workspace-owner-id <existing-owner-id>
bun run db:seed:mail --workspace-name "Acme Team" --workspace-owner-id <existing-owner-id>
```

The owner must already belong to the selected workspace with the owner role. Name lookup
checks all accessible pages and refuses duplicate names; use the workspace ID or slug to
disambiguate. Missing, conflicting, or repeated selectors fail before any database writes.

## Listening

The local runner selects local defaults explicitly because `development` also names a published
environment. Missing role/schema prerequisites fail startup before activation; RLS guards and
shared migration history remain authoritative.

Inbox attachment associations reuse the existing private attachment service, so linked
files survive temporary-upload cleanup. A separate public storage path would duplicate
authorization and retention rules. Sender addresses are recorded when delivery is attempted;
if an uncertain attempt is retried with a different sender, its historical sender remains
unknown instead of claiming an address that may not have been used. Receiving external
email remains a separate integration; the development seed is explicitly test data.

The mail seed accepts explicit workspace selectors instead of a fixed personal workspace.
Name selection reuses identity-scoped workspace discovery and then revalidates membership
through the existing Mail authority. Exact ID and slug selectors avoid name ambiguity;
none of the selectors falls back to the user's preferred workspace. Sample recipients use
reserved, workspace-neutral addresses, while fixture IDs remain scoped to the selected
workspace so reruns preserve existing data.
