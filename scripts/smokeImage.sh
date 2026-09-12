#!/usr/bin/env bash

set -Eeuo pipefail

readonly postgres_image='postgres:18.6-alpine'
readonly smoke_suffix="${BASHPID}-${RANDOM}"
readonly network_name="mailflow-core-smoke-network-${smoke_suffix}"
readonly database_name="mailflow-core-smoke-database-${smoke_suffix}"
readonly api_name="mailflow-core-smoke-api-${smoke_suffix}"
readonly worker_name="mailflow-core-smoke-worker-${smoke_suffix}"
readonly database_url="postgresql://mailflow:mailflow@${database_name}:5432/mailflow"
readonly api_container_port=18081

docker_bin="${DOCKER_BIN:-docker}"
if ! command -v "${docker_bin}" >/dev/null 2>&1 && command -v docker.exe >/dev/null 2>&1; then
  docker_bin='docker.exe'
fi

if ! command -v "${docker_bin}" >/dev/null 2>&1; then
  printf 'Docker CLI is required; set DOCKER_BIN or install docker.\n' >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  printf 'curl is required for image smoke tests.\n' >&2
  exit 1
fi

readonly image_tag="mailflow-core-smoke:${smoke_suffix}"

container_is_running() {
  [[ "$("${docker_bin}" inspect --format '{{.State.Running}}' "$1" 2>/dev/null || true)" == 'true' ]]
}

wait_for_container_exit() {
  local container_name="$1"
  local timeout_seconds="${2:-15}"
  local deadline=$((SECONDS + timeout_seconds))

  while container_is_running "${container_name}"; do
    if ((SECONDS >= deadline)); then
      return 1
    fi
    sleep 1
  done
}

terminate_container() {
  local container_name="$1"

  if ! container_is_running "${container_name}"; then
    return 0
  fi

  "${docker_bin}" kill --signal TERM "${container_name}" >/dev/null
  if ! wait_for_container_exit "${container_name}" 15; then
    printf 'Container did not exit after SIGTERM: %s\n' "${container_name}" >&2
    return 1
  fi
}

remove_container() {
  local container_name="$1"

  if "${docker_bin}" inspect "${container_name}" >/dev/null 2>&1; then
    terminate_container "${container_name}" || true
    "${docker_bin}" rm --volumes "${container_name}" >/dev/null 2>&1 || "${docker_bin}" rm --force --volumes "${container_name}" >/dev/null 2>&1 || true
  fi
}

cleanup() {
  local exit_code=$?
  set +e

  remove_container "${api_name}"
  remove_container "${worker_name}"
  if "${docker_bin}" inspect "${database_name}" >/dev/null 2>&1; then
    "${docker_bin}" stop --time 10 "${database_name}" >/dev/null 2>&1 || true
    "${docker_bin}" rm --volumes "${database_name}" >/dev/null 2>&1 || "${docker_bin}" rm --force --volumes "${database_name}" >/dev/null 2>&1 || true
  fi
  "${docker_bin}" network rm "${network_name}" >/dev/null 2>&1 || true
  "${docker_bin}" image rm "${image_tag}" >/dev/null 2>&1 || true

  exit "${exit_code}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf 'Building %s\n' "${image_tag}"
"${docker_bin}" build --tag "${image_tag}" .
"${docker_bin}" network create "${network_name}" >/dev/null

printf 'Starting disposable PostgreSQL\n'
"${docker_bin}" run --detach \
  --name "${database_name}" \
  --network "${network_name}" \
  --tmpfs /var/lib/postgresql:rw,noexec,nosuid,size=256m \
  --env POSTGRES_DB=mailflow \
  --env POSTGRES_USER=mailflow \
  --env POSTGRES_PASSWORD=mailflow \
  "${postgres_image}" >/dev/null

database_deadline=$((SECONDS + 30))
until "${docker_bin}" exec "${database_name}" pg_isready -U mailflow -d mailflow >/dev/null 2>&1; do
  if ((SECONDS >= database_deadline)); then
    printf 'PostgreSQL did not become ready.\n' >&2
    exit 1
  fi
  sleep 1
done

printf 'Starting API and worker\n'
api_publish="127.0.0.1::${api_container_port}"
if [[ -n "${SMOKE_API_PORT:-}" ]]; then
  api_publish="127.0.0.1:${SMOKE_API_PORT}:${api_container_port}"
fi
"${docker_bin}" run --detach \
  --name "${api_name}" \
  --network "${network_name}" \
  --publish "${api_publish}" \
  --env APP_ENV=test \
  --env DATABASE_URL="${database_url}" \
  --env HOST=0.0.0.0 \
  --env PORT="${api_container_port}" \
  --env LOG_LEVEL=info \
  --env SERVICE_VERSION=smoke \
  "${image_tag}" >/dev/null
"${docker_bin}" run --detach \
  --name "${worker_name}" \
  --network "${network_name}" \
  --env APP_ENV=test \
  --env DATABASE_URL="${database_url}" \
  --env LOG_LEVEL=info \
  --env SERVICE_VERSION=smoke \
  "${image_tag}" node --enable-source-maps dist/entrypoints/worker.js >/dev/null

api_host_port="${SMOKE_API_PORT:-}"
if [[ -z "${api_host_port}" ]]; then
  api_host_port="$("${docker_bin}" port "${api_name}" "${api_container_port}/tcp" | head -n 1 | tr -d '\r' | awk -F: '{print $NF}')"
fi
if [[ ! "${api_host_port}" =~ ^[0-9]+$ ]]; then
  printf 'Could not determine the published API port.\n' >&2
  exit 1
fi

if [[ "$("${docker_bin}" exec "${api_name}" id -u)" == '0' ]]; then
  printf 'API is running as root.\n' >&2
  exit 1
fi

api_deadline=$((SECONDS + 30))
until live_status="$(curl --silent --show-error --max-time 3 --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:${api_host_port}/health/live" || true)" && [[ "${live_status}" == '200' ]]; do
  if ((SECONDS >= api_deadline)); then
    printf 'API did not expose /health/live.\n' >&2
    exit 1
  fi
  sleep 1
