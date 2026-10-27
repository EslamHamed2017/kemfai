#!/usr/bin/env bash
# T111 exact-owned PostgreSQL/Redis fixture. The Nest HTTP test replaces only the external
# Odoo RPC seam; all control-plane persistence, guards, controllers, services, and sweep writes
# use this run's isolated database. Every Docker resource carries the owner-required exact label.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
api_dir="$repo_dir/backend/api"
mode="${1:-}"
expected_label='kemfai.phase11.operation=t111-trial-enforcement-20261025T003529Z'
fixture_label="${T111_FIXTURE_LABEL:-}"
evidence_root="${T111_EVIDENCE_DIR:-}"

case "$mode" in
  focused|regression) ;;
  *) echo 'FAIL T111 fixture: expected mode focused or regression' >&2; exit 2 ;;
esac
[ "$fixture_label" = "$expected_label" ] || {
  echo "FAIL T111 fixture: T111_FIXTURE_LABEL must equal $expected_label" >&2
  exit 2
}
[ -n "$evidence_root" ] || {
  echo 'FAIL T111 fixture: T111_EVIDENCE_DIR is required' >&2
  exit 2
}

for command in docker npm node python3 openssl; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "FAIL T111 fixture: required command is unavailable: $command" >&2
    exit 1
  }
done
docker info >/dev/null 2>&1 || {
  echo 'FAIL T111 fixture: Docker daemon is unavailable' >&2
  exit 1
}
for image in postgres:16 redis:7-alpine; do
  docker image inspect "$image" >/dev/null 2>&1 || {
    echo "FAIL T111 fixture: required cached image is unavailable: $image" >&2
    exit 1
  }
done

existing="$({
  docker ps -aq --filter "label=$fixture_label"
  docker network ls -q --filter "label=$fixture_label"
  docker volume ls -q --filter "label=$fixture_label"
} | sed '/^$/d')"
[ -z "$existing" ] || {
  echo 'FAIL T111 fixture: exact-label resources already exist; refusing concurrent/shared use' >&2
  exit 1
}

run_id="t111_$(date -u +%Y%m%dT%H%M%SZ)_$$_${RANDOM}"
network="${run_id}_net"
postgres_container="${run_id}_postgres"
redis_container="${run_id}_redis"
postgres_volume="${run_id}_postgres_data"
redis_volume="${run_id}_redis_data"
private_dir="$(mktemp -d)"
chmod 700 "$private_dir"
mkdir -p "$evidence_root"
evidence_dir="$evidence_root/${mode}-${run_id}"
mkdir -p "$evidence_dir"
chmod 700 "$evidence_dir"
cleanup_failed=0

resource_has_label() {
  local kind="$1" name="$2" actual=''
  case "$kind" in
    container) actual="$(docker inspect -f "{{ index .Config.Labels \"kemfai.phase11.operation\" }}" "$name" 2>/dev/null || true)" ;;
    network) actual="$(docker network inspect -f "{{ index .Labels \"kemfai.phase11.operation\" }}" "$name" 2>/dev/null || true)" ;;
    volume) actual="$(docker volume inspect -f "{{ index .Labels \"kemfai.phase11.operation\" }}" "$name" 2>/dev/null || true)" ;;
    *) return 1 ;;
  esac
  [ "$actual" = 't111-trial-enforcement-20261025T003529Z' ]
}

cleanup() {
  local status=$? name survivors
  trap - EXIT INT TERM
  set +e
  for name in "$redis_container" "$postgres_container"; do
    if docker inspect "$name" >/dev/null 2>&1; then
      if resource_has_label container "$name"; then
        docker rm -f -v "$name" >/dev/null 2>&1 || cleanup_failed=1
      else
        echo "FAIL T111 cleanup: container ownership mismatch: $name" >&2
        cleanup_failed=1
      fi
    fi
  done
  for name in "$redis_volume" "$postgres_volume"; do
    if docker volume inspect "$name" >/dev/null 2>&1; then
      if resource_has_label volume "$name"; then
        docker volume rm "$name" >/dev/null 2>&1 || cleanup_failed=1
      else
        echo "FAIL T111 cleanup: volume ownership mismatch: $name" >&2
        cleanup_failed=1
      fi
    fi
  done
  if docker network inspect "$network" >/dev/null 2>&1; then
    if resource_has_label network "$network"; then
      docker network rm "$network" >/dev/null 2>&1 || cleanup_failed=1
    else
      echo "FAIL T111 cleanup: network ownership mismatch: $network" >&2
      cleanup_failed=1
    fi
  fi
  survivors="$({
    docker ps -aq --filter "label=$fixture_label"
    docker network ls -q --filter "label=$fixture_label"
    docker volume ls -q --filter "label=$fixture_label"
  } | sed '/^$/d')"
  if [ -n "$survivors" ]; then
    echo 'FAIL T111 cleanup: exact-label Docker survivors remain' >&2
    cleanup_failed=1
    printf 'survivors=%s\n' "$survivors" >"$evidence_dir/cleanup.txt"
  else
    printf 'containers=0\nnetworks=0\nvolumes=0\n' >"$evidence_dir/cleanup.txt"
  fi
  rm -rf -- "$private_dir" || cleanup_failed=1
  [ "$cleanup_failed" -eq 0 ] || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

