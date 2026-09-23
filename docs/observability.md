# Core observability setup

This repository contains the application instrumentation and the private Collector configuration.
Provider account creation and secret entry remain an operator task.

## Application contract

Configure the application values in the existing Infisical path `/mailflow-core` used by the Core
API and worker services:

| Key | API value | Worker value | Notes |
| --- | --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://<actual-private-domain>:4318` | Same | Read exact private domain from Railway; no Grafana URL in applications |
| `OTEL_TRACE_SAMPLE_RATE` | `0.1` | `0.1` | Parent-based ratio sampling for successful traces |
| `OTEL_SERVICE_INSTANCE_ID` | Railway service instance value | Railway service instance value | Optional; hostname/process fallback is safe |

For each environment, open the Collector service in the same Railway project and environment, then
copy its exact private domain from **Settings > Networking**. Configure API and worker with
`http://<actual-private-domain>:4318`. For example, a development service named
`mailflow-core-otel-collector-dev` may expose
`http://mailflow-core-otel-collector-dev.railway.internal:4318`; this is conditional and must not
be inferred from the service name.

Application code does not read or use the Grafana token. In `dev`, both Grafana variables are stored
in Infisical at `/mailflow-core` and are currently copied manually into the Railway Collector
service. No Secret Sync is configured for the Railway Collector service; existing API/worker sync
behavior must be audited before claiming isolation. If `OTEL_EXPORTER_OTLP_ENDPOINT` is absent, the
SDK and metrics are no-op safe and Pino remains local stdout only.

## Grafana Cloud values

Create one Grafana Cloud Free stack for the pilot and an OTLP access policy/token with write-only
permissions for metrics, logs, and traces. The current `dev` source of record is Infisical
`/mailflow-core`; the values are manually copied into Railway because Collector Secret Sync is not
configured:

| Collector key | Source | Current delivery |
| --- | --- | --- |
| `GRAFANA_CLOUD_OTLP_ENDPOINT` | Grafana Cloud stack OTLP HTTP endpoint | Infisical `dev /mailflow-core`, then manual Railway copy |
| `GRAFANA_CLOUD_OTLP_AUTH_HEADER` | `Basic <base64(instance-id:token)>` | Infisical `dev /mailflow-core`, then manual Railway copy |

Do not commit either value. The authorization value is derived from the Grafana user/instance ID
and token and must be rotated as a single secret in Infisical. Because the Collector maps this
value to the OTLP exporter's `headers.Authorization`, store only the HTTP header value beginning
with `Basic `. Do not include the `Authorization=` variable-name prefix shown in some Grafana
snippets. The Infisical key name must remain exactly `GRAFANA_CLOUD_OTLP_AUTH_HEADER`.

## Infisical scope and Secret Sync

Infisical `dev /mailflow-core` currently contains `DATABASE_URL` and both Grafana variables. The
Railway Collector has no configured Secret Sync, so its values are manually entered there. If an
existing API/worker sync consumes `/mailflow-core`, those Grafana variables may also reach API or
worker environments; verify this behavior and do not assume isolation. Keep the token write-only
and limited to metrics, logs, and traces, and rotate it as a single Infisical secret.

Hardening follow-up: configure service-specific Secret Sync so API/worker and Collector have
separate source scopes and targets. The Collector scope must be delivered only to the private
Collector service; API/worker sync must not import it. Do not treat this isolation as active until
the provider configuration is created and verified.

## Railway Collector service

Create one private Railway service per environment with an environment-specific name, for example
`mailflow-core-otel-collector-dev`. Build it from this repository using `Dockerfile.collector`. That Dockerfile pins
`otel/opentelemetry-collector-contrib:0.143.0` and copies
`observability/otel-collector.yaml` into the image. Do not configure a repository mount or a
runtime volume for the Collector configuration. The image starts with:

```text
otelcol-contrib --config=/etc/otel-collector-config.yaml
```

If the service is configured from a Railway Dockerfile path, set the path to
`Dockerfile.collector`; otherwise publish the same Dockerfile as an immutable custom image and
deploy that image. The selected source revision must contain both the Dockerfile and the
configuration before the service is created.

The Collector consumes `GRAFANA_CLOUD_OTLP_ENDPOINT` and `GRAFANA_CLOUD_OTLP_AUTH_HEADER` from
manually entered Railway service variables. Collector Secret Sync is not configured yet; when
introduced, verify that only the Collector receives these values. Expose no public port. The
Collector listens on private HTTP `4318` and health-check HTTP `13133`.
Configure API and worker services to use the exact private endpoint copied from Railway Networking,
then run:

```bash
bun run observability:collector:validate
```

The Collector applies memory limiting, sensitive-log filtering/deletion, batching, bounded retry,
and a bounded sending queue before OTLP HTTP export. It has separate traces, metrics, and logs
pipelines. It does not invent queue metrics; those require real worker jobs.

## Signals and privacy

- API services: HTTP request count/duration/status, request spans, process memory/uptime, and Pino logs.
- Worker service: process memory/uptime, startup/shutdown lifecycle, and Pino logs.
- Service identities: `mailflow-core-api` and `mailflow-core-worker`.
- Correlation: `requestId`, W3C trace context, `traceId`, and `spanId`.
- Never emit email content, subject, address, recipient list, attachment name, cookies,
  authorization headers, secrets, `DATABASE_URL`, provider payloads, or unbounded identifiers as
  metric labels.
