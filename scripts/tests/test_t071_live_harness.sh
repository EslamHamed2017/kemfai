#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
runner="$repo_dir/scripts/test_t071_live.sh"
stage="$(mktemp)"
probe_pid=""
delayed_probe_pid=""
registration_failure_pid_file=""
pidfd_probe_pid=""
leaf_violation_parent=""
leaf_violation_child=""
leaf_violation_file=""
cross_group_parent=""
cross_group_child=""
cross_group_child_start=""
cross_group_file=""
private_home=""
fixture_dir=""
relay_dir=""
offline_cleanup() {
  [ -z "$probe_pid" ] || kill -KILL -- "-$probe_pid" 2>/dev/null || true
  [ -z "$delayed_probe_pid" ] || kill -KILL -- "-$delayed_probe_pid" 2>/dev/null || kill -KILL -- "$delayed_probe_pid" 2>/dev/null || true
  [ -z "$registration_failure_pid_file" ] || rm -f -- "$registration_failure_pid_file"
  [ -z "$pidfd_probe_pid" ] || kill -KILL -- "$pidfd_probe_pid" 2>/dev/null || true
  [ -z "$leaf_violation_child" ] || kill -KILL -- "$leaf_violation_child" 2>/dev/null || true
  [ -z "$leaf_violation_parent" ] || kill -KILL -- "$leaf_violation_parent" 2>/dev/null || true
  [ -z "$leaf_violation_file" ] || rm -f -- "$leaf_violation_file"
  [ -z "$cross_group_child" ] || signal_owned_pid "$cross_group_child" "$cross_group_child_start" KILL 2>/dev/null || true
  [ -z "$cross_group_parent" ] || signal_owned_pid "$cross_group_parent" "${owned_pid_starttime[$cross_group_parent]:-}" KILL 2>/dev/null || true
  [ -z "$cross_group_file" ] || rm -f -- "$cross_group_file"
  [ -z "$private_home" ] || rmdir "$private_home" 2>/dev/null || true
  [ -z "$fixture_dir" ] || rm -rf -- "$fixture_dir"
  [ -z "$relay_dir" ] || rm -rf -- "$relay_dir"
  rm -f -- "$stage"
}
trap offline_cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
grep -qF 'test_t056_live_browser.sh' "$runner" || fail "runner must reuse the accepted owned fixture lifecycle"
grep -qF 'KEMFAI_T071_VALIDATE_STAGE_ONLY' "$runner" || fail "runner needs an offline stage-validation mode"
grep -qF 'quay.io/minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e' "$runner" \
  || fail "runner must pin the parent-verified cached MinIO server digest"
grep -qF 't071_minio_fixture.mjs' "$runner" || fail "runner does not use the repository MinIO SDK fixture"
grep -qF 'KEYCLOAK_INTERNAL_REALM' "$runner" || fail "runner must configure the real internal realm"
grep -qF 't071_fault_proxy.mjs' "$runner" || fail "runner must use the controlled pass-through fault proxy"
grep -qF 'billing_decision_notification_outbox' "$runner" || fail "runner must assert the real notification outbox"
grep -qF 'billing.payment_submission.decided' "$runner" || fail "runner must assert persisted decision audits"

KEMFAI_T071_VALIDATE_STAGE_ONLY=1 KEMFAI_T071_STAGE_OUTPUT="$stage" \
  KEMFAI_T071_REPO_DIR="$repo_dir" bash "$runner" >/dev/null
bash -n "$stage"

# These inspect the generated program, not convenient strings in the transformer.
grep -qF 'owned_pid_starttime' "$stage" || fail "generated lifecycle does not pin process start time"
grep -qF 'owned_pid_session' "$stage" || fail "generated lifecycle does not pin process session"
grep -qF 'register_owned_process "$api_pid"' "$stage" || fail "API process identity is not registered"
grep -qF 'register_owned_process "$frontend_pid"' "$stage" || fail "frontend process identity is not registered"
grep -qF 'register_owned_process "$proxy_pid"' "$stage" || fail "proxy process identity is not registered"
grep -qF 'source "$repo_dir/scripts/fixtures/t071_process_lifecycle.sh"' "$stage" || fail "generated lifecycle does not load the tested process helper"
[ "$(grep -cF 't071_owned_session_exec.py' "$stage")" -eq 4 ] || fail "every owned host service must use the no-fork session launcher"
grep -qF 'exec setsid ' "$stage" && fail "generated lifecycle retained a racy direct setsid launch"
grep -qF 'session_survivors' "$repo_dir/scripts/fixtures/t071_process_lifecycle.sh" || fail "process helper does not prove session extinction"
grep -qF '. "$repo_dir/scripts/lib_docker_test_cleanup.sh"' "$stage" \
  || fail "generated lifecycle does not load the shared exact-owned Docker cleanup helper"
