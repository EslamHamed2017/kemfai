#!/usr/bin/env bash
# T054/T055 live gate: real Odoo 18 + real PostgreSQL proof for the
# GET/PUT /companies/current/setup wizard (step save/resume, country validation,
# concurrency), plus a real-HTTP harness against the NestJS BFF. T055 (2026-10-05)
# extends this SAME run/fixture set with POST /companies/current/setup/complete and
# GET/PUT /companies/current/settings — the live-HTTP spec file this script runs
# (company-setup-live.integration-spec.ts) now covers both; no second isolated runner
# was created, per the reuse-the-existing-runner guidance for this addition.
#
# Hard requirements (arbiter binding resolution, point 5/6):
#   * FAILS (non-zero exit), never silently skips, when Docker is unavailable.
#   * Every resource — network, PostgreSQL, Redis, both Odoo containers, every
#     scratch database — is newly created by THIS run, labelled with this run's
#     id, and never an existing/shared container or database (no "kemfai-db",
#     no "kemfai-odoo", no "docker_default" network). Nothing pre-existing is
#     ever read, written, started, stopped, or dropped.
#   * Cleanup verifies the `kemfai.t054.run=<run_id>` label on a resource before
#     removing it — it never removes anything it did not itself label.
#   * Generated Postgres/Odoo credentials live only in a private (chmod 700),
#     per-run directory as env files passed to `docker run --env-file` — never
#     as `-e` argv, never echoed to a log.
#   * The isolated Odoo HTTP container pins `dbfilter` to this run's own
#     database prefix (anchored regex) and sets `list_db = False`, so even a
#     stray request against it cannot see or list any other database.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
addons_dir="$repo_dir/backend/addons"
api_dir="$repo_dir/backend/api"
# shellcheck source=scripts/lib_docker_test_cleanup.sh
. "$repo_dir/scripts/lib_docker_test_cleanup.sh"

command -v docker >/dev/null 2>&1 || { echo "FAIL: docker CLI is not available" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "FAIL: docker daemon is not reachable" >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "FAIL: openssl is required to generate scratch credentials" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "FAIL: curl is required to poll the isolated Odoo container" >&2; exit 1; }

run_id="t054r$(openssl rand -hex 5)"
label="kemfai.t054.run=${run_id}"
network="${run_id}_net"
pg_container="${run_id}_pg"
redis_container="${run_id}_redis"
orm_container="${run_id}_orm"
http_container="${run_id}_http"
http_bootstrap_init_container="${run_id}_httpinit"
http_bootstrap_admin_container="${run_id}_httpadmin"
orm_db="${run_id}_ormdb"
http_db="${run_id}_httpdb"
control_db="${run_id}_ctrl"

pg_password="$(openssl rand -hex 20)"
odoo_master_password="$(openssl rand -hex 20)"
odoo_admin_login="t054admin${RANDOM}@example.com"
odoo_admin_password="$(openssl rand -hex 20)"

# Nonsecret gate evidence is preserved in a job-artifacts directory (never deleted
# by cleanup): KEMFAI_ARTIFACTS_DIR overrides, else a sibling directory of the repo
# so the main checkout stays clean.
artifacts_dir="${KEMFAI_ARTIFACTS_DIR:-$(dirname "$repo_dir")/t054-live-evidence-${run_id}}"
mkdir -p "$artifacts_dir"
evidence_file="$artifacts_dir/evidence.txt"

# Private per-run secrets dir: env files for `docker run --env-file`, never -e/argv,
# never printed. Mode 700 on the dir, 600 on every file written into it.
private_dir="$(mktemp -d)"
chmod 700 "$private_dir"
umask 077

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# Resources this run actually created, in creation order — the only things
# `cleanup()` is allowed to remove, and only after re-verifying the ownership
# label on each one at removal time.
kemfai_docker_cleanup_init "kemfai.t054.run" "$run_id"

cleanup() {
  local cleanup_status=$?
  local cleanup_failed=0
  trap - EXIT
  set +e
  echo "== Cleanup: removing only resources labelled ${label} =="
  kemfai_cleanup_owned_containers || cleanup_failed=1
  kemfai_cleanup_owned_networks || cleanup_failed=1
  # Evidence/logs in $artifacts_dir are deliberately KEPT (nonsecret job artifacts).
  rm -rf "$private_dir" || cleanup_failed=1
  [ "$cleanup_failed" -eq 0 ] || [ "$cleanup_status" -ne 0 ] || cleanup_status=1
  exit "$cleanup_status"
}
trap cleanup EXIT
kemfai_install_cleanup_signal_traps

