#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
runner="$repo_dir/scripts/test_t071_live.sh"
stage="$(mktemp)"
probe_pid=""
delayed_probe_pid=""
registration_failure_pid_file=""
pidfd_probe_pid=""
freeze_failure_pid=""
freeze_failure_dir=""
transition_supervisor=""
transition_child=""
leaf_violation_parent=""
leaf_violation_child=""
leaf_violation_file=""
cross_group_parent=""
cross_group_child=""
cross_group_child_start=""
cross_group_file=""
exited_service_leader=""
exited_service_child=""
exited_service_child_start=""
exited_service_file=""
private_home=""
fixture_dir=""
relay_dir=""
relay_supervisor=""
startup_signal_dir=""
startup_signal_supervisor=""
post_leaf_race_dir=""
post_leaf_race_supervisor=""
post_leaf_race_child=""
kill_boundary_race_dir=""
kill_boundary_race_supervisor=""
kill_boundary_race_child=""
non_utf8_leader=""
non_utf8_child=""
non_utf8_file=""
offline_cleanup() {
  [ -z "$probe_pid" ] || kill -KILL -- "-$probe_pid" 2>/dev/null || true
  [ -z "$delayed_probe_pid" ] || kill -KILL -- "-$delayed_probe_pid" 2>/dev/null || kill -KILL -- "$delayed_probe_pid" 2>/dev/null || true
  [ -z "$registration_failure_pid_file" ] || rm -f -- "$registration_failure_pid_file"
  [ -z "$pidfd_probe_pid" ] || kill -KILL -- "$pidfd_probe_pid" 2>/dev/null || true
  [ -z "$freeze_failure_pid" ] || kill -KILL -- "$freeze_failure_pid" 2>/dev/null || true
  [ -z "$freeze_failure_dir" ] || rm -rf -- "$freeze_failure_dir"
  [ -z "$transition_child" ] || kill -KILL -- "$transition_child" 2>/dev/null || true
  [ -z "$transition_supervisor" ] || kill -KILL -- "$transition_supervisor" 2>/dev/null || true
  [ -z "$leaf_violation_child" ] || kill -KILL -- "$leaf_violation_child" 2>/dev/null || true
  [ -z "$leaf_violation_parent" ] || kill -KILL -- "$leaf_violation_parent" 2>/dev/null || true
  [ -z "$leaf_violation_file" ] || rm -f -- "$leaf_violation_file"
  [ -z "$cross_group_child" ] || signal_owned_pid "$cross_group_child" "$cross_group_child_start" KILL 2>/dev/null || true
  [ -z "$cross_group_parent" ] || signal_owned_pid "$cross_group_parent" "${owned_pid_starttime[$cross_group_parent]:-}" KILL 2>/dev/null || true
  [ -z "$cross_group_file" ] || rm -f -- "$cross_group_file"
  [ -z "$exited_service_child" ] || signal_owned_pid "$exited_service_child" "$exited_service_child_start" KILL 2>/dev/null || true
  [ -z "$exited_service_leader" ] || signal_owned_pid "$exited_service_leader" "${owned_pid_starttime[$exited_service_leader]:-}" KILL 2>/dev/null || true
  [ -z "$exited_service_file" ] || rm -f -- "$exited_service_file"
  [ -z "$private_home" ] || rmdir "$private_home" 2>/dev/null || true
  [ -z "$fixture_dir" ] || rm -rf -- "$fixture_dir"
  [ -z "$relay_supervisor" ] || terminate_owned_process_group "$relay_supervisor" t071_loopback_relay.py 2>/dev/null || true
  [ -z "$relay_dir" ] || rm -rf -- "$relay_dir"
  [ -z "$startup_signal_supervisor" ] || terminate_owned_process_group "$startup_signal_supervisor" sleep 2>/dev/null || true
  [ -z "$startup_signal_dir" ] || rm -rf -- "$startup_signal_dir"
  [ -z "$post_leaf_race_child" ] || kill -KILL -- "$post_leaf_race_child" 2>/dev/null || true
  [ -z "$post_leaf_race_supervisor" ] || kill -KILL -- "$post_leaf_race_supervisor" 2>/dev/null || true
  [ -z "$post_leaf_race_dir" ] || rm -rf -- "$post_leaf_race_dir"
  [ -z "$kill_boundary_race_child" ] || kill -KILL -- "$kill_boundary_race_child" 2>/dev/null || true
  [ -z "$kill_boundary_race_supervisor" ] || kill -KILL -- "$kill_boundary_race_supervisor" 2>/dev/null || true
  [ -z "$kill_boundary_race_dir" ] || rm -rf -- "$kill_boundary_race_dir"
  if [ -n "$non_utf8_leader" ] && [ -n "${owned_pid_starttime[$non_utf8_leader]:-}" ]; then
    terminate_owned_process_group "$non_utf8_leader" t071-non-utf8-descendant 2>/dev/null || true
  fi
  [ -z "$non_utf8_file" ] || rm -f -- "$non_utf8_file"
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
[ "$(grep -cF 't071_owned_session_exec.py' "$stage")" -eq 4 ] || fail "every owned host service must use the owned session supervisor"
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
set +e
python3 "$repo_dir/scripts/fixtures/t071_owned_session_exec.py" sh -c 'exit 7'
supervisor_exit=$?
set -e
[ "$supervisor_exit" -eq 7 ] || fail "owned session supervisor did not preserve service exit status"
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

# Cleanup is idempotent after the authenticated owned session has already exited
# naturally. An absent leader is safe only when the recorded session has no survivors.
python3 "$repo_dir/scripts/fixtures/t071_owned_session_exec.py" sleep 1 &
naturally_exited_leader=$!
register_owned_process "$naturally_exited_leader" sleep
naturally_exited_session="${owned_pid_session[$naturally_exited_leader]}"
wait "$naturally_exited_leader"
[ -z "$(session_survivors "$naturally_exited_session")" ] \
  || fail "naturally exited owned session retained a survivor"
terminate_owned_process_group "$naturally_exited_leader" sleep \
  || fail "cleanup rejected an already-extinct owned session"

# Kernel process names are byte strings. A non-UTF-8 comm must not disappear from
# session membership or cleanup scans.
non_utf8_file="$(mktemp)"
PROBE_FILE="$non_utf8_file" python3 "$repo_dir/scripts/fixtures/t071_owned_session_exec.py" \
  --keep-env PROBE_FILE python3 -c 'exec("import ctypes,os,time\npid=os.fork()\nif pid:\n open(os.environ[\"PROBE_FILE\"],\"w\").write(str(pid)+\"\\n\")\n time.sleep(.2)\n os._exit(0)\nctypes.CDLL(None).prctl(15, ctypes.c_char_p(b\"bad\\xffname\"), 0, 0, 0)\ntime.sleep(30) # t071-non-utf8-descendant")' &
non_utf8_leader=$!
register_owned_process "$non_utf8_leader" t071-non-utf8-descendant
for _ in $(seq 1 100); do [ -s "$non_utf8_file" ] && break; sleep .02; done
[ -s "$non_utf8_file" ] || fail "non-UTF-8 session fixture did not report its child"
read -r non_utf8_child <"$non_utf8_file"
sleep .3
kill -0 "$non_utf8_leader" 2>/dev/null \
  || fail "owned supervisor lost a live descendant with a non-UTF-8 process name"
terminate_owned_process_group "$non_utf8_leader" t071-non-utf8-descendant \
  || fail "cleanup rejected a non-UTF-8 owned-session member"
[ -z "$(session_survivors "${owned_pid_session[$non_utf8_leader]}")" ] \
  || fail "non-UTF-8 owned-session member survived cleanup"
wait "$non_utf8_leader" 2>/dev/null || true
non_utf8_leader=""; non_utf8_child=""
rm -f -- "$non_utf8_file"; non_utf8_file=""
echo "PASS: non-UTF-8 process names remain supervised and cleanable"

# Termination during the fork-to-handler startup window must remain pending until
# the supervisor can forward it. sitecustomize deterministically pauses pidfd_open
# after the service fork but before signal handlers are installed.
startup_signal_dir="$(mktemp -d)"
cat >"$startup_signal_dir/sitecustomize.py" <<'PY_STARTUP_SIGNAL'
import os
import pathlib
import time

_original_pidfd_open = os.pidfd_open

def paused_pidfd_open(pid):
    marker = pathlib.Path(os.environ["KEMFAI_STARTUP_SIGNAL_MARKER"])
    marker.write_text(str(pid) + "\n")
    release = marker.with_suffix(".release")
    for _ in range(3000):
        if release.exists():
            break
        time.sleep(0.01)
    else:
        raise TimeoutError("startup signal test was not released")
    return _original_pidfd_open(pid)

os.pidfd_open = paused_pidfd_open
PY_STARTUP_SIGNAL
startup_signal_marker="$startup_signal_dir/paused"
PYTHONPATH="$startup_signal_dir" KEMFAI_STARTUP_SIGNAL_MARKER="$startup_signal_marker" \
  python3 "$repo_dir/scripts/fixtures/t071_owned_session_exec.py" \
    --keep-env KEMFAI_STARTUP_SIGNAL_MARKER sleep 30 &
startup_signal_supervisor=$!
register_owned_process "$startup_signal_supervisor" sleep
for _ in $(seq 1 500); do [ -s "$startup_signal_marker" ] && break; sleep .01; done
[ -s "$startup_signal_marker" ] || fail "startup-signal fixture did not reach the pre-handler window"
read -r startup_signal_child <"$startup_signal_marker"
kill -TERM "$startup_signal_supervisor"
: >"$startup_signal_marker.release"
for _ in $(seq 1 500); do
  if ! kill -0 "$startup_signal_child" 2>/dev/null; then break; fi
  sleep .01
done
if kill -0 "$startup_signal_child" 2>/dev/null; then
  fail "termination during supervisor startup orphaned the service child"
fi
set +e
wait "$startup_signal_supervisor"
startup_signal_status=$?
set -e
[ "$startup_signal_status" -eq 143 ] \
  || fail "startup-signal supervisor returned unexpected status: $startup_signal_status"
startup_signal_supervisor=""
rm -rf -- "$startup_signal_dir"; startup_signal_dir=""

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

# The authenticated session leader must remain alive while any service descendant
# survives, even when the directly executed service process exits first. Otherwise
# cleanup cannot safely distinguish that owned orphan session from a reused SID.
exited_service_file="$(mktemp)"
python3 "$repo_dir/scripts/fixtures/t071_owned_session_exec.py" python3 -c '
import os, pathlib, sys, time
child = os.fork()
if child == 0:
    os.setpgid(0, 0)
    time.sleep(30)
else:
    pathlib.Path(sys.argv[1]).write_text(str(child) + "\n")
' "$exited_service_file" &
exited_service_leader=$!
register_owned_process "$exited_service_leader" python3
for _ in $(seq 1 50); do [ -s "$exited_service_file" ] && break; sleep .02; done
[ -s "$exited_service_file" ] || fail "exited-service fixture did not start"
read -r exited_service_child <"$exited_service_file"
exited_service_child_identity="$(process_identity "$exited_service_child")"
read -r exited_service_child_start _ <<<"$exited_service_child_identity"
sleep .1
kill -0 "$exited_service_leader" 2>/dev/null \
  || fail "owned session leader exited while a service descendant survived"
terminate_owned_process_group "$exited_service_leader" python3 \
  || fail "owned session with an exited service process did not terminate"
[ -z "$(session_survivors "${owned_pid_session[$exited_service_leader]}")" ] \
  || fail "exited-service owned session survivor remained"
wait "$exited_service_leader" 2>/dev/null || true
exited_service_leader=""; exited_service_child=""; exited_service_child_start=""
rm -f -- "$exited_service_file"; exited_service_file=""

# The real relay readiness contract must expose the registered supervisor identity,
# not the forked service PID, so the generated launcher can authenticate it.
relay_dir="$(mktemp -d)"; chmod 700 "$relay_dir"
relay_config="$relay_dir/config.json"; relay_ready="$relay_dir/ready.json"
printf '{"targetIp":"10.0.0.2","subnet":"10.0.0.0/24","targetPort":5432,"readyFile":"%s"}\n'   "$relay_ready" >"$relay_config"; chmod 600 "$relay_config"
(
  export T071_RELAY_CONFIG="$relay_config"
  exec python3 "$repo_dir/scripts/fixtures/t071_owned_session_exec.py"     --keep-env T071_RELAY_CONFIG python3 "$repo_dir/scripts/fixtures/t071_loopback_relay.py"
) &
relay_supervisor=$!
register_owned_process "$relay_supervisor" t071_loopback_relay.py
for _ in $(seq 1 50); do [ -s "$relay_ready" ] && break; sleep .02; done
[ -s "$relay_ready" ] || fail "supervised relay did not publish readiness"
relay_ready_pid="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pid"])' "$relay_ready")"
[ "$relay_ready_pid" = "$relay_supervisor" ]   || fail "supervised relay readiness did not identify its registered leader"
terminate_owned_process_group "$relay_supervisor" t071_loopback_relay.py   || fail "supervised relay session did not terminate"
[ -z "$(session_survivors "${owned_pid_session[$relay_supervisor]}")" ]   || fail "supervised relay session survivor remained"
wait "$relay_supervisor" 2>/dev/null || true
relay_supervisor=""; rm -rf -- "$relay_dir"; relay_dir=""

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

