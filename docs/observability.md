# Core observability setup

This repository contains the application instrumentation and the private Collector configuration.
Provider account creation and secret entry remain an operator task.

## Application contract

Configure these values in the Infisical environment path used by each Core API/worker service:

| Key | API value | Worker value | Notes |
| --- | --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://mailflow-core-otel-collector.railway.internal:4318` | Same | Private Railway URL only; no Grafana URL in applications |
| `OTEL_TRACE_SAMPLE_RATE` | `0.1` | `0.1` | Parent-based ratio sampling for successful traces |
| `OTEL_SERVICE_INSTANCE_ID` | Railway service instance value | Railway service instance value | Optional; hostname/process fallback is safe |

The application never receives a Grafana token. If `OTEL_EXPORTER_OTLP_ENDPOINT` is absent, the
SDK and metrics are no-op safe and Pino remains local stdout only.

## Grafana Cloud values

Create one Grafana Cloud Free stack for the pilot and an OTLP access policy/token with write-only
permissions for metrics, logs, and traces. Record the stack's OTLP HTTP base URL and the generated
Basic authorization value in the Collector environment only:

| Collector key | Source | Scope |
| --- | --- | --- |
| `GRAFANA_CLOUD_OTLP_ENDPOINT` | Grafana Cloud stack OTLP HTTP endpoint | Collector only |
| `GRAFANA_CLOUD_OTLP_AUTH_HEADER` | `Basic <base64(instance-id:token)>` | Collector only |

Do not commit either value. The authorization value is derived from the Grafana user/instance ID
and token and must be rotated as a single secret in Infisical. Because the Collector maps this
value to the OTLP exporter's `headers.Authorization`, store only the HTTP header value beginning
with `Basic `. Do not include the `Authorization=` variable-name prefix shown in some Grafana
snippets.

## Infisical scope and Secret Sync

Keep application and Collector secrets in separate paths in every environment (`dev`, `staging`,
and `prod`):

| Infisical path | Consumer | Allowed observability keys |
| --- | --- | --- |
| `/mailflow-core` | Core API and worker | `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_TRACE_SAMPLE_RATE`, `OTEL_SERVICE_INSTANCE_ID` |
| `/mailflow-core/otel-collector` | Private Collector only | `GRAFANA_CLOUD_OTLP_ENDPOINT`, `GRAFANA_CLOUD_OTLP_AUTH_HEADER` |

Configure each Railway Secret Sync/integration with its exact path. Do not place the Grafana keys
under `/mailflow-core`, and do not configure API or worker services to import the
`/mailflow-core/otel-collector` subpath. The API and worker sync must remain exact/non-recursive at
`/mailflow-core`; the Collector sync must use exact source `/mailflow-core/otel-collector` and
target only the Collector service. The Infisical key name must match the YAML exactly:
`GRAFANA_CLOUD_OTLP_AUTH_HEADER`; rename any differently named Grafana auth key before syncing it.

## Railway Collector service

Create one private Railway service per environment named `mailflow-core-otel-collector`. Build it
from this repository using `Dockerfile.collector`. That Dockerfile pins
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

Inject only `GRAFANA_CLOUD_OTLP_ENDPOINT` and `GRAFANA_CLOUD_OTLP_AUTH_HEADER` into this service.
Expose no public port. The Collector listens on private HTTP `4318` and health-check HTTP `13133`.
Configure API and worker services to use the private endpoint above, then run:

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
