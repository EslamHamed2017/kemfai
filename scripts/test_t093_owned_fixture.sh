#!/usr/bin/env bash
set -euo pipefail
umask 077

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
api_dir="$repo_dir/backend/api"
run_id="t093-$(date -u +%Y%m%dT%H%M%SZ)-$$_${RANDOM}"
label="kemfai.t093.run=$run_id"
label_key="${label%%=*}"
label_value="${label#*=}"
network="$run_id-net"
pg="$run_id-pg"
redis="$run_id-redis"
evidence="${T093_EVIDENCE_DIR:-/tmp/$run_id-evidence}"
mkdir -p "$evidence"
chmod 700 "$evidence"
private_dir="$(mktemp -d)"
pg_user="t093_${RANDOM}_$$"
pg_password="$(openssl rand -hex 24)"
cleanup_failed=0
completed=0
docker_ready=0
network_created=0
pg_created=0
redis_created=0

fail() { printf 'FAIL T093 owned fixture: %s\n' "$*" >&2; exit 1; }

owned_container_id() {
  local name="$1" id proof
  id="$(docker ps -aq --no-trunc --filter "name=^/${name}$")" || return 3
  [ -n "$id" ] || return 1
  case "$id" in *$'\n'*) return 3 ;; esac
  proof="$(docker inspect -f "{{.Id}} {{ index .Config.Labels \"$label_key\" }}" "$id")" || return 3
  [ "$proof" = "$id $label_value" ] || return 2
  printf '%s\n' "$id"
}

owned_network_id() {
  local id proof
  id="$(docker network ls -q --no-trunc --filter "name=^${network}$")" || return 3
  [ -n "$id" ] || return 1
  case "$id" in *$'\n'*) return 3 ;; esac
  proof="$(docker network inspect -f "{{.Id}} {{ index .Labels \"$label_key\" }}" "$id")" || return 3
  [ "$proof" = "$id $label_value" ] || return 2
  printf '%s\n' "$id"
}