{
  echo "T054 live gate evidence (no secrets) — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "run id:                  ${run_id}"
  echo "artifacts dir:           ${artifacts_dir}"
  echo "private network:         ${network}"
  echo "private postgres:        ${pg_container}"
  echo "private redis:           ${redis_container}"
  echo "orm-test odoo container: ${orm_container} -> scratch db ${orm_db}"
  echo "http-test odoo container:${http_container} -> scratch db ${http_db}"
  echo "control db:              ${control_db}"
} | tee "$evidence_file"

echo
echo "== Creating a newly-owned private network and PostgreSQL/Redis containers =="
kemfai_register_network_intent "$network"
docker network create --label "$label" "$network" >/dev/null

pg_env_file="$private_dir/pg.env"
printf 'POSTGRES_USER=odoo\nPOSTGRES_PASSWORD=%s\n' "$pg_password" > "$pg_env_file"
chmod 600 "$pg_env_file"
kemfai_register_container_intent "$pg_container"
docker run -d --label "$label" --name "$pg_container" --network "$network" \
  --env-file "$pg_env_file" -p 127.0.0.1::5432 postgres:16 >/dev/null

kemfai_register_container_intent "$redis_container"
docker run -d --label "$label" --name "$redis_container" --network "$network" \
  -p 127.0.0.1::6379 redis:7-alpine >/dev/null

pg_host_port=""
redis_host_port=""
ready=0
for _ in $(seq 1 60); do
  if docker exec "$pg_container" pg_isready -h 127.0.0.1 -U odoo >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done
[ "$ready" -eq 1 ] || fail "private PostgreSQL container '${pg_container}' never became ready"
pg_host_port="$(docker port "$pg_container" 5432/tcp | head -1 | cut -d: -f2)"
redis_host_port="$(docker port "$redis_container" 6379/tcp | head -1 | cut -d: -f2)"
echo "PASS: private, newly-created PostgreSQL (${pg_container}) and Redis (${redis_container}) are ready." | tee -a "$evidence_file"

docker exec "$pg_container" psql -U odoo -d postgres -c "CREATE DATABASE ${control_db} OWNER odoo;" >/dev/null \
  || fail "failed to create scratch control DB ${control_db}"

echo
echo "== Phase 1: real Odoo addon tests (test_company_setup.py) on scratch tenant DB ${orm_db} =="
odoo_env_file="$private_dir/odoo.env"
printf 'HOST=%s\nUSER=odoo\nPASSWORD=%s\n' "$pg_container" "$pg_password" > "$odoo_env_file"
chmod 600 "$odoo_env_file"
log_file="$artifacts_dir/addon-tests.log"
# Named and label-registered BEFORE the attached run starts, so cleanup() can
# verify-and-remove this container even if the bounded run below times out —
# an unnamed --rm container can never be targeted for label-verified cleanup.
kemfai_register_container_intent "$orm_container"
set +e
timeout --kill-after=30 1800 \
  docker run --rm --name "$orm_container" --label "$label" --network "$network" \
  --env-file "$odoo_env_file" \
  -v "${addons_dir}:/mnt/extra-addons:ro" \
  odoo:18 odoo \
  -d "$orm_db" \
  --addons-path=/mnt/extra-addons,/usr/lib/python3/dist-packages/odoo/addons \
  -i kemfai_tenant_core,kemfai_company_setup \
  --test-enable --test-tags /kemfai_company_setup \
  --stop-after-init \
  --without-demo=all \
  > "$log_file" 2>&1
status=$?
set -e
cat "$log_file"
[ $status -ne 124 ] && [ $status -ne 137 ] || fail "Odoo addon-test run on ${orm_db} did not finish within the bounded 1800s timeout (status $status)"
[ $status -eq 0 ] || fail "Odoo addon-test run on ${orm_db} exited non-zero ($status) — Odoo 18 exits rc=1 per failing test, rc=-1 on init failure"
if grep -qE 'Module [A-Za-z0-9_]+: [1-9][0-9]* failures' "$log_file"; then
  fail "Odoo unittest run on ${orm_db} reported module test failures (see log above)"
fi
if grep -qE '(FAIL|ERROR): odoo\.addons\.kemfai_company_setup' "$log_file"; then
  fail "Odoo unittest run on ${orm_db} has failing kemfai_company_setup tests (see log above)"
fi
if grep -iE 'traceback|CRITICAL' "$log_file" >/dev/null; then
  fail "Odoo addon-test log for ${orm_db} contains a traceback/critical error"
