# Workspace operational recovery — phase 6, local checkpoint

## Scope delivered

When the shared PostgreSQL request budget fails, workspace discovery, entry and
selection fail closed with `503 workspace_control_unavailable`. The response is
private/no-store and does not serialize the infrastructure error. No reader or
preference writer runs after this failure. OpenAPI includes the 503 outcome.
This is an operational failure, distinct from an expected `429` rejection.

## Bounded isolation exercise

Predefined workload: two independent budget function instances over the same
restricted PostgreSQL pool; 150 simultaneous requests for synthetic identity A
and 20 simultaneous requests for synthetic identity B. Acceptance: exactly 120
A requests accepted, 30 rejected with a positive Retry-After, all 20 B requests
accepted. The permanent integration test passed. Test-owned rate-limit rows are
removed in finally. No shared or production data is used.

This verifies atomic accounting and identity separation, not throughput, latency
SLOs, tenant scheduling fairness, or future Mail/job isolation. A single identity
shares its budget across its workspaces intentionally. The separate HTTP exercise
below adds local end-to-end latency evidence, not production capacity guarantees.

### Real HTTP exercise (2026-10-06)

`test/workspaceSwitching/httpLoadSmoke.ts` signs in two synthetic identities
through the real Better Auth HTTP handler and sends a finite concurrent burst to
the real list endpoint / restricted PostgreSQL pool. It checks response identity,
exclusion of unrelated memberships, Retry-After and absence of preference/session
organization/global Mail side effects. It outputs aggregates only, never cookies
or credentials. The harness binds only to loopback and requires the dedicated DB.

Predefined workload/goals: 150 requests for A, 20 for B; 120 A successes / 30
rate-limit rejections; 20 B successes / no rejections; no unexpected status; B
p95 below 2 seconds; complete burst below 5 seconds. This is a local test ceiling,
not a production SLO. Nearest-rank percentiles include complete response reads.

Initial run failed: A had 13 successes / 137 rejections while B had 20 successes.
The route installed overlapping exact and wildcard authorization middleware;
each list request debited twice. Under concurrency, first-pass requests exhausted
the budget before many could finish their second pass. A permanent regression
proved two debits per request. Removing the redundant exact registration made it
pass, without weakening authentication or changing the 120/minute budget.

Same workload after the fix: complete burst 548 ms; A 120 success / 30 rejected,
p50 441 ms, p95 504 ms, max 509 ms; B 20 success / 0 rejected, p50 513 ms,
p95 519 ms, max 520 ms. Unexpected HTTP outcomes: zero. All predefined goals
passed. No membership leakage or selection/global Mail side effects detected.

Reproduction with an independently owned test fixture running:

```sh
bun run tsx --conditions=development test/workspaceSwitching/httpLoadSmoke.ts
```

The script resets only that fixture's owned budget/preferences before execution;
do not share the fixture process with another active test suite. This does not
prove sustained throughput, production scale, or fairness of future Mail/jobs.
Full Core check after the accounting fix: 169 tests plus lint, formatting,
typecheck and build passed with the isolated PostgreSQL database.

## Validation and remaining work

Initial discovery regression failed with 500; the controlled response made it
pass. Full Core check passed with the isolated PostgreSQL database (166 tests,
including the selection regression). No schema changes.

Phase 6 is **not complete**: approved environment ingestion/smoke remain.
Real browser-to-Core local correlation is now validated below. Browser recovery, configured concurrent
startup, compiled Worker SSR and development integration were subsequently
validated in the Web checkout; see its companion operational document. These
local checks do not prove the TanStack resolver race universally eliminated or
the real DNS/TLS/cookie topology approved.
No external deployment, DNS, cookies or observability configuration was changed.

## Workspace telemetry and local ingestion

`mailflow.workspace.operation.count` and `mailflow.workspace.operation.duration`
record only four operations (`list`, `context`, `entry`, `selection`) and five
results (`success`, `denied`, `rate_limited`, `unavailable`, `failure`). Route
templates are used, never request URLs, tenant slugs or user IDs. The same bounded
attributes are added to the existing request span and completion log; existing
requestId/traceId/spanId provide correlation without becoming metric labels.

