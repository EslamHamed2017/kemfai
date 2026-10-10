#!/usr/bin/env bash
# T052 genuine acceptance gate. This intentionally reuses the already-reviewed T056
# disposable-stack harness by making a private runtime copy, changing its ownership
# namespace to T052, and adding only the fixtures/assertions T052 needs. The tracked T056
# harness is never edited or sourced, and no shared/prod/dev service or database is used.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
template="$repo_dir/scripts/test_t056_live_browser.sh"
report_root="$(cd "$repo_dir/.." && pwd -P)"

[ -f "$template" ] || { echo "FAIL: required T056 fixture harness is missing" >&2; exit 1; }
command -v sed >/dev/null 2>&1 || { echo "FAIL: sed is required" >&2; exit 1; }

wrapper_private_dir="$(mktemp -d)"
chmod 700 "$wrapper_private_dir"
cleanup_wrapper() {
  local status=$?
  set +e
  rm -rf -- "$wrapper_private_dir"
  trap - EXIT
  exit "$status"
}
trap cleanup_wrapper EXIT

staged_harness="$wrapper_private_dir/test_t052_owned_fixture.sh"
sed -e 's/T056/T052/g' -e 's/t056/t052/g' "$template" > "$staged_harness"
chmod 700 "$staged_harness"

require_single_anchor() {
  local pattern="$1" description="$2" count
  count="$(grep -cF -- "$pattern" "$staged_harness" || true)"
  [ "$count" -eq 1 ] || {
    echo "FAIL: reusable fixture contract changed: expected one ${description} anchor, found ${count}" >&2
    exit 1
  }
}

company_anchor='echo "PASS: Alpha company id=${alpha_company_id}, Beta company id=${beta_company_id}." | tee -a "$evidence_file"'
private_anchor='chmod 700 "$private_dir"'
seed_anchor='echo "PASS: control-plane seeded — Alpha tenant=${alpha_tenant_id}, Beta tenant=${beta_tenant_id}; both bound WorkspaceOwner in scratch Keycloak." | tee -a "$evidence_file"'
export_anchor='export T052_BETA_TENANT_ID="$beta_tenant_id"'
green_anchor='[ $status -eq 0 ] || fail "real browser harness (tests/e2e-live/t052-real-browser.live.spec.ts) failed"'
pass_anchor='echo "PASS: real browser Alpha persistence, stale-scope rejection, logout, and Beta isolation all verified end to end." | tee -a "$evidence_file"'
repo_anchor='repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"'
cleanup_anchor='value out of every file this run wrote, in place, regardless of how the run ended.'

require_single_anchor "$company_anchor" "company fixture"
require_single_anchor "$private_anchor" "private runtime directory"
require_single_anchor "$seed_anchor" "control-plane seed"
require_single_anchor "$export_anchor" "browser environment"
require_single_anchor "$green_anchor" "browser result"
require_single_anchor "$pass_anchor" "browser pass"
require_single_anchor "$repo_anchor" "repository root"
require_single_anchor "$cleanup_anchor" "cleanup evidence"

fixture_fragment="$wrapper_private_dir/fixture.fragment"
cat > "$fixture_fragment" <<'T052_FIXTURE'

# T052-only, disposable tenant-plane configuration. These rows exist solely inside
# this run's two private Odoo databases and are deleted with the labelled Postgres
# container. No production/dev country rule, industry, company, or database is read or
# mutated.
if grep -qF 'invalid module names' "$artifacts_dir/bootstrap-${alpha_db}.log" "$artifacts_dir/bootstrap-${beta_db}.log"; then
  fail "private Odoo bootstrap reported an invalid addon instead of installing current source"