fi
post_tests_count="$(grep -oE '[0-9]+ post-tests in' "$log_file" | grep -oE '^[0-9]+' | head -1 || true)"
if [ "${post_tests_count:-0}" -lt 1 ]; then
  fail "no post-install tests ran on ${orm_db} (tag filter matched nothing) — gate requires the real suite"
fi
echo "PASS: real Odoo addon tests ran clean (${post_tests_count} post-install tests, 0 failures) on scratch DB ${orm_db}." | tee -a "$evidence_file"

echo
echo "== Phase 2a: offline bootstrap of scratch DB ${http_db} (list_db=False forbids exp_create_database, so this DB must exist before the HTTP server starts) =="
# check_db_management_enabled (Odoo 18 ir/http.py) raises AccessDenied on
# exp_create_database/db.create_database whenever list_db is False — by design, and this
# gate must not weaken that by turning list_db on. Instead, a separate, newly-owned, named,
# labelled, bounded, offline CLI container creates+installs ${http_db} with --stop-after-init
# while no list_db=False HTTP server is listening yet, using the same scratch Postgres as the
# eventual HTTP container. Named and label-registered BEFORE it starts, exactly like orm_container,
# so cleanup() can verify-and-remove it even if the bounded run below times out.
kemfai_register_container_intent "$http_bootstrap_init_container"
set +e
bootstrap_init_log="$artifacts_dir/http-db-bootstrap-init.log"
timeout --kill-after=30 900 \
  docker run --rm --name "$http_bootstrap_init_container" --label "$label" --network "$network" \
  --env-file "$odoo_env_file" \
  -v "${addons_dir}:/mnt/extra-addons:ro" \
  odoo:18 odoo \
  -d "$http_db" \
  --addons-path=/mnt/extra-addons,/usr/lib/python3/dist-packages/odoo/addons \
  -i kemfai_tenant_core,kemfai_company_setup \
  --stop-after-init \
  --without-demo=all \
  > "$bootstrap_init_log" 2>&1
bootstrap_init_status=$?
set -e
cat "$bootstrap_init_log"
[ $bootstrap_init_status -ne 124 ] && [ $bootstrap_init_status -ne 137 ] \
  || fail "offline bootstrap init of ${http_db} did not finish within the bounded 900s timeout (status $bootstrap_init_status)"
[ $bootstrap_init_status -eq 0 ] || fail "offline bootstrap init of ${http_db} exited non-zero ($bootstrap_init_status)"

echo
echo "== Phase 2b: setting scratch admin login/password on ${http_db} via an offline Odoo shell (no secrets in argv/logs) =="
# The admin login/password are read inside the container from the private env-file (never
# interpolated into argv or this script's own text), via a genuine ORM write + commit through
# `odoo shell`. This is the real admin user this fixture authenticates as over RPC afterwards.
printf 'ADMIN_LOGIN=%s\nADMIN_PASSWORD=%s\n' "$odoo_admin_login" "$odoo_admin_password" >> "$odoo_env_file"
shell_script_file="$private_dir/bootstrap_admin.py"
cat > "$shell_script_file" <<'PYEOF'
import os
user = env['res.users'].browse(2)
user.write({'login': os.environ['ADMIN_LOGIN'], 'password': os.environ['ADMIN_PASSWORD']})
env.cr.commit()
PYEOF
chmod 600 "$shell_script_file"
kemfai_register_container_intent "$http_bootstrap_admin_container"
set +e
bootstrap_admin_log="$artifacts_dir/http-db-bootstrap-admin.log"
timeout --kill-after=15 180 \
  docker run --rm -i --name "$http_bootstrap_admin_container" --label "$label" --network "$network" \
  --env-file "$odoo_env_file" \
  -v "${addons_dir}:/mnt/extra-addons:ro" \
  odoo:18 odoo shell \
  -d "$http_db" \
  --addons-path=/mnt/extra-addons,/usr/lib/python3/dist-packages/odoo/addons \
  --no-http \
  < "$shell_script_file" \
  > "$bootstrap_admin_log" 2>&1
bootstrap_admin_status=$?
set -e
cat "$bootstrap_admin_log"
[ $bootstrap_admin_status -ne 124 ] && [ $bootstrap_admin_status -ne 137 ] \
  || fail "offline admin bootstrap of ${http_db} did not finish within the bounded 180s timeout (status $bootstrap_admin_status)"