grep -qF 'kemfai_register_container_intent "$minio_container"' "$stage" \
  || fail "generated lifecycle does not register the MinIO intent before creation"
grep -qF 'kemfai_cleanup_owned_containers || cleanup_verification_failed=1' "$stage" \
  || fail "generated lifecycle does not use shared exact-owned container cleanup"
grep -qF 'docker rm -f -v "$resource_id"' "$repo_dir/scripts/lib_docker_test_cleanup.sh" \
  || fail "shared container cleanup does not remove verified anonymous volumes"
grep -qF 'kemfai_exact_owned_container_id "$container_name"' "$stage" \
  || fail "relay targeting does not use shared exact container ownership checks"
grep -qF 'kemfai_exact_owned_network_id "$network"' "$stage" \
  || fail "relay targeting does not use shared exact network ownership checks"
grep -qF 'declare -a owned_containers=()' "$stage" \
  && fail "generated lifecycle retained the pre-library container ownership array"
grep -qF 'exact_owned_volume_id' "$stage" || fail "generated lifecycle does not verify owned named volumes"
grep -qF 'volume survivor(s) detected' "$stage" || fail "generated cleanup does not fail on volume survivors"
grep -qF 'docker image inspect "$image"' "$stage" || fail "generated launcher does not fail closed on missing local images"
grep -qF 'T071_MINIO_FIXTURE_CONFIG' "$stage" || fail "generated launcher does not invoke the SDK fixture through a private config"
grep -qF 'UPDATE tenant SET minio_bucket=' "$stage" \
  || fail "owned tenant row is not linked to its owned MinIO bucket before queue reads"
grep -qE 'minio/mc:|docker pull|quay\.io/minio/minio:latest' "$stage" \
  && fail "generated launcher can pull/use unavailable or mutable MinIO images"
grep -qF 'docker port ' "$stage" && fail "internal-network launcher still depends on suppressed published ports"
grep -qF 'start_owned_relay "$pg_container" 5432 pg_host_port' "$stage" || fail "PostgreSQL relay is missing"
grep -qF 'start_owned_relay "$redis_container" 6379 redis_host_port' "$stage" || fail "Redis relay is missing"
grep -qF 'start_owned_relay "$minio_container" 9000 minio_host_port' "$stage" || fail "MinIO relay is missing"
grep -qF 'start_owned_relay "$kc_container" 8080 kc_host_port' "$stage" || fail "Keycloak relay is missing"
grep -qF 'start_owned_relay "$http_container" 8069 odoo_host_port' "$stage" || fail "Odoo relay is missing"
grep -qF 'terminate_owned_process_group "$relay_pid" "t071_loopback_relay.py"' "$stage" || fail "relay sessions are not cleaned up"
grep -qF 'sanitize_host_environment' "$stage" || fail "host Node processes inherit an unbounded caller environment"
grep -qF 'assert_no_dotenv_files' "$stage" || fail "host build/start can silently consume checkout .env files"
grep -qF 't071_resolve_playwright_browser.mjs' "$stage" || fail "generated preflight does not resolve the installed browser before sanitizing HOME"
grep -qF 'PLAYWRIGHT_BROWSERS_PATH="$playwright_browsers_path"' "$stage" || fail "sanitized children do not receive the validated browser cache"
grep -qF 'npx playwright test --config tests/e2e-live/playwright.t071-live.config.ts tests/e2e-live/t071-billing-admin.live.spec.ts' "$stage" \
  || fail "generated launcher does not target the exact T071 Playwright spec"
grep -qF 'tests/e2e-live/t071-real-browser.live.spec.ts' "$stage" \
  && fail "generated launcher retained the mechanically-renamed T056 Playwright target"
grep -qF 'HOST=127.0.0.1' "$stage" || fail "host services are not explicitly loopback-bound"
grep -qF 'NEXT_PUBLIC_PAYMENT_PROOF_ORIGINS="http://127.0.0.1:${minio_host_port}"' "$stage" \
  || fail "frontend build does not allowlist the exact owned MinIO proof origin"
