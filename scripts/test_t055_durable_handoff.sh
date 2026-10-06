#!/usr/bin/env bash
# T055 arbiter binding resolution, point 6 — real application-level regression gate for
# the `company_mutation_handoff` durability protocol, against a FRESH, OWNED, newly
# created scratch PostgreSQL (never the shared dev `kemfai-db`/`kemfai_control`).
#
# Scope (Tier 1 of two — see also scripts/test_t054_live.sh's Phase 4.5, which proves the
# SAME protocol end-to-end through real HTTP + real Odoo): this gate exercises
# `CompanyMutationHandoffService`, `AuditService`, and `CompanyMutationRecoveryWorker`
# directly against real Postgres (real SQL, real unique-index/lease/backoff behavior) —
# the control-plane half of the protocol, where the fault/concurrency/key-scope
# guarantees actually live. The Odoo RPC boundary is stubbed here deliberately: the
# addon's own idempotent-receipt behavior is proven for real against real Odoo by
# `backend/addons/kemfai_company_setup/tests/test_company_setup.py`
# (scripts/test_t054_live.sh Phase 1), and the full HTTP->Odoo->audit path is proven for
# real by scripts/test_t054_live.sh Phase 4.5. Three independent real proofs, each at the
# layer where its guarantee is actually enforced, rather than one test re-deriving all of
# Odoo/Postgres/HTTP for every scenario.
#
# Hard requirements (same contract as test_t054_live.sh):
#   * FAILS (non-zero exit), never silently skips, when Docker is unavailable.
#   * The PostgreSQL container and its scratch database are newly created by THIS run,
#     labelled with this run's id, and never an existing/shared container or database.
#   * Cleanup verifies the `kemfai.t055.run=<run_id>` label before removing anything.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
api_dir="$repo_dir/backend/api"

command -v docker >/dev/null 2>&1 || { echo "FAIL: docker CLI is not available" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "FAIL: docker daemon is not reachable" >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "FAIL: openssl is required to generate scratch credentials" >&2; exit 1; }

run_id="t055h$(openssl rand -hex 5)"
label="kemfai.t055.run=${run_id}"
pg_container="${run_id}_pg"
control_db="${run_id}_ctrl"
pg_password="$(openssl rand -hex 20)"

artifacts_dir="${KEMFAI_ARTIFACTS_DIR:-$(dirname "$repo_dir")/t055-handoff-evidence-${run_id}}"
mkdir -p "$artifacts_dir"
evidence_file="$artifacts_dir/evidence.txt"

declare -a owned_containers=()

verify_owned_container() {
  local name="$1"
  local actual
  actual="$(docker inspect -f '{{ index .Config.Labels "kemfai.t055.run" }}' "$name" 2>/dev/null || true)"
  [ "$actual" = "$run_id" ]
}

cleanup() {
  set +e
  echo "== Cleanup: removing only resources labelled ${label} =="
  for name in "${owned_containers[@]}"; do
    if verify_owned_container "$name"; then
      docker rm -f "$name" >/dev/null 2>&1
    else
      echo "SKIP cleanup: '$name' is missing the ${label} label — not touching it" >&2
    fi
  done
}
trap cleanup EXIT

{
  echo "T055 durable-handoff live gate evidence (no secrets) — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "run id:            ${run_id}"
  echo "artifacts dir:     ${artifacts_dir}"
  echo "private postgres:  ${pg_container}"
  echo "control db:        ${control_db}"
} | tee "$evidence_file"

echo
echo "== Creating a newly-owned private PostgreSQL container =="
docker run -d --label "$label" --name "$pg_container" \
  -e POSTGRES_USER=odoo -e POSTGRES_PASSWORD="$pg_password" \
  -p 127.0.0.1::5432 postgres:16 >/dev/null
owned_containers+=("$pg_container")

ready=0
for _ in $(seq 1 60); do
  if docker exec "$pg_container" pg_isready -h 127.0.0.1 -U odoo >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done
[ "$ready" -eq 1 ] || { echo "FAIL: private PostgreSQL container '${pg_container}' never became ready" >&2; exit 1; }
pg_host_port="$(docker port "$pg_container" 5432/tcp | head -1 | cut -d: -f2)"
echo "PASS: private, newly-created PostgreSQL (${pg_container}) is ready." | tee -a "$evidence_file"

docker exec "$pg_container" psql -U odoo -d postgres -c "CREATE DATABASE ${control_db} OWNER odoo;" >/dev/null

echo
echo "== Migrating the scratch control DB =="
cd "$api_dir"
export CONTROL_DB_HOST=127.0.0.1
export CONTROL_DB_PORT="$pg_host_port"
export CONTROL_DB_USER=odoo
export CONTROL_DB_PASSWORD="$pg_password"
export CONTROL_DB_NAME="$control_db"
log_file="$artifacts_dir/migrations.log"
npm run migration:run > "$log_file" 2>&1 || { cat "$log_file"; echo "FAIL: migrations failed against scratch control DB ${control_db}" >&2; exit 1; }
echo "PASS: migrations applied cleanly to scratch control DB ${control_db}." | tee -a "$evidence_file"

echo
echo "== Running the durable-handoff application-level regression suite =="
export KEMFAI_LIVE_T055_HANDOFF=1
log_file="$artifacts_dir/handoff-suite.log"
set +e
npx jest --config test/jest-integration.json --runInBand company-mutation-handoff.integration-spec.ts --testTimeout=60000 > "$log_file" 2>&1
status=$?
set -e
cat "$log_file"
[ $status -eq 0 ] || { echo "FAIL: durable-handoff regression suite failed" >&2; exit 1; }
echo "PASS: durable-handoff regression suite passed against scratch control DB ${control_db}." | tee -a "$evidence_file"

echo
echo "== T055 durable-handoff live gate: ALL PHASES PASSED =="
cat "$evidence_file"
