# Workspace onboarding — phase 2

## Scope and dependency

Branch `feat/workspace-onboarding` is stacked on local phase 1 (`feat/workspace-foundation`,
`6a98e96`). Merge/rebase against the approved foundation before merging this slice.
It adds initial signup only: canonical Better Auth User + Organization + owner, email
verification and a safe initial workspace login destination. No automatic session,
invites, workspace administration, switching or preference persistence is introduced.

The Site companion branch must ship with this Core contract. Phases 3–6 remain separate.
The existing database and shared API per environment remain the architecture; tenants
are not separate APIs or databases.

## Contract and consistency

- Public `POST /api/v1/onboarding/signup` accepts name, email, password, workspaceName
  and workspaceSlug, plus a UUID `Idempotency-Key` header. Only the configured exact
  Site origin is accepted. JSON payload is limited to 4 KiB.
- Success is `202 { "status": "verification-pending" }`, with no OTP, membership
  discovery, session token or authentication cookie. Responses are private/no-store.
- Core validates DNS labels, provisional reserved infrastructure names and authoritative
  uniqueness. Conflicts return a generic `signup_unavailable` response.
- A transaction creates the identity, workspace, owner, idempotency receipt and protected
  verification email together. Advisory locking serializes the same key; an HMAC
  fingerprint rejects changed input. Passwords are not stored in receipts or email jobs.
- Same-key retries recover an acknowledged or uncertain commit, without a second identity,
  workspace or OTP. The Site keeps the key and request only in memory; a refresh after an
  uncertain response uses the existing account-verification recovery path, not a stored password.
- OTP/resend delegate to Better Auth inside a transaction. Invalid OTP attempts commit
  their attempt counter; verification, check and resend are serialized per email to
  prevent lost counters or duplicate verification under concurrency. Signup explicitly
  checks that its OTP was enqueued, even if Better Auth swallows callback errors.
  Failure to enqueue the welcome rolls back verification and OTP
  consumption, permitting a safe retry. No external email request is made before commit.
- Verified response adds an authorized `loginUrl`, derived through the user's membership
  rather than accepting a client redirect. Legacy users with no workspace use base `/login`.
  HTTP Organization management remains closed.

## Database and delivery

Apply identity-workspace migrations `0000`–`0007` using a migration owner, not the runtime
role. `0004` adds receipt/outbox tables; `0005`–`0007` establish deferred constraints and
FORCE RLS policies. Runtime startup rejects owner/superuser/BYPASSRLS roles or incomplete
RLS setup. Grant the restricted runtime role the required schema/table privileges after
migration, following the phase-1 role procedure; grants alone do not bypass RLS.

Authorization is set with transaction-local server GUCs, reset at transaction boundaries.
Receipt creation requires a fresh identity and workspace. Queue dispatch capability is
restricted to the identity-owned outbox and does not authorize tenant data. This protects
application query boundaries, not arbitrary SQL execution by a compromised runtime.

Email payloads use AES-256-GCM with job-bound authenticated context and an HKDF-derived
key from `BETTER_AUTH_SECRET`. Stored new OTP values are protected separately. Only exact
legacy six-digit plaintext OTPs remain readable for the short transition window.

OTP jobs expire after five minutes; welcome jobs after 24 hours. The worker leases one job
at a time, without holding a DB transaction during delivery, retries at most five attempts
with bounded backoff, and clears payloads on delivery, terminal failure or expiry. Expired
protected verification records are cleaned in bounded batches. A stopped worker delays
cleanup: monitor backlog and keep delivery running to drain/expire jobs after API rollback.
Rotate the auth secret only with an approved queue/OTP transition; old ciphertext cannot
be decrypted using a new secret. Completed job/receipt metadata is not automatically
purged; define retention for metadata/rate-limit rows before public activation.

