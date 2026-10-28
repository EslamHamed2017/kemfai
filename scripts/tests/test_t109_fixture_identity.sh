#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
runner="$repo_dir/scripts/test_t109_odoo_exposure.sh"
expected='kemfai.phase12.operation=t109-parent-gates-continuation-20261025T153344Z'
bare='t109-parent-gates-continuation-20261025T153344Z'
prior='kemfai.phase12.operation=t109-odoo-exposure-20261025T033137Z'

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

output="$(T109_FIXTURE_LABEL="$expected" "$runner" preflight)" \
  || fail 'the controller-provided full fixture label was rejected'
[ "$output" = "T109 fixture identity: $expected" ] \
  || fail 'preflight did not report the exact authorized fixture label'

output="$(env -u T109_FIXTURE_LABEL "$runner" preflight)" \
  || fail 'the safe exact default fixture label was rejected'
[ "$output" = "T109 fixture identity: $expected" ] \
  || fail 'the safe default did not resolve to the authorized fixture label'

if T109_FIXTURE_LABEL="$bare" "$runner" preflight >/dev/null 2>&1; then
  fail 'the ambiguous bare operation id was accepted as T109_FIXTURE_LABEL'
fi
if T109_FIXTURE_LABEL="$prior" "$runner" preflight >/dev/null 2>&1; then
  fail 'the frozen predecessor operation label was accepted'
fi
if T109_FIXTURE_LABEL='kemfai.phase12.operation=t109-other-operation' \
  "$runner" preflight >/dev/null 2>&1; then
  fail 'a different operation label was accepted'
fi

grep -qF "'$expected'" \
  "$repo_dir/backend/api/test/support/t109-http-server.ts" \
  || fail 'the Nest fixture does not enforce the controller-provided full label'
grep -qF "'$expected'" \
  "$repo_dir/frontend/tests/e2e/full-surface-odoo-exposure-sweep.spec.ts" \
  || fail 'the browser spec does not enforce the controller-provided full label'
grep -qF "'$expected'" \
  "$repo_dir/frontend/tests/e2e/support/t109-evidence-reporter.ts" \
  || fail 'the browser evidence does not record the controller-provided full label'
grep -qF "\"$expected\"" "$repo_dir/scripts/fixtures/t109_validate_evidence.py" \
  || fail 'the evidence validator does not require the controller-provided full label'
grep -qF 'docker rm -fv "$candidate"' "$runner" \
  || fail 'exact fixture cleanup does not remove its anonymous volume'
grep -qF 'postgres_final_ready_messages=' "$runner" \
  || fail 'fixture registry does not record final PostgreSQL readiness'
grep -qF -- "-c 'SELECT 1'" "$runner" \
  || fail 'PostgreSQL readiness does not require a final SQL SELECT 1'
grep -qF 'CONTROL_DB_PASSWORD="$(<"$PRIVATE_DIR/postgres-password")"' "$runner" \
  || fail 'the newline-free generated PostgreSQL password is loaded with a set -e-safe assignment'
if grep -qF 'read -r CONTROL_DB_PASSWORD' "$runner"; then
  fail 'newline-free PostgreSQL password still uses read, which exits 1 under set -e'
fi
grep -qF 'local session_id="$1" token_name="$2"' "$runner" \
  || fail 'frontend session seed declares input names before deriving paths'
grep -qF 'local session_file="$PRIVATE_DIR/session-$token_name.json"' "$runner" \
  || fail 'frontend session path is derived only after token_name is assigned'
if grep -qF 'token_name="$2" session_file=' "$runner"; then
  fail 'frontend session path still expands token_name inside the same local declaration'
fi
grep -qF 'remove_owned_container "$PG_CONTAINER"' "$runner" \
  || fail 'exact PostgreSQL cleanup is missing'
grep -qF 'remove_owned_container "$REDIS_CONTAINER"' "$runner" \
  || fail 'exact Redis cleanup is missing'
grep -qF 'rm -rf -- "$PRIVATE_DIR" || cleanup_status=1' "$runner" \
  || fail 'private-directory cleanup failure is not recorded'
grep -qF 'log_has_startup_failure "$log"' "$runner" \
  || fail 'HTTP readiness does not use the portable startup-log matcher'
grep -qF 'command -v rg' "$runner" \
  || fail 'the startup-log matcher does not feature-detect rg'
grep -qF 'grep -Eq' "$runner" \
  || fail 'the startup-log matcher has no grep fallback when rg is unavailable'
grep -qF 'route.fetch({ maxRedirects: 0 })' \
  "$repo_dir/frontend/tests/e2e/full-surface-odoo-exposure-sweep.spec.ts" \
  || fail 'browser response capture does not read response bytes before delivery/navigation'
if grep -qF "page.on('response'" \
  "$repo_dir/frontend/tests/e2e/full-surface-odoo-exposure-sweep.spec.ts"; then
  fail 'browser response capture still uses the navigation-racy passive response listener'
fi
if grep -qF "mode: 'serial'" \
  "$repo_dir/frontend/tests/e2e/full-surface-odoo-exposure-sweep.spec.ts"; then
  fail 'browser coverage can still cascade into serial skips'
fi
if grep -qF "getByRole('alert')" \
  "$repo_dir/frontend/tests/e2e/full-surface-odoo-exposure-sweep.spec.ts"; then
  fail 'browser suite still has ambiguous global alert locators'
fi
grep -qF 'imports: [AppModule]' "$repo_dir/backend/api/test/support/t109-surface-harness.ts" \
  || fail 'backend fixture does not boot the production AppModule'
grep -qF '.overrideProvider(ODOO_RPC_CLIENT)' \
  "$repo_dir/backend/api/test/support/t109-surface-harness.ts" \
  || fail 'backend fixture does not isolate the external Odoo adapter seam'
if [ -e "$repo_dir/backend/api/src/common/interceptors/no-odoo-exposure.interceptor.ts" ]; then
  fail 'prohibited global regex response sanitizer still exists'
fi
if grep -qF 'SURFACE_MAP' \
  "$repo_dir/frontend/tests/e2e/support/t109-evidence-reporter.ts"; then
  fail 'browser evidence reporter still substitutes a static surface map for observations'
fi

for generated_path in \
  "$repo_dir/backend/api/dist" \
  "$repo_dir/backend/api/coverage" \
  "$repo_dir/frontend/.next" \
  "$repo_dir/frontend/coverage" \
  "$repo_dir/frontend/playwright-report" \
  "$repo_dir/frontend/test-results" \
  "$repo_dir/frontend/tsconfig.tsbuildinfo"; do
  if [ -e "$generated_path" ]; then
    fail "generated artifact remains in pinned source: ${generated_path#"$repo_dir/"}"
  fi
done

echo 'PASS: T109 fixture identity matches the controller and rejects every other label.'
