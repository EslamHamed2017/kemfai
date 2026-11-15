#!/usr/bin/env bash
# T072/T073/T075/T076 exact-owned live acceptance. No container port is published:
# audited loopback relays are the only host bridge into the run's internal Docker network.
set -euo pipefail
umask 077
repo_dir="${KEMFAI_T072_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
api_dir="$repo_dir/backend/api"
run_id="t072_$(date -u +%Y%m%dT%H%M%SZ)_$$_${RANDOM}"
label="kemfai.t072.run=$run_id"
network="${run_id}_net"; pg="${run_id}_pg"; redis="${run_id}_redis"; odoo="${run_id}_odoo"
pg_volume="${run_id}_pgdata"; odoo_volume="${run_id}_odoodata"
tenant_a="${run_id}_tenant_a"; tenant_b="${run_id}_tenant_b"; control_db="${run_id}_control"
private_dir="$(mktemp -d)"; chmod 700 "$private_dir"
artifacts_dir="${KEMFAI_ARTIFACTS_DIR:-$repo_dir/.artifacts/${run_id}}"; mkdir -p "$artifacts_dir"; chmod 700 "$artifacts_dir"
declare -a relay_pids=(); declare -A owned_pid_starttime=(); declare -A owned_pid_session=()
cleanup_failed=0
exit_reason='unhandled command failure'

fail() { exit_reason="$*"; echo "FAIL T072 live: $*" >&2; exit 1; }
source "$repo_dir/scripts/fixtures/t071_process_lifecycle.sh"

redact_stream() {
  python3 -c 'import pathlib,sys
secrets=[v for v in pathlib.Path(sys.argv[1]).read_bytes().split(b"\0") if v]
data=sys.stdin.buffer.read()
for value in secrets: data=data.replace(value,b"[REDACTED]")
sys.stdout.buffer.write(data)' "$secrets"
}

capture_failure_diagnostics() {
  local status="$1" name state_file log_file resource_id
  printf 'run_id=%s\nexit_status=%s\nexit_reason=%s\nnetwork=%s\ncontainers=%s,%s,%s\nvolumes=%s,%s\n' \
    "$run_id" "$status" "$exit_reason" "$network" "$pg" "$redis" "$odoo" \
    "$pg_volume" "$odoo_volume" >"$artifacts_dir/ownership-manifest.txt"
  chmod 600 "$artifacts_dir/ownership-manifest.txt"
  for name in "$pg" "$redis" "$odoo"; do
    resource_id="$(docker ps -aq --filter "name=^/${name}$" --filter "label=$label" 2>/dev/null || true)"
    [ -n "$resource_id" ] || continue
    state_file="$artifacts_dir/${name#${run_id}_}-state.json"
    log_file="$artifacts_dir/${name#${run_id}_}-logs.log"
    docker inspect --format '{{json .State}}' "$resource_id" 2>/dev/null | redact_stream >"$state_file" || printf '{}\n' >"$state_file"
    docker inspect --format 'service={{.Name}} running={{.State.Running}} exit_code={{.State.ExitCode}} oom_killed={{.State.OOMKilled}} error={{json .State.Error}}' \
      "$resource_id" 2>/dev/null | redact_stream >>"$artifacts_dir/ownership-manifest.txt" || true
    docker logs "$resource_id" 2>&1 | redact_stream >"$log_file" || true
    chmod 600 "$state_file" "$log_file"
  done
}

cleanup() {
  local status=$? pid survivors
  trap - EXIT INT TERM
  if [ "$status" -ne 0 ]; then capture_failure_diagnostics "$status" || cleanup_failed=1; fi
  for pid in "${relay_pids[@]}"; do terminate_owned_process_group "$pid" t071_loopback_relay.py || cleanup_failed=1; done
  mapfile -t owned < <(docker ps -aq --filter "label=$label" 2>/dev/null || true)
  [ "${#owned[@]}" -eq 0 ] || docker rm -fv "${owned[@]}" >/dev/null 2>&1 || cleanup_failed=1
  docker network ls -q --filter "label=$label" | xargs -r docker network rm >/dev/null 2>&1 || cleanup_failed=1
  docker volume ls -q --filter "label=$label" | xargs -r docker volume rm >/dev/null 2>&1 || cleanup_failed=1
  survivors="$(docker ps -aq --filter "label=$label" 2>/dev/null; docker network ls -q --filter "label=$label" 2>/dev/null; docker volume ls -q --filter "label=$label" 2>/dev/null)"
  [ -z "$survivors" ] || { echo "FAIL cleanup: exact-label survivor(s): $survivors" >&2; cleanup_failed=1; }
  rm -rf -- "$private_dir"
  [ "$cleanup_failed" -eq 0 ] || status=1
  exit "$status"
}
trap cleanup EXIT INT TERM

