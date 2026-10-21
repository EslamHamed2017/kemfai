#!/usr/bin/env bash
# T050 live gate: disposable, label-owned PostgreSQL/Redis/Odoo fixtures for the
# country-dependent company VAT/tax validation integration suite. No existing KEMFAI
# service or database is inspected, restarted, or reused.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
api_dir="$repo_dir/backend/api"
addons_dir="$repo_dir/backend/addons"
# shellcheck source=scripts/lib_docker_test_cleanup.sh
. "$repo_dir/scripts/lib_docker_test_cleanup.sh"

command -v docker >/dev/null 2>&1 || { echo "FAIL: docker CLI is unavailable" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "FAIL: docker daemon is unreachable" >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "FAIL: openssl is unavailable" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "FAIL: curl is unavailable" >&2; exit 1; }

run_id="t050r$(openssl rand -hex 5)"
label_key="kemfai.t050.run"
label="${label_key}=${run_id}"
network="${run_id}_net"
pg_container="${run_id}_pg"
redis_container="${run_id}_redis"
bootstrap_container="${run_id}_init"
admin_container="${run_id}_admin"
odoo_container="${run_id}_odoo"
tenant_db="${run_id}_tenant"
control_db="${run_id}_control"

artifacts_dir="${KEMFAI_ARTIFACTS_DIR:-$(dirname "$repo_dir")/t050-live-evidence-${run_id}}"
mkdir -p "$artifacts_dir"
evidence_file="$artifacts_dir/evidence.txt"
private_dir="$(mktemp -d)"
chmod 700 "$private_dir"
umask 077
fixture_addons="$private_dir/addons"
cp -a "$addons_dir" "$fixture_addons"
chmod -R u=rwX,go=rX "$fixture_addons"

pg_password="$(openssl rand -hex 24)"
odoo_master_password="$(openssl rand -hex 24)"
odoo_admin_login="t050-${run_id}@example.invalid"
odoo_admin_password="$(openssl rand -hex 24)"

kemfai_docker_cleanup_init "$label_key" "$run_id"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

cleanup() {
  local exit_status=$?
  trap - EXIT
  set +e
  echo "== Cleanup: label-verified T050 resources ==" | tee -a "$evidence_file"
  if ! kemfai_cleanup_owned_containers; then
    [ "$exit_status" -ne 0 ] || exit_status=1
  fi
  if ! kemfai_cleanup_owned_networks; then
    [ "$exit_status" -ne 0 ] || exit_status=1
  fi
  echo "Cleanup verification completed for ${label}." | tee -a "$evidence_file"
  if [ "$fixture_addons" = "$private_dir/addons" ] && [ -d "$fixture_addons" ]; then
    find "$fixture_addons" -depth -delete
  fi
  find "$private_dir" -mindepth 1 -maxdepth 1 -type f -delete
  rmdir "$private_dir" 2>/dev/null || true
  exit "$exit_status"
}
trap cleanup EXIT
kemfai_install_cleanup_signal_traps

{
  echo "T050 live integration evidence (nonsecret)"
  echo "started_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "run_id=${run_id}"
  echo "network=${network}"
  echo "postgres=${pg_container}"
  echo "redis=${redis_container}"
  echo "odoo=${odoo_container}"
  echo "tenant_db=${tenant_db}"
  echo "control_db=${control_db}"
} | tee "$evidence_file"

kemfai_register_network_intent "$network"
docker network create --label "$label" "$network" >/dev/null

pg_env_file="$private_dir/postgres.env"
printf 'POSTGRES_USER=odoo\nPOSTGRES_PASSWORD=%s\n' "$pg_password" > "$pg_env_file"
chmod 600 "$pg_env_file"
kemfai_register_container_intent "$pg_container"
docker run -d --name "$pg_container" --label "$label" --network "$network" \
  --env-file "$pg_env_file" -p 127.0.0.1::5432 postgres:16 >/dev/null

kemfai_register_container_intent "$redis_container"
docker run -d --name "$redis_container" --label "$label" --network "$network" \
  -p 127.0.0.1::6379 redis:7-alpine >/dev/null

ready=0
for _ in $(seq 1 60); do
  if docker exec "$pg_container" pg_isready -h 127.0.0.1 -U odoo >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done
[ "$ready" -eq 1 ] || fail "private PostgreSQL did not become ready"
pg_port="$(docker port "$pg_container" 5432/tcp | head -1 | cut -d: -f2)"
redis_port="$(docker port "$redis_container" 6379/tcp | head -1 | cut -d: -f2)"
docker exec "$pg_container" psql -U odoo -d postgres \
  -c "CREATE DATABASE ${control_db} OWNER odoo" >/dev/null

odoo_env_file="$private_dir/odoo.env"
printf 'HOST=%s\nUSER=odoo\nPASSWORD=%s\nADMIN_LOGIN=%s\nADMIN_PASSWORD=%s\n' \
  "$pg_container" "$pg_password" "$odoo_admin_login" "$odoo_admin_password" > "$odoo_env_file"
chmod 600 "$odoo_env_file"

kemfai_register_container_intent "$bootstrap_container"
timeout --kill-after=30 900 docker run --name "$bootstrap_container" --label "$label" \
  --network "$network" --env-file "$odoo_env_file" \
  -v "${fixture_addons}:/mnt/extra-addons:ro" odoo:18 odoo \
  -d "$tenant_db" \
  --addons-path=/mnt/extra-addons,/usr/lib/python3/dist-packages/odoo/addons \
  -i kemfai_tenant_core,kemfai_company_setup --stop-after-init --without-demo=all \
  > "$artifacts_dir/odoo-bootstrap.log" 2>&1 || {
    sed -n '1,240p' "$artifacts_dir/odoo-bootstrap.log"
    fail "scratch tenant database bootstrap failed"
  }
