#!/usr/bin/env bash
set -euo pipefail
umask 077

mode="${1:-}"
case "$mode" in
  backend|ui) ;;
  *) printf 'usage: %s backend|ui\n' "$0" >&2; exit 2 ;;
esac

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
api_dir="$repo_dir/backend/api"
frontend_dir="$repo_dir/frontend"
expected_label='kemfai.phase12.operation=t112-feature-gating-repair-20261025T113424Z'
label="${T112_FIXTURE_LABEL:-}"
[ "$label" = "$expected_label" ] || {
  printf 'T112_FIXTURE_LABEL must equal %s\n' "$expected_label" >&2
  exit 2
}
evidence_root="${T112_EVIDENCE_DIR:-}"
[ -n "$evidence_root" ] || { printf 'T112_EVIDENCE_DIR is required\n' >&2; exit 2; }
mkdir -p "$evidence_root"
evidence_root="$(cd "$evidence_root" && pwd)"
case "$evidence_root/" in
  "$repo_dir/"*) printf 'T112_EVIDENCE_DIR must be outside the source tree\n' >&2; exit 2 ;;
esac
evidence="$evidence_root/$mode"
mkdir -p "$evidence"
chmod 700 "$evidence"

label_key="${label%%=*}"
label_value="${label#*=}"
run_id="t112-${mode}-$(date -u +%Y%m%dT%H%M%SZ)-$$_${RANDOM}"
network="${run_id}-net"
pg="${run_id}-pg"
redis="${run_id}-redis"
control_db='kemfai_control'
private_dir="$(mktemp -d)"
chmod 700 "$private_dir"
secrets="$private_dir/secrets"
: >"$secrets"
chmod 600 "$secrets"

source "$repo_dir/scripts/fixtures/t071_process_lifecycle.sh"
declare -A owned_pid_starttime=()
declare -A owned_pid_session=()
declare -A original_flags=()
declare -a registered_containers=("$pg" "$redis")
declare -a flag_keys=(
  module.accounts
  module.company_setup
  module.module_selection
  module.onboarding_checklist
  module.support_access
)
port_keeper_pid=''
fixture_pid=''
api_pid=''
frontend_pid=''
db_ready=0
cleanup_failed=0
forced_kill=0
main_completed=0

fail() {
  printf 'FAIL T112 %s fixture: %s\n' "$mode" "$*" >&2
  exit 1
}

redact() {
  python3 -c '
import pathlib, sys
data = sys.stdin.buffer.read()
for value in pathlib.Path(sys.argv[1]).read_bytes().split(b"\0"):
    if value:
        data = data.replace(value, b"[REDACTED]")
sys.stdout.buffer.write(data)
' "$secrets"
}

record_secret() {
  [ -z "$1" ] || printf '%s\0' "$1" >>"$secrets"
}

stop_owned_process() {
  local pid="$1" marker="$2" session survivors
  [ -n "$pid" ] || return 0
  session="${owned_pid_session[$pid]:-}"
  [ -n "$session" ] || return 1
  if pid_owned_by_this_run "$pid" "$marker" || [ -n "$(session_survivors "$session")" ]; then
    kill -TERM -- "-$pid" 2>/dev/null || true
  fi
  for _ in $(seq 1 50); do
    survivors="$(session_survivors "$session")"
    [ -z "$survivors" ] && return 0
    sleep .1
  done
  forced_kill=1
  kill -KILL -- "-$pid" 2>/dev/null || true
  for _ in $(seq 1 50); do
    survivors="$(session_survivors "$session")"
    [ -z "$survivors" ] && return 1
    sleep .1
  done
  return 1
}

exact_container_id() {
  local name="$1" id ownership
  id="$(docker ps -aq --no-trunc --filter "name=^/${name}$")" || return 3
  [ -n "$id" ] || return 1
  case "$id" in *$'\n'*) return 3 ;; esac
  ownership="$(docker inspect -f "{{.Id}} {{ index .Config.Labels \"${label_key}\" }}" "$id")" || return 3
  [ "$ownership" = "$id $label_value" ] || return 2
  printf '%s\n' "$id"
}