node - "$stage" <<'NODE'
const source = require('node:fs').readFileSync(process.argv[2], 'utf8');
const initialToken = source.indexOf('TOKEN="$(admin_token)"');
const bindOwner = source.indexOf('bind_owner "$alpha_kc_id" "$alpha_tenant_id"');
const renewalMarker = source.lastIndexOf('renewing scratch Keycloak admin token before late bindings', bindOwner);
const renewedToken = source.lastIndexOf('TOKEN="$(admin_token)"', bindOwner);
const redaction = source.lastIndexOf('printf \'%s\\0\' "$TOKEN" >> "$redaction_secrets_file"', bindOwner);
const headerRewrite = source.lastIndexOf('write_token_header', bindOwner);
if (!(initialToken >= 0 && renewalMarker > initialToken && renewedToken > renewalMarker &&
      redaction > renewedToken && headerRewrite > redaction && bindOwner > headerRewrite)) {
  console.error('FAIL: generated launcher does not renew, redact, and install a fresh admin token before late tenant bindings');
  process.exit(1);
}
NODE
grep -qF 'wait "$staged_pid"' "$runner" || fail "wrapper does not retain ownership while the staged child runs"
grep -qF 'forward_stage_signal' "$runner" || fail "wrapper does not forward termination to its staged child"
grep -qE '^exec "\$stage"$' "$runner" && fail "wrapper exec bypasses its private-directory cleanup trap"

# Exercise the same lifecycle helper used by the generated launcher with a disposable
# local process session (no sockets, Docker, or network).
declare -A owned_pid_starttime=() owned_pid_session=()
source "$repo_dir/scripts/fixtures/t071_process_lifecycle.sh"
python3 "$repo_dir/scripts/fixtures/t071_owned_session_exec.py" sleep 30 &
probe_pid=$!
register_owned_process "$probe_pid" sleep
pid_owned_by_this_run "$probe_pid" sleep || fail "registered process identity was not recognized"
saved_start="${owned_pid_starttime[$probe_pid]}"
owned_pid_starttime["$probe_pid"]="invalid"
if pid_owned_by_this_run "$probe_pid" sleep; then fail "changed start time was accepted"; fi
owned_pid_starttime["$probe_pid"]="$saved_start"
terminate_owned_process_group "$probe_pid" sleep || fail "owned process session did not terminate"
[ -z "$(session_survivors "${owned_pid_session[$probe_pid]}")" ] || fail "owned process-session survivor remained"
probe_pid=""

# Cleanup must terminate every member of the owned session, including descendants
# that create a separate process group while remaining in that session.
cross_group_file="$(mktemp)"
python3 "$repo_dir/scripts/fixtures/t071_owned_session_exec.py" python3 -c '
import os, pathlib, sys, time
child = os.fork()
if child == 0:
    os.setpgid(0, 0)
    time.sleep(30)
else:
    pathlib.Path(sys.argv[1]).write_text(str(child) + "\n")
    os.waitpid(child, 0)
' "$cross_group_file" &
cross_group_parent=$!
register_owned_process "$cross_group_parent" python3
for _ in $(seq 1 50); do [ -s "$cross_group_file" ] && break; sleep .02; done
[ -s "$cross_group_file" ] || fail "cross-process-group fixture did not start"
read -r cross_group_child <"$cross_group_file"
cross_group_child_identity="$(process_identity "$cross_group_child")"
read -r cross_group_child_start _ <<<"$cross_group_child_identity"
[ "$(ps -o sid= -p "$cross_group_child" | tr -d ' ')" = "${owned_pid_session[$cross_group_parent]}" ] \
  || fail "cross-process-group child left the owned session"
[ "$(ps -o pgid= -p "$cross_group_child" | tr -d ' ')" != "$cross_group_parent" ] \
  || fail "cross-process-group child did not establish a distinct process group"
terminate_owned_process_group "$cross_group_parent" python3 \
  || fail "owned session with multiple process groups did not terminate"
[ -z "$(session_survivors "${owned_pid_session[$cross_group_parent]}")" ] \
  || fail "cross-process-group owned session survivor remained"
wait "$cross_group_parent" 2>/dev/null || true
cross_group_parent=""; cross_group_child=""; cross_group_child_start=""
rm -f -- "$cross_group_file"; cross_group_file=""

