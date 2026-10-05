# Workspace foundation — phase 1

This slice implements authenticated discovery and explicit context resolution, not
the complete Workspace Management task. It is based on `development`, independently
of the experimental architecture branch.

## Contract and ownership

- `GET /api/v1/workspaces?cursor=<last-id>` returns `{ items, nextCursor }` for the
  session identity only. Pages contain at most 50 entries, ordered by stable ID.
- `GET /api/v1/workspaces/{slug}/context` returns `{ workspace }` only with a live
  membership. Unknown and unauthorized workspaces receive the same 404 response.
- A summary contains `id`, `name`, `slug` and the requesting member's `role`.
- Missing sessions receive 401; invalid selectors/cursors receive 400; the shared
  per-identity budget permits 120 discovery requests per 60 seconds, then returns
  429 with `Retry-After`. Operational errors use the existing sanitized handler.
- Responses are private/no-store. Public Organization HTTP endpoints are closed;
  the plugin is not an unrestricted API or proxy for product consumers.

IdentityWorkspace owns Organization, Member and the plugin-required Invitation
table. There are no duplicate memberships, cross-module joins, Mail tables or
invitation/admin endpoints. The nullable session field required by the plugin is
not used as the browser's active workspace: an authorized explicit host wins.

## Database and migration safety

Apply `0002_workspace_foundation` followed by `0003_workspace_isolation` with the
approved migration credential **before starting this version of Core**, even if
discovery remains disabled. Better Auth's session mapping includes the new column.
The flag does not make the binary compatible with an unmigrated authentication DB.

The application role must be distinct from the table/migration owner, have neither
SUPERUSER nor BYPASSRLS and not inherit the owning role. With
`WORKSPACE_READ_ENABLED=true`, startup checks all three tables for enabled/FORCE
RLS and rejects an unsafe application role or incomplete migration.

Only verified session IDs enter `SET LOCAL mailflow.user_id` inside a transaction.
Queries also explicitly constrain identity; COMMIT/ROLLBACK clears connection
context before pool reuse. Discovery grants only self-membership and authorized
organization SELECT visibility. There are no mutation policies, and invitations
have no public policy. This slice does not grant a generic provisioning bypass.

Slug/membership uniqueness and the single-owner index are database constraints.
Deferred constraint triggers additionally reject a surviving organization without
exactly one owner at COMMIT. The invariant function has a fixed `pg_catalog` search
path, revoked PUBLIC execution and must be owned by the privileged migration role
capable of checking all memberships under FORCE RLS. Never grant its ownership or
that role to the application. Provisioning authority is a separately reviewed next
slice; application inserts are intentionally denied now.

There is no backfill, production seed or automatic assignment of existing users.
Approve backup/recovery, migration credentials and deployment order per environment.
Rollback disables discovery/returns to a compatible binary; do not drop populated
tables or remove isolation to recover an unavailable workspace.

## Isolated validation

Prerequisites: Node matching `.node-version`, Bun 1.4.1 and PostgreSQL 18.6. Use a
dedicated loopback DB named `mailflow_workspace_test`, never a shared development or
production database. The test credential must be allowed to migrate and create the
restricted synthetic `workspace_test_app` role. Test helpers validate host/name,
apply real migrations and remove only their own generated fixtures at normal exit.

```bash
bun install --frozen-lockfile
export MAILFLOW_WORKSPACE_TEST_DATABASE_URL='<dedicated-local-test-migration-url>'
bun run test:workspace
bun run check
```

Workspace integration tests fail when the mandatory URL is absent; absence is not
reported as a passing skip. Existing optional auth lifecycle tests can also run
against the migrated test DB by setting `MAILFLOW_AUTH_INTEGRATION_DATABASE_URL`.
The Core CI workflow provisions the dedicated PostgreSQL service for workspace
tests. Its credentials are synthetic, not deployed credentials.

For the coordinated real-browser tests, keep this command running and follow the
Web document in the paired branch:

```bash
bun run test:workspace:server
```

The fixture server binds only to `127.0.0.1:8081`. It uses the real Core/Better Auth
flow and a restricted database pool, but a no-delivery account-email adapter. Its
local `/__fixture` endpoint and synthetic credentials are test-only, not compiled
into the production API. Stop it with Ctrl+C to close pools and clean its fixtures.

## Evidence and remaining gates

Local validation on 2026-10-05: lint, format, typecheck, 67 unit/integration tests and
build; migration metadata check; production-image smoke (liveness/readiness,
database outage and graceful API/worker shutdown); real PostgreSQL reads, denied writes, pool reuse,
owner/slug/membership constraints, failed-rollback connection disposal and atomic discovery limiting. Paired Web tests
exercise actual login and context through this Core, not a tenant stub.

DNS/TLS, shared-cookie boundaries, environment-approved trusted origins, hosted
Workers routes and live telemetry ingestion are not certified by these local
tests. Current trusted origins remain exact, without broadening CORS. A future
cross-host transition must resolve those gates before exposure. Review the paired
contracts before merge; publish Core and Web in coordinated order. Do not enable
the complete feature until onboarding, switching/preference, independent tabs and
the operational phases are integrated and accepted.