cleanup() {
  local status=$? id net_id containers networks volumes
  trap - EXIT INT TERM
  set +e
  : >"$evidence/resource-ownership-before-removal.txt"
  if [ "$docker_ready" -ne 1 ]; then
    printf 'docker_ready=0; no resources were created\n' \
      >"$evidence/resource-ownership-before-removal.txt"
    printf 'label=%s\ncontainers=0\nnetworks=0\nvolumes=0\nprocesses=0\n' "$label" \
      >"$evidence/cleanup-receipt.txt"
    rm -rf -- "$private_dir"
    printf 'FAIL T093 owned fixture command_status=%s cleanup_status=0\n' "$status" \
      | tee "$evidence/result.txt" >&2
    exit "$status"
  fi
  for name in "$pg" "$redis"; do
    [ "$name" != "$pg" ] || [ "$pg_created" -eq 1 ] || continue
    [ "$name" != "$redis" ] || [ "$redis_created" -eq 1 ] || continue
    if id="$(owned_container_id "$name")"; then
      printf 'container=%s id=%s label=%s\n' "$name" "$id" "$label" \
        >>"$evidence/resource-ownership-before-removal.txt"
      docker rm -f -v "$id" >/dev/null || cleanup_failed=1
    else
      rc=$?
      [ "$rc" -eq 1 ] || cleanup_failed=1
      printf 'container=%s ownership_status=%s\n' "$name" "$rc" \
        >>"$evidence/resource-ownership-before-removal.txt"
    fi
  done
  if [ "$network_created" -eq 1 ] && net_id="$(owned_network_id)"; then
    printf 'network=%s id=%s label=%s\n' "$network" "$net_id" "$label" \
      >>"$evidence/resource-ownership-before-removal.txt"
    docker network rm "$net_id" >/dev/null || cleanup_failed=1
  else
    rc=$?
    [ "$rc" -eq 1 ] || cleanup_failed=1
    printf 'network=%s ownership_status=%s\n' "$network" "$rc" \
      >>"$evidence/resource-ownership-before-removal.txt"
  fi
  containers="$(docker ps -aq --no-trunc --filter "label=$label" 2>/dev/null)" || containers=lookup_failed
  networks="$(docker network ls -q --no-trunc --filter "label=$label" 2>/dev/null)" || networks=lookup_failed
  volumes="$(docker volume ls -q --filter "label=$label" 2>/dev/null)" || volumes=lookup_failed
  [ -z "$containers" ] || cleanup_failed=1
  [ -z "$networks" ] || cleanup_failed=1
  [ -z "$volumes" ] || cleanup_failed=1
  printf 'label=%s\ncontainers=%s\nnetworks=%s\nvolumes=%s\nprocesses=0\n' \
    "$label" "$([ -z "$containers" ] && printf 0 || printf nonzero)" \
    "$([ -z "$networks" ] && printf 0 || printf nonzero)" \
    "$([ -z "$volumes" ] && printf 0 || printf nonzero)" >"$evidence/cleanup-receipt.txt"
  rm -rf -- "$private_dir"
  if [ "$status" -eq 0 ] && [ "$cleanup_failed" -eq 0 ] && [ "$completed" -eq 1 ]; then
    printf 'PASS T093 owned fixture\n' | tee "$evidence/result.txt"
    exit 0
  fi
  printf 'FAIL T093 owned fixture command_status=%s cleanup_status=%s\n' "$status" "$cleanup_failed" \
    | tee "$evidence/result.txt" >&2
  [ "$status" -ne 0 ] && exit "$status"
  exit 1
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for command in docker node npm openssl; do command -v "$command" >/dev/null || fail "$command is missing"; done
docker info >/dev/null 2>&1 || fail 'Docker is unavailable'
docker_ready=1
[ ! -e "$api_dir/.env" ] || fail 'backend/api/.env is refused'
for image in postgres:16 redis:7-alpine; do
  docker image inspect "$image" >/dev/null 2>&1 || fail "offline image is missing: $image"
done
[ -z "$(docker ps -aq --no-trunc --filter "label=$label")" ] || fail 'run-labeled container exists'
[ -z "$(docker network ls -q --no-trunc --filter "label=$label")" ] || fail 'run-labeled network exists'
[ -z "$(docker volume ls -q --filter "label=$label")" ] || fail 'run-labeled volume exists'

docker network create --label "$label" "$network" >"$private_dir/network-id"
network_created=1
docker run -d --pull never --name "$pg" --label "$label" --network "$network" \
  --memory=1g --cpus=2 --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=1073741824 \
  -p 127.0.0.1::5432 -e POSTGRES_INITDB_ARGS=--no-sync -e POSTGRES_USER="$pg_user" -e POSTGRES_PASSWORD="$pg_password" \
  -e POSTGRES_DB=kemfai_control postgres:16 >"$private_dir/postgres-id"
pg_created=1
docker run -d --pull never --name "$redis" --label "$label" --network "$network" \
  --memory=256m --cpus=.5 --tmpfs /data:rw,noexec,nosuid,size=134217728 \
  -p 127.0.0.1::6379 redis:7-alpine redis-server --save '' --appendonly no \
  >"$private_dir/redis-id"
redis_created=1

sleep 5
pg_port="$(docker port "$pg" 5432/tcp | sed -n 's/^127\.0\.0\.1://p')"
redis_port="$(docker port "$redis" 6379/tcp | sed -n 's/^127\.0\.0\.1://p')"
[[ "$pg_port" =~ ^[0-9]+$ && "$redis_port" =~ ^[0-9]+$ ]] || fail 'loopback port discovery failed'
for _ in $(seq 1 480); do
  docker exec "$pg" pg_isready -U "$pg_user" -d kemfai_control >/dev/null 2>&1 && break
  sleep .25
done
docker exec "$pg" pg_isready -U "$pg_user" -d kemfai_control >/dev/null || { docker logs "$pg" >"$evidence/postgres-readiness.log" 2>&1 || true; fail 'PostgreSQL readiness failed'; }
for _ in $(seq 1 480); do
  [ "$(docker exec "$redis" redis-cli ping 2>/dev/null)" = PONG ] && break
  sleep .25
done
[ "$(docker exec "$redis" redis-cli ping 2>/dev/null)" = PONG ] || { docker logs "$redis" >"$evidence/redis-readiness.log" 2>&1 || true; fail 'Redis readiness failed'; }

export CONTROL_DB_HOST=127.0.0.1 CONTROL_DB_PORT="$pg_port" CONTROL_DB_USER="$pg_user"
export CONTROL_DB_PASSWORD="$pg_password" CONTROL_DB_NAME=kemfai_control
export REDIS_URL="redis://127.0.0.1:$redis_port/14"
printf 'run_id=%s\nlabel=%s\npostgres=%s\nredis=%s\npostgres_port=%s\nredis_port=%s\n' \
  "$run_id" "$label" "$pg" "$redis" "$pg_port" "$redis_port" >"$evidence/fixture-registry.txt"

node "$repo_dir/scripts/t093_manifest.mjs" check
(cd "$api_dir" && npm run migration:run) >"$evidence/migrations.log" 2>&1
: >"$evidence/captures.jsonl"
: >"$evidence/prior-suites.log"
mkdir -p "$evidence/suite-results"
suite_number=0
while IFS=$'\t' read -r suite_path suite_environment; do
  suite_number=$((suite_number + 1))
  suite_database="t093_suite_$(printf '%03d' "$suite_number")"
  suite_key="$(basename "$suite_path" .integration-spec.ts)"
  docker exec "$redis" redis-cli -n 14 FLUSHDB >/dev/null
  docker exec "$pg" psql -v ON_ERROR_STOP=1 -U "$pg_user" -d postgres \
    -c "CREATE DATABASE \"$suite_database\" TEMPLATE \"kemfai_control\"" \
    >>"$evidence/prior-suites.log" 2>&1
  suite_env=()
  [ -z "$suite_environment" ] || suite_env+=("$suite_environment")
  if ! (cd "$api_dir" && env CONTROL_DB_NAME="$suite_database" "${suite_env[@]}" \
    ./node_modules/.bin/jest --config test/jest-t093.json --runInBand \
    --runTestsByPath "$suite_path" --json \
    --outputFile="$evidence/suite-results/$suite_key.json") \
    >>"$evidence/prior-suites.log" 2>&1; then
    fail "isolated suite failed: $suite_path"
  fi
  capture_count="$(docker exec "$pg" psql -v ON_ERROR_STOP=1 -At -U "$pg_user" \
    -d "$suite_database" -c 'SELECT count(*) FROM public.t093_audit_capture')"
  [[ "$capture_count" =~ ^[1-9][0-9]*$ ]] || fail "selected suite produced no persisted audit capture: $suite_path"
  docker exec "$pg" psql -v ON_ERROR_STOP=1 -At -U "$pg_user" -d "$suite_database" \
    -c "SELECT jsonb_build_object('suite_key','$suite_key','capture',to_jsonb(c)) FROM public.t093_audit_capture c ORDER BY capture_id" \
    >>"$evidence/captures.jsonl"
  docker exec "$pg" psql -v ON_ERROR_STOP=1 -U "$pg_user" -d postgres \
    -c "DROP DATABASE \"$suite_database\"" >>"$evidence/prior-suites.log" 2>&1
done < <(node "$repo_dir/scripts/t093_manifest.mjs" list)
node "$repo_dir/scripts/t093_aggregate.mjs" "$evidence/suite-results" "$evidence/prior-suites.json"

export T093_CAPTURE_JSONL="$evidence/captures.jsonl"
(cd "$api_dir" && ./node_modules/.bin/jest --config test/jest-t093-verifier.json --runInBand \
  --runTestsByPath test/integration/audit-source-linkage.integration-spec.ts --json \
  --outputFile="$evidence/verifier.json") >"$evidence/verifier.log" 2>&1

completed=1
exit 0