Resend requests reuse `onboarding-email/<job-id>` as their idempotency key and have a
15-second abort timeout. This is recoverable at-least-once delivery, **not exactly-once**.
Provider idempotency is bounded to its documented retention window. See
[send email API](https://resend.com/docs/api-reference/emails/send-email) and
[idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys).

Signup and OTP budgets are atomic PostgreSQL windows, keyed globally and by an HMAC
of the email, not by an untrusted caller IP. Current per-minute limits (global/email)
are signup 30/3, resend 60/3 and verification 180/5. These are provisional protection
limits, not capacity/fairness certification. Logs use finite outcomes without OTP/PII.

## Manual activation checklist — not executed by this implementation

1. Approve/merge foundation and this Core/Site pair. Review migrations, runtime grants,
   reserved host names, budget capacity and retention in the target environment.
2. Confirm the real per-environment Web base zone, DNS, wildcard TLS, Workers routes,
   trusted proxy client-IP configuration and permitted Site/Web origins. Configure the
   cookie/session continuation strategy together with phase 3. **Setting only the Web
   base origin does not allow every tenant origin in Better Auth or CORS.**
3. Apply migrations as owner. Keep the API and worker on the restricted role. Configure
   approved Resend sender/key and the same auth secret for API and worker; never copy
   test credentials or fixture origins into a deployed environment.
4. Enable `WORKSPACE_EMAIL_DELIVERY_ENABLED=true` on the worker and verify real delivery
   and safe finite failure signals in an authorized environment.
5. Enable `WORKSPACE_ONBOARDING_ENABLED=true` on Core with an exact
   `WORKSPACE_WEB_BASE_ORIGIN`. Leave `WORKSPACE_SIGNUP_CUTOVER_ENABLED=false` initially.
   Workspace reads require the separate phase-1 `WORKSPACE_READ_ENABLED=true` flag.
6. Build/redeploy Site with `PUBLIC_WORKSPACE_ONBOARDING_ENABLED=true` and matching
   `PUBLIC_API_URL`/`PUBLIC_WEB_URL`. Public Site values are build-time configuration.
7. Prove actual mailbox delivery, resend, verification and tenant login/bootstrap at
   desktop/mobile before setting `WORKSPACE_SIGNUP_CUTOVER_ENABLED=true`. This flag
   closes legacy `/api/auth/sign-up/email`; it requires onboarding to be enabled.
8. On rollback, restore the consumer first and reopen legacy signup as coordinated.
   Drain/expire already committed queue jobs rather than deleting users or migrations.

The three Core flags default to false. No deployment/DNS/Infisical/Cloudflare settings
have been changed. This slice must not be publicly activated before the tenant-origin
and live provider acceptance gates are satisfied.

## Reproducible local validation

Use Node 24 and Bun 1.4.1. Never point fixtures at a shared or production database.
`MAILFLOW_WORKSPACE_TEST_DATABASE_URL` must be an isolated migration-owner PostgreSQL
database; fixtures create restricted app credentials and uniquely scoped synthetic data.
Set `MAILFLOW_AUTH_INTEGRATION_DATABASE_URL` to that database's restricted runtime URL
to also exercise existing auth regression integration tests.

```sh
MAILFLOW_WORKSPACE_TEST_DATABASE_URL='<isolated-owner-url>' \
MAILFLOW_AUTH_INTEGRATION_DATABASE_URL='<isolated-runtime-url>' bun run check
```

The Site `test:e2e:onboarding` suite starts this Core checkout, the Site and phase-1 Web,
with real PostgreSQL and real auth/context APIs. It covers signup, refresh, OTP resend,
verification, login and correct workspace bootstrap at desktop/mobile; both palettes
are checked with Axe and horizontal overflow assertions. Its loopback-only harness uses
exact synthetic tenant origins, synthetic trusted-client IPs for separate test scenarios,
and a capturing email **provider double**. It neither sends live Resend email nor proves
wildcard DNS/cookies/proxy behavior in production. See the companion Site document for commands.

### Recorded local evidence (2026-10-05)

- Core quality gates: lint, format, typecheck, 88 tests (including real restricted-role
  PostgreSQL auth/workspace/onboarding integrations) and TypeScript build.
- Tests include provisioning/enqueue rollback, idempotent/concurrent signup, contested
  slug, encrypted OTP, failed welcome retry, concurrent invalid-attempt accounting,
  concurrent atomic budgets, FORCE RLS authority, worker lease contention, expiry and
  stable-key delivery retries.
- Site quality gates: 49 tests, Astro diagnostics/build, three Wrangler **dry-runs**.
- Site regression browser suite: 37 passed; seven pre-existing project-specific skips
  (mobile-only navigation and desktop-only hover/visual cases, covered in the other
  applicable project). These are not missing onboarding prerequisites.
- Cross-repository onboarding: two passed (desktop/mobile), no skips, real DB/API/auth,
  synthetic provider; Axe both palettes and correct authorized workspace in the shell.
- Docker image smoke: live/ready/not-ready, non-root API, worker liveness and clean
  SIGTERM. This smoke keeps feature flags off; feature behavior is covered by the
  restricted-role integration and browser suites, not by the dark-runtime smoke.

External acceptance (real Resend mailbox, deployed tenant origins/DNS/TLS/session
continuation and observability ingestion) remains unverified and is a rollout gate.