# If authenticated inspection fails after SIGSTOP, cleanup must return failure only
# after restoring SIGCONT so the caller never inherits a stranded stopped process.
freeze_failure_dir="$(mktemp -d)"
cat >"$freeze_failure_dir/sitecustomize.py" <<'PY_FREEZE_FAILURE'
import os
import pathlib

_original_read_text = pathlib.Path.read_text
_target = os.environ["KEMFAI_FREEZE_FAILURE_STAT"]
_reads = 0

def fail_second_stat_read(path, *args, **kwargs):
    global _reads
    if str(path) == _target:
        _reads += 1
        if _reads == 2:
            raise OSError("injected post-stop stat failure")
    return _original_read_text(path, *args, **kwargs)

pathlib.Path.read_text = fail_second_stat_read
PY_FREEZE_FAILURE
sleep 30 &
freeze_failure_pid=$!
freeze_failure_identity="$(process_identity "$freeze_failure_pid")"
read -r freeze_failure_start _ <<<"$freeze_failure_identity"
if PYTHONPATH="$freeze_failure_dir" KEMFAI_FREEZE_FAILURE_STAT="/proc/$freeze_failure_pid/stat" \
  kill_frozen_owned_pre_session "$freeze_failure_pid" "$freeze_failure_start"; then
  fail "freeze failure injection unexpectedly succeeded"
