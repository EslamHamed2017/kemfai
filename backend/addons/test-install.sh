#!/usr/bin/env bash
# Smoke test for T005: every kemfai_* addon skeleton must install cleanly
# (zero errors/warnings) on a scratch Odoo 18 Community database.
#
# Requires the dev stack's kemfai-db Postgres container to be running
# (infra/docker/docker-compose.yml) and reachable on the "docker_default"
# network. Spins up a throwaway Odoo container against a scratch database,
# installs every kemfai_* addon found here, and fails if the log contains
# any error/warning/traceback. The scratch database is always dropped.
set -euo pipefail

ADDONS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NETWORK="docker_default"
DB_CONTAINER="kemfai-db"
DB_USER="odoo"
DB_PASSWORD="kemfai_dev_pg"
TEST_DB="kemfai_test_addon_install_$$"
LOG_FILE="$(mktemp)"

MODULES=$(find "$ADDONS_DIR" -maxdepth 1 -mindepth 1 -type d -name 'kemfai_*' -printf '%f,' | sed 's/,$//')

if [ -z "$MODULES" ]; then
  echo "No kemfai_* addons found under $ADDONS_DIR" >&2
  exit 1
fi

cleanup() {
  docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d postgres -c "DROP DATABASE IF EXISTS ${TEST_DB};" >/dev/null 2>&1 || true
  rm -f "$LOG_FILE"
}
trap cleanup EXIT

echo "Installing modules on scratch DB ${TEST_DB}: ${MODULES}"

docker run --rm --network "$NETWORK" \
  -e HOST="$DB_CONTAINER" -e USER="$DB_USER" -e PASSWORD="$DB_PASSWORD" \
  -v "${ADDONS_DIR}:/mnt/extra-addons:ro" \
  odoo:18 odoo \
  -d "$TEST_DB" \
  --addons-path=/mnt/extra-addons,/usr/lib/python3/dist-packages/odoo/addons \
  -i "$MODULES" \
  --stop-after-init \
  > "$LOG_FILE" 2>&1
status=$?

if [ $status -ne 0 ]; then
  echo "Odoo install exited non-zero ($status):" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

if grep -iE "error|critical|traceback|warning" "$LOG_FILE"; then
  echo "FAIL: install log contains error/warning/traceback (see above)" >&2
  exit 1
fi

company_count=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$TEST_DB" -Atc "SELECT count(*) FROM res_company;")
if [ "$company_count" != "1" ]; then
  echo "FAIL: expected exactly one initial res.company; found $company_count" >&2
  exit 1
fi

echo "PASS: tenant addon installed with exactly one initial res.company."
echo "PASS: all kemfai_* addons installed cleanly with zero errors/warnings."