401/403/404 are expected denials; 429 is a rate-limit rejection; 503 is controlled
unavailability; 5xx other than 503, redirects and escaped exceptions are failures.
These classifications do not inspect response bodies or error messages.

The permanent telemetry regression started red (no workspace samples), then
passed. It checks seven status outcomes and absence of identity, slug, query PII,
cookies and body markers in recorded logs, metrics and spans. Full Core check:
167 tests, lint, format, typecheck and build passed.

Local smoke command (Node 24/Bun 1.4.1):

```sh
bun run tsx --conditions=development test/workspaceSwitching/telemetrySmoke.ts
```

The smoke uses the real application HTTP middleware and OTLP exporters with
synthetic auth/readers/budget outcomes. It does not connect to PostgreSQL or prove
production auth. The endpoint is fixed to loopback port 14318; it reads no remote
telemetry credentials. Collector config:
`observability/otel-collector.workspace-local.yaml`, image
`otel/opentelemetry-collector-contrib:0.143.0`.

Actual collector debug output contained ResourceSpans and ResourceMetrics for
success, denied, rate_limited and unavailable, including both workspace metric
names and trace ID `11111111111111111111111111111111`. The matching Core completion
logs contained that trace ID. This proves **local OTLP ingestion**, not Grafana
Cloud ingestion, browser Faro correlation or remote alert delivery.

## Operational views / proposed alerts

Use the existing Grafana stack after its environment gate, not a new platform:

- Operation traffic and outcome proportions, grouped only by operation/result.
- Duration percentiles by operation; compare to the environment's agreed SLO.
- Separate access denials/rate limits from unavailable/failure outcomes.
- Investigate failures through trace IDs in completion logs, not user IDs in labels.

Proposed alerts (not activated): unavailable/failure ratio above 5% for five
minutes with at least 20 operations; sustained rate-limited ratio above 20% for
ten minutes as a warning, not a paging authorization incident. These are initial
review thresholds, not established SLOs. Confirm exporter naming/unit translation
and data presence before creating queries. No per-tenant dimensions or alerts.

## Real browser correlation and early-middleware outcomes — 2026-10-06

The real Chromium/Faro → Web gateway → Core → local OTLP Collector test exposed
an instrumentation gap: when discovery middleware returned 429, Hono's route
remained `/api/v1/workspaces/*`. The completion span/log lacked a workspace
operation/result, so the original handler-only telemetry test was insufficient.
A new actual-application regression started red (zero workspace counter samples)
and passed after resolving only the four known operation route templates before
middleware execution. Early 401/429/503 are now classified consistently. Unknown
paths/methods are not copied into workspace dimensions; tenant selectors and
queries are never added to metric labels. Authorization and budgets are unchanged.

The opt-in browser fixture (`MAILFLOW_WORKSPACE_TELEMETRY_LOCAL=true`) uses the
real NodeSDK/OTLP exporters, sample rate 1 and a fixed loopback endpoint 14318.
Its bounded in-memory completion records are schema-whitelisted and available
only through the test control key, not a production route. Normal browser tests
remain silent/no-op; no remote telemetry credentials are read. SDK shutdown
flushes telemetry before the fixture pool closes.

Latest real browser test passed in 28.1 seconds, one worker, zero retries/skips.
It verifies five results: success (200), denied (404), injected selection failure
(Core 500 → Web 502), injected control outage (503), and real shared-budget
exhaustion (429). Authentication and restricted PostgreSQL are real; outage
injection is explicitly a fixture double, not proof of a physical DB outage.
For each request, the browser's actual SDK-created traceparent matches the Core
completion trace ID; Collector output matches that trace, Core span ID and the
browser parent span ID. Both workspace metric names were actually ingested.
This preserves correlation through Web's forwarding gateway; it does not claim
an additional instrumented Web-server span or Grafana Cloud acceptance.

Web's same test checks real Faro payloads for tenant/identity/credential and
composer-content leakage; the companion Web document records the discovered
plain-host sanitization correction. Full Core quality gates passed: 173 tests in
39 files, lint, formatting, typecheck and build, with the isolated database.

Real domains/TLS/cookies, trusted proxy/IP, live provider delivery, remote
Grafana ingestion and alert activation remain deferred. Use the companion Web
`docs/workspace-rollout-manual.md` when the developer resumes that final stage.