fi
for _ in $(seq 1 100); do
  freeze_failure_state="$(python3 - "$freeze_failure_pid" <<'PY_FREEZE_STATE'
import pathlib, sys
try:
    raw = pathlib.Path('/proc', sys.argv[1], 'stat').read_text()
    print(raw[raw.rfind(')') + 2:].split()[0])
except (FileNotFoundError, ProcessLookupError):
    pass
PY_FREEZE_STATE
)"
  [ "$freeze_failure_state" != T ] && [ "$freeze_failure_state" != t ] && break
  sleep .01
done
[ "$freeze_failure_state" != T ] && [ "$freeze_failure_state" != t ] \
  || fail "failed frozen cleanup left its authenticated process stopped"
kill -KILL -- "$freeze_failure_pid" 2>/dev/null || true
wait "$freeze_failure_pid" 2>/dev/null || true
freeze_failure_pid=""; rm -rf -- "$freeze_failure_dir"; freeze_failure_dir=""

# Cleanup can begin after the pinned launcher has completed setsid/fork but before
# registration records the session. It must authenticate that transition and clean
# the whole newly owned session rather than treating its child as a leaf violation.
python3 "$repo_dir/scripts/fixtures/t071_owned_session_exec.py" sleep 30 &
transition_supervisor=$!
transition_identity="$(process_identity "$transition_supervisor")"
read -r transition_start _ <<<"$transition_identity"
for _ in $(seq 1 50); do
  transition_identity="$(process_identity "$transition_supervisor" 2>/dev/null || true)"
  transition_child="$(python3 - "$transition_supervisor" <<'PY_CHILD'
