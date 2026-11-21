#!/usr/bin/env bash
# Offline regression for the T072 launcher. It must not invoke Docker or open listeners.
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
launcher="$repo_dir/scripts/test_t072_live.sh"
bash -n "$launcher"
python3 - "$launcher" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text()
required = (
    'docker volume create --label "$label" "$odoo_volume"',
    "odoo_config_path='/var/lib/odoo/.kemfai-t072.conf'",
    "printf '%s\\n' \"$odoo_config\" | docker run --rm -i --label \"$label\"",
    "umask 077; cat > /var/lib/odoo/.kemfai-t072.conf",
    "stat -c %a /var/lib/odoo/.kemfai-t072.conf",
    '-v "$odoo_volume:/var/lib/odoo"',
    'docker run --rm --entrypoint odoo --label "$label" --network "$network"',
    'docker run --rm -i --entrypoint odoo --label "$label" --network "$network"',
    'docker run -d --entrypoint odoo --label "$label" --name "$odoo"',
    'capture_failure_diagnostics "$status"',
    "docker inspect --format '{{json .State}}'",
    'running={{.State.Running}} exit_code={{.State.ExitCode}} oom_killed={{.State.OOMKilled}}',
    'docker logs "$resource_id" 2>&1 | redact_stream',
    'chmod 600 "$state_file" "$log_file"',
    'pg_isready -h /var/run/postgresql -p 5432',
    "pg_readiness=\"$artifacts_dir/pg-readiness.log\"",
    'python3 -I "$repo_dir/scripts/fixtures/t071_owned_session_exec.py" --hold-for-cleanup --keep-env T071_RELAY_CONFIG',
)
for marker in required:
    if marker not in text:
        raise SystemExit(f'FAIL: missing secure Odoo config marker: {marker}')
if text.index('docker volume create --label "$label" "$odoo_volume"') > text.index(
    "printf '%s\\n' \"$odoo_config\" | docker run --rm -i --label \"$label\""
):
    raise SystemExit('FAIL: Odoo config is written before its exact-labelled volume exists')
if text.count('--entrypoint odoo') != 3:
    raise SystemExit('FAIL: every bootstrap/shell/server Odoo command must bypass the image wrapper')
for forbidden in (
    '--user root', '--user 0', '/etc/odoo/odoo.conf:ro', 'chmod 644',
    'odoo:18 odoo -c', 'odoo:18 odoo shell', '.Config.Env',
    'exec setsid python3 "$repo_dir/scripts/fixtures/t071_loopback_relay.py"',
):
    if forbidden in text:
        raise SystemExit(f'FAIL: insecure Odoo config transport reintroduced: {forbidden}')
cleanup = text[text.index('cleanup() {'):text.index('trap cleanup EXIT INT TERM')]
capture_at = cleanup.index('capture_failure_diagnostics')
for destructive in ('docker rm -fv', 'docker network ls', 'docker volume ls'):
    if capture_at > cleanup.index(destructive):
        raise SystemExit(f'FAIL: diagnostics occur after destructive cleanup: {destructive}')
for inspect_line in (line for line in text.splitlines() if 'docker inspect' in line):
    if '--format' not in inspect_line and ' -f ' not in inspect_line:
        raise SystemExit(f'FAIL: unrestricted docker inspect is forbidden: {inspect_line}')
if '2>&1 | redact_stream >"$log_file"' not in text:
    raise SystemExit('FAIL: retained container logs do not pass through secret redaction')
print('PASS: T072 launcher preserves redacted pre-cleanup diagnostics and secure Odoo startup')
PY


# A registration failure before setsid must clean only the exact pinned positive PID.
# It must neither report success with an orphan nor signal the caller's session.
pre_session_pid=""
cleanup_pre_session_probe() {
  [ -z "$pre_session_pid" ] || kill -KILL -- "$pre_session_pid" 2>/dev/null || true
}
trap cleanup_pre_session_probe EXIT
declare -A owned_pid_starttime=() owned_pid_session=()
fail() { echo "FAIL: $*" >&2; exit 1; }
source "$repo_dir/scripts/fixtures/t071_process_lifecycle.sh"
sleep 30 &
pre_session_pid=$!
read -r pre_session_start _ < <(process_identity "$pre_session_pid")
owned_pid_starttime["$pre_session_pid"]="$pre_session_start"
owned_pid_session["$pre_session_pid"]=""
terminate_owned_process_group "$pre_session_pid" sleep \
  || fail "pre-session exact-PID cleanup returned failure"