fi
odoo_search_one() {
  local db="$1" uid="$2" model="$3" domain_json="$4"
  odoo_rpc object execute_kw "[\"${db}\",${uid},\"${odoo_admin_password}\",\"${model}\",\"search\",[${domain_json}],{\"limit\":1}]" \
    | python3 -c "
import json, sys
body = json.load(sys.stdin)
if 'result' not in body:
    message = body.get('error', {}).get('data', {}).get('message', 'unknown Odoo RPC error')
    print('fixture search failed: ' + str(message), file=sys.stderr)
    raise SystemExit(1)
rows = body['result']
print(rows[0] if rows else '')
"
}
odoo_create() {
  local db="$1" uid="$2" model="$3" values_json="$4"
  odoo_rpc object execute_kw "[\"${db}\",${uid},\"${odoo_admin_password}\",\"${model}\",\"create\",[${values_json}]]" \
    | python3 -c "
import json, sys
body = json.load(sys.stdin)
if 'result' not in body:
    message = body.get('error', {}).get('data', {}).get('message', 'unknown Odoo RPC error')
    print('fixture create failed: ' + str(message), file=sys.stderr)
    raise SystemExit(1)
print(body['result'])
"
}

alpha_country_id="$(odoo_search_one "$alpha_db" "$alpha_uid" res.country '[["code","=","AE"]]')"
beta_country_id="$(odoo_search_one "$beta_db" "$beta_uid" res.country '[["code","=","AE"]]')"
[ -n "$alpha_country_id" ] && [ -n "$beta_country_id" ] || fail "AE country fixture is missing"
alpha_industry_id="$(odoo_create "$alpha_db" "$alpha_uid" res.partner.industry '{"name":"T052 English Industry"}')"
beta_industry_id="$(odoo_create "$beta_db" "$beta_uid" res.partner.industry '{"name":"T052 Arabic Industry"}')"
# Seed configuration directly in these disposable databases so fixture preparation is
# independent of customer-facing RPC permissions. This is fixture setup, never an
# application-path shortcut; every wizard mutation below still uses the real UI/BFF/API.
docker exec "$pg_container" psql -U odoo -d "$alpha_db" -X -q -v ON_ERROR_STOP=1 \
  -c "INSERT INTO kemfai_company_setup_country_rule (country_id, vat_regex, vat_format_hint) VALUES (${alpha_country_id}, '^[0-9]{15}$', '15 digits');" >/dev/null \
  || fail "failed to seed Alpha's private VAT validation rule"
docker exec "$pg_container" psql -U odoo -d "$beta_db" -X -q -v ON_ERROR_STOP=1 \
  -c "INSERT INTO kemfai_company_setup_country_rule (country_id, vat_regex, vat_format_hint) VALUES (${beta_country_id}, '^[0-9]{15}$', '15 digits');" >/dev/null \
  || fail "failed to seed Beta's private VAT validation rule"
[ -n "$alpha_industry_id" ] && [ -n "$beta_industry_id" ] || fail "industry fixtures were not created"
echo "PASS: private T052 VAT-rule and industry fixtures created in Alpha/Beta databases." | tee -a "$evidence_file"
T052_FIXTURE

addons_fragment="$wrapper_private_dir/addons.fragment"
cat > "$addons_fragment" <<'T052_ADDONS'

# The checkout is owner-only. Never chmod/chown the repo or its shared fixtures: make
# a private runtime copy and grant only that disposable copy the read/traverse bits the
# unprivileged Odoo container requires.
runtime_addons_dir="$private_dir/runtime-addons"
mkdir -p "$runtime_addons_dir"
cp -a "$addons_dir/." "$runtime_addons_dir/"
chmod -R u=rwX,go=rX "$runtime_addons_dir"
addons_dir="$runtime_addons_dir"
module_scan="$(docker run --rm --label "$label" -v "${addons_dir}:/mnt/extra-addons:ro" \
  --entrypoint python3 odoo:18 -c \
  "from odoo.tools import config; config.parse_config(['--addons-path=/mnt/extra-addons,/usr/lib/python3/dist-packages/odoo/addons']); from odoo.modules.module import get_modules; print(','.join(sorted(x for x in get_modules() if x.startswith('kemfai_'))))")"
case ",${module_scan}," in
  *,kemfai_company_setup,*kemfai_tenant_core,*) ;;
  *) echo "FAIL: Odoo cannot discover the required addons in the disposable runtime copy (found: ${module_scan:-none})" >&2; exit 1 ;;
