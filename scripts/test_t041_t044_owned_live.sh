#!/usr/bin/env bash
# Exact-owned live harness for the two provisioning suites excluded from generic Jest.
# Every service is created by this run and removed by exact name+label verification.
set -euo pipefail
umask 077
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
api_dir="$repo_dir/backend/api"
addons_dir="$repo_dir/backend/addons"
. "$repo_dir/scripts/lib_docker_test_cleanup.sh"
for command in docker node npm openssl curl python3; do
  command -v "$command" >/dev/null 2>&1 || { echo "FAIL: $command is unavailable" >&2; exit 1; }
done
docker info >/dev/null 2>&1 || { echo 'FAIL: Docker daemon is unreachable' >&2; exit 1; }
[ ! -e "$api_dir/.env" ] || { echo 'FAIL: checkout-local backend .env is refused' >&2; exit 1; }

run_id="t041t044r$(openssl rand -hex 6)"
label_key='kemfai.t041-t044.run'; label="$label_key=$run_id"
network="${run_id}_net"; pg="${run_id}_pg"; redis="${run_id}_redis"
minio="${run_id}_minio"; keycloak="${run_id}_keycloak"; odoo="${run_id}_odoo"
control_db="kemfai_t041_${run_id//[^a-zA-Z0-9]/_}"
evidence="${KEMFAI_ARTIFACTS_DIR:-$repo_dir/.artifacts/t041-t044-${run_id}}"
private="$(mktemp -d)"; mkdir -p "$evidence"; chmod 700 "$private" "$evidence"
pg_password="$(openssl rand -hex 24)"; minio_access="t041$(openssl rand -hex 8)"
minio_secret="$(openssl rand -hex 24)"; kc_admin="admin_${run_id}"
kc_password="$(openssl rand -hex 24)"; odoo_master="$(openssl rand -hex 24)"
odoo_login="admin-${run_id}@example.invalid"; odoo_password="$(openssl rand -hex 24)"
kemfai_docker_cleanup_init "$label_key" "$run_id"
fail() { echo "FAIL: $*" >&2; exit 1; }
cleanup() {
  local status=$? cleanup_status=0
  trap - EXIT INT TERM; set +e
  kemfai_cleanup_owned_containers || cleanup_status=1
  kemfai_cleanup_owned_networks || cleanup_status=1
  rm -rf -- "$private"
  printf 'label=%s\ncommand_status=%s\ncleanup_status=%s\n' "$label" "$status" "$cleanup_status" >"$evidence/cleanup-receipt.txt"
  [ "$status" -ne 0 ] && exit "$status"
  exit "$cleanup_status"
}
trap cleanup EXIT
trap 'exit 130' INT; trap 'exit 143' TERM
for name in "$pg" "$redis" "$minio" "$keycloak" "$odoo"; do kemfai_register_container_intent "$name"; done
kemfai_register_network_intent "$network"
[ -z "$(docker ps -aq --no-trunc --filter "label=$label")" ] || fail 'run label collision'
docker network create --label "$label" "$network" >/dev/null

printf 'POSTGRES_USER=odoo\nPOSTGRES_PASSWORD=%s\nPOSTGRES_DB=%s\n' "$pg_password" "$control_db" >"$private/pg.env"
printf 'MINIO_ROOT_USER=%s\nMINIO_ROOT_PASSWORD=%s\n' "$minio_access" "$minio_secret" >"$private/minio.env"
printf 'KC_BOOTSTRAP_ADMIN_USERNAME=%s\nKC_BOOTSTRAP_ADMIN_PASSWORD=%s\n' "$kc_admin" "$kc_password" >"$private/keycloak.env"
printf 'HOST=%s\nPORT=5432\nUSER=odoo\nPASSWORD=%s\n' "$pg" "$pg_password" >"$private/odoo.env"
cat >"$private/realm.json" <<JSON
{"realm":"kemfai-customers","enabled":true,"registrationAllowed":false,
 "roles":{"realm":[{"name":"WorkspaceOwner"}]},
 "clients":[{"clientId":"kemfai-api","enabled":true,"publicClient":true,"standardFlowEnabled":false,"directAccessGrantsEnabled":false}]}