done

ready_body="$(mktemp)"
ready_status="$(curl --silent --show-error --max-time 5 --output "${ready_body}" --write-out '%{http_code}' "http://127.0.0.1:${api_host_port}/health/ready" || true)"
if [[ "${ready_status}" != '200' ]] || ! grep -q '"status":"ready"' "${ready_body}"; then
  printf 'Expected ready health response, got HTTP %s: %s\n' "${ready_status}" "$(<"${ready_body}")" >&2
  rm -f "${ready_body}"
  exit 1
fi
rm -f "${ready_body}"

sleep 3
if ! container_is_running "${worker_name}"; then
  printf 'Worker exited before the liveness check.\n' >&2
  exit 1
fi

printf 'Checking readiness failure after database shutdown\n'
"${docker_bin}" stop --time 10 "${database_name}" >/dev/null
not_ready_body="$(mktemp)"
not_ready_status="$(curl --silent --show-error --max-time 5 --output "${not_ready_body}" --write-out '%{http_code}' "http://127.0.0.1:${api_host_port}/health/ready" || true)"
if [[ "${not_ready_status}" != '503' ]] || ! grep -q '"status":"not_ready"' "${not_ready_body}"; then
  printf 'Expected not-ready health response, got HTTP %s: %s\n' "${not_ready_status}" "$(<"${not_ready_body}")" >&2
  rm -f "${not_ready_body}"
  exit 1
fi
rm -f "${not_ready_body}"
if ! container_is_running "${api_name}"; then
  printf 'API exited while checking database readiness failure.\n' >&2
  exit 1
fi
if ! container_is_running "${worker_name}"; then
  printf 'Worker exited while checking database readiness failure.\n' >&2
  exit 1
fi

printf 'Checking graceful SIGTERM shutdown\n'
"${docker_bin}" kill --signal TERM "${api_name}" >/dev/null
wait_for_container_exit "${api_name}" 15
api_exit_code="$("${docker_bin}" inspect --format '{{.State.ExitCode}}' "${api_name}")"
if [[ "${api_exit_code}" != '0' ]] || ! "${docker_bin}" logs "${api_name}" 2>&1 | grep -q 'API shutdown completed'; then
  printf 'API did not shut down cleanly (exit code %s).\n' "${api_exit_code}" >&2
  exit 1
fi

"${docker_bin}" kill --signal TERM "${worker_name}" >/dev/null
wait_for_container_exit "${worker_name}" 15
worker_exit_code="$("${docker_bin}" inspect --format '{{.State.ExitCode}}' "${worker_name}")"
if [[ "${worker_exit_code}" != '0' ]] || ! "${docker_bin}" logs "${worker_name}" 2>&1 | grep -q 'Worker shutdown completed'; then
  printf 'Worker did not shut down cleanly (exit code %s).\n' "${worker_exit_code}" >&2
  exit 1
fi

printf 'Image smoke tests passed: live, ready, not-ready, worker liveness, and graceful shutdown.\n'
