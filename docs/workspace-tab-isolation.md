# Workspace concurrency — phase 5 checkpoint

The integration suite now checks 72 concurrent context reads for two live identities
through the same restricted pool. Acme and Globex remain inaccessible to the
unrelated identity; Northwind returns each identity's own role. Direct SQL without
an identity remains empty after connection reuse.

The complete Core check passed: lint, formatting, typecheck, 163 tests and build.
No schema, migration or production configuration was changed.

## Identity consistency contract

Authenticated workspace responses include `X-Workspace-Identity`, derived only
from the verified session. A client may send that header as an expected-identity
precondition. A mismatch returns 403 `workspace_identity_changed` before discovery
budget consumption or selection writes. The header never authenticates a request,
changes its actor, bypasses membership checks, or selects a tenant.

Selection retains its exact trusted-origin check and now shares the authenticated
identity/budget middleware with discovery. Existing request bodies are unchanged.
The regression test verifies that a stale tab cannot write a preference for a new
identity even when that identity is authorized for the selected workspace.

Publish the compatible Core before adopting this Web slice. The new Web fails
closed when a successful upstream response lacks identity binding; an older Core
therefore cannot be used as evidence that this slice is integrated successfully.

These identifiers are not added to request logs or metric dimensions. The existing
request logger emits method, route template, status, duration and correlation IDs,
not arbitrary headers. Web telemetry separately redacts the new identity header.

The Web's final 21-case real-Core browser suite passed, including delayed responses,
identity transitions, simultaneous A/B refresh, revalidation and explicit unauthorized
hosts. Its serial legacy regression and real onboarding regression also passed.

The local phase-5 functional acceptance is verified. The Web documented a concurrent
development-SSR failure reproduced on its prior checkpoint as well as this slice;
serial success does not resolve that operational limitation. Phase 6 must include
production-runtime concurrency, capacity (including the extra live session reads),
observability and real topology/rollout gates. These tests do not certify deployments
or the future tenant-aware Mail implementation.