JSON
cat >"$private/odoo.conf" <<EOF
[options]
admin_passwd = $odoo_master
addons_path = /mnt/extra-addons,/usr/lib/python3/dist-packages/odoo/addons
data_dir = /var/lib/odoo
list_db = True
dbfilter = ^kemfai_tenant_.*$
db_host = $pg
db_port = 5432
db_user = odoo
db_password = $pg_password
workers = 0
max_cron_threads = 0
EOF
chmod 600 "$private"/*
chmod 644 "$private/odoo.conf" "$private/realm.json"

docker run -d --name "$pg" --label "$label" --network "$network" --env-file "$private/pg.env" \
  --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=1g -p 127.0.0.1:0:5432 postgres:16.10-alpine >/dev/null
docker run -d --name "$redis" --label "$label" --network "$network" \
  --tmpfs /data:rw,noexec,nosuid,size=128m -p 127.0.0.1:0:6379 redis:7.4.7-alpine redis-server --save '' --appendonly no >/dev/null
docker run -d --name "$minio" --label "$label" --network "$network" --env-file "$private/minio.env" \
  --tmpfs /data:rw,noexec,nosuid,size=512m -p 127.0.0.1:0:9000 bitnamilegacy/minio@sha256:6dabb4a2088c9a79908de3bc05f4586c23ad2182c8908e7e3acbf61c1467fb20 server /data >/dev/null
docker run -d --name "$keycloak" --label "$label" --network "$network" --env-file "$private/keycloak.env" \
  --tmpfs /opt/keycloak/data:rw,noexec,nosuid,size=512m -v "$private/realm.json:/opt/keycloak/data/import/realm.json:ro" \
  -p 127.0.0.1:0:8080 quay.io/keycloak/keycloak:26.0 start-dev --import-realm >/dev/null
docker run -d --name "$odoo" --label "$label" --network "$network" --env-file "$private/odoo.env" \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=128m --tmpfs /var/lib/odoo:rw,nosuid,mode=1777,size=1g \
  -v "$addons_dir:/mnt/extra-addons:ro" -v "$private/odoo.conf:/etc/odoo/odoo.conf:ro" \
  -p 127.0.0.1:0:8069 odoo:18.0 >/dev/null
for container in "$pg" "$redis" "$minio" "$keycloak" "$odoo"; do
  [ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || true)" = true ] || {
    docker logs --tail 100 "$container" 2>&1 || true
    fail "container $container exited during startup"
  }
done
pg_port="$(docker port "$pg" 5432/tcp | python3 -c 'import sys; print(sys.stdin.read().strip().rsplit(":",1)[1])')"
redis_port="$(docker port "$redis" 6379/tcp | python3 -c 'import sys; print(sys.stdin.read().strip().rsplit(":",1)[1])')"
minio_port="$(docker port "$minio" 9000/tcp | python3 -c 'import sys; print(sys.stdin.read().strip().rsplit(":",1)[1])')"
kc_port="$(docker port "$keycloak" 8080/tcp | python3 -c 'import sys; print(sys.stdin.read().strip().rsplit(":",1)[1])')"
odoo_port="$(docker port "$odoo" 8069/tcp | python3 -c 'import sys; print(sys.stdin.read().strip().rsplit(":",1)[1])')"
for _ in $(seq 1 180); do docker exec "$pg" pg_isready -U odoo -d "$control_db" >/dev/null 2>&1 && break; sleep .5; done
docker exec "$pg" pg_isready -U odoo -d "$control_db" >/dev/null 2>&1 || fail 'PostgreSQL readiness timed out'
for _ in $(seq 1 120); do [ "$(docker exec "$redis" redis-cli ping 2>/dev/null || true)" = PONG ] && break; sleep .5; done
[ "$(docker exec "$redis" redis-cli ping 2>/dev/null)" = PONG ] || fail 'Redis readiness timed out'
for _ in $(seq 1 180); do curl -fsS "http://127.0.0.1:$minio_port/minio/health/ready" >/dev/null 2>&1 && break; sleep .5; done
curl -fsS "http://127.0.0.1:$minio_port/minio/health/ready" >/dev/null || fail 'MinIO readiness timed out'
for _ in $(seq 1 240); do curl -fsS "http://127.0.0.1:$kc_port/realms/kemfai-customers/.well-known/openid-configuration" >/dev/null 2>&1 && break; sleep .5; done
curl -fsS "http://127.0.0.1:$kc_port/realms/kemfai-customers/.well-known/openid-configuration" >/dev/null || fail 'Keycloak readiness timed out'
odoo_response="$private/odoo-db-list.json"
odoo_db_service_ready() {
  curl -fsS -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","method":"call","params":{"service":"db","method":"list","args":[]},"id":1}' \
    "http://127.0.0.1:$odoo_port/jsonrpc" -o "$odoo_response" 2>/dev/null || return 1
  python3 -c 'import json,sys; data=json.load(open(sys.argv[1])); raise SystemExit(0 if isinstance(data.get("result"), list) and "error" not in data else 1)' \
    "$odoo_response" >/dev/null 2>&1
}
for _ in $(seq 1 240); do odoo_db_service_ready && break; sleep .5; done
if ! odoo_db_service_ready; then
  docker logs --tail 300 "$odoo" >"$evidence/odoo-readiness.log" 2>&1 || true
  fail 'Odoo database JSON-RPC readiness timed out'
fi

export CONTROL_DB_HOST=127.0.0.1 CONTROL_DB_PORT="$pg_port" CONTROL_DB_USER=odoo
export CONTROL_DB_PASSWORD="$pg_password" CONTROL_DB_NAME="$control_db" REDIS_URL="redis://127.0.0.1:$redis_port/13"
export STORAGE_ENDPOINT="http://127.0.0.1:$minio_port" STORAGE_ACCESS_KEY="$minio_access" STORAGE_SECRET_KEY="$minio_secret"
export KEYCLOAK_URL="http://127.0.0.1:$kc_port" KEYCLOAK_CUSTOMERS_REALM=kemfai-customers KEYCLOAK_ADMIN="$kc_admin" KEYCLOAK_ADMIN_PASSWORD="$kc_password"
export KEMFAI_ODOO_URL="http://127.0.0.1:$odoo_port" KEMFAI_ODOO_MASTER_PASSWORD="$odoo_master"
export KEMFAI_TENANT_ADMIN_LOGIN="$odoo_login" KEMFAI_TENANT_ADMIN_PASSWORD="$odoo_password" KEMFAI_LIVE_PROVISION=1
(cd "$api_dir" && npm run migration:run) >"$evidence/migrations.log" 2>&1 || fail 'control migrations failed'
result="$evidence/jest.json"
(cd "$api_dir" && ./node_modules/.bin/jest --config test/jest-owned-integration.json --runInBand --runTestsByPath \
  test/integration/tenant-isolation.integration-spec.ts \
  test/integration/tenant-provisioning-live.integration-spec.ts --json --outputFile="$result") >"$evidence/jest.log" 2>&1 || fail 'T041/T044 owned live suites failed'
python3 - "$result" <<'PYJSON'
import json, pathlib, sys
p=pathlib.Path(sys.argv[1]); d=json.loads(p.read_text())
expected={'numTotalTestSuites':2,'numPassedTestSuites':2,'numFailedTestSuites':0,
          'numTotalTests':2,'numPassedTests':2,'numFailedTests':0,'numPendingTests':0,'numTodoTests':0}
bad={k:(d.get(k),v) for k,v in expected.items() if d.get(k)!=v}
if d.get('success') is not True or bad: raise SystemExit(f'incomplete owned Jest result: {bad}')
PYJSON
printf 'PASS: T041 tenant isolation and T044 live provisioning ran against exact-owned Odoo, MinIO, Keycloak, PostgreSQL, and Redis.\n' | tee "$evidence/result.txt"