exact_network_id() {
  local id ownership
  id="$(docker network ls -q --no-trunc --filter "name=^${network}$")" || return 3
  [ -n "$id" ] || return 1
  case "$id" in *$'\n'*) return 3 ;; esac
  ownership="$(docker network inspect -f "{{.Id}} {{ index .Labels \"${label_key}\" }}" "$id")" || return 3
  [ "$ownership" = "$id $label_value" ] || return 2
  printf '%s\n' "$id"
}

capture_failure_diagnostics() {
  local name id ownership_status diagnostic_name
  for name in "${registered_containers[@]}"; do
    if [ "$name" = "$pg" ]; then
      diagnostic_name=postgres
    else
      diagnostic_name=redis
    fi
    id="$(exact_container_id "$name")"
    ownership_status=$?
    case "$ownership_status" in
      0)
        docker inspect --format 'id={{.Id}} name={{.Name}} state.status={{.State.Status}} state.running={{.State.Running}} state.restarting={{.State.Restarting}} state.oom_killed={{.State.OOMKilled}} state.dead={{.State.Dead}} state.exit_code={{.State.ExitCode}} state.error={{json .State.Error}} state.started_at={{.State.StartedAt}} state.finished_at={{.State.FinishedAt}} restart_count={{.RestartCount}}' "$id" \
          >"$private_dir/${diagnostic_name}-failure-inspect.raw.log" 2>&1 ||
          printf 'allowlisted docker inspect failed\n' \
            >>"$private_dir/${diagnostic_name}-failure-inspect.raw.log"
        docker logs --timestamps "$id" \
          >"$private_dir/${diagnostic_name}-failure-docker.raw.log" 2>&1 ||
          printf 'docker logs failed\n' \
            >>"$private_dir/${diagnostic_name}-failure-docker.raw.log"
        ;;
      1)
        printf 'container absent before failure diagnostics\n' \
          >"$private_dir/${diagnostic_name}-failure-inspect.raw.log"
        ;;
      *)
        printf 'container ownership could not be proven; diagnostics withheld\n' \
          >"$private_dir/${diagnostic_name}-failure-inspect.raw.log"
        ;;
    esac
  done
}

psql_q() {
  docker exec "$pg" psql -v ON_ERROR_STOP=1 -U "$pg_user" -d "$control_db" -X -q -t -A -c "$1"
}

snapshot_flags() {
  local key value
  : >"$evidence/feature-flags-before.txt"
  for key in "${flag_keys[@]}"; do
    value="$(psql_q "SELECT enabled::int FROM feature_flag WHERE feature_key='${key}'")"
    [ "$value" = 0 ] || [ "$value" = 1 ] || fail "missing persisted flag $key"
    original_flags["$key"]="$value"
    printf '%s=%s\n' "$key" "$value" >>"$evidence/feature-flags-before.txt"
  done
}

restore_flags() {
  local key value restored
  [ "$db_ready" -eq 1 ] || return 0
  [ "${#original_flags[@]}" -eq "${#flag_keys[@]}" ] || return 0
  : >"$evidence/feature-flags-restored.txt"
  for key in "${flag_keys[@]}"; do
    value="${original_flags[$key]}"
    psql_q "UPDATE feature_flag SET enabled=$([ "$value" = 1 ] && printf true || printf false) WHERE feature_key='${key}'" >/dev/null || return 1
    restored="$(psql_q "SELECT enabled::int FROM feature_flag WHERE feature_key='${key}'")" || return 1
    [ "$restored" = "$value" ] || return 1
    printf '%s=%s\n' "$key" "$restored" >>"$evidence/feature-flags-restored.txt"
  done
}

