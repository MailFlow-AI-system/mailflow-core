#!/usr/bin/env bash

set -Eeuo pipefail

readonly project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly docker_bin="${DOCKER_BIN:-docker}"

image_id="$("${docker_bin}" build --quiet --file "${project_root}/Dockerfile.collector" "${project_root}")"
"${docker_bin}" run --rm \
  --env GRAFANA_CLOUD_OTLP_ENDPOINT=http://127.0.0.1:4318 \
  --env 'GRAFANA_CLOUD_OTLP_AUTH_HEADER=Basic validation-placeholder' \
  "${image_id}" validate --config=/etc/otel-collector-config.yaml
