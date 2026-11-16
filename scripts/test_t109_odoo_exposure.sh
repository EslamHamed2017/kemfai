#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

OPERATION_ID='t109-parent-gates-continuation-20261025T153344Z'
RESOURCE_LABEL="kemfai.phase12.operation=$OPERATION_ID"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MODE="${1:-all}"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

case "$MODE" in
  backend|frontend|all|preflight) ;;
  *) fail 'usage: test_t109_odoo_exposure.sh backend|frontend|all|preflight' ;;
esac
[ "${T109_FIXTURE_LABEL:-$RESOURCE_LABEL}" = "$RESOURCE_LABEL" ] \
  || fail 'unexpected T109_FIXTURE_LABEL'
export T109_FIXTURE_LABEL="$RESOURCE_LABEL"
if [ "$MODE" = preflight ]; then
  echo "T109 fixture identity: $T109_FIXTURE_LABEL"
  exit 0
fi

EVIDENCE_DIR="${T109_EVIDENCE_DIR:-/tmp/t109-odoo-exposure-evidence.$$.d}"
case "$EVIDENCE_DIR" in /*) ;; *) fail 'T109_EVIDENCE_DIR must be absolute' ;; esac
case "$EVIDENCE_DIR/" in "$REPO_ROOT"/*) fail 'T109_EVIDENCE_DIR must be outside the pinned source' ;; esac
mkdir -p -m 700 "$EVIDENCE_DIR"
chmod 700 "$EVIDENCE_DIR"
export T109_EVIDENCE_DIR="$EVIDENCE_DIR"

PRIVATE_DIR="$(mktemp -d /tmp/t109-odoo-exposure.XXXXXX)"
declare -A owned_pid_starttime=()
declare -A owned_pid_session=()
API_PID=''
NEXT_PID=''
PG_CONTAINER="kemfai-t109-${$}-postgres"
REDIS_CONTAINER="kemfai-t109-${$}-redis"
PG_CONTAINER_ID=''
REDIS_CONTAINER_ID=''
PG_ATTEMPTED=0
REDIS_ATTEMPTED=0
PG_PORT=''
REDIS_PORT=''
API_PORT=''
FRONTEND_PORT=''
source "$SCRIPT_DIR/fixtures/t071_process_lifecycle.sh"

remove_owned_container() {
  local name="$1" expected_id="$2" kind="$3" candidate='' actual_label=''
  candidate="$(docker container inspect --format '{{.Id}}' "$name" 2>/dev/null)" || true
  [ -n "$candidate" ] || return 0
  actual_label="$(docker container inspect \
    --format '{{ index .Config.Labels "kemfai.phase12.operation" }}' \
    "$candidate" 2>/dev/null)" || true
  if [ "$actual_label" != "$OPERATION_ID" ] || { [ -n "$expected_id" ] && [ "$candidate" != "$expected_id" ]; }; then
    echo "FAIL cleanup: $kind fixture identity/label mismatch; refusing removal" >&2
    return 1
  fi
  docker rm -fv "$candidate" >/dev/null 2>&1
}

cleanup() {
  local status=$? cleanup_status=0 survivors=''
  trap - EXIT INT TERM
  set +e
  terminate_owned_process_group "$NEXT_PID" 'next start' || cleanup_status=1
  terminate_owned_process_group "$API_PID" 't109-http-server.ts' || cleanup_status=1
  if command -v docker >/dev/null 2>&1 \
    && { [ "$REDIS_ATTEMPTED" -eq 1 ] || [ "$PG_ATTEMPTED" -eq 1 ]; }; then
    if [ "$REDIS_ATTEMPTED" -eq 1 ]; then
      remove_owned_container "$REDIS_CONTAINER" "$REDIS_CONTAINER_ID" Redis \
        || cleanup_status=1
    fi
    if [ "$PG_ATTEMPTED" -eq 1 ]; then
      remove_owned_container "$PG_CONTAINER" "$PG_CONTAINER_ID" PostgreSQL \
        || cleanup_status=1
    fi
    survivors="$(docker ps -aq --filter "label=$RESOURCE_LABEL" 2>/dev/null)" \
      || cleanup_status=1
    [ -z "$survivors" ] || cleanup_status=1
  fi
  case "$PRIVATE_DIR" in
    /tmp/t109-odoo-exposure.*) rm -rf -- "$PRIVATE_DIR" || cleanup_status=1 ;;
    *) cleanup_status=1 ;;
  esac
  printf 'operation_id=%s\nresource_label=%s\ncontainer_survivors=%s\nprocess_or_resource_cleanup=%s\n' \
    "$OPERATION_ID" "$RESOURCE_LABEL" "${survivors:-none}" "$cleanup_status" \
    > "$EVIDENCE_DIR/cleanup-receipt.txt"
  chmod 600 "$EVIDENCE_DIR/cleanup-receipt.txt"
  if [ "$status" -eq 0 ] && [ "$cleanup_status" -ne 0 ]; then status=$cleanup_status; fi
  exit "$status"
}
trap cleanup EXIT INT TERM

log_has_startup_failure() {
  local log="$1"
  if command -v rg >/dev/null 2>&1; then
    rg -q '(^|[^0-9])(Error|FAIL|EADDRINUSE|EPERM)' "$log"
  else
    grep -Eq '(^|[^0-9])(Error|FAIL|EADDRINUSE|EPERM)' "$log"
  fi
}

wait_http() {
  local url="$1" log="$2"
  for _ in $(seq 1 480); do
    if curl --silent --show-error --fail --max-time 2 "$url" >/dev/null 2>&1; then return 0; fi
    if [ -n "$log" ] && [ -f "$log" ] && log_has_startup_failure "$log"; then
      tail -n 100 "$log" >&2
      return 1
    fi
    sleep 0.25
  done
  [ -f "$log" ] && tail -n 100 "$log" >&2
  return 1
}

allocate_ports() {
  local output first
  output="$(printf 'release pg\nrelease redis\nrelease api\nrelease frontend\n' \
    | "$SCRIPT_DIR/reserve_loopback_ports.py")"
  first="${output%%$'\n'*}"
  read -r PG_PORT REDIS_PORT API_PORT FRONTEND_PORT < <(
    python3 -c 'import json,sys; p=json.loads(sys.argv[1]); print(p["pg"],p["redis"],p["api"],p["frontend"])' "$first"
  )
  [ -n "$PG_PORT" ] && [ -n "$REDIS_PORT" ] && [ -n "$API_PORT" ] && [ -n "$FRONTEND_PORT" ] \
    || fail 'port allocator did not return four ports'
  [ "$(printf '%s\n' "$PG_PORT" "$REDIS_PORT" "$API_PORT" "$FRONTEND_PORT" | sort -u | wc -l)" -eq 4 ] \
    || fail 'port allocator returned a duplicate'
}

start_owned_fixtures() {
  local ready=0 final_select='' ready_count=0 pg_env="$PRIVATE_DIR/postgres.env"
  command -v docker >/dev/null 2>&1 || fail 'docker is required for T109 disposable fixtures'
  docker info >/dev/null 2>&1 || fail 'docker daemon is not reachable'
  docker image inspect postgres:16 >/dev/null 2>&1 \
    || fail 'required local image is unavailable: postgres:16'
  docker image inspect redis:7-alpine >/dev/null 2>&1 \
    || fail 'required local image is unavailable: redis:7-alpine'
  [ -z "$(docker ps -aq --filter "label=$RESOURCE_LABEL")" ] \
    || fail 'an exact-label T109 fixture resource already exists'
  allocate_ports

  node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('hex'))" \
    > "$PRIVATE_DIR/postgres-password"
  chmod 600 "$PRIVATE_DIR/postgres-password"
  {
    printf 'POSTGRES_USER=odoo\nPOSTGRES_PASSWORD='
    cat "$PRIVATE_DIR/postgres-password"
    printf '\nPOSTGRES_DB=kemfai_control\n'
  } > "$pg_env"
  chmod 600 "$pg_env"

  PG_ATTEMPTED=1
  PG_CONTAINER_ID="$(docker run -d \
    --name "$PG_CONTAINER" \
    --label "$RESOURCE_LABEL" \
    --memory 768m \
    --cpus 1 \
    --env-file "$pg_env" \
    -p "127.0.0.1:$PG_PORT:5432" \
    postgres:16)" || fail 'owned PostgreSQL fixture failed to start'

  # The image briefly starts a temporary initialization server.  Do not accept that
  # socket as readiness: require both ready log entries, pg_isready on the final server,
  # and a final post-initialization SELECT 1 against the intended database.
  for _ in $(seq 1 480); do
    ready_count="$(docker logs "$PG_CONTAINER_ID" 2>&1 \
      | awk '/database system is ready to accept connections/{n++} END{print n+0}')"
    if [ "$ready_count" -ge 2 ] \
      && docker exec "$PG_CONTAINER_ID" pg_isready -U odoo -d kemfai_control >/dev/null 2>&1; then
      final_select="$(docker exec "$PG_CONTAINER_ID" \
        psql -X -q -t -A -v ON_ERROR_STOP=1 -U odoo -d kemfai_control -c 'SELECT 1' 2>/dev/null)" \
        || final_select=''
      if [ "$final_select" = 1 ]; then ready=1; break; fi
    fi
    sleep 0.25
  done
  if [ "$ready" -ne 1 ]; then
    docker logs "$PG_CONTAINER_ID" 2>&1 | tail -n 120 >&2 || true
    fail 'owned PostgreSQL fixture did not reach final-server SELECT 1 readiness'
  fi

  REDIS_ATTEMPTED=1
  REDIS_CONTAINER_ID="$(docker run -d \
    --name "$REDIS_CONTAINER" \
    --label "$RESOURCE_LABEL" \
    --memory 256m \
    --cpus .5 \
    -p "127.0.0.1:$REDIS_PORT:6379" \
    redis:7-alpine redis-server --save '' --appendonly no)" \
    || fail 'owned Redis fixture failed to start'
  ready=0
  for _ in $(seq 1 120); do
    if [ "$(docker exec "$REDIS_CONTAINER_ID" redis-cli ping 2>/dev/null)" = PONG ]; then
      ready=1
      break
    fi
    sleep 0.25
  done
  [ "$ready" -eq 1 ] || fail 'owned Redis fixture did not become ready'

  export CONTROL_DB_HOST=127.0.0.1
  export CONTROL_DB_PORT="$PG_PORT"
  export CONTROL_DB_USER=odoo
  # The password generator intentionally does not append a newline. A bare `read`
  # assigns that value but returns 1 at EOF, which aborts this set -e runner after
  # the fixtures become ready. Bash's file command substitution is success-valued.
  CONTROL_DB_PASSWORD="$(<"$PRIVATE_DIR/postgres-password")"
  export CONTROL_DB_PASSWORD
  export CONTROL_DB_NAME=kemfai_control
  export T109_CONTROL_DB_OWNED=1
  export REDIS_URL="redis://127.0.0.1:$REDIS_PORT/14"
  export NODE_ENV=test

  printf 'operation_id=%s\nresource_label=%s\npostgres_container=%s\nredis_container=%s\npostgres_port=%s\nredis_port=%s\napi_port=%s\nfrontend_port=%s\npostgres_final_ready_messages=%s\npostgres_final_select=%s\n' \
    "$OPERATION_ID" "$RESOURCE_LABEL" "$PG_CONTAINER_ID" "$REDIS_CONTAINER_ID" \
    "$PG_PORT" "$REDIS_PORT" "$API_PORT" "$FRONTEND_PORT" "$ready_count" "$final_select" \
    > "$EVIDENCE_DIR/fixture-registry.txt"
  chmod 600 "$EVIDENCE_DIR/fixture-registry.txt"
}

run_backend() {
  (
    cd "$REPO_ROOT/backend/api"
    ./node_modules/.bin/jest \
      --config test/jest-integration-nonlive.json \
      --runInBand \
      test/integration/no-odoo-exposure.integration-spec.ts \
      --json \
      --outputFile "$EVIDENCE_DIR/backend-jest.json"
  ) 2>&1 | tee "$EVIDENCE_DIR/backend-jest.log"
  "$SCRIPT_DIR/fixtures/t109_validate_evidence.py" backend "$EVIDENCE_DIR/backend-jest.json"
}

seed_frontend_session() {
  local session_id="$1" token_name="$2"
  local session_file="$PRIVATE_DIR/session-$token_name.json"
  node - "$PRIVATE_DIR/session-fixture.json" "$token_name" "$session_file" <<'NODE'
const fs = require('node:fs');
const [input, tokenName, output] = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync(input, 'utf8'));
const accessToken = fixture?.tokens?.[tokenName];
if (typeof accessToken !== 'string' || !accessToken) throw new Error(`missing ${tokenName} token`);
const expires = Date.now() + 2 * 60 * 60 * 1000;
fs.writeFileSync(output, JSON.stringify({
  accessToken,
  refreshToken: `t109-synthetic-${tokenName}`,
  accessExpiresAt: expires,
  refreshExpiresAt: expires,
}), { mode: 0o600 });
NODE
  docker exec -i "$REDIS_CONTAINER_ID" redis-cli -n 15 -x SET \
    "kemfai:session:$session_id" < "$session_file" >/dev/null \
    || fail "could not seed owned Redis $token_name session"
  docker exec "$REDIS_CONTAINER_ID" redis-cli -n 15 PEXPIRE \
    "kemfai:session:$session_id" 7200000 >/dev/null \
    || fail "could not expire owned Redis $token_name session"
}

run_frontend() {
  local redis_url api_url base_url runtime_frontend browser_cache
  redis_url="redis://127.0.0.1:$REDIS_PORT/15"
  api_url="http://127.0.0.1:$API_PORT"
  base_url="http://localhost:$FRONTEND_PORT"

  docker exec "$REDIS_CONTAINER_ID" redis-cli -n 14 FLUSHDB >/dev/null \
    || fail 'could not reset owned API queue database'
  docker exec "$REDIS_CONTAINER_ID" redis-cli -n 15 FLUSHDB >/dev/null \
    || fail 'could not reset owned frontend session database'

  runtime_frontend="$PRIVATE_DIR/frontend"
  mkdir -p "$runtime_frontend"
  rsync -a \
    --exclude node_modules \
    --exclude .next \
    --exclude coverage \
    "$REPO_ROOT/frontend/" "$runtime_frontend/"
  ln -s "$REPO_ROOT/frontend/node_modules" "$runtime_frontend/node_modules"
  browser_cache="$(cd "$REPO_ROOT/frontend" \
    && node "$SCRIPT_DIR/fixtures/t071_resolve_playwright_browser.mjs")"

  (
    cd "$runtime_frontend"
    env \
      NEXT_TELEMETRY_DISABLED=1 \
      NEXT_PUBLIC_API_URL="$api_url" \
      NEXT_PUBLIC_PAYMENT_PROOF_ORIGINS='https://storage.example.test' \
      T109_FIXTURE_LABEL="$RESOURCE_LABEL" \
      ./node_modules/.bin/next build
  ) > "$EVIDENCE_DIR/next-build.log" 2>&1 || {
    tail -n 140 "$EVIDENCE_DIR/next-build.log" >&2
    fail 'isolated Next production build failed'
  }

  (
    cd "$REPO_ROOT/backend/api"
    exec python3 "$SCRIPT_DIR/fixtures/t071_owned_session_exec.py" --hold-for-cleanup \
      --keep-env CONTROL_DB_HOST,CONTROL_DB_PORT,CONTROL_DB_USER,CONTROL_DB_PASSWORD,CONTROL_DB_NAME,REDIS_URL \
      env \
      NODE_ENV=test \
      T109_FIXTURE_LABEL="$RESOURCE_LABEL" \
      T109_CONTROL_DB_OWNED=1 \
      T109_API_PORT="$API_PORT" \
      T109_FRONTEND_ORIGIN="$base_url" \
      ./node_modules/.bin/ts-node --transpile-only test/support/t109-http-server.ts
  ) > "$EVIDENCE_DIR/nest-fixture.log" 2>&1 &
  API_PID=$!
  register_owned_process "$API_PID" 't109-http-server.ts'
  wait_http "$api_url/__t109/health" "$EVIDENCE_DIR/nest-fixture.log" \
    || fail 'Nest fixture did not become ready'

  curl --silent --show-error --fail --max-time 5 \
    "$api_url/__t109/session-fixture" > "$PRIVATE_DIR/session-fixture.json" \
    || fail 'could not fetch signed fixture sessions'
  chmod 600 "$PRIVATE_DIR/session-fixture.json"
  seed_frontend_session t109-customer-session customer
  seed_frontend_session t109-admin-session admin
  seed_frontend_session t109-denied-session denied

  (
    cd "$runtime_frontend"
    exec python3 "$SCRIPT_DIR/fixtures/t071_owned_session_exec.py" --hold-for-cleanup env \
      NODE_ENV=production \
      NEXT_TELEMETRY_DISABLED=1 \
      NEXT_PUBLIC_API_URL="$api_url" \
      NEXT_PUBLIC_PAYMENT_PROOF_ORIGINS='https://storage.example.test' \
      T109_FIXTURE_LABEL="$RESOURCE_LABEL" \
      KEMFAI_API_URL="$api_url" \
      REDIS_URL="$redis_url" \
      KEYCLOAK_ISSUER='http://127.0.0.1:1/realms/t109-customer' \
      KEYCLOAK_BACKCHANNEL_URL='http://127.0.0.1:1/realms/t109-customer' \
      KEYCLOAK_JWKS_URI='http://127.0.0.1:1/realms/t109-customer/certs' \
      KEYCLOAK_CLIENT_ID='t109-customer-ui' \
      KEYCLOAK_REDIRECT_URI="$base_url/auth/callback" \
      INTERNAL_KEYCLOAK_ISSUER='http://127.0.0.1:1/realms/t109-internal' \
      INTERNAL_KEYCLOAK_BACKCHANNEL_URL='http://127.0.0.1:1/realms/t109-internal' \
      INTERNAL_KEYCLOAK_JWKS_URI='http://127.0.0.1:1/realms/t109-internal/certs' \
      INTERNAL_KEYCLOAK_CLIENT_ID='t109-internal-ui' \
      INTERNAL_KEYCLOAK_REDIRECT_URI="$base_url/internal-auth/callback" \
      SUPPORT_EMAIL='support@example.test' \
      ./node_modules/.bin/next start --hostname localhost --port "$FRONTEND_PORT"
  ) > "$EVIDENCE_DIR/next-server.log" 2>&1 &
  NEXT_PID=$!
  register_owned_process "$NEXT_PID" 'next start'
  wait_http "$base_url/plans" "$EVIDENCE_DIR/next-server.log" \
    || fail 'Next production server did not become ready'

  (
    cd "$REPO_ROOT/frontend"
    env \
      PLAYWRIGHT_BROWSERS_PATH="$browser_cache" \
      T109_FIXTURE_LABEL="$RESOURCE_LABEL" \
      T109_API_URL="$api_url" \
      T109_BASE_URL="$base_url" \
      T109_EVIDENCE_DIR="$EVIDENCE_DIR" \
      ./node_modules/.bin/playwright test --config playwright.t109.config.ts
  ) 2>&1 | tee "$EVIDENCE_DIR/playwright.log"
  "$SCRIPT_DIR/fixtures/t109_validate_evidence.py" browser "$EVIDENCE_DIR/browser-summary.json"
}

start_owned_fixtures
if [ "$MODE" = backend ] || [ "$MODE" = all ]; then run_backend; fi
if [ "$MODE" = frontend ] || [ "$MODE" = all ]; then run_frontend; fi

echo "T109 evidence: $EVIDENCE_DIR"