import pathlib, sys
try:
    print(pathlib.Path('/proc', sys.argv[1], 'task', sys.argv[1], 'children').read_text().strip())
except (FileNotFoundError, ProcessLookupError):
    pass
PY_CHILD
)"
  read -r _ transition_session <<<"$transition_identity"
  [ "$transition_session" = "$transition_supervisor" ] && [ -n "$transition_child" ] && break
  sleep .02
done
[ "$transition_session" = "$transition_supervisor" ] && [ -n "$transition_child" ]   || fail "owned-session transition fixture did not start"
owned_pid_starttime["$transition_supervisor"]="$transition_start"
owned_pid_session["$transition_supervisor"]=""
terminate_owned_process_group "$transition_supervisor" sleep   || fail "cleanup did not adopt the pinned pre-session to owned-session transition"
[ -z "$(session_survivors "$transition_supervisor")" ]   || fail "transitioned owned session survivor remained"
wait "$transition_supervisor" 2>/dev/null || true
transition_supervisor=""; transition_child=""

# A launcher can complete setsid/fork after the pre-session leaf check but before the
# first signal. Cleanup must adopt that late session transition instead of killing only
# its authenticated leader and leaving a TERM-resistant service child behind.
post_leaf_race_dir="$(mktemp -d)"
cat >"$post_leaf_race_dir/sitecustomize.py" <<'PY_POST_LEAF_RACE'
import os
import pathlib
import time