umask 077
postgres_password="$(openssl rand -hex 24)"
postgres_env="$private_dir/postgres.env"
printf 'POSTGRES_USER=t111_fixture\nPOSTGRES_PASSWORD=%s\nPOSTGRES_DB=t111_control\n' \
  "$postgres_password" >"$postgres_env"
chmod 600 "$postgres_env"
secrets_file="$private_dir/secrets"
printf '%s\0' "$postgres_password" >"$secrets_file"
chmod 600 "$secrets_file"

redact_stream() {
  python3 -c 'import pathlib,sys
secrets=[value for value in pathlib.Path(sys.argv[1]).read_bytes().split(b"\0") if value]
data=sys.stdin.buffer.read()
for value in secrets:
    data=data.replace(value,b"[REDACTED]")
sys.stdout.buffer.write(data)' "$secrets_file"
}

run_logged() {
  local log_file="$1"
  shift
  set +e
  "$@" 2>&1 | redact_stream | tee "$log_file"
  local command_status="${PIPESTATUS[0]}"
  set -e
  return "$command_status"
}

printf 'mode=%s\nlabel=%s\nrun_id=%s\n' "$mode" "$fixture_label" "$run_id" \
  >"$evidence_dir/fixture.txt"

docker network create --label "$fixture_label" "$network" >/dev/null
docker volume create --label "$fixture_label" "$postgres_volume" >/dev/null
docker volume create --label "$fixture_label" "$redis_volume" >/dev/null
docker run -d --name "$postgres_container" --label "$fixture_label" --network "$network" \
  --env-file "$postgres_env" -v "$postgres_volume:/var/lib/postgresql/data" \
  -p 127.0.0.1::5432 postgres:16 >/dev/null
docker run -d --name "$redis_container" --label "$fixture_label" --network "$network" \
  -v "$redis_volume:/data" -p 127.0.0.1::6379 redis:7-alpine >/dev/null

postgres_ready=0
for _ in $(seq 1 120); do
  if docker exec "$postgres_container" pg_isready -U t111_fixture -d t111_control \
    >/dev/null 2>&1; then
    postgres_ready=1
    break
  fi
  sleep 0.25
done
[ "$postgres_ready" -eq 1 ] || {
  echo 'FAIL T111 fixture: isolated PostgreSQL did not become ready' >&2
  exit 1
}
redis_ready=0
for _ in $(seq 1 120); do
  if [ "$(docker exec "$redis_container" redis-cli ping 2>/dev/null || true)" = PONG ]; then
    redis_ready=1
    break
  fi
  sleep 0.25
done
[ "$redis_ready" -eq 1 ] || {
  echo 'FAIL T111 fixture: isolated Redis did not become ready' >&2
  exit 1
}

postgres_binding="$(docker port "$postgres_container" 5432/tcp)"
redis_binding="$(docker port "$redis_container" 6379/tcp)"
case "$postgres_binding" in 127.0.0.1:*) ;; *) echo 'FAIL: PostgreSQL is not loopback-only' >&2; exit 1 ;; esac
case "$redis_binding" in 127.0.0.1:*) ;; *) echo 'FAIL: Redis is not loopback-only' >&2; exit 1 ;; esac
postgres_port="${postgres_binding##*:}"
redis_port="${redis_binding##*:}"

export CONTROL_DB_HOST=127.0.0.1
export CONTROL_DB_PORT="$postgres_port"
export CONTROL_DB_USER=t111_fixture
export CONTROL_DB_PASSWORD="$postgres_password"
export CONTROL_DB_NAME=t111_control
export REDIS_URL="redis://127.0.0.1:${redis_port}/14"

cd "$api_dir"
run_logged "$evidence_dir/migrations.log" npm run migration:run

if [ "$mode" = focused ]; then
  run_logged "$evidence_dir/jest.log" npm run test:integration -- --runInBand \
    --runTestsByPath test/integration/trial-window-enforcement.integration-spec.ts
else
  run_logged "$evidence_dir/jest.log" npm run test:integration -- --runInBand \
    --runTestsByPath test/integration/support-access-sweep-idempotency.integration-spec.ts \
    test/integration/audit-event-dedupe.integration-spec.ts
fi

printf 'result=PASS\nmode=%s\n' "$mode" | tee "$evidence_dir/result.txt"