[ $bootstrap_admin_status -eq 0 ] || fail "offline admin bootstrap of ${http_db} exited non-zero ($bootstrap_admin_status)"
echo "PASS: scratch DB ${http_db} created, modules installed, and admin credentials configured offline before the list_db=False HTTP server starts." | tee -a "$evidence_file"

echo
echo "== Phase 2c: starting an ISOLATED Odoo container for the live HTTP harness =="
# dbfilter is anchored to THIS run's own database prefix, and list_db is off, so
# even a stray request against this private container cannot see or list any
# database outside this run's own scratch set.
conf_file="$private_dir/odoo.conf"
cat > "$conf_file" <<EOF
[options]
addons_path = /mnt/extra-addons,/usr/lib/python3/dist-packages/odoo/addons
data_dir = /var/lib/odoo
admin_passwd = ${odoo_master_password}
dbfilter = ^${run_id}_.*\$
list_db = False
EOF
chmod 644 "$conf_file"
kemfai_register_container_intent "$http_container"
docker run -d --label "$label" --name "$http_container" --network "$network" \
  --env-file "$odoo_env_file" \
  -v "${addons_dir}:/mnt/extra-addons:ro" \
  -v "${conf_file}:/etc/odoo/odoo.conf:ro" \
  -p 127.0.0.1::8069 odoo:18 >/dev/null

odoo_host_port="$(docker port "$http_container" 8069/tcp | head -1 | cut -d: -f2)"
ready=0
for _ in $(seq 1 90); do
  if curl --fail --silent "http://127.0.0.1:${odoo_host_port}/web/login" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" -eq 1 ] || fail "isolated Odoo container '${http_container}' did not become ready on port ${odoo_host_port}"
echo "PASS: isolated Odoo container ${http_container} is ready on 127.0.0.1:${odoo_host_port}, dbfilter anchored to ${run_id}_, list_db off." | tee -a "$evidence_file"

echo
echo "== Phase 3: scratch control DB migrations for the live HTTP harness =="
cd "$api_dir"
export CONTROL_DB_HOST=127.0.0.1
export CONTROL_DB_PORT="$pg_host_port"
export CONTROL_DB_USER=odoo
export CONTROL_DB_PASSWORD="$pg_password"
export CONTROL_DB_NAME="$control_db"
export REDIS_URL="redis://127.0.0.1:${redis_host_port}"
log_file="$artifacts_dir/migrations.log"
npm run migration:run > "$log_file" 2>&1 || { cat "$log_file"; fail "migrations failed against scratch control DB ${control_db}"; }
echo "PASS: migrations applied cleanly to scratch control DB ${control_db}." | tee -a "$evidence_file"

echo
echo "== Phase 4: real HTTP harness (GET/PUT/POST setup+complete+settings, owner/tenant/feature/trial guards) =="
export KEMFAI_LIVE_T054=1
export KEMFAI_ODOO_URL="http://127.0.0.1:${odoo_host_port}"
export KEMFAI_ODOO_MASTER_PASSWORD="$odoo_master_password"
export KEMFAI_TENANT_ADMIN_LOGIN="$odoo_admin_login"
export KEMFAI_TENANT_ADMIN_PASSWORD="$odoo_admin_password"
export KEMFAI_T054_TENANT_DB="$http_db"
export KEMFAI_T054_DB_PREINITIALIZED=1

set +e
log_file="$artifacts_dir/http-harness.log"
./node_modules/.bin/jest --config test/jest-owned-integration.json --runInBand --runTestsByPath test/integration/company-setup-live.integration-spec.ts --testTimeout=180000 > "$log_file" 2>&1
status=$?
set -e
cat "$log_file"
[ $status -eq 0 ] || fail "live HTTP harness (company-setup-live.integration-spec.ts) failed"
echo "PASS: real HTTP harness exercised GET/PUT/POST-complete/settings + owner/tenant/feature/trial guards against scratch DBs ${http_db} / ${control_db}." | tee -a "$evidence_file"

echo
echo "== Phase 5: general API integration suite (order-independence, no leaked T054 state) =="
export KEMFAI_LIVE_T054=0
log_file="$artifacts_dir/api-integration.log"
set +e
npm run test:integration -- --runInBand > "$log_file" 2>&1
status=$?
set -e
cat "$log_file"
[ $status -eq 0 ] || fail "general API integration suite failed after the T054 live harness"
echo "PASS: general API integration suite passed after the T054 live harness (no leaked flag/fixture state)." | tee -a "$evidence_file"

echo
echo "== T054 live gate: ALL PHASES PASSED =="
cat "$evidence_file"