esac
T052_ADDONS

cleanup_fragment="$wrapper_private_dir/cleanup.fragment"
cat > "$cleanup_fragment" <<'T052_CLEANUP'
  if [ "$cleanup_verification_failed" -eq 0 ]; then
    echo "PASS cleanup: zero exact-label T052 container/network survivors; owned process groups stopped." | tee -a "$evidence_file"
  fi
T052_CLEANUP

build_fragment="$wrapper_private_dir/build.fragment"
cat > "$build_fragment" <<'T052_BUILD'

echo
echo "== T052 build: compile the exact API and frontend source under test =="
(
  cd "$api_dir"
  npm run build
) > "$artifacts_dir/api-build.log" 2>&1 \
  || { redact_secrets < "$artifacts_dir/api-build.log"; fail "API build failed"; }
(
  cd "$frontend_dir"
  export NODE_ENV=production
  export NEXT_PUBLIC_API_URL="http://127.0.0.1:${api_port}" NEXT_PUBLIC_DEFAULT_LOCALE=en
  export KEYCLOAK_ISSUER="${kc_base}/realms/${realm_name}"
  export KEYCLOAK_BACKCHANNEL_URL="${kc_base}/realms/${realm_name}"
  export KEYCLOAK_JWKS_URI="${kc_base}/realms/${realm_name}/protocol/openid-connect/certs"
  export KEYCLOAK_CLIENT_ID="kemfai-api" KEYCLOAK_REDIRECT_URI="${redirect_uri}"
  export KEMFAI_API_URL="http://127.0.0.1:${api_port}"
  export REDIS_URL="redis://127.0.0.1:${redis_host_port}"
  export SUPPORT_EMAIL="support@example.test"
  npm run build
) > "$artifacts_dir/frontend-build.log" 2>&1 \
  || { redact_secrets < "$artifacts_dir/frontend-build.log"; fail "frontend build failed"; }
echo "PASS: API and frontend production builds completed from current source." | tee -a "$evidence_file"
T052_BUILD

browser_fragment="$wrapper_private_dir/browser.fragment"
cat > "$browser_fragment" <<'T052_BROWSER'
export T052_ALPHA_INDUSTRY_ID="$alpha_industry_id"
export T052_BETA_INDUSTRY_ID="$beta_industry_id"

echo
echo "== T052 TDD RED: disposable negative-control copy, exact expected failure =="
red_root="$private_dir/t052-negative-control"
red_test_dir="$red_root/tests/e2e-live"
mkdir -p "$red_test_dir" "$red_root/src/locales/en" "$red_root/src/locales/ar"
cp "$frontend_dir/tests/e2e-live/t052-full-wizard.live.spec.ts" "$red_test_dir/t052-negative.live.spec.ts"
cp "$frontend_dir/src/locales/en/common.json" "$red_root/src/locales/en/common.json"
cp "$frontend_dir/src/locales/ar/common.json" "$red_root/src/locales/ar/common.json"
ln -s "$frontend_dir/node_modules" "$red_root/node_modules"
red_source="$red_test_dir/t052-negative.live.spec.ts"
red_before="$(grep -cF "const EXPECTED_LAST_PROGRESS_ID = 'accounting_setup';" "$red_source" || true)"
[ "$red_before" -eq 1 ] || fail "negative-control source anchor is not exact"
sed -i "s/const EXPECTED_LAST_PROGRESS_ID = 'accounting_setup';/const EXPECTED_LAST_PROGRESS_ID = 't052_missing_negative_control_step';/" "$red_source"
grep -qF "const EXPECTED_LAST_PROGRESS_ID = 't052_missing_negative_control_step';" "$red_source" \
  || fail "negative-control mutation was not applied to the disposable copy"
grep -qF "const EXPECTED_LAST_PROGRESS_ID = 'accounting_setup';" \
  "$frontend_dir/tests/e2e-live/t052-full-wizard.live.spec.ts" \
  || fail "submitted GREEN source was unexpectedly mutated"

