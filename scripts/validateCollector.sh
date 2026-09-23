#!/usr/bin/env bash

set -Eeuo pipefail

readonly project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly config_path="${project_root}/observability/otel-collector.yaml"
readonly dockerfile_path="${project_root}/Dockerfile.collector"

required_dockerfile_fragments=(
  'FROM otel/opentelemetry-collector-contrib:0.143.0'
  'COPY observability/otel-collector.yaml /etc/otel-collector-config.yaml'
  'ENTRYPOINT ["/otelcol-contrib"]'
  'CMD ["--config=/etc/otel-collector-config.yaml"]'
)

for fragment in "${required_dockerfile_fragments[@]}"; do
  if ! grep -Fq "${fragment}" "${dockerfile_path}"; then
    printf 'Collector Dockerfile is missing: %s\n' "${fragment}" >&2
    exit 1
  fi
done

required_fragments=(
  'endpoint: 0.0.0.0:4318'
  'memory_limiter:'
  'filter/drop-sensitive:'
  'transform/redact:'
  'batch:'
  'sending_queue:'
  'retry_on_failure:'
  'otlphttp/grafana:'
  'pipelines:'
  'traces:'
  'metrics:'
  'logs:'
)

for fragment in "${required_fragments[@]}"; do
  if ! grep -Fq "${fragment}" "${config_path}"; then
    printf 'Collector config is missing: %s\n' "${fragment}" >&2
    exit 1
  fi
done

if grep -Eiq '(^|[[:space:]])(api[_-]?key|password|token|secret)[[:space:]]*:' "${config_path}"; then
  printf 'Collector config contains a literal credential field.\n' >&2
  exit 1
fi

docker_bin="${DOCKER_BIN:-docker}"
if command -v "${docker_bin}" >/dev/null 2>&1 && "${docker_bin}" version >/dev/null 2>&1; then
  "${docker_bin}" run --rm \
    --volume "${config_path}:/etc/otel-collector-config.yaml:ro" \
    otel/opentelemetry-collector-contrib:0.143.0 \
    validate --config=/etc/otel-collector-config.yaml
else
  printf 'Collector static validation passed; Docker CLI is unavailable for image validation.\n'
fi