for _ in $(seq 1 100); do
  kill -0 "$pre_session_pid" 2>/dev/null || break
  sleep .01
done
if kill -0 "$pre_session_pid" 2>/dev/null; then
  fail "pre-session exact-PID cleanup left its pinned child alive"
fi
wait "$pre_session_pid" 2>/dev/null || true
pre_session_pid=""
trap - EXIT
echo "PASS: pre-session cleanup terminates only the exact pinned process"


# Force the reviewed check-to-signal interleaving: the first legacy TERM helper call
# makes the pinned pre-session process fork before delivering TERM to its parent.
race_dir="$(mktemp -d)"
race_parent=""; race_child=""; unrelated_pid=""
cleanup_pre_session_race_probe() {
  [ -z "$race_child" ] || kill -KILL -- "$race_child" 2>/dev/null || true
  [ -z "$race_parent" ] || kill -KILL -- "$race_parent" 2>/dev/null || true
  [ -z "$unrelated_pid" ] || kill -KILL -- "$unrelated_pid" 2>/dev/null || true
  rm -rf -- "$race_dir"
}
trap cleanup_pre_session_race_probe EXIT
python3 "$repo_dir/scripts/fixtures/t071_pre_session_fork_probe.py" \
  "$race_dir/ready" "$race_dir/child" &
race_parent=$!
sleep 30 & unrelated_pid=$!
for _ in $(seq 1 100); do [ -s "$race_dir/ready" ] && break; sleep .01; done
[ -s "$race_dir/ready" ] || fail "pre-session race fixture did not become ready"
read -r race_start _ < <(process_identity "$race_parent")
owned_pid_starttime["$race_parent"]="$race_start"
owned_pid_session["$race_parent"]=""
# Override only the obsolete signal boundary. A safe implementation freezes and
# revalidates instead, so this hook is never reached and the fixture cannot fork.
signal_owned_pid() {
  local target="$1"
  if kill -0 "$target" 2>/dev/null; then
    kill -USR1 -- "$target"
    for _ in $(seq 1 100); do [ -s "$race_dir/child" ] && break; sleep .01; done
    [ -s "$race_dir/child" ] || return 2
    kill -TERM -- "$target"
    return 0
  fi
  return 3
}
terminate_owned_process_group "$race_parent" t071_pre_session_fork_probe.py \
  || fail "frozen pre-session race cleanup returned failure"
if [ -s "$race_dir/child" ]; then
  read -r race_child <"$race_dir/child"
  if kill -0 "$race_child" 2>/dev/null; then
    fail "pre-session cleanup returned success with orphan child $race_child"
  fi
fi
kill -0 "$unrelated_pid" 2>/dev/null \
  || fail "pre-session cleanup signaled an unrelated process"
wait "$race_parent" 2>/dev/null || true
kill -KILL -- "$unrelated_pid" 2>/dev/null || true
wait "$unrelated_pid" 2>/dev/null || true
race_parent=""; race_child=""; unrelated_pid=""
rm -rf -- "$race_dir"
trap - EXIT
echo "PASS: frozen pre-session cleanup closes the fork window without unrelated signaling"


# A service descendant that creates a new session remains owned by the authenticated
# subreaper and must not survive cleanup.
cross_session_file="$(mktemp)"
cross_session_leader=""
cross_session_child=""
cleanup_cross_session_probe() {
  [ -z "$cross_session_child" ] || kill -KILL -- "$cross_session_child" 2>/dev/null || true
  [ -z "$cross_session_leader" ] || kill -KILL -- "$cross_session_leader" 2>/dev/null || true
  rm -f -- "$cross_session_file"
}
trap cleanup_cross_session_probe EXIT
PROBE_FILE="$cross_session_file" python3 -I "$repo_dir/scripts/fixtures/t071_owned_session_exec.py" \
  --hold-for-cleanup --keep-env PROBE_FILE python3 -c '