persist_private_logs() {
  local file destination
  for file in "$private_dir"/*.raw.log; do
    [ -f "$file" ] || continue
    destination="$evidence/$(basename "${file%.raw.log}").log"
    redact <"$file" >"$destination"
    chmod 600 "$destination"
  done
}

cleanup() {
  local status=$? pid session survivors id ownership_status network_id
  local container_survivors network_survivors volume_survivors volumes_before
  local process_survivor_count=0 ownership_proof_failed=0
  local -A verified_container_ids=()
  trap - EXIT INT TERM
  set +e

  stop_owned_process "$frontend_pid" 'next' || cleanup_failed=1
  stop_owned_process "$api_pid" 'dist/main.js' || cleanup_failed=1
  stop_owned_process "$fixture_pid" 't112-live-fixture.ts' || cleanup_failed=1
  stop_owned_process "$port_keeper_pid" 'reserve_loopback_ports.py' || cleanup_failed=1
  [ "$forced_kill" -eq 0 ] || cleanup_failed=1

  restore_flags || cleanup_failed=1

  : >"$evidence/process-cleanup.txt"
  for pid in "${!owned_pid_starttime[@]}"; do
    session="${owned_pid_session[$pid]}"
    survivors="$(session_survivors "$session")"
    [ -z "$survivors" ] || process_survivor_count=$((process_survivor_count + 1))
    printf 'pid=%s starttick=%s session=%s survivors=%s\n' \
      "$pid" "${owned_pid_starttime[$pid]}" "$session" "${survivors:-none}" \
      >>"$evidence/process-cleanup.txt"
  done
  printf 'forced_kill=%s\nchild_session_survivor_groups=%s\n' \
    "$forced_kill" "$process_survivor_count" >>"$evidence/process-cleanup.txt"
  [ "$process_survivor_count" -eq 0 ] || cleanup_failed=1

  if [ "$status" -ne 0 ] || [ "$main_completed" -ne 1 ] || [ "$cleanup_failed" -ne 0 ]; then
    capture_failure_diagnostics
  fi
  persist_private_logs || cleanup_failed=1

  : >"$evidence/resource-ownership-before-removal.txt"
  for name in "${registered_containers[@]}"; do
    id="$(exact_container_id "$name")"
    ownership_status=$?
    case "$ownership_status" in
      0)
        printf 'container name=%s id=%s label=%s\n' "$name" "$id" "$label" \
          >>"$evidence/resource-ownership-before-removal.txt"
        verified_container_ids["$name"]="$id"
        ;;
      1) printf 'container name=%s absent=true\n' "$name" >>"$evidence/resource-ownership-before-removal.txt" ;;
      *)
        printf 'container name=%s ownership_verified=false\n' "$name" \
          >>"$evidence/resource-ownership-before-removal.txt"
        ownership_proof_failed=1
        ;;
    esac
  done
  network_id="$(exact_network_id)"
  ownership_status=$?
  case "$ownership_status" in
    0)
      printf 'network name=%s id=%s label=%s\n' "$network" "$network_id" "$label" \
        >>"$evidence/resource-ownership-before-removal.txt"
      ;;
    1) printf 'network name=%s absent=true\n' "$network" >>"$evidence/resource-ownership-before-removal.txt" ;;
    *)
      printf 'network name=%s ownership_verified=false\n' "$network" \
        >>"$evidence/resource-ownership-before-removal.txt"
      ownership_proof_failed=1
      ;;
  esac
  if ! volumes_before="$(docker volume ls -q --filter "label=$label" 2>/dev/null)"; then
    printf 'volumes label=%s lookup_failed=true\n' "$label" \
      >>"$evidence/resource-ownership-before-removal.txt"
    ownership_proof_failed=1
  elif [ -z "$volumes_before" ]; then
    printf 'volumes label=%s count=0\n' "$label" >>"$evidence/resource-ownership-before-removal.txt"
  else
    printf 'volumes label=%s unexpected=%s\n' "$label" "$volumes_before" \
      >>"$evidence/resource-ownership-before-removal.txt"
    ownership_proof_failed=1
  fi
  if [ "$ownership_proof_failed" -eq 0 ]; then
    for name in "${registered_containers[@]}"; do
      id="${verified_container_ids[$name]:-}"
      [ -z "$id" ] || docker rm -f -v "$id" >/dev/null || cleanup_failed=1
    done
    [ -z "$network_id" ] || docker network rm "$network_id" >/dev/null || cleanup_failed=1
  else
    cleanup_failed=1
  fi

  if ! container_survivors="$(docker ps -aq --no-trunc --filter "label=$label" 2>/dev/null)"; then
    container_survivors='lookup_failed'
  fi
  if ! network_survivors="$(docker network ls -q --no-trunc --filter "label=$label" 2>/dev/null)"; then
    network_survivors='lookup_failed'
  fi
  if ! volume_survivors="$(docker volume ls -q --filter "label=$label" 2>/dev/null)"; then
    volume_survivors='lookup_failed'
  fi
  [ -z "$container_survivors" ] || cleanup_failed=1
  [ -z "$network_survivors" ] || cleanup_failed=1
  [ -z "$volume_survivors" ] || cleanup_failed=1
  printf 'label=%s\ncontainers=%s\nnetworks=%s\nvolumes=%s\nchild_session_survivor_groups=%s\nforced_kill=%s\n' \
    "$label" \
    "$([ -z "$container_survivors" ] && printf 0 || printf nonzero)" \
    "$([ -z "$network_survivors" ] && printf 0 || printf nonzero)" \
    "$([ -z "$volume_survivors" ] && printf 0 || printf nonzero)" \
    "$process_survivor_count" "$forced_kill" >"$evidence/cleanup-receipt.txt"

  rm -rf -- "$private_dir"
  if [ "$status" -eq 0 ] && [ "$cleanup_failed" -eq 0 ] && [ "$main_completed" -eq 1 ]; then
    printf 'PASS T112 %s owned fixture\n' "$mode" >"$evidence/result.txt"
    exit 0
  fi
  printf 'FAIL T112 %s owned fixture command_status=%s cleanup_status=%s\n' \
    "$mode" "$status" "$cleanup_failed" >"$evidence/result.txt"
  [ "$status" -ne 0 ] && exit "$status"
  exit 1
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for command in docker node npm npx python3 openssl curl; do
  command -v "$command" >/dev/null || fail "$command is missing"
done
docker info >/dev/null 2>&1 || fail 'Docker is unavailable'
[ ! -e "$api_dir/.env" ] && [ ! -e "$frontend_dir/.env" ] || fail 'checkout-local env files are refused'
for image in postgres:16 redis:7-alpine; do
  docker image inspect "$image" >/dev/null 2>&1 || fail "offline image is missing: $image"
done
[ -z "$(docker ps -aq --no-trunc --filter "label=$label")" ] || fail 'labeled container already exists'
[ -z "$(docker network ls -q --no-trunc --filter "label=$label")" ] || fail 'labeled network already exists'
[ -z "$(docker volume ls -q --filter "label=$label")" ] || fail 'labeled volume already exists'

coproc T112_PORT_KEEPER { exec setsid python3 "$repo_dir/scripts/reserve_loopback_ports.py"; }
port_keeper_pid="$T112_PORT_KEEPER_PID"
port_read_fd="${T112_PORT_KEEPER[0]}"
port_write_fd="${T112_PORT_KEEPER[1]}"
register_owned_process "$port_keeper_pid" reserve_loopback_ports.py
read -r port_json <&"$port_read_fd"
readarray -t reserved_ports < <(
  python3 -c 'import json,sys; data=json.loads(sys.argv[1]); [print(data[key]) for key in ("pg","redis","api","frontend")]' "$port_json"
)
[ "${#reserved_ports[@]}" -eq 4 ] || fail 'four-port reservation failed'
pg_port="${reserved_ports[0]}"
redis_port="${reserved_ports[1]}"
api_port="${reserved_ports[2]}"
frontend_port="${reserved_ports[3]}"

release_port() {
  local name="$1" acknowledgement
  printf 'release %s\n' "$name" >&"$port_write_fd"
  read -r acknowledgement <&"$port_read_fd"
  [ "$acknowledgement" = "released $name" ] || fail "port release failed for $name"
}

assert_listener() {
  python3 - "$1" <<'PY'
import socket, sys
with socket.create_connection(('127.0.0.1', int(sys.argv[1])), timeout=2):
    pass
PY
}

pg_user="t112_$(openssl rand -hex 5)"
pg_password="$(openssl rand -hex 24)"
record_secret "$pg_password"
printf 'mode=%s\nrun_id=%s\nlabel=%s\npostgres_container=%s\nredis_container=%s\npostgres_port=%s\nredis_port=%s\napi_port=%s\nfrontend_port=%s\n' \
  "$mode" "$run_id" "$label" "$pg" "$redis" "$pg_port" "$redis_port" "$api_port" \
  "$frontend_port" >"$evidence/fixture-registry.txt"

docker network create --label "$label" "$network" >/dev/null
release_port pg
docker run -d --name "$pg" --label "$label" --network "$network" \
  --memory=768m --cpus=1 \
  --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=536870912 \
  -p "127.0.0.1:$pg_port:5432" \
  -e POSTGRES_USER="$pg_user" -e POSTGRES_PASSWORD="$pg_password" -e POSTGRES_DB="$control_db" \
  postgres:16 >"$private_dir/postgres-container-id"
release_port redis
docker run -d --name "$redis" --label "$label" --network "$network" \
  --memory=256m --cpus=.5 --tmpfs /data:rw,noexec,nosuid,size=134217728 \
  -p "127.0.0.1:$redis_port:6379" redis:7-alpine \
  redis-server --save '' --appendonly no >"$private_dir/redis-container-id"

pg_final_initialization=0
for _ in $(seq 1 120); do
  pg_logs="$(docker logs "$pg" 2>&1 || true)"
  case "$pg_logs" in
    *'PostgreSQL init process complete; ready for start up.'*)
      pg_final_initialization=1
      break
      ;;
  esac
  sleep .25
done
[ "$pg_final_initialization" -eq 1 ] || fail 'PostgreSQL final initialization timed out'
pg_stable_successes=0
for _ in $(seq 1 120); do
  if pg_probe="$(psql_q 'SELECT 1' 2>/dev/null)" && [ "$pg_probe" = 1 ]; then
    pg_stable_successes=$((pg_stable_successes + 1))
    [ "$pg_stable_successes" -lt 4 ] || break
  else
    pg_stable_successes=0
  fi
  sleep .25
done
[ "$pg_stable_successes" -ge 4 ] || fail 'PostgreSQL stable SQL readiness timed out'
for _ in $(seq 1 120); do
  [ "$(docker exec "$redis" redis-cli ping 2>/dev/null)" = PONG ] && break
  sleep .25
done
[ "$(docker exec "$redis" redis-cli ping 2>/dev/null)" = PONG ] || fail 'Redis readiness timed out'
assert_listener "$pg_port"
assert_listener "$redis_port"

export CONTROL_DB_HOST=127.0.0.1
export CONTROL_DB_PORT="$pg_port"
export CONTROL_DB_USER="$pg_user"
export CONTROL_DB_PASSWORD="$pg_password"
export CONTROL_DB_NAME="$control_db"
export REDIS_URL="redis://127.0.0.1:$redis_port/14"
export SUPPORT_ACCESS_MAX_DURATION_HOURS=24

(cd "$api_dir" && npm run migration:run) >"$private_dir/migrations.raw.log" 2>&1
db_ready=1
snapshot_flags

validate_jest_json() {
  python3 - "$@" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
expected_suites = int(sys.argv[2])
expected_tests = int(sys.argv[3])
expected_specs = sys.argv[4:]
data = json.loads(path.read_text())
required_zero = (
    'numFailedTestSuites',
    'numFailedTests',
    'numPendingTestSuites',
    'numPendingTests',
    'numRuntimeErrorTestSuites',
    'numTodoTests',
)
bad = {key: data.get(key) for key in required_zero if data.get(key) != 0}
counts = {
    'numTotalTestSuites': data.get('numTotalTestSuites'),
    'numPassedTestSuites': data.get('numPassedTestSuites'),
    'numTotalTests': data.get('numTotalTests'),
    'numPassedTests': data.get('numPassedTests'),
}
expected_counts = {
    'numTotalTestSuites': expected_suites,
    'numPassedTestSuites': expected_suites,
    'numTotalTests': expected_tests,
    'numPassedTests': expected_tests,
}
actual_specs = [pathlib.Path(result.get('name', '')).as_posix() for result in data.get('testResults', [])]
missing_specs = [spec for spec in expected_specs if not any(name.endswith('/' + spec) for name in actual_specs)]
unexpected_specs = [name for name in actual_specs if not any(name.endswith('/' + spec) for spec in expected_specs)]
if (
    bad
    or data.get('success') is not True
    or data.get('wasInterrupted') is not False
    or counts != expected_counts
    or len(expected_specs) != expected_suites
    or missing_specs
    or unexpected_specs
):
    raise SystemExit(
        f'non-green/incomplete Jest JSON: zero_fields={bad}, success={data.get("success")!r}, '
        f'interrupted={data.get("wasInterrupted")!r}, counts={counts}, expected={expected_counts}, '
        f'missing_specs={missing_specs}, unexpected_specs={unexpected_specs}'
    )
print(json.dumps({key: data.get(key) for key in (*required_zero, *counts, 'success', 'wasInterrupted')}, sort_keys=True))
PY
}

if [ "$mode" = backend ]; then
  integration_json="$evidence/backend-integration.json"
  unit_json="$evidence/backend-affected-unit.json"
  (cd "$api_dir" && npm run test:integration -- --runInBand --runTestsByPath \
    test/integration/feature-flag-gating.integration-spec.ts \
    test/integration/support-access-denial.integration-spec.ts \
    test/integration/entitlements-service.integration-spec.ts \
    --json --outputFile="$integration_json") >"$private_dir/backend-integration.raw.log" 2>&1
  validate_jest_json "$integration_json" 3 77 \
    test/integration/feature-flag-gating.integration-spec.ts \
    test/integration/support-access-denial.integration-spec.ts \
    test/integration/entitlements-service.integration-spec.ts \
    >"$evidence/backend-integration-summary.json"
  (cd "$api_dir" && npm test -- --runInBand --runTestsByPath \
    src/modules/entitlements/entitlements.service.spec.ts \
    src/common/guards/feature-flag.guard.spec.ts src/app.guard-order.spec.ts \
    --json --outputFile="$unit_json") >"$private_dir/backend-affected-unit.raw.log" 2>&1
  validate_jest_json "$unit_json" 3 20 \
    src/modules/entitlements/entitlements.service.spec.ts \
    src/common/guards/feature-flag.guard.spec.ts src/app.guard-order.spec.ts \
    >"$evidence/backend-affected-unit-summary.json"
else
  plan_id='11200000-0000-4000-8000-000000000005'
  account_id='11200000-0000-4000-8000-000000000003'
  tenant_id='11200000-0000-4000-8000-000000000004'
  subscription_id='11200000-0000-4000-8000-000000000006'
  customer_subject='11200000-0000-4000-8000-000000000001'
  tenant_database='t112_synthetic_tenant'
  psql_q "INSERT INTO plan(id,name,name_en,name_ar,published,monthly_price,annual_price,currency) VALUES('$plan_id','T112 synthetic plan','T112 synthetic plan','T112',true,10,100,'USD'); INSERT INTO plan_setting(plan_id,trial_window_days,auto_restrict_unpaid) VALUES('$plan_id',14,true); INSERT INTO feature(id,key,display_name,display_name_en,display_name_ar,kind) VALUES(gen_random_uuid(),'module.accounting','Accounting','Accounting','المحاسبة','module') ON CONFLICT(key) DO NOTHING; INSERT INTO plan_feature_entitlement(plan_id,feature_key,enabled) VALUES('$plan_id','module.accounting',true); INSERT INTO account(id,keycloak_user_id,email,email_verified,mfa_enrolled,selected_plan_id,selected_billing_cycle) VALUES('$account_id','$customer_subject','t112-owner@example.invalid',true,true,'$plan_id','monthly'); INSERT INTO tenant(id,account_id,status,odoo_db_name,odoo_company_id,provisioning_attempts,ready_at) VALUES('$tenant_id','$account_id','Ready','$tenant_database',1,1,now()); INSERT INTO subscription(id,tenant_id,plan_id,billing_cycle,status,current_period_start,current_period_end,activated_at,activated_by) VALUES('$subscription_id','$tenant_id','$plan_id','monthly','Active',current_date,'2099-01-01',now(),'$account_id'); UPDATE feature_flag SET enabled=true WHERE feature_key IN ('module.accounts','module.company_setup','module.module_selection','module.onboarding_checklist','module.support_access');" >/dev/null

  fixture_json="$private_dir/live-fixture.json"
  (
    cd "$api_dir"
    export T112_FIXTURE_OUTPUT="$fixture_json" T112_TENANT_ID="$tenant_id" T112_TENANT_DATABASE="$tenant_database"
    exec setsid ./node_modules/.bin/ts-node test/support/t112-live-fixture.ts
  ) >"$private_dir/live-fixture.raw.log" 2>&1 &
  fixture_pid=$!
  register_owned_process "$fixture_pid" t112-live-fixture.ts
  for _ in $(seq 1 120); do
    [ -s "$fixture_json" ] && break
    sleep .1
  done
  [ -s "$fixture_json" ] || fail 'identity/Odoo fixture readiness timed out'
  readarray -t fixture_values < <(
    python3 -c 'import json,sys; data=json.load(open(sys.argv[1])); [print(data[key]) for key in ("customerIssuer","audience","jwksUri","ownerToken","odooUrl")]' "$fixture_json"
  )
  customer_issuer="${fixture_values[0]}"
  audience="${fixture_values[1]}"
  jwks_uri="${fixture_values[2]}"
  owner_token="${fixture_values[3]}"
  odoo_url="${fixture_values[4]}"
  record_secret "$owner_token"
  session_id="$(openssl rand -hex 24)"
  odoo_master="$(openssl rand -hex 24)"
  odoo_password="$(openssl rand -hex 24)"
  record_secret "$session_id"
  record_secret "$odoo_master"
  record_secret "$odoo_password"
  now_ms="$(date +%s000)"
  expires_ms="$((now_ms + 7200000))"
  docker exec "$redis" redis-cli -n 14 SET "kemfai:session:$session_id" \
    "{\"accessToken\":\"$owner_token\",\"refreshToken\":\"synthetic-t112\",\"accessExpiresAt\":$expires_ms,\"refreshExpiresAt\":$expires_ms}" \
    PX 7200000 >/dev/null

  (cd "$api_dir" && npm run build) >"$private_dir/api-build.raw.log" 2>&1
  (
    cd "$frontend_dir"
    export KEMFAI_API_URL="http://127.0.0.1:$api_port" REDIS_URL="redis://127.0.0.1:$redis_port/14"
    export NEXT_PUBLIC_DEFAULT_LOCALE=en NEXT_PUBLIC_APP_URL="http://127.0.0.1:$frontend_port"
    export KEYCLOAK_ISSUER="$customer_issuer" KEYCLOAK_BACKCHANNEL_URL="$customer_issuer"
    export KEYCLOAK_JWKS_URI="$jwks_uri" KEYCLOAK_CLIENT_ID=kemfai-api
    export KEYCLOAK_REDIRECT_URI="http://127.0.0.1:$frontend_port/auth/callback"
    NEXT_PRIVATE_BUILD_WORKER=1 npm run build
  ) >"$private_dir/frontend-build.raw.log" 2>&1

  release_port api
  (
    cd "$api_dir"
    export PORT="$api_port" HOST=127.0.0.1 NODE_ENV=test
    export KEYCLOAK_ISSUER="$customer_issuer" KEYCLOAK_API_AUDIENCE="$audience" KEYCLOAK_JWKS_URI="$jwks_uri"
    export KEMFAI_ODOO_URL="$odoo_url" KEMFAI_ODOO_MASTER_PASSWORD="$odoo_master"
    export KEMFAI_TENANT_ADMIN_LOGIN=t112-owned KEMFAI_TENANT_ADMIN_PASSWORD="$odoo_password"
    export KEMFAI_DISABLE_MODULE_SELECTION_RECOVERY_WORKER=1 KEMFAI_DISABLE_MUTATION_RECOVERY_WORKER=1
    export KEMFAI_DISABLE_BILLING_NOTIFICATION_RECOVERY_WORKER=1
    exec setsid node dist/main.js
  ) >"$private_dir/api.raw.log" 2>&1 &
  api_pid=$!
  register_owned_process "$api_pid" dist/main.js
  for _ in $(seq 1 120); do
    curl -sf "http://127.0.0.1:$api_port/" >/dev/null && break
    sleep .25
  done
  curl -sf "http://127.0.0.1:$api_port/" >/dev/null || fail 'Nest API readiness timed out'
  assert_listener "$api_port"

  release_port frontend
  (
    cd "$frontend_dir"
    export NODE_ENV=production PORT="$frontend_port"
    export KEMFAI_API_URL="http://127.0.0.1:$api_port" REDIS_URL="redis://127.0.0.1:$redis_port/14"
    export NEXT_PUBLIC_DEFAULT_LOCALE=en NEXT_PUBLIC_APP_URL="http://127.0.0.1:$frontend_port"
    export KEYCLOAK_ISSUER="$customer_issuer" KEYCLOAK_BACKCHANNEL_URL="$customer_issuer"
    export KEYCLOAK_JWKS_URI="$jwks_uri" KEYCLOAK_CLIENT_ID=kemfai-api
    export KEYCLOAK_REDIRECT_URI="http://127.0.0.1:$frontend_port/auth/callback"
    exec setsid ./node_modules/.bin/next start -H 127.0.0.1 -p "$frontend_port"
  ) >"$private_dir/frontend.raw.log" 2>&1 &
  frontend_pid=$!
  register_owned_process "$frontend_pid" next
  for _ in $(seq 1 180); do
    curl -sf "http://127.0.0.1:$frontend_port/" >/dev/null && break
    sleep .25
  done
  curl -sf "http://127.0.0.1:$frontend_port/" >/dev/null || fail 'Next readiness timed out'
  assert_listener "$frontend_port"

  playwright_json="$evidence/playwright.json"
  export T112_BASE_URL="http://127.0.0.1:$frontend_port"
  export T112_SESSION_ID="$session_id"
  export T112_PG_CONTAINER="$pg"
  export T112_PG_USER="$pg_user"
  export T112_CONTROL_DB="$control_db"
  export T112_PLAYWRIGHT_JSON="$playwright_json"
  export T112_PLAYWRIGHT_OUTPUT_DIR="$evidence/playwright-output"
  (
    cd "$frontend_dir"
    export PLAYWRIGHT_BROWSERS_PATH
    PLAYWRIGHT_BROWSERS_PATH="$(node ../scripts/fixtures/t071_resolve_playwright_browser.mjs)"
    npx playwright test --config tests/e2e-live/playwright.t112-live.config.ts
  ) >"$private_dir/playwright.raw.log" 2>&1
  python3 - "$playwright_json" "$evidence/playwright-summary.json" <<'PY'
import json, pathlib, sys
source, destination = map(pathlib.Path, sys.argv[1:])
data = json.loads(source.read_text())
stats = data.get('stats', {})
summary = {key: stats.get(key) for key in ('expected', 'skipped', 'unexpected', 'flaky')}
summary['errors'] = len(data.get('errors', []))
if summary != {'expected': 6, 'skipped': 0, 'unexpected': 0, 'flaky': 0, 'errors': 0}:
    raise SystemExit(f'non-green Playwright JSON: {summary}')
destination.write_text(json.dumps(summary, sort_keys=True) + '\n')
PY
  psql_q "SELECT feature_key || '=' || enabled::int FROM feature_flag WHERE feature_key IN ('module.module_selection','module.onboarding_checklist','module.support_access') ORDER BY feature_key" >"$evidence/ui-cycle-final-flags.txt"
fi

main_completed=1
exit 0