_original_setsid = os.setsid
_marker = pathlib.Path(os.environ["KEMFAI_POST_LEAF_RACE_MARKER"])

def paused_setsid():
    _marker.write_text(str(os.getpid()) + "\n")
    release = _marker.with_suffix(".release")
    for _ in range(3000):
        if release.exists():
            return _original_setsid()
        time.sleep(0.01)
    raise TimeoutError("post-leaf transition test was not released")

os.setsid = paused_setsid
PY_POST_LEAF_RACE
post_leaf_race_marker="$post_leaf_race_dir/paused"
PYTHONPATH="$post_leaf_race_dir" KEMFAI_POST_LEAF_RACE_MARKER="$post_leaf_race_marker" \
  python3 "$repo_dir/scripts/fixtures/t071_owned_session_exec.py" python3 -c \
    'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)' &
post_leaf_race_supervisor=$!
for _ in $(seq 1 500); do [ -s "$post_leaf_race_marker" ] && break; sleep .01; done
[ -s "$post_leaf_race_marker" ] || fail "post-leaf transition fixture did not pause before setsid"
post_leaf_race_identity="$(process_identity "$post_leaf_race_supervisor")"
read -r post_leaf_race_start _ <<<"$post_leaf_race_identity"
owned_pid_starttime["$post_leaf_race_supervisor"]="$post_leaf_race_start"
owned_pid_session["$post_leaf_race_supervisor"]=""
original_signal_owned_pid_definition="$(declare -f signal_owned_pid)"
eval "${original_signal_owned_pid_definition/signal_owned_pid ()/post_leaf_race_signal_owned_pid ()}"
post_leaf_race_released=0
signal_owned_pid() {
  if [ "$post_leaf_race_released" -eq 0 ]; then
    post_leaf_race_released=1
    : >"$post_leaf_race_marker.release"
    for _ in $(seq 1 500); do
      post_leaf_race_identity="$(process_identity "$post_leaf_race_supervisor" 2>/dev/null || true)"
      post_leaf_race_child="$(python3 - "$post_leaf_race_supervisor" <<'PY_POST_LEAF_CHILD'
import pathlib, sys
try:
    print(pathlib.Path('/proc', sys.argv[1], 'task', sys.argv[1], 'children').read_text().strip())
except (FileNotFoundError, ProcessLookupError):
    pass
PY_POST_LEAF_CHILD
)"
      read -r _ post_leaf_race_session <<<"$post_leaf_race_identity"
      [ "$post_leaf_race_session" = "$post_leaf_race_supervisor" ] && [ -n "$post_leaf_race_child" ] && break
      sleep .01
    done
    [ "$post_leaf_race_session" = "$post_leaf_race_supervisor" ] && [ -n "$post_leaf_race_child" ] \
      || fail "post-leaf transition fixture did not establish its owned child"
  fi
  post_leaf_race_signal_owned_pid "$@"
}
terminate_owned_process_group "$post_leaf_race_supervisor" python3 \
  || fail "cleanup rejected the post-leaf owned-session transition"
[ -z "$(session_survivors "$post_leaf_race_supervisor")" ] \
  || fail "post-leaf owned-session transition left a service survivor"
eval "$original_signal_owned_pid_definition"
wait "$post_leaf_race_supervisor" 2>/dev/null || true
post_leaf_race_supervisor=""; post_leaf_race_child=""
rm -rf -- "$post_leaf_race_dir"; post_leaf_race_dir=""

# The same transition at the final frozen-KILL boundary must be adopted safely.
kill_boundary_race_dir="$(mktemp -d)"
cat >"$kill_boundary_race_dir/sitecustomize.py" <<'PY_KILL_BOUNDARY_RACE'
import os
import pathlib
import time

_original_setsid = os.setsid
_marker = pathlib.Path(os.environ["KEMFAI_KILL_BOUNDARY_RACE_MARKER"])