import os, pathlib, time
child = os.fork()
if child == 0:
    os.setsid()
    pathlib.Path(os.environ["PROBE_FILE"]).write_text(str(os.getpid()) + "\n")
    time.sleep(30)
os._exit(0)
' &
cross_session_leader=$!
register_owned_process "$cross_session_leader" python3
for _ in $(seq 1 100); do [ -s "$cross_session_file" ] && break; sleep .02; done
[ -s "$cross_session_file" ] || fail "cross-session fixture did not report its child"
read -r cross_session_child <"$cross_session_file"
terminate_owned_process_group "$cross_session_leader" python3 \
  || fail "cross-session owned cleanup returned failure"
for _ in $(seq 1 100); do
  kill -0 "$cross_session_child" 2>/dev/null || break
  sleep .01
done
if kill -0 "$cross_session_child" 2>/dev/null; then
  fail "cross-session owned descendant survived cleanup"
fi
wait "$cross_session_leader" 2>/dev/null || true
cross_session_leader=""; cross_session_child=""
rm -f -- "$cross_session_file"
trap - EXIT
echo "PASS: cross-session descendants remain supervised and cleanable"


# Compatibility: an unchanged direct setsid launcher may lose ancestry when an
# intermediate exits. Its live same-session orphan must still be authenticated and
# terminated before the owned leader is released.
direct_orphan_file="$(mktemp)"
direct_orphan_leader=""; direct_orphan_child=""
cleanup_direct_orphan_probe() {
  if [ -n "$direct_orphan_child" ] && kill -0 "$direct_orphan_child" 2>/dev/null; then
    echo "TEST CLEANUP: terminating surviving direct-session orphan $direct_orphan_child" >&2
    kill -KILL -- "$direct_orphan_child" 2>/dev/null || true
  fi
  [ -z "$direct_orphan_leader" ] || kill -KILL -- "$direct_orphan_leader" 2>/dev/null || true
  [ -z "$direct_orphan_leader" ] || wait "$direct_orphan_leader" 2>/dev/null || true
  rm -f -- "$direct_orphan_file"
}
trap cleanup_direct_orphan_probe EXIT
python3 "$repo_dir/scripts/fixtures/t071_direct_session_orphan.py" "$direct_orphan_file" &
direct_orphan_leader=$!
register_owned_process "$direct_orphan_leader" t071_direct_session_orphan.py
for _ in $(seq 1 100); do [ -s "$direct_orphan_file" ] && break; sleep .02; done
[ -s "$direct_orphan_file" ] || fail "direct-session fixture did not report its orphan"
read -r direct_orphan_child direct_orphan_parent <"$direct_orphan_file"
read -r direct_orphan_start direct_orphan_session < <(process_identity "$direct_orphan_child")
[ "$direct_orphan_session" = "$direct_orphan_leader" ] \
  || fail "direct-session fixture orphan escaped its immutable session"
[ "$direct_orphan_parent" != "$direct_orphan_leader" ] \
  || fail "direct-session fixture did not move outside leader ancestry"
terminate_owned_process_group "$direct_orphan_leader" t071_direct_session_orphan.py \
  || fail "direct-session orphan cleanup returned failure"
for _ in $(seq 1 100); do
  kill -0 "$direct_orphan_child" 2>/dev/null || break
  sleep .01
done
if kill -0 "$direct_orphan_child" 2>/dev/null; then
  fail "direct-session same-session orphan survived cleanup: $direct_orphan_child"
fi
wait "$direct_orphan_leader" 2>/dev/null || true
direct_orphan_leader=""; direct_orphan_child=""
rm -f -- "$direct_orphan_file"
trap - EXIT
echo "PASS: direct-session orphan is extinct before its authenticated leader"
