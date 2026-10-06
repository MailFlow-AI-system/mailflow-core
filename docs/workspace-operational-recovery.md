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
shares its budget across its workspaces intentionally. Load measurements through
the complete HTTP stack remain pending.

## Validation and remaining work

Initial discovery regression failed with 500; the controlled response made it
pass. Full Core check passed with the isolated PostgreSQL database (166 tests,
including the selection regression). No schema changes.

Phase 6 is **not complete**: correlated operational telemetry/ingestion, measured
HTTP abuse exercise, browser recovery evidence, the previously reproduced
parallel SSR failure, final development integration and environment smoke remain.
No external deployment, DNS, cookies or observability configuration was changed.