def paused_setsid():
    _marker.write_text(str(os.getpid()) + "\n")
    release = _marker.with_suffix(".release")
    for _ in range(3000):
        if release.exists():
            return _original_setsid()
        time.sleep(0.01)
    raise TimeoutError("kill-boundary transition test was not released")

os.setsid = paused_setsid
PY_KILL_BOUNDARY_RACE
kill_boundary_race_marker="$kill_boundary_race_dir/paused"
PYTHONPATH="$kill_boundary_race_dir" KEMFAI_KILL_BOUNDARY_RACE_MARKER="$kill_boundary_race_marker" \
  python3 "$repo_dir/scripts/fixtures/t071_owned_session_exec.py" python3 -c \
    'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)' &
kill_boundary_race_supervisor=$!
for _ in $(seq 1 500); do [ -s "$kill_boundary_race_marker" ] && break; sleep .01; done
[ -s "$kill_boundary_race_marker" ] || fail "kill-boundary transition fixture did not pause before setsid"
kill_boundary_race_identity="$(process_identity "$kill_boundary_race_supervisor")"
read -r kill_boundary_race_start _ <<<"$kill_boundary_race_identity"
owned_pid_starttime["$kill_boundary_race_supervisor"]="$kill_boundary_race_start"
owned_pid_session["$kill_boundary_race_supervisor"]=""
original_kill_boundary_signal_definition="$(declare -f signal_owned_pid)"
eval "${original_kill_boundary_signal_definition/signal_owned_pid ()/kill_boundary_race_signal_owned_pid ()}"
signal_owned_pid() {
  [ "$3" = TERM ] && return 0
  kill_boundary_race_signal_owned_pid "$@"
}
original_kill_frozen_definition="$(declare -f kill_frozen_owned_pre_session)"
eval "${original_kill_frozen_definition/kill_frozen_owned_pre_session ()/kill_boundary_race_frozen_kill ()}"
kill_frozen_owned_pre_session() {
  : >"$kill_boundary_race_marker.release"
  for _ in $(seq 1 500); do
    kill_boundary_race_identity="$(process_identity "$kill_boundary_race_supervisor" 2>/dev/null || true)"
    kill_boundary_race_child="$(python3 - "$kill_boundary_race_supervisor" <<'PY_KILL_BOUNDARY_CHILD'
import pathlib, sys
try:
    print(pathlib.Path('/proc', sys.argv[1], 'task', sys.argv[1], 'children').read_text().strip())
except (FileNotFoundError, ProcessLookupError):
    pass
PY_KILL_BOUNDARY_CHILD
)"
    read -r _ kill_boundary_race_session <<<"$kill_boundary_race_identity"
    [ "$kill_boundary_race_session" = "$kill_boundary_race_supervisor" ] && [ -n "$kill_boundary_race_child" ] && break
    sleep .01
  done
  [ "$kill_boundary_race_session" = "$kill_boundary_race_supervisor" ] && [ -n "$kill_boundary_race_child" ] \
    || fail "kill-boundary transition fixture did not establish its owned child: identity=${kill_boundary_race_identity:-missing} child=${kill_boundary_race_child:-missing}"
  kill_boundary_race_frozen_kill "$@"
}
terminate_owned_process_group "$kill_boundary_race_supervisor" python3 \
  || fail "cleanup rejected the KILL-boundary owned-session transition"
[ -z "$(session_survivors "$kill_boundary_race_supervisor")" ] \
  || fail "KILL-boundary owned-session transition left a service survivor"
eval "$original_kill_frozen_definition"
eval "$original_kill_boundary_signal_definition"
wait "$kill_boundary_race_supervisor" 2>/dev/null || true
kill_boundary_race_supervisor=""; kill_boundary_race_child=""
rm -rf -- "$kill_boundary_race_dir"; kill_boundary_race_dir=""

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
t074_runner="$repo_dir/scripts/test_t074_live_browser.sh"
grep -qF 't071_owned_session_exec.py" --keep-env T071_RELAY_CONFIG python3 "$repo_dir/scripts/fixtures/t071_loopback_relay.py"' "$t074_runner" \
  || fail "T074 relay does not use the owned session supervisor"
grep -qF 'exec setsid python3 "$repo_dir/scripts/fixtures/t071_loopback_relay.py"' "$t074_runner" \
  && fail "T074 relay reverted to the direct setsid launcher"
echo "PASS: T074 relay uses the owned session supervisor"

