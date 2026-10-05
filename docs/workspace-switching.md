# Workspace switching — phase 3, local acceptance

## Scope and stack

Branch: `feat/workspace-switching`, based on `origin/development` (`a36a95e`).
The unpublished foundation and onboarding commits were rebased as `df49c22`
and `43964ee`. Their original feature branches were preserved. The latest global
Mail module and its tests were retained. This branch is stacked, not an isolated
replacement for the earlier slices. No push, deployment, production migration,
DNS change or published cookie configuration is part of this execution.

IdentityWorkspace owns the durable preference and canonical membership. This
phase writes preferences; phase 4 still owns preference resolution at generic
entry/login. Invites, roles administration and tenant-aware emails remain outside
this slice. A preference never grants membership or overrides an explicit host.

## Selection contract

`POST /api/v1/workspace-selection` accepts only `{ "workspaceId": "<id>" }`.
The session supplies the identity. Strict validation rejects actor/redirect
fields; the body is bounded to 1024 bytes. Only exact trusted origins can write;
no Origin, `null` Origin and untrusted sibling origins are denied. Authentication
precedes selection. The existing per-identity discovery budget also limits writes.

Successful response: `{ "workspace": { "id", "name", "slug", "role" } }`.
Unknown and unauthorized targets both return 404. Responses are private/no-store.
The preference is committed before success; no session cookie or global active
organization is changed by selection. The destination independently resolves its
live membership. Revocation after commit produces an unavailable state there,
not workspace content or a misleading active-workspace label.

## Database authority

Migrations `0008_workspace_preference` and `0009_workspace_selection_authority`
follow the existing foundation/onboarding migrations. Preference has one row per
identity, canonical foreign keys, RLS/FORCE and only self SELECT visibility. There
is no runtime INSERT/UPDATE policy. Its bounded SECURITY DEFINER function has a
fixed `pg_catalog` search path, qualified relations, `row_security=off`, and no
PUBLIC execution permission. It locks the target membership and organization
until the transaction commits and serializes preference writes for one identity.
Only the privileged migration owner can implement this authority; it is not a
generic bypass or organization-management API.

Before any reviewed rollout, a database administrator must apply migrations with
the approved migration credential and grant **only** this function to the actual
restricted runtime role (replace the example role with the reviewed role):

```sql
GRANT EXECUTE ON FUNCTION identity_workspace.select_workspace_preference(text)
  TO reviewed_runtime_role;
```

The runtime must remain a non-owner without SUPERUSER/BYPASSRLS or owner-role
inheritance. Selection startup additionally verifies preference FORCE RLS,
function ownership and explicit EXECUTE capability. Migration owners must have
the reviewed bypass authority used by the existing invariant triggers. Do not
grant PUBLIC execution or weaken table policies to make startup pass. COMMIT must
actually report COMMIT; rollback/failed cleanup never reports a successful choice.

## Temporary global Inbox protection

Development introduced a Mail repository shared by all authenticated identities,
without a workspace boundary. The user explicitly approved preserving that
repository only in legacy mode and blocking it in workspace mode.

With workspace reads, onboarding or selection dependencies installed, Core denies
`/api/v1/mail/*` after authentication with 503 `workspace_mail_unavailable`, before
calling the repository. The Web also blocks `/api/mail/messages` whenever the
workspace base host is configured and does not mount the global list/search.
The page explains that workspace mail is unavailable. This is a deliberate safe
limitation, not an implemented tenant inbox. No email schema/backfill was added.
In dark/legacy mode the authenticated global Inbox continues to work unchanged.

## Local continuity policy and pending deployment gate

`WORKSPACE_LOCAL_SWITCHING_ENABLED=false` by default. Enabling it requires
`APP_ENV=development`, workspace reads, the restricted database authority and
local auth configuration. The Web's corresponding
`VITE_WORKSPACE_LOCAL_SWITCHING_ENABLED` is also false by default and can be true
only with `VITE_WORKSPACE_BASE_HOST=workspace.test`.

Shared cookies are opted in only for the synthetic `workspace.test` zone, with
local HTTP Core, development environment and exact local trusted origins. They
remain HttpOnly and SameSite=Lax. Better Auth's normal host-only defaults are not
changed when the flag is off. The browser fixture explicitly trusts only its
known A/B/base/Site origins, keeps rate limiting enabled and simulates a trusted
proxy assigning a distinct synthetic IP per browser test. Fixture controls use a
synthetic key, bind only to loopback and are excluded from production builds.

This proves local continuity; it is **not** approval of production cookie scope.
Real development/staging/production base domains, exact trusted-origin strategy,
DNS/TLS, environment-specific cookie isolation and coordinated Core/Web rollout
still require confirmation. The current ordinary auth configuration supplies
exact Site/Web origins, not an automatic wildcard tenant allowlist. Do not enable
local flags or substitute real domains to bypass this gate.

The existing Web auth BFF does not forward a trusted client-IP header, while Core
expects `x-real-ip`; real-browser onboarding still emits the pre-existing shared
rate-bucket warning. The switching fixture supplies a synthetic trusted IP without
disabling limits. Before rollout, review the actual proxy/IP chain; never forward
an arbitrary browser-supplied `x-real-ip` as a workaround. This slice does not
silently change the production authentication proxy.

## Validation and reproduction

Use the pinned Node 24/Bun 1.4.1 toolchain. Tests require the dedicated local
`mailflow_workspace_test` database and cannot silently skip when it is missing.
The test fixture applies migrations with the synthetic admin and exercises the
workspace runtime with a restricted role. No real Resend delivery is performed.

```bash
MAILFLOW_WORKSPACE_TEST_DATABASE_URL=<isolated-local-admin-url> bun run test:workspace
```

For complete Core checks, also supply the restricted URL to
`MAILFLOW_AUTH_INTEGRATION_DATABASE_URL` and an isolated, migrated Mail test DB to
`MAILFLOW_MAIL_INTEGRATION_DATABASE_URL`, then run `bun run check`. Never point the
Mail integration tests at a shared database: their fixture replaces the Mail
dataset within a test transaction. Local acceptance also runs the Web's real-Core
switching browser harness and the existing composer/auth regression suite.

Coverage includes authorized commit; unknown/unrelated/revoked targets; RLS and
direct-write denial; locking during concurrent revocation; actual COMMIT checks;
strict payload/origin/budget limits; genuine browser cookie continuity; refresh;
destination membership revocation; protected global Inbox; saved/minimized drafts
and attachments; cancel with no mutation; write failure preserving the message;
safe collection navigation without old IDs/query/hash; keyboard/mobile and Axe.

Recorded validation: Core `bun run check` passed (33 files, 152 tests, including
real workspace/onboarding/auth/Mail PostgreSQL suites; no skipped integrations).
Web check passed (52 files, 238 unit tests and production build). Real switching
browser harness passed 6/6; legacy composer/auth/telemetry E2E passed 10/10;
Site → Core → Web onboarding regression passed 2/2 (desktop/mobile). Workspace
discovery/selection integration coverage is also included in the full Core run.

Preference reading/resumption, independent-tab acceptance and coordinated real
environment rollout remain phases 4–6, not claimed complete by these tests.