for command in curl docker node npm python3 openssl; do command -v "$command" >/dev/null || fail "$command is required"; done
docker info >/dev/null 2>&1 || fail 'Docker daemon unavailable'
[ ! -e "$api_dir/.env" ] && [ ! -e "$api_dir/.env.local" ] || fail 'refusing checkout-local .env files'
for image in postgres:16 redis:7-alpine odoo:18; do docker image inspect "$image" >/dev/null 2>&1 || fail "required offline image missing: $image"; done

pg_user="t072_$(openssl rand -hex 6)"; pg_password="$(openssl rand -hex 24)"
odoo_login="admin"; odoo_password="$(openssl rand -hex 24)"; odoo_master="$(openssl rand -hex 24)"
secrets="$private_dir/secrets"; printf '%s\0%s\0%s\0' "$pg_password" "$odoo_password" "$odoo_master" >"$secrets"; chmod 600 "$secrets"
pg_env="$private_dir/postgres.env"; printf 'POSTGRES_USER=%s\nPOSTGRES_PASSWORD=%s\nPOSTGRES_DB=%s\n' "$pg_user" "$pg_password" "$control_db" >"$pg_env"; chmod 600 "$pg_env"
odoo_config="$(cat <<EOF
[options]
admin_passwd = $odoo_master
db_host = $pg
db_port = 5432
db_user = $pg_user
db_password = $pg_password
dbfilter = ^${run_id}_tenant_[ab]$
list_db = False
proxy_mode = False
workers = 0
without_demo = all
addons_path = /mnt/extra-addons,/usr/lib/python3/dist-packages/odoo/addons
EOF
)"

docker network create --internal --label "$label" "$network" >/dev/null
docker volume create --label "$label" "$pg_volume" >/dev/null
docker volume create --label "$label" "$odoo_volume" >/dev/null
# The official image runs as an unprivileged Odoo UID which cannot read a host-owned
# mode-0600 bind mount. Feed the config once through stdin to that UID and store it mode
# 0600 in this run's exact-labelled Odoo volume (removed by the cleanup trap). Values
# never enter argv, environment, logs, an image layer, or a host-readable bind mount.
odoo_config_path='/var/lib/odoo/.kemfai-t072.conf'
printf '%s\n' "$odoo_config" | docker run --rm -i --label "$label" \
  -v "$odoo_volume:/var/lib/odoo" odoo:18 sh -c \
  'set -eu; umask 077; cat > /var/lib/odoo/.kemfai-t072.conf; [ "$(stat -c %a /var/lib/odoo/.kemfai-t072.conf)" = 600 ]'
docker run -d --label "$label" --name "$pg" --network "$network" --env-file "$pg_env" -v "$pg_volume:/var/lib/postgresql/data" postgres:16 >/dev/null
docker run -d --label "$label" --name "$redis" --network "$network" redis:7-alpine >/dev/null
pg_readiness="$artifacts_dir/pg-readiness.log"; : >"$pg_readiness"; chmod 600 "$pg_readiness"
pg_ready=0
for attempt in $(seq 1 60); do
  set +e
  readiness_output="$(docker exec "$pg" pg_isready -h /var/run/postgresql -p 5432 -U "$pg_user" -d "$control_db" 2>&1)"
  readiness_code=$?
  set -e
  printf 'attempt=%s exit_code=%s\n%s\n' "$attempt" "$readiness_code" "$readiness_output" | redact_stream >>"$pg_readiness"
  if [ "$readiness_code" -eq 0 ]; then pg_ready=1; break; fi
  pg_running="$(docker inspect --format '{{.State.Running}}' "$pg" 2>/dev/null || printf unknown)"
  if [ "$pg_running" != true ]; then fail 'PostgreSQL container exited during readiness; retained state and logs identify the cause'; fi
  sleep .5
done
[ "$pg_ready" -eq 1 ] || fail 'PostgreSQL remained running but was not ready within the 30-second bound'
redis_readiness="$artifacts_dir/redis-readiness.log"; : >"$redis_readiness"; chmod 600 "$redis_readiness"
set +e; redis_output="$(docker exec "$redis" redis-cli ping 2>&1)"; redis_code=$?; set -e
printf 'exit_code=%s\n%s\n' "$redis_code" "$redis_output" | redact_stream >"$redis_readiness"
[ "$redis_code" -eq 0 ] && [ "$redis_output" = PONG ] || fail 'Redis not ready; retained state and logs identify the cause'

for tenant_db in "$tenant_a" "$tenant_b"; do
  docker run --rm --entrypoint odoo --label "$label" --network "$network" \
    -v "$repo_dir/backend/addons:/mnt/extra-addons:ro" -v "$odoo_volume:/var/lib/odoo" \
    odoo:18 -c "$odoo_config_path" -d "$tenant_db" \
    -i base,kemfai_tenant_core,kemfai_module_selection --stop-after-init --without-demo=all \
    2>&1 | redact_stream >"$artifacts_dir/bootstrap-${tenant_db}.log" || fail "Odoo bootstrap failed for $tenant_db"
  printf "env['res.users'].browse(2).write({'login': '%s', 'password': '%s'})\nenv.cr.commit()\n" "$odoo_login" "$odoo_password" |
    docker run --rm -i --entrypoint odoo --label "$label" --network "$network" \
      -v "$repo_dir/backend/addons:/mnt/extra-addons:ro" -v "$odoo_volume:/var/lib/odoo" \
      odoo:18 shell -c "$odoo_config_path" -d "$tenant_db" \
      2>&1 | redact_stream >>"$artifacts_dir/bootstrap-${tenant_db}.log" || fail "Odoo credential setup failed for $tenant_db"