export T052_TEST_DIR="$red_test_dir"
export T052_TEST_MATCH="t052-negative.live.spec.ts"
export T052_PLAYWRIGHT_OUTPUT_DIR="$private_dir/red-playwright-output"
set +e
npx playwright test --config tests/e2e-live/playwright.t052-live.config.ts \
  > "$artifacts_dir/red-negative-control.log" 2>&1
red_status=$?
set -e
redact_secrets < "$artifacts_dir/red-negative-control.log"
[ "$red_status" -ne 0 ] || fail "negative control unexpectedly passed"
grep -qF "T052_NEGATIVE_CONTROL_EXPECTED" "$artifacts_dir/red-negative-control.log" \
  || fail "negative control failed for an unexpected reason"
grep -Eq '(^|[^0-9])1 failed([^0-9]|$)' "$artifacts_dir/red-negative-control.log" \
  || fail "negative control did not report exactly one failed test"
if grep -Eq '(^|[^0-9])[1-9][0-9]* (passed|skipped|flaky)([^a-z]|$)' "$artifacts_dir/red-negative-control.log"; then
  fail "negative control reported an unexpected pass, skip, or flaky test"
fi
rm -rf -- "$red_root"
unset T052_TEST_DIR T052_TEST_MATCH
export T052_PLAYWRIGHT_OUTPUT_DIR="$private_dir/green-playwright-output"
echo "PASS: exact expected RED observed from disposable copy; tracked source stayed unchanged." | tee -a "$evidence_file"
T052_BROWSER

green_fragment="$wrapper_private_dir/green.fragment"
cat > "$green_fragment" <<'T052_GREEN'
grep -Eq '(^|[^0-9])1 passed([^0-9]|$)' "$artifacts_dir/browser-harness.log" \
  || fail "GREEN browser run did not report exactly one passed test"
if grep -Eq '(^|[^0-9])[1-9][0-9]* (failed|skipped|flaky)([^a-z]|$)' "$artifacts_dir/browser-harness.log"; then
  fail "GREEN browser run reported a failure, skip, or flaky test"
fi
T052_GREEN

audit_fragment="$wrapper_private_dir/audit.fragment"
cat > "$audit_fragment" <<'T052_AUDIT'
echo
echo "== T052 post-browser proof: exact audit and completed-state checks =="
audit_ready=0
for _ in $(seq 1 30); do
  alpha_audit_count="$(psql_q "SELECT count(*) FROM audit_event WHERE action = 'company.setup.completed' AND tenant_id = '${alpha_tenant_id}';")"
  beta_audit_count="$(psql_q "SELECT count(*) FROM audit_event WHERE action = 'company.setup.completed' AND tenant_id = '${beta_tenant_id}';")"
  if [ "$alpha_audit_count" = "1" ] && [ "$beta_audit_count" = "1" ]; then audit_ready=1; break; fi
  sleep 0.2
done
[ "$audit_ready" -eq 1 ] || fail "expected one completion audit event for each private tenant"
echo "PASS: each private tenant has exactly one company.setup.completed audit event." | tee -a "$evidence_file"
T052_AUDIT

# Read-fragment insertion is anchored and count-checked above. All generated content
# lives in the owner-only wrapper directory and is deleted on exit.
escape_bre() {
  sed 's/[][\\.^$*]/\\&/g'
}
company_re="$(printf '%s' "$company_anchor" | escape_bre)"
private_re="$(printf '%s' "$private_anchor" | escape_bre)"
seed_re="$(printf '%s' "$seed_anchor" | escape_bre)"
export_re="$(printf '%s' "$export_anchor" | escape_bre)"
green_re="$(printf '%s' "$green_anchor" | escape_bre)"
pass_re="$(printf '%s' "$pass_anchor" | escape_bre)"
cleanup_re="$(printf '%s' "$cleanup_anchor" | escape_bre)"

