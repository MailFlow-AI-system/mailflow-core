# Workspace resumption — phase 4

## Scope and dependencies

Branch: `feat/workspace-resumption`, stacked on phase 3 (`0c8127f`). The
development base remains `a36a95e`; it was fetched and rechecked before this slice.
Foundation, onboarding and selection dependencies have not been published by
this execution. Keep their PR/merge ordering explicit. No push, release, deploy,
real database migration or infrastructure change was performed.

This slice reads the existing durable preference. It does not add another
selection writer, active organization, session-owned tenant, administration API,
invitation flow or tenant Mail repository. There is **no new migration**.

## Authenticated entry contract

`GET /api/v1/workspace-entry` accepts no query selectors, identity or redirect.
The authenticated session supplies the actor. Successful outcomes are:

- `source: preference`: the stored choice still has a live membership.
- `source: fallback`: the lowest stable workspace ID among live memberships.
- `source: none`: no membership exists; `workspace` is null.

Preference/fallback responses include only the existing public summary
(`id`, `name`, `slug`, the actor's `role`). Core returns a summary, not a URL.
Another identity cannot read or mutate the actor's preference through this
contract. An explicit workspace URL continues to use the context endpoint; it
does not consult or rewrite the preference.

Authentication precedes discovery. The existing atomic per-identity budget is
shared with workspace discovery/selection. Responses are private/no-store;
400 rejects selectors, 401 requires login, 429 carries Retry-After, and operational
failures use the existing sanitized Problem Details handling. Existing request
logging/tracing provides route/status/request-ID correlation without logging
workspace names, preference contents or session credentials.

## Database authority

The reader uses the restricted runtime role and existing identity transaction.
A single SQL statement joins the actor's canonical membership/organization to
their RLS-protected preference. A preference alone cannot produce a result.
Revocation causes a permitted fallback, not silent membership creation. The
invalid preference is left untouched; only an explicit phase-3 selection writes.

No entry function runs with elevated privileges. Preference self-visibility and
FORCE RLS, runtime role constraints and transactional cleanup remain unchanged.
The destination independently checks membership again, including revocation
between entry resolution and arrival.

## Activation and manual gates

Entry is installed with `WORKSPACE_LOCAL_SWITCHING_ENABLED`, default false, under
the same development-only/isolated-zone guard used by selection. The test Web
uses its matching local flag; this is not an approved production cookie policy.
Global Mail stays blocked in workspace mode and unchanged in legacy mode.

No manual action is needed to continue local phases 5/6 with Docker available.
Before a real rollout, the developer/infrastructure owner must still confirm
environment-specific domains, DNS/TLS/Workers routes, trusted origins and proxy
IP chain, cookie isolation, reviewed runtime grants and ordered migrations from
the preceding slices. Coordinate Core and consumers after the remaining phases
and approvals; do not enable the local flags on real domains as a workaround.

## Verification

`bun run check` passed: lint, formatting, typecheck, **161 tests** (35 files,
including real PostgreSQL auth/Mail/workspace integration) and build.
The entry suite covers valid preference, revocation without a rewrite, identity
isolation through a reused restricted pool, absence of memberships and repeated
stable fallback. HTTP tests cover pre-auth denial, private responses, selectors
and request budget. Required database tests fail rather than silently skip.

Use the dedicated loopback `mailflow_workspace_test` database, the pinned
Node 24/Bun 1.4.1 toolchain and the same three integration database variables
documented in `workspace-switching.md`. Browser evidence/reproduction is tracked
in the matching Web `docs/workspace-resumption.md`. External OTP delivery,
production observability ingestion and real DNS/cookies are not certified here.