done
docker run -d --entrypoint odoo --label "$label" --name "$odoo" --network "$network" \
  -v "$repo_dir/backend/addons:/mnt/extra-addons:ro" \
  -v "$odoo_volume:/var/lib/odoo" odoo:18 -c "$odoo_config_path" >/dev/null

start_relay() {
  local container="$1" port="$2" output="$3" ip subnet config ready pid ready_pid relay_port
  ip="$(docker inspect -f "{{with index .NetworkSettings.Networks \"$network\"}}{{.IPAddress}}{{end}}" "$container")"
  subnet="$(docker network inspect -f '{{(index .IPAM.Config 0).Subnet}}' "$network")"
  config="$private_dir/relay-${container}.json"; ready="$private_dir/relay-${container}.ready"
  printf '{"targetIp":"%s","subnet":"%s","targetPort":%s,"readyFile":"%s"}\n' "$ip" "$subnet" "$port" "$ready" >"$config"; chmod 600 "$config"
  (export T071_RELAY_CONFIG="$config"; exec python3 "$repo_dir/scripts/fixtures/t071_owned_session_exec.py" --keep-env T071_RELAY_CONFIG python3 "$repo_dir/scripts/fixtures/t071_loopback_relay.py") >"$artifacts_dir/relay-${container}.log" 2>&1 &
  pid=$!; relay_pids+=("$pid"); register_owned_process "$pid" t071_loopback_relay.py
  for _ in $(seq 1 100); do [ -s "$ready" ] && break; sleep .05; done
  [ -s "$ready" ] || fail "relay for $container failed"
  read -r ready_pid relay_port < <(python3 - "$ready" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); print(d['pid'],d['port'])
PY
  )
  [ "$ready_pid" = "$pid" ] || fail 'relay PID mismatch'
  printf -v "$output" '%s' "$relay_port"
}
start_relay "$pg" 5432 pg_port
start_relay "$redis" 6379 redis_port
start_relay "$odoo" 8069 odoo_port
odoo_readiness="$artifacts_dir/odoo-readiness.log"; : >"$odoo_readiness"; chmod 600 "$odoo_readiness"
odoo_ready=0
for attempt in $(seq 1 120); do
  set +e; odoo_output="$(curl -sf "http://127.0.0.1:${odoo_port}/web/health" 2>&1)"; odoo_code=$?; set -e
  printf 'attempt=%s exit_code=%s\n%s\n' "$attempt" "$odoo_code" "$odoo_output" | redact_stream >>"$odoo_readiness"
  if [ "$odoo_code" -eq 0 ]; then odoo_ready=1; break; fi
  odoo_running="$(docker inspect --format '{{.State.Running}}' "$odoo" 2>/dev/null || printf unknown)"
  [ "$odoo_running" = true ] || fail 'Odoo container exited during readiness; retained state and logs identify the cause'
  sleep .5
done
[ "$odoo_ready" -eq 1 ] || fail 'Odoo remained running but HTTP was not ready within the existing bound'

export CONTROL_DB_HOST=127.0.0.1 CONTROL_DB_PORT="$pg_port" CONTROL_DB_USER="$pg_user" CONTROL_DB_PASSWORD="$pg_password" CONTROL_DB_NAME="$control_db"
export REDIS_URL="redis://127.0.0.1:${redis_port}/14" KEMFAI_ODOO_URL="http://127.0.0.1:${odoo_port}"
export KEMFAI_ODOO_MASTER_PASSWORD="$odoo_master" KEMFAI_TENANT_ADMIN_LOGIN="$odoo_login" KEMFAI_TENANT_ADMIN_PASSWORD="$odoo_password"
export KEMFAI_LIVE_T072=1 KEMFAI_T072_STACK_OWNED=1 KEMFAI_T072_TENANT_A_DB="$tenant_a" KEMFAI_T072_TENANT_B_DB="$tenant_b"
(cd "$api_dir" && npm run typeorm -- migration:run -d src/database/data-source.ts) 2>&1 | redact_stream >"$artifacts_dir/migrations.log" || fail 'control migrations failed'
(cd "$api_dir" && ./node_modules/.bin/jest --config test/jest-owned-integration.json --runInBand --runTestsByPath test/integration/module-selection-live.integration-spec.ts) 2>&1 | redact_stream | tee "$artifacts_dir/module-selection-live.log"
echo "PASS T072 owned live acceptance; evidence=$artifacts_dir"
