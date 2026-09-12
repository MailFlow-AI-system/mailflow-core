# MailFlow Core Deployment Runbook

Status: accepted MVP operating model; remote deployment evidence is incomplete.

This runbook describes the six existing Railway services, their dashboard configuration, the
reviewed promotion path, and the evidence required before calling an environment healthy. It
does not provision Railway, GitHub, Infisical, Neon, or any other external resource.

## Deployment model

Railway hosts two processes from the `MailFlow-AI-system/mailflow-core` repository in three isolated
environments. Each service builds the selected Git branch independently from the repository root.
This is an accepted native Railway rebuild model; the MVP does not publish to GHCR or claim that
API and worker releases share one immutable image digest.

Railway is cost-accepted for the MVP because it provides persistent API and worker processes
without forcing the project to operate a VPS before product scale justifies it. If traffic,
reliability, resource control, or operating requirements later justify a change, the same
containerized services can move to a paid VPS. That would change compute operations; Neon, Infisical,
and other managed dependencies remain separate decisions.

| Environment | Railway branch | API service | Worker service | `APP_ENV` | Region | Public API |
| --- | --- | --- | --- | --- | --- | --- |
| Development | `development` | `dev-api-core` | `dev-api-worker` | `development` | Virginia, reported panel setting | [mailflow-core-api-dev.up.railway.app](https://mailflow-core-api-dev.up.railway.app) |
| Staging | `staging` | `staging-api-core` | `staging-api-worker` | `staging` | Virginia, reported panel setting | [mailflow-core-api-staging.up.railway.app](https://mailflow-core-api-staging.up.railway.app) |
| Production | `main` | `api-core` | `api-worker` | `production` | Virginia, reported panel setting | [mailflow-core-api.up.railway.app](https://mailflow-core-api.up.railway.app) |

The exact Railway region identifier, the rendered dashboard branch values, and the Infisical
environment slugs are still pending independent capture. Do not infer those values from the table
alone.

## Dashboard configuration

The following are target settings for each existing service in the Railway dashboard. The repository
ships no Railway config file, so the target Config File path is empty. Existing dashboard values
remain authoritative: compare them and change only mismatches; do not recreate or re-enable a
legacy manifest path. Railway's current
documentation marks Config as Code as deprecated, retains legacy-file support only until
2026-12-01, and directs new configuration toward Infrastructure as Code; this repository chooses
the existing-service dashboard path and adds no IaC dependency. See [Config as Code](https://docs.railway.com/config-as-code)
and [Dockerfile detection](https://docs.railway.com/builds/dockerfiles).

| Setting | API services | Worker services |
| --- | --- | --- |
| Repository | `MailFlow-AI-system/mailflow-core` | `MailFlow-AI-system/mailflow-core` |
| Root directory | `/` (repository root) | `/` (repository root) |
| Config File path (target) | Empty | Empty |
| Build | Native Railway build from root `Dockerfile` | Native Railway build from root `Dockerfile` |
| Build/runtime versions | Bun `1.4.1` during build; Node.js `24.20.0` at runtime | Bun `1.4.1` during build; Node.js `24.20.0` at runtime |
| Start command | `node --enable-source-maps dist/entrypoints/api.js` | `node --enable-source-maps dist/entrypoints/worker.js` |
| Healthcheck path (target) | `/health/ready` | Cleared; no HTTP healthcheck |
| Public domain | Environment API domain from the table | None |
| Restart policy (target) | `On Failure`, default maximum 10 retries | `On Failure`, default maximum 10 retries |
| Draining seconds (target) | `15` | `15` |

Railway automatically detects a file named `Dockerfile` at the source root. No custom Dockerfile
path, build command, Railpack setting, or GHCR image is required. The start commands invoke Node.js
directly, so Railway does not need a shell wrapper or a Bun runtime process.

The API healthcheck is a deploy-time readiness gate. Railway waits for a successful HTTP response
before activating the new deployment, but it does not continuously monitor that endpoint after the
deployment is live. See [Healthchecks](https://docs.railway.com/deployments/healthchecks). The
application's API has a 10-second graceful-shutdown force timer; 15 seconds of Railway draining
allows that timer to complete before the platform sends SIGKILL. Railway's [restart policy](https://docs.railway.com/deployments/restart-policy)
defaults to `On Failure` with up to 10 restarts.

## Variables and secret boundaries

Set only non-secret application configuration in Railway. Infisical remains the secret delivery
boundary. Six existing service-specific Secret Syncs (API and worker in each environment) use the
connections `railway-mailflow-core-development`, `railway-mailflow-core-staging`, and
`railway-mailflow-core-production`; each uses the `/mailflow-core` path and supplies only its
environment's `DATABASE_URL`. The exact Infisical slugs and current panel bindings remain pending
verification.

| Variable | Source | Per-environment value |
| --- | --- | --- |
| `DATABASE_URL` | Infisical Secret Sync | The matching development, staging, or production database URL |
| `APP_ENV` | Railway service variable | `development`, `staging`, or `production` from the deployment table |
| `SERVICE_VERSION` | Railway reference variable | `${{RAILWAY_GIT_COMMIT_SHA}}` |
| `HOST` | Application default | `0.0.0.0` unless the panel requires an explicit value |
| `PORT` | Railway-injected variable | The API listens on Railway's `PORT`; application default is `8080` |
| `LOG_LEVEL` | Application default | `info` unless an environment requires a deliberate override |

`RAILWAY_GIT_COMMIT_SHA` is a Railway-provided Git variable available when the deployment was
triggered by GitHub. Railway reference variables use the `${{...}}` syntax; the exact reference is
`SERVICE_VERSION=${{RAILWAY_GIT_COMMIT_SHA}}`. For a manual dashboard or CLI deployment, inspect
the rendered variable before treating `SERVICE_VERSION` as release evidence. Never replace the
reference with a pasted commit or a secret. Railway variables are available to both build and
runtime processes; keep secrets out of Dockerfiles, build arguments, logs, and commits. See the
[Variables Reference](https://docs.railway.com/variables/reference).

The worker is a private process. It does not expose an HTTP port or domain, and its lack of a
healthcheck is intentional. Its startup and shutdown are proved through deployment logs and the
image smoke test rather than through an HTTP endpoint.

## Promotion procedure

The approved path is a reviewed branch promotion:

1. Open the initial pull request from the feature branch to `development`.
2. Merge the reviewed change into `development` after local checks and the required CI check pass.
3. Let the development API and worker rebuild from `development`; capture deployment evidence.
4. Promote the reviewed change to `staging`, rebuild both staging services, and repeat the evidence capture.
5. Promote the reviewed change to `main`, rebuild both production services, and repeat the evidence capture.

Each environment records the actual target commit deployed there. A rebase-only merge or a branch
promotion can produce a new target SHA, so the process does not promise that all three environments
share one SHA. For each environment, wait until both its API and worker deployments finish before
starting another release or configuration change to that same environment. This operational lock
does not require serializing overlapping CI runs. Capture a compatible API and worker pair for each
environment before accepting it. API and worker services deploy independently. Their healthchecks do
not make the pair atomic, and a healthy API does not prove that the worker is running the same commit.
Capture both service deployment IDs, commit SHA, rendered `SERVICE_VERSION`, status, logs, and UTC
timestamps for each environment. Do not claim promotion from a successful API request alone.

At the observed branch snapshot on 2026-09-12, `staging` at `f578ca6` was one commit ahead of and one commit
behind `main`. A comparison reporting `files[]` does not prove that the trees are equal; reconcile
the actual commit graph and tree diff before the first staging or production promotion.

### GitHub protection and CI gate

The local workflow is `.github/workflows/ci.yml`. It has one job named `CI Required`, runs on pull
requests and pushes to `development`, `staging`, and `main`, pins its action revisions, disables
automatic package-manager caching, uses no repository secrets, and sets
`persist-credentials: false`. Pull requests cancel superseded runs for the same PR; pushes use a
unique run ID so a new delivery push does not cancel an earlier run.

The verified active ruleset is `main rules`. In GitHub, open **Settings → Rules → Rulesets → main rules**.
It currently protects `main`, `develop`, and `staging`,
requires two approvals, requires approval after the last push, requires conversation resolution,
restricts deletion, blocks force pushes, permits rebase-only merging, has one always-bypass user,
and has no status checks. The workflow uses `development`, so `develop` is a branch-pattern
mismatch. In the existing ruleset UI, correct the include pattern to `development`, retain the two
approvals, last-push approval, conversation-resolution, deletion, force-push, and rebase-only
restrictions, then add `CI Required` from the GitHub Actions source with strict up-to-date branches
after the first remote PR creates the check suite. Review the always-bypass actor so normal direct
pushes remain prohibited. Do not create a duplicate ruleset or loosen existing protections. The
remote workflow and check suite are not yet confirmed.

Railway autodeploy and `Wait for CI` are reported enabled on all six services. Railway's [GitHub
Autodeploy](https://docs.railway.com/deployments/github-autodeploys) behavior keeps a deployment in
`WAITING` while checks run and skips it when a workflow fails. Skipped and neutral checks do not
block Railway; a cancelled workflow blocks only when no other workflow for the same commit succeeds.
Do not interpret a non-failure as proof that every check ran successfully. Do not add a post-deploy
workflow dependency to the CI job; that would create a circular gate. Manual post-deploy evidence is
sufficient for the initial rollout.

### Safe Wait for CI verification

The positive check is a normal reviewed promotion to `development`. Record the commit SHA, workflow
run ID, workflow status and timestamp, Railway deployment IDs and statuses, the incumbent service
status, API health responses, and an observed worker process/log line. Repeat the same record for
staging and `main` only after the preceding environment is accepted.

The negative check requires explicit approval before it is published. In an authorized reviewed PR,
add exactly this temporary step to the existing CI job:

```yaml
- name: Temporary Wait for CI negative test
  if: ${{ github.event_name == 'push' && github.ref == 'refs/heads/development' }}
  run: exit 1
```

This fails only after a push to `development`, never for pull requests. Merge that PR through the
existing protection; do not push directly, disable `Wait for CI`, loosen the ruleset, or promote to
staging or production. Confirm that the failed push leaves Railway's new deployment skipped while
the incumbent healthy deployment continues serving. Capture the same SHA, run ID, deployment ID,
statuses, timestamps, and worker observation. Remove the temporary step in a second reviewed PR and
repeat the positive development check. This test changes no application code and must leave source
healthy even when the gate fails.

### Monitoring commands

Use the GitHub CLI to inspect the workflow without exposing secrets:

```bash
gh run list --repo MailFlow-AI-system/mailflow-core --workflow ci.yml --branch development
gh run view RUN_ID --repo MailFlow-AI-system/mailflow-core --log-failed
```

In Railway, inspect both the build logs and deployment/runtime logs for the API and worker, then
record the deployment ID, target SHA, rendered version, and incumbent service status. A build or
start-command failure should leave the incumbent deployment serving when the API health gate is
configured. A CI failure should leave the new deployment skipped through Wait for CI. These are
different failure paths and must be recorded separately.

## Health and evidence boundary

The API exposes two separate signals:

- `GET /health/live` reports that the API process is alive.
- `GET /health/ready` checks required configuration and PostgreSQL connectivity.

The current external probe recorded on 2026-09-12 returned HTTP 200 for both endpoints on all three API URLs. That proves
only the current public HTTP response. It does not prove the exact database identity or version,
the deployed commit, worker liveness, Secret Sync correctness, CI gating, branch configuration, or
continuous health after deployment. The worker has no public endpoint; use its deployment status and
logs plus the image smoke test.

### Evidence already available locally

The current branch has local evidence recorded on 2026-09-12 for:

- frozen Bun `1.4.1` installation;
- `bun run check` passing with 4 test files and 12 tests;
- `actionlint`, `bash -n`, and `shellcheck` passing for the CI workflow and smoke script;
- `git diff --check` passing; and
- a completed `DOCKER_BIN=docker.exe bash scripts/smokeImage.sh` run covering rootless API runtime,
  `/health/live`, ready and not-ready database states, worker liveness, and graceful SIGTERM
  shutdown.

These checks validate the repository and image behavior locally. They do not substitute for remote
Railway, GitHub, Infisical, or Neon evidence.

### Evidence still pending remotely

Before declaring an environment complete, capture:

- the rendered Railway branch, root directory, empty Config File path, Virginia region identifier,
  start command, healthcheck, restart policy, retry limit, and draining setting;
- the rendered `DATABASE_URL` source binding without exposing its value, the Infisical environment
  and `/mailflow-core` path, and non-empty `SERVICE_VERSION`;
- the GitHub workflow run ID and `CI Required` status for the promoted SHA;
- the Railway deployment IDs, build/deploy status, logs, and UTC timestamps for both API and worker;
- HTTP 200 from `/health/live` and `/health/ready` for the API, with database identity/version
  verified through an approved safe diagnostic; and
- worker startup, continued liveness, and graceful termination evidence.

Do not describe the rollout as complete while these remote facts are missing. Obtain explicit user
approval for any external push, deployment, or temporary failing-gate verification after the
concrete branch and environment diff is reviewable.

## Rollback and data-change discipline

For a bad deployment, stop the next promotion and use the affected services' Railway Deployments
menus to roll both API and worker back to a compatible last-known-good pair. Railway restores both
the Docker image and that deployment's custom variables; see [Deployment Actions](https://docs.railway.com/deployments/deployment-actions).
After rollback, reconcile the restored Railway variables with the current Infisical Secret Sync
because a secret change can trigger a redeploy independently of a Git merge. Verify both rendered
versions, current secret bindings without exposing values, deployment IDs, and worker status. API
and worker rollback remains service-scoped because native deployments are not atomic.

An image rollback does not roll back PostgreSQL schema. The current foundation has no production
migration job, and the development-oriented Drizzle commands must not be reused for staging or
production without an environment-safe release design. When migrations are introduced, use a
versioned migration release with a backup, a release lock, and one migration run per environment
and release. Use expand/contract sequencing so the old and new application versions can coexist;
never run the same migration concurrently from both API and worker. CI concurrency does not
serialize Railway releases; never cancel a migration in progress to make room for a later release.
Keep the direct migration connection separate from the pooled runtime `DATABASE_URL`.

Railway gives the previous deployment a configurable SIGTERM-to-SIGKILL window through deployment
teardown settings; the target for these services is 15 seconds, while Railway's default is 0. See
[Deployment Teardown](https://docs.railway.com/deployments/deployment-teardown).

## Repository file map

- `Dockerfile`: builds the Bun dependency/build stages and the non-root Node.js runtime image.
- `.dockerignore`: limits the Docker build context and excludes secrets, dependencies, tests, and generated output.
- `.github/workflows/ci.yml`: one pinned `CI Required` workflow for pull requests and delivery-branch pushes.
- `scripts/smokeImage.sh`: disposable PostgreSQL, API/worker image, health, liveness, readiness, and shutdown smoke test.
- `src/shared/database/client.ts` and `client.test.ts`: bounded idle-pool error logging and its regression test.
- `README.md` and `docs/deployment.md`: product setup and operational deployment runbook.
- `biome.json`: existing formatting configuration; the branch also contains a whitespace-only normalization.

## Listening

The pool error handler logs only bounded PostgreSQL metadata (`name` and optional `code`) so an
arbitrary driver message cannot expose a connection URL or password. Native branch rebuilds remain
the accepted MVP trade-off because strict image-digest promotion is not yet coordinated with
Railway's source builds. Dashboard settings are documented instead of adding deprecated Railway
JSON manifests; no external resources were changed by this runbook update.