# Pre-session cleanup must use a stable kernel process reference. A mismatched pinned
# start time must not signal the process; the matching identity must terminate it.
sleep 30 &
pidfd_probe_pid=$!
pidfd_probe_start="$(process_identity "$pidfd_probe_pid")"
read -r pidfd_probe_start _ <<<"$pidfd_probe_start"
if signal_owned_pid "$pidfd_probe_pid" invalid TERM; then
  fail "pidfd signaling accepted a mismatched process identity"
fi
kill -0 "$pidfd_probe_pid" 2>/dev/null || fail "mismatched pidfd identity signaled the process"
owned_pid_starttime["$pidfd_probe_pid"]="$pidfd_probe_start"
owned_pid_session["$pidfd_probe_pid"]=""
terminate_owned_process_group "$pidfd_probe_pid" sleep \
  || fail "matching pre-session pidfd identity was not terminated"
wait "$pidfd_probe_pid" 2>/dev/null || true
pidfd_probe_pid=""

# Pre-session cleanup is only safe for the no-fork launcher invariant. If a caller
# violates it, cleanup must fail closed without signaling either the parent or child.
leaf_violation_file="$(mktemp)"
bash -c 'sleep 30 & printf "%s\n" "$!" >"$1"; wait' _ "$leaf_violation_file" &
leaf_violation_parent=$!
for _ in $(seq 1 50); do [ -s "$leaf_violation_file" ] && break; sleep .02; done
[ -s "$leaf_violation_file" ] || fail "leaf-invariant fixture did not start"
read -r leaf_violation_child <"$leaf_violation_file"
leaf_violation_start="$(process_identity "$leaf_violation_parent")"
read -r leaf_violation_start _ <<<"$leaf_violation_start"
owned_pid_starttime["$leaf_violation_parent"]="$leaf_violation_start"
owned_pid_session["$leaf_violation_parent"]=""
if terminate_owned_process_group "$leaf_violation_parent" sleep; then
  fail "pre-session cleanup accepted a process with descendants"
fi
kill -0 "$leaf_violation_parent" 2>/dev/null || fail "leaf-invariant failure signaled its parent"
kill -0 "$leaf_violation_child" 2>/dev/null || fail "leaf-invariant failure signaled its child"
kill -KILL -- "$leaf_violation_child" "$leaf_violation_parent" 2>/dev/null || true
wait "$leaf_violation_parent" 2>/dev/null || true
leaf_violation_parent=""; leaf_violation_child=""
rm -f -- "$leaf_violation_file"; leaf_violation_file=""

# Registration must tolerate the bounded fork-to-exec race: the background PID exists
# before it becomes the leader of the new setsid session.
bash -c 'sleep .2; exec python3 "$1" sleep 30' _ "$repo_dir/scripts/fixtures/t071_owned_session_exec.py" &
delayed_probe_pid=$!
register_owned_process "$delayed_probe_pid" sleep
pid_owned_by_this_run "$delayed_probe_pid" sleep || fail "delayed exec process identity was not recognized"
terminate_owned_process_group "$delayed_probe_pid" sleep || fail "delayed exec process session did not terminate"
[ -z "$(session_survivors "${owned_pid_session[$delayed_probe_pid]}")" ] || fail "delayed exec process-session survivor remained"
delayed_probe_pid=""

# A marker-validation failure after setsid must still clean the registered session.
registration_failure_pid_file="$(mktemp)"
if (
  declare -A owned_pid_starttime=() owned_pid_session=()
  failed_pid=""
  failed_cleanup() {
    local status=$?
    trap - EXIT
    [ -z "$failed_pid" ] || terminate_owned_process_group "$failed_pid" wrong-marker
    exit "$status"
  }
  trap failed_cleanup EXIT
  setsid sleep 30 &
  failed_pid=$!
  printf '%s\n' "$failed_pid" >"$registration_failure_pid_file"
  register_owned_process "$failed_pid" wrong-marker
); then
  fail "wrong process marker registration unexpectedly succeeded"
fi
read -r failed_pid <"$registration_failure_pid_file"
for _ in $(seq 1 25); do kill -0 "$failed_pid" 2>/dev/null || break; sleep .02; done
if kill -0 "$failed_pid" 2>/dev/null; then fail "failed registration leaked its owned session"; fi
rm -f -- "$registration_failure_pid_file"; registration_failure_pid_file=""