sed -i "\#${private_re}#r $addons_fragment" "$staged_harness"
sed -i "\#${company_re}#r $fixture_fragment" "$staged_harness"
sed -i "\#${seed_re}#r $build_fragment" "$staged_harness"
sed -i "\#${export_re}#r $browser_fragment" "$staged_harness"
sed -i 's#tests/e2e-live/playwright\.live\.config\.ts#tests/e2e-live/playwright.t052-live.config.ts#' "$staged_harness"
sed -i 's#> "$artifacts_dir/browser-harness\.log"#> "$artifacts_dir/browser-harness.log"#' "$staged_harness"
sed -i "\#${green_re}#r $green_fragment" "$staged_harness"
sed -i "\#${pass_re}#r $audit_fragment" "$staged_harness"
sed -i "\#${cleanup_re}#r $cleanup_fragment" "$staged_harness"
sed -i 's#real browser Alpha persistence, stale-scope rejection, logout, and Beta isolation all verified end to end\.#full English/LTR and Arabic/RTL wizard walkthroughs completed through the real stack.#' "$staged_harness"
sed -i 's#^repo_dir=.*#repo_dir="${KEMFAI_T052_REPO_DIR:?KEMFAI_T052_REPO_DIR is required}"#' "$staged_harness"

# Ensure the staged copy now points only at T052's dedicated live test/config.
grep -qF 'playwright.t052-live.config.ts' "$staged_harness" || {
  echo "FAIL: staged harness did not select the T052 Playwright config" >&2
  exit 1
}
if grep -qE 'kemfai\.t056|T056_|t056r|kemfai-t056' "$staged_harness"; then
  echo "FAIL: staged harness retained a T056 ownership or credential namespace" >&2
  exit 1
fi

if [ "${KEMFAI_T052_VALIDATE_STAGE_ONLY:-0}" = "1" ]; then
  bash -n "$staged_harness"
  if [ -n "${KEMFAI_T052_STAGE_OUTPUT:-}" ]; then
    cp "$staged_harness" "$KEMFAI_T052_STAGE_OUTPUT"
    chmod 600 "$KEMFAI_T052_STAGE_OUTPUT"
  fi
  echo "PASS: staged T052 harness is syntactically valid and all reuse anchors resolved."
  exit 0
fi

# T056's scrubber intentionally rewrites every retained artifact to redact secrets.
# Never let an ambient override point that recursive operation at an existing/shared
# directory: T052 accepts only a new direct child of this task's authorized report root
# and creates it atomically immediately before the staged harness starts.
requested_artifacts_dir="${KEMFAI_ARTIFACTS_DIR:-}"
if [ -n "$requested_artifacts_dir" ]; then
  [ "$requested_artifacts_dir" = "${requested_artifacts_dir//$'\n'/}" ] \
    || { echo "FAIL: KEMFAI_ARTIFACTS_DIR contains a newline" >&2; exit 1; }
  [ "$(dirname "$requested_artifacts_dir")" = "$report_root" ] \
    || { echo "FAIL: KEMFAI_ARTIFACTS_DIR must be a direct child of ${report_root}" >&2; exit 1; }
  artifact_basename="$(basename "$requested_artifacts_dir")"
  [[ "$artifact_basename" =~ ^t052[-A-Za-z0-9._]+$ ]] \
    || { echo "FAIL: KEMFAI_ARTIFACTS_DIR basename must be T052-owned" >&2; exit 1; }
  [ ! -e "$requested_artifacts_dir" ] && [ ! -L "$requested_artifacts_dir" ] \
    || { echo "FAIL: KEMFAI_ARTIFACTS_DIR must not already exist" >&2; exit 1; }
  mkdir "$requested_artifacts_dir"
  chmod 700 "$requested_artifacts_dir"
  owned_artifacts_dir="$requested_artifacts_dir"
else
  owned_artifacts_dir="$(mktemp -d "$report_root/t052-live-evidence-XXXXXXXXXX")"
  chmod 700 "$owned_artifacts_dir"
fi

set +e
KEMFAI_T052_REPO_DIR="$repo_dir" KEMFAI_ARTIFACTS_DIR="$owned_artifacts_dir" bash "$staged_harness"
status=$?
set -e
exit "$status"