# Every production runner that imports the authenticated session cleanup helper
# must launch each process immediately preceding its registration through the
# supervisor. Discover callers so a future lifecycle user cannot escape this gate.
python3 - "$repo_dir" <<'PY_SUPERVISED_CALLERS'
import pathlib
import sys

scripts = pathlib.Path(sys.argv[1], "scripts")
expected = {
    "test_t071_live.sh",
    "test_t072_live.sh",
    "test_t074_live_browser.sh",
    "test_t109_odoo_exposure.sh",
    "test_t112_owned_fixture.sh",
}
callers = {
    path.name: path.read_text()
    for path in scripts.glob("*.sh")
    if "t071_process_lifecycle.sh" in path.read_text()
}
if set(callers) != expected:
    raise SystemExit(
        "FAIL: shared lifecycle caller inventory mismatch: "
        f"expected={sorted(expected)} discovered={sorted(callers)}"
    )
for name, source in callers.items():
    registrations = source.count("register_owned_process ")
    supervisors = source.count("t071_owned_session_exec.py")
    if registrations == 0:
        raise SystemExit(f"FAIL: shared lifecycle caller has no registration: {name}")
    if supervisors != registrations:
        raise SystemExit(
            f"FAIL: every registered process requires one owned supervisor in {name}: "
            f"supervisors={supervisors} registrations={registrations}"
        )
print("PASS: all discovered shared lifecycle callers supervise every registered process")
PY_SUPERVISED_CALLERS

# The fallback before setsid is observed must report escalation too. Pin the exact
# leaf identity as registration does, while intentionally keeping it pre-session.
pre_session_forced_kill=0
bash -c 'trap "" TERM; exec sleep 60' &
pre_session_forced_pid=$!
read -r pre_session_start _ < <(process_identity "$pre_session_forced_pid")
owned_pid_starttime["$pre_session_forced_pid"]="$pre_session_start"
owned_pid_session["$pre_session_forced_pid"]=""
terminate_owned_process_group "$pre_session_forced_pid" sleep pre_session_forced_kill \
  || fail "pre-session forced-kill reporting probe did not terminate"
[ "$pre_session_forced_kill" -eq 1 ] \
  || fail "pre-session cleanup did not report SIGKILL escalation"
echo "PASS: pre-session cleanup reports SIGKILL escalation"

# Callers that require graceful-only cleanup must be told when the shared helper
# escalates to SIGKILL, while callers without an output variable retain compatibility.
forced_kill_probe=0
python3 "$repo_dir/scripts/fixtures/t071_owned_session_exec.py" python3 -c \
  'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60) # t071-ignore-term' &
forced_kill_probe_pid=$!
register_owned_process "$forced_kill_probe_pid" t071-ignore-term
sleep 0.2
terminate_owned_process_group "$forced_kill_probe_pid" t071-ignore-term forced_kill_probe \
  || fail "forced-kill reporting probe did not terminate"
[ "$forced_kill_probe" -eq 1 ] \
  || fail "shared lifecycle helper did not report SIGKILL escalation"
echo "PASS: shared lifecycle helper reports SIGKILL escalation"

# The T109 API supervisor deliberately starts from a minimal environment, so every
# inherited disposable-service setting required by the child must be explicitly kept.
t109_runner="$repo_dir/scripts/test_t109_odoo_exposure.sh"
grep -qF -- '--keep-env CONTROL_DB_HOST,CONTROL_DB_PORT,CONTROL_DB_USER,CONTROL_DB_PASSWORD,CONTROL_DB_NAME,REDIS_URL' "$t109_runner" \
  || fail "T109 API supervisor drops its owned database/Redis environment"
echo "PASS: T109 API supervisor preserves owned database/Redis environment"

# T112 must use the authenticated session-wide cleanup implementation. Its former
# process-group-only wrapper leaked descendants that moved to another process group.
t112_runner="$repo_dir/scripts/test_t112_owned_fixture.sh"
grep -qF 'terminate_owned_process_group "$frontend_pid"' "$t112_runner" \
  || fail "T112 frontend cleanup does not terminate the complete owned session"
grep -qF 'terminate_owned_process_group "$api_pid"' "$t112_runner" \
  || fail "T112 API cleanup does not terminate the complete owned session"
grep -qF 'stop_owned_process()' "$t112_runner" \
  && fail "T112 retains unsafe process-group-only cleanup"
echo "PASS: T112 uses authenticated session-wide cleanup"

echo "PASS: T071 harness stages safely, validates URLs exactly, and declares real-stack proof points."