# Resolve under the caller's installed cache, then prove that only the validated cache
# root is sufficient with an otherwise empty environment and private HOME.
browser_cache="$(cd "$repo_dir/frontend" && node "$repo_dir/scripts/fixtures/t071_resolve_playwright_browser.mjs")"
private_home="$(mktemp -d)"
chmod 700 "$private_home"
(cd "$repo_dir/frontend" && env -i PATH="$PATH" HOME="$private_home" PLAYWRIGHT_BROWSERS_PATH="$browser_cache" \
  node "$repo_dir/scripts/fixtures/t071_resolve_playwright_browser.mjs" >/dev/null) \
  || fail "validated Playwright cache did not survive sanitized HOME"
rmdir "$private_home"
private_home=""

fixture_dir="$(mktemp -d)"; chmod 700 "$fixture_dir"
printf '%%PDF-1.7\nT071 offline fixture\n%%%%EOF\n' >"$fixture_dir/proof.pdf"
cat >"$fixture_dir/config.json" <<JSON
{"endpoint":"http://127.0.0.1:9000","accessKey":"offline","secretKey":"offline-only","tenantId":"11111111-1111-4111-8111-111111111111","submissionIds":["21111111-1111-4111-8111-111111111111","31111111-1111-4111-8111-111111111111","41111111-1111-4111-8111-111111111111","51111111-1111-4111-8111-111111111111","61111111-1111-4111-8111-111111111111"],"proofPath":"$fixture_dir/proof.pdf"}
JSON
chmod 600 "$fixture_dir/config.json" "$fixture_dir/proof.pdf"
(cd "$repo_dir/backend/api" && T071_MINIO_FIXTURE_CONFIG="$fixture_dir/config.json" \
  node "$repo_dir/scripts/fixtures/t071_minio_fixture.mjs" --validate-only) >/dev/null \
  || fail "repository MinIO SDK fixture validation failed"
sed -i 's#http://127.0.0.1:9000#https://storage.example.invalid#' "$fixture_dir/config.json"
if (cd "$repo_dir/backend/api" && T071_MINIO_FIXTURE_CONFIG="$fixture_dir/config.json" \
  node "$repo_dir/scripts/fixtures/t071_minio_fixture.mjs" --validate-only) >/dev/null 2>&1; then
  fail "MinIO fixture accepted a non-loopback endpoint"
fi
rm -rf -- "$fixture_dir"; fixture_dir=""

# Validate relay targeting without binding a listener: only an allowlisted service port
# and a usable private IPv4 address inside the inspected subnet are accepted.
relay_dir="$(mktemp -d)"; chmod 700 "$relay_dir"
cat >"$relay_dir/config.json" <<JSON
{"targetIp":"172.30.0.7","subnet":"172.30.0.0/24","targetPort":6379,"readyFile":"$relay_dir/ready.json"}
JSON
chmod 600 "$relay_dir/config.json"
T071_RELAY_CONFIG="$relay_dir/config.json" python3 "$repo_dir/scripts/fixtures/t071_loopback_relay.py" --validate-only >/dev/null \
  || fail "valid owned-network relay configuration was rejected"
sed -i 's/172.30.0.7/198.51.100.7/' "$relay_dir/config.json"
if T071_RELAY_CONFIG="$relay_dir/config.json" python3 "$repo_dir/scripts/fixtures/t071_loopback_relay.py" --validate-only >/dev/null 2>&1; then
  fail "relay accepted a target outside its owned private subnet"
fi
sed -i 's/198.51.100.7/172.30.0.7/; s/"targetPort":6379/"targetPort":22/' "$relay_dir/config.json"
if T071_RELAY_CONFIG="$relay_dir/config.json" python3 "$repo_dir/scripts/fixtures/t071_loopback_relay.py" --validate-only >/dev/null 2>&1; then
  fail "relay accepted a target port outside the fixture allowlist"
fi
rm -rf -- "$relay_dir"; relay_dir=""

# Validation is exact: both URLs must independently be loopback HTTP(S) URLs with ports.
node "$repo_dir/scripts/fixtures/t071_validate_local_url.mjs" 'http://127.0.0.1:3100' >/dev/null
node "$repo_dir/scripts/fixtures/t071_validate_local_url.mjs" 'http://localhost:4100' >/dev/null
for unsafe in 'https://example.invalid/127.0.0.1' 'http://127.0.0.1.evil:9' 'file://127.0.0.1:9/x' 'http://localhost' 'http://[::1]:9'; do
  if node "$repo_dir/scripts/fixtures/t071_validate_local_url.mjs" "$unsafe" >/dev/null 2>&1; then
    fail "unsafe URL accepted: $unsafe"
  fi