echo "PASS: scratch tenant database and production addons initialized." | tee -a "$evidence_file"

admin_script="$private_dir/set-admin.py"
printf '%s\n' \
  'import os' \
  "user = env['res.users'].browse(2)" \
  "user.write({'login': os.environ['ADMIN_LOGIN'], 'password': os.environ['ADMIN_PASSWORD']})" \
  'env.cr.commit()' > "$admin_script"
chmod 600 "$admin_script"
kemfai_register_container_intent "$admin_container"
timeout --kill-after=15 180 docker run -i --name "$admin_container" --label "$label" \
  --network "$network" --env-file "$odoo_env_file" \
  -v "${fixture_addons}:/mnt/extra-addons:ro" odoo:18 odoo shell \
  -d "$tenant_db" \
  --addons-path=/mnt/extra-addons,/usr/lib/python3/dist-packages/odoo/addons --no-http \
  < "$admin_script" > "$artifacts_dir/odoo-admin-bootstrap.log" 2>&1 || {
    sed -n '1,240p' "$artifacts_dir/odoo-admin-bootstrap.log"
    fail "scratch Odoo admin setup failed"
  }

odoo_conf="$private_dir/odoo.conf"
printf '%s\n' \
  '[options]' \
  'addons_path = /mnt/extra-addons,/usr/lib/python3/dist-packages/odoo/addons' \
  'data_dir = /var/lib/odoo' \
  "dbfilter = ^${run_id}_.*\$" \
  'list_db = False' > "$odoo_conf"
chmod 644 "$odoo_conf"
kemfai_register_container_intent "$odoo_container"
docker run -d --name "$odoo_container" --label "$label" --network "$network" \
  --env-file "$odoo_env_file" -v "${fixture_addons}:/mnt/extra-addons:ro" \
  -v "${odoo_conf}:/etc/odoo/odoo.conf:ro" -p 127.0.0.1::8069 odoo:18 >/dev/null
odoo_port="$(docker port "$odoo_container" 8069/tcp | head -1 | cut -d: -f2)"
ready=0
for _ in $(seq 1 90); do
  if curl --fail --silent "http://127.0.0.1:${odoo_port}/web/login?db=${tenant_db}" \
    >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  docker logs "$odoo_container" > "$artifacts_dir/odoo-server.log" 2>&1 || true
  sed -n '1,260p' "$artifacts_dir/odoo-server.log"
  fail "private Odoo did not become ready"
fi
echo "PASS: private Odoo is ready with list_db disabled and an anchored dbfilter." | tee -a "$evidence_file"

api_env_file="$private_dir/api.env"
printf '%s\n' \
  'CONTROL_DB_HOST=127.0.0.1' \
  "CONTROL_DB_PORT=${pg_port}" \
  'CONTROL_DB_USER=odoo' \
  "CONTROL_DB_PASSWORD=${pg_password}" \
  "CONTROL_DB_NAME=${control_db}" \
  "REDIS_URL=redis://127.0.0.1:${redis_port}/13" \
  "KEMFAI_ODOO_URL=http://127.0.0.1:${odoo_port}" \
  "KEMFAI_ODOO_MASTER_PASSWORD=${odoo_master_password}" \
  "KEMFAI_TENANT_ADMIN_LOGIN=${odoo_admin_login}" \
  "KEMFAI_TENANT_ADMIN_PASSWORD=${odoo_admin_password}" \
  'KEMFAI_LIVE_T050=1' \
  'KEMFAI_T050_DB_PREINITIALIZED=1' \
  "KEMFAI_T050_TENANT_DB=${tenant_db}" > "$api_env_file"
chmod 600 "$api_env_file"

set -a
# shellcheck disable=SC1090
. "$api_env_file"
set +a
cd "$api_dir"

npm run migration:run > "$artifacts_dir/migrations.log" 2>&1 || {
  sed -n '1,240p' "$artifacts_dir/migrations.log"
  fail "control database migrations failed"
}
echo "PASS: control-plane migrations applied to the private database." | tee -a "$evidence_file"

target='test/integration/company-setup-validation.integration-spec.ts'
red_log="$artifacts_dir/red-proof.log"
set +e
KEMFAI_T050_RED_MUTATION=seed-missing-rule \
  npm run test:integration -- --runInBand "$target" > "$red_log" 2>&1
red_status=$?
set -e
if [ "$red_status" -eq 0 ]; then
  sed -n '1,260p' "$red_log"
  fail "bounded red proof unexpectedly passed"
fi
if ! grep -F 'fails closed with schema-conformant 409 when the selected country has no rule' \
  "$red_log" >/dev/null; then
  sed -n '1,260p' "$red_log"
  fail "bounded red proof failed for an unrelated reason"
fi
echo "PASS: bounded fixture mutation filled the omitted rule and made the 409 assertion fail (expected red)." \
  | tee -a "$evidence_file"

green_log="$artifacts_dir/green.log"
npm run test:integration -- --runInBand "$target" > "$green_log" 2>&1 || {
  sed -n '1,320p' "$green_log"
  fail "T050 targeted green integration run failed"
}
sed -n '1,320p' "$green_log"
echo "PASS: T050 targeted live integration suite is green." | tee -a "$evidence_file"
echo "completed_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "$evidence_file"