done

grep -qF 'page.route(' "$repo_dir/frontend/tests/e2e-live/t071-billing-admin.live.spec.ts" \
  && fail "live browser test must not intercept BFF/API routes"
grep -qF 'locator(KEYCLOAK_PASSWORD_SELECTOR).fill' "$repo_dir/frontend/tests/e2e-live/t071-billing-admin.live.spec.ts" \
  || fail "live Keycloak login does not use the DOM-tested password selector"
grep -qF 'getByLabel(/password/i).fill' "$repo_dir/frontend/tests/e2e-live/t071-billing-admin.live.spec.ts" \
  && fail "broad password label matcher is strict-mode ambiguous in Keycloak 26"
grep -qF 'getByLabel(/^Password$/i).fill' "$repo_dir/frontend/tests/e2e-live/t071-billing-admin.live.spec.ts" \
  && fail "disproven exact-label password matcher remains in the live fixture"
grep -qF "waitForResponse((response) =>" "$repo_dir/frontend/tests/e2e-live/t071-billing-admin.live.spec.ts" \
  || fail "live UI fixture does not synchronize with and validate the real review-queue response"
grep -qF "window.fetch('/api/internal/auth/logout', { method: 'POST' })" "$repo_dir/frontend/tests/e2e-live/t071-billing-admin.live.spec.ts" \
  || fail "logout race must originate in the browser so the real same-origin CSRF header is present"
grep -qF "page.request.post('/api/internal/auth/logout')" "$repo_dir/frontend/tests/e2e-live/t071-billing-admin.live.spec.ts" \
  && fail "APIRequestContext logout omits the browser Origin and only proves a CSRF 403"
grep -qF "getByTestId('billing-review-background').locator('button').first().focus()" "$repo_dir/frontend/tests/e2e-live/t071-billing-admin.live.spec.ts" \
  || fail "inert background control must be selected structurally for the focus-containment probe"
grep -qF "getByTestId('billing-review-background').getByRole('button')" "$repo_dir/frontend/tests/e2e-live/t071-billing-admin.live.spec.ts" \
  && fail "accessibility role queries intentionally omit controls inside the inert background"
grep -qF 'const focusOrder = note ? [textbox, confirm, cancel] : [confirm, cancel];' "$repo_dir/frontend/tests/e2e-live/t071-billing-admin.live.spec.ts" \
  || fail "live dialog test does not model the distinct approve and note-dialog tab orders"
grep -qF 'const replacementPromise = page.waitForResponse((response) =>' "$repo_dir/frontend/tests/e2e-live/t071-billing-admin.live.spec.ts" \
  || fail "decision helper does not synchronize with the real post-decision queue replacement"
grep -qF "import en from '../../src/locales/en/common.json';" "$repo_dir/frontend/tests/e2e-live/t071-billing-admin.live.spec.ts" \
  || fail "live journey does not source its English assertions from the shipped catalog"
grep -qF 'getByText(/awaiting the customer/i)' "$repo_dir/frontend/tests/e2e-live/t071-billing-admin.live.spec.ts" \
  && fail "live journey contains invented MoreInfoRequested copy"
grep -qF 'getByText(/outcome is unknown/i)' "$repo_dir/frontend/tests/e2e-live/t071-billing-admin.live.spec.ts" \
  && fail "live journey contains invented unknown-outcome copy"
node - "$repo_dir/frontend/tests/e2e-live/t071-billing-admin.live.spec.ts" <<'NODE'
const source = require('node:fs').readFileSync(process.argv[2], 'utf8');
const expired = source.indexOf('expect(expiredReplay.status()).toBe(401)');
const fresh = source.indexOf('const freshAdminToken = await passwordToken', expired);
const conflict = source.indexOf('authorization: `Bearer ${freshAdminToken}`', fresh);
if (!(expired >= 0 && fresh > expired && conflict > fresh)) {
  console.error('FAIL: live fixture does not distinguish expired-token 401 from fresh-token terminal 409');
  process.exit(1);
}
NODE
echo "PASS: T071 harness stages safely, validates URLs exactly, and declares real-stack proof points."
