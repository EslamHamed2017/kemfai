#!/usr/bin/env bash
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
# shellcheck source=scripts/tests/lib_test_helpers.sh
. "$HERE/lib_test_helpers.sh"

gate="$REPO/scripts/check_docker_test_cleanup.py"
(
  cd "$REPO"
  python3 "$gate"
) >/dev/null
assert_eq "focused suite runs the actual repository static gate" 0 "$?"

tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
mkdir "$tmp/bin"
cat > "$tmp/bin/docker" <<'FAKE'
#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
exists="$(cat "$FAKE_DOCKER_STATE")"
network_exists="$(cat "$FAKE_NETWORK_STATE")"
if [ "${1:-}" = info ]; then
  exit 0
elif [ "${1:-}" = run ]; then
  printf 'present\n' > "$FAKE_DOCKER_STATE"
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --label ]; then printf '%s\n' "${2#*=}" > "$FAKE_CONTAINER_LABEL_FILE"; shift; fi
    shift
  done
  printf '%s\n' "$FAKE_DOCKER_ID"
  exit "${FAKE_RUN_STATUS:-0}"
elif [ "${1:-} ${2:-}" = "ps -aq" ]; then
  [ "${FAKE_LIST_FAIL:-0}" = 0 ] || exit 71
  if printf '%s\n' "$*" | grep -F 'volume=' >/dev/null && [ "${FAKE_VOLUME_ATTACHED:-0}" = 1 ]; then
    printf '%s\n' "$FAKE_NETWORK_ID"
  elif [ "$exists" = present ]; then
    printf '%s\n' "$FAKE_DOCKER_ID"
  fi
  exit 0
elif [ "${1:-}" = inspect ]; then
  [ "${FAKE_INSPECT_FAIL:-0}" = 0 ] || exit 72
  [ "$exists" = present ] || exit 1
  if printf '%s\n' "$*" | grep -F '.Mounts' >/dev/null; then
    printf '%s\n' "${FAKE_MOUNT_METADATA:-[]|[]|[]}" 
  else
    printf '%s %s\n' "$FAKE_DOCKER_ID" "${FAKE_DOCKER_LABEL:-$(cat "$FAKE_CONTAINER_LABEL_FILE")}" 
  fi
elif [ "${1:-} ${2:-}" = "rm -f" ]; then
  [ "${FAKE_RM_FAIL:-0}" = 0 ] || exit 73
  printf 'absent\n' > "$FAKE_DOCKER_STATE"
  [ "${FAKE_VOLUME_SURVIVES:-0}" = 1 ] || printf 'absent\n' > "$FAKE_VOLUME_STATE"
elif [ "${1:-} ${2:-}" = "volume inspect" ]; then
  [ "${FAKE_VOLUME_INSPECT_FAIL:-0}" = 0 ] || exit 78
  [ "$(cat "$FAKE_VOLUME_STATE")" = present ] || exit 1
  printf '%s\n' "$FAKE_VOLUME_ID"
elif [ "${1:-} ${2:-}" = "volume ls" ]; then
  [ "${FAKE_VOLUME_LIST_FAIL:-0}" = 0 ] || exit 79
  [ "$(cat "$FAKE_VOLUME_STATE")" = present ] && printf '%s\n' "$FAKE_VOLUME_ID"
  exit 0
elif [ "${1:-} ${2:-}" = "network ls" ]; then
  [ "${FAKE_NETWORK_LIST_FAIL:-0}" = 0 ] || exit 75
  [ "$network_exists" = present ] && printf '%s\n' "$FAKE_NETWORK_ID"
  exit 0
elif [ "${1:-} ${2:-}" = "network inspect" ]; then
  [ "${FAKE_NETWORK_INSPECT_FAIL:-0}" = 0 ] || exit 76
  [ "$network_exists" = present ] || exit 1
  printf '%s %s\n' "$FAKE_NETWORK_ID" "${FAKE_NETWORK_LABEL:-run1}"
elif [ "${1:-} ${2:-}" = "network rm" ]; then
  [ "${FAKE_NETWORK_RM_FAIL:-0}" = 0 ] || exit 77
  printf 'absent\n' > "$FAKE_NETWORK_STATE"
elif [ "${1:-}" = exec ]; then
  exit 0
else
  exit 74
fi
FAKE
chmod +x "$tmp/bin/docker"

export PATH="$tmp/bin:$PATH"
export FAKE_DOCKER_LOG="$tmp/docker.log" FAKE_DOCKER_STATE="$tmp/state"
export FAKE_NETWORK_STATE="$tmp/network-state" FAKE_CONTAINER_LABEL_FILE="$tmp/container-label"
export FAKE_VOLUME_STATE="$tmp/volume-state"
export FAKE_DOCKER_ID="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
export FAKE_NETWORK_ID="abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
export FAKE_VOLUME_ID="fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
printf 'absent\n' > "$FAKE_NETWORK_STATE"
printf 'absent\n' > "$FAKE_VOLUME_STATE"
printf 'run1\n' > "$FAKE_CONTAINER_LABEL_FILE"

run_helper() {
  local initial="$1"
  : > "$FAKE_DOCKER_LOG"
  # shellcheck source=scripts/lib_docker_test_cleanup.sh
  . "$REPO/scripts/lib_docker_test_cleanup.sh"
  kemfai_docker_cleanup_init kemfai.test.run run1
  kemfai_register_container_intent fixture
  kemfai_cleanup_owned_resources "$initial"
}

printf 'present\n' > "$FAKE_DOCKER_STATE"; export FAKE_DOCKER_LABEL=run1 FAKE_RM_FAIL=0
export FAKE_MOUNT_METADATA='[]|[]|[]' FAKE_VOLUME_SURVIVES=0 FAKE_VOLUME_LIST_FAIL=0 FAKE_VOLUME_INSPECT_FAIL=0 FAKE_VOLUME_ATTACHED=0
run_helper 0; status=$?
assert_eq "success cleanup succeeds" 0 "$status"
log="$(cat "$FAKE_DOCKER_LOG")"
assert_contains "immutable full id is deletion target" "$log" "rm -f -v $FAKE_DOCKER_ID"

export FAKE_MOUNT_METADATA="[{\"Type\":\"volume\",\"Name\":\"$FAKE_VOLUME_ID\",\"Source\":\"$FAKE_VOLUME_ID\",\"Destination\":\"/anon\"},{\"Type\":\"volume\",\"Name\":\"kept_named\",\"Source\":\"kept_named\",\"Destination\":\"/named\"},{\"Type\":\"bind\",\"Source\":\"/host\",\"Destination\":\"/bind\"}]|[\"kept_named:/named\",\"/host:/bind\"]|[]"
printf 'present\n' > "$FAKE_DOCKER_STATE"; printf 'present\n' > "$FAKE_VOLUME_STATE"
run_helper 0; status=$?
assert_eq "captured anonymous volume absence is verified" 0 "$status"
assert_contains "anonymous metadata is validated" "$(cat "$FAKE_DOCKER_LOG")" "volume inspect -f {{.Name}} $FAKE_VOLUME_ID"
assert_not_contains "named volume metadata is not treated as anonymous" "$(cat "$FAKE_DOCKER_LOG")" "volume inspect -f {{.Name}} kept_named"

printf 'present\n' > "$FAKE_DOCKER_STATE"; printf 'present\n' > "$FAKE_VOLUME_STATE"
export FAKE_VOLUME_SURVIVES=1
run_helper 0 >/dev/null 2>&1; status=$?
assert_eq "unexplained anonymous-volume survivor fails without explicit deletion" 1 "$status"
assert_not_contains "helper never explicitly removes a volume" "$(cat "$FAKE_DOCKER_LOG")" "volume rm"

printf 'present\n' > "$FAKE_DOCKER_STATE"; printf 'present\n' > "$FAKE_VOLUME_STATE"
export FAKE_VOLUME_ATTACHED=1
shared_output="$(run_helper 0 2>&1)"; status=$?
assert_eq "anonymous volume shared elsewhere remains a reported failure" 1 "$status"
assert_contains "shared anonymous survivor is explicitly preserved" "$shared_output" "remains attached elsewhere; preserving it"
assert_not_contains "shared anonymous survivor is never explicitly deleted" "$(cat "$FAKE_DOCKER_LOG")" "volume rm"
export FAKE_VOLUME_ATTACHED=0

printf 'present\n' > "$FAKE_DOCKER_STATE"; printf 'present\n' > "$FAKE_VOLUME_STATE"
export FAKE_VOLUME_SURVIVES=0 FAKE_VOLUME_LIST_FAIL=1
run_helper 0 >/dev/null 2>&1; status=$?
assert_eq "volume API listing failure is not mistaken for absence" 1 "$status"
export FAKE_VOLUME_LIST_FAIL=0 FAKE_MOUNT_METADATA='[]|[]|[]'

printf 'present\n' > "$FAKE_DOCKER_STATE"; export FAKE_DOCKER_LABEL=other
run_helper 0 >/dev/null 2>&1; status=$?
assert_eq "ownership mismatch fails closed" 1 "$status"
assert_not_contains "ownership mismatch never removes" "$(cat "$FAKE_DOCKER_LOG")" "rm -f"

printf 'present\n' > "$FAKE_DOCKER_STATE"; export FAKE_DOCKER_LABEL=run1 FAKE_LIST_FAIL=1
run_helper 0 >/dev/null 2>&1; status=$?
assert_eq "Docker listing failure fails closed" 1 "$status"
export FAKE_LIST_FAIL=0 FAKE_INSPECT_FAIL=1
run_helper 0 >/dev/null 2>&1; status=$?
assert_eq "Docker inspection failure fails closed" 1 "$status"
export FAKE_INSPECT_FAIL=0

printf 'absent\n' > "$FAKE_DOCKER_STATE"; printf 'present\n' > "$FAKE_NETWORK_STATE"
export FAKE_NETWORK_LABEL=other FAKE_NETWORK_RM_FAIL=0 FAKE_NETWORK_LIST_FAIL=0
. "$REPO/scripts/lib_docker_test_cleanup.sh"
kemfai_docker_cleanup_init kemfai.test.run run1
kemfai_register_network_intent fixture_net
: > "$FAKE_DOCKER_LOG"
kemfai_cleanup_owned_resources 0 >/dev/null 2>&1; status=$?
assert_eq "network ownership mismatch fails closed" 1 "$status"
assert_not_contains "network ownership mismatch never removes" "$(cat "$FAKE_DOCKER_LOG")" "network rm"
export FAKE_NETWORK_LABEL=run1 FAKE_NETWORK_RM_FAIL=1
kemfai_cleanup_owned_resources 0 >/dev/null 2>&1; status=$?
assert_eq "network removal failure fails closed" 1 "$status"
export FAKE_NETWORK_RM_FAIL=0 FAKE_NETWORK_LIST_FAIL=1
kemfai_cleanup_owned_resources 0 >/dev/null 2>&1; status=$?
assert_eq "network listing failure fails closed" 1 "$status"
export FAKE_NETWORK_LIST_FAIL=0
printf 'absent\n' > "$FAKE_NETWORK_STATE"

printf 'present\n' > "$FAKE_DOCKER_STATE"; export FAKE_DOCKER_LABEL=run1 FAKE_RM_FAIL=1
run_helper 0 >/dev/null 2>&1; status=$?
assert_eq "deletion failure turns success into failure" 1 "$status"
printf 'present\n' > "$FAKE_DOCKER_STATE"
run_helper 42 >/dev/null 2>&1; status=$?
assert_eq "initial nonzero failure is preserved" 42 "$status"

printf 'absent\n' > "$FAKE_DOCKER_STATE"; export FAKE_RM_FAIL=0
run_helper 0; status=$?
assert_eq "registered partial creation with no container is safe" 0 "$status"

trap_harness="$tmp/trap-harness.sh"
cat > "$trap_harness" <<'HARNESS'
#!/usr/bin/env bash
set -uo pipefail
. "$HELPER"
kemfai_docker_cleanup_init kemfai.test.run run1
finish() { local status=$?; trap - EXIT; set +e; kemfai_cleanup_owned_resources "$status"; exit $?; }
trap finish EXIT
kemfai_install_cleanup_signal_traps
kemfai_register_container_intent fixture
docker run --name fixture --label kemfai.test.run=run1 fake:image >/dev/null
HARNESS
chmod +x "$trap_harness"
export HELPER="$REPO/scripts/lib_docker_test_cleanup.sh" FAKE_DOCKER_LABEL=run1
for pair in 0:0 42:42; do
  export FAKE_RUN_STATUS="${pair%%:*}"
  printf 'absent\n' > "$FAKE_DOCKER_STATE"; : > "$FAKE_DOCKER_LOG"
  bash "$trap_harness" >/dev/null 2>&1; status=$?
  assert_eq "actual EXIT trap preserves docker run status ${pair%%:*}" "${pair##*:}" "$status"
  assert_contains "actual EXIT trap removes materialized container after status ${pair%%:*}" \
    "$(cat "$FAKE_DOCKER_LOG")" "rm -f -v $FAKE_DOCKER_ID"
done
export FAKE_RUN_STATUS=0

signal_harness="$tmp/signal-harness.sh"
cat > "$signal_harness" <<'HARNESS'
#!/usr/bin/env bash
set -uo pipefail
. "$HELPER"
kemfai_docker_cleanup_init kemfai.test.run run1
kemfai_register_container_intent fixture
finish() { local status=$?; trap - EXIT; set +e; kemfai_cleanup_owned_resources "$status"; exit $?; }
trap finish EXIT
kemfai_install_cleanup_signal_traps
kill "-$1" "$$"
HARNESS
chmod +x "$signal_harness"
export HELPER="$REPO/scripts/lib_docker_test_cleanup.sh" FAKE_DOCKER_LABEL=run1 FAKE_RM_FAIL=0
for pair in INT:130 TERM:143; do
  signal="${pair%%:*}" expected="${pair##*:}"
  printf 'present\n' > "$FAKE_DOCKER_STATE"; : > "$FAKE_DOCKER_LOG"
  bash "$signal_harness" "$signal" >/dev/null 2>&1; status=$?
  assert_eq "$signal preserves conventional signal exit" "$expected" "$status"
  assert_contains "$signal runs volume cleanup" "$(cat "$FAKE_DOCKER_LOG")" "rm -f -v $FAKE_DOCKER_ID"
done

# Exercise the actual changed T055 entrypoint through its registration-before-run and
# EXIT trap. The fake run materializes a labelled container, then returns nonzero.
printf 'absent\n' > "$FAKE_DOCKER_STATE"; : > "$FAKE_DOCKER_LOG"
export FAKE_RUN_STATUS=42 FAKE_DOCKER_LABEL= FAKE_RM_FAIL=0
KEMFAI_ARTIFACTS_DIR="$tmp/t055-artifacts" bash "$REPO/scripts/test_t055_durable_handoff.sh" \
  >/dev/null 2>&1
status=$?
assert_eq "actual T055 preserves failed docker run status" 42 "$status"
assert_contains "actual T055 EXIT trap removes post-create survivor" "$(cat "$FAKE_DOCKER_LOG")" \
  "rm -f -v $FAKE_DOCKER_ID"
export FAKE_RUN_STATUS=0 FAKE_DOCKER_LABEL=run1

staged_t052="$tmp/staged-t052.sh"
KEMFAI_T052_VALIDATE_STAGE_ONLY=1 KEMFAI_T052_STAGE_OUTPUT="$staged_t052" \
  bash "$REPO/scripts/test_t052_live_browser.sh" >/dev/null 2>&1
status=$?
assert_eq "T052 stage-only validation succeeds offline" 0 "$status"
init_line="$(grep -nF 'kemfai_docker_cleanup_init "kemfai.t052.run" "$run_id"' "$staged_t052" | cut -d: -f1)"
trap_line="$(grep -nF 'kemfai_install_cleanup_signal_traps' "$staged_t052" | cut -d: -f1)"
register_line="$(grep -nF 'kemfai_register_container_intent "$module_scan_container"' "$staged_t052" | cut -d: -f1)"
run_line="$(grep -nF 'docker run --rm --name "$module_scan_container"' "$staged_t052" | cut -d: -f1)"
if [ "$init_line" -lt "$trap_line" ] && [ "$trap_line" -lt "$register_line" ] && \
   [ "$register_line" -lt "$run_line" ]; then order_status=0; else order_status=1; fi
assert_eq "T052 staged module scan follows helper init, traps, and intent registration" 0 "$order_status"

for pair in INT:130 TERM:143; do
  signal="${pair%%:*}" expected="${pair##*:}"
  signal_marker="$tmp/t052-signal-${signal}"
  KEMFAI_T052_VALIDATE_SIGNAL_FORWARDING=1 \
    KEMFAI_T052_SIGNAL_GRACE_SECONDS=5 KEMFAI_T052_SIGNAL_MARKER="$signal_marker" \
    python3 -c '
import os, signal, sys
signal.signal(signal.SIGINT, signal.SIG_DFL)
signal.signal(signal.SIGTERM, signal.SIG_DFL)
os.execvp(sys.argv[1], sys.argv[1:])
' bash "$REPO/scripts/test_t052_live_browser.sh" >/dev/null 2>&1 &
  wrapper_pid=$!
  ready=0
  for _ in $(seq 1 100); do
    if [ -f "$signal_marker.ready" ] && grep -qF READY "$signal_marker.ready"; then ready=1; break; fi
    if ! kill -0 "$wrapper_pid" 2>/dev/null; then break; fi
    sleep 0.05
  done
  assert_eq "T052 $signal forwarding hook becomes ready within deadline" 1 "$ready"
  if [ "$ready" -eq 1 ]; then
    kill -s "$signal" "$wrapper_pid"
  fi
  deadline=$((SECONDS + 8))
  while kill -0 "$wrapper_pid" 2>/dev/null && [ "$SECONDS" -lt "$deadline" ]; do sleep 0.05; done
  if kill -0 "$wrapper_pid" 2>/dev/null; then
    assert_eq "T052 $signal wrapper exits within bounded deadline" exited running
    kill -TERM "$wrapper_pid" 2>/dev/null || true
  else
    assert_eq "T052 $signal wrapper exits within bounded deadline" exited exited
  fi
  wait "$wrapper_pid"; status=$?
  assert_eq "T052 wrapper returns $expected after forwarded $signal" "$expected" "$status"
  marker_value="$(cat "$signal_marker.signal" 2>/dev/null || true)"
  assert_eq "T052 child receives forwarded $signal" "$signal" "$marker_value"
  child_pid_from_hook="$(cat "$signal_marker.pid" 2>/dev/null || true)"
  [ -z "$child_pid_from_hook" ] || ! kill -0 "$child_pid_from_hook" 2>/dev/null
  assert_eq "T052 $signal leaves no known child survivor" 0 "$?"
done

# The addon installer uses shared DB/network but owns only its uniquely-labelled Odoo
# one-shot. Prove a post-create client failure cleans that container and preserves status.
printf 'absent\n' > "$FAKE_DOCKER_STATE"; : > "$FAKE_DOCKER_LOG"
export FAKE_RUN_STATUS=43 FAKE_DOCKER_LABEL= FAKE_RM_FAIL=0
bash "$REPO/backend/addons/test-install.sh" >/dev/null 2>&1
status=$?
assert_eq "actual addon installer preserves failed docker run status" 43 "$status"
assert_contains "actual addon installer cleans only its owned one-shot" "$(cat "$FAKE_DOCKER_LOG")" \
  "rm -f -v $FAKE_DOCKER_ID"
assert_not_contains "addon installer never removes shared network" "$(cat "$FAKE_DOCKER_LOG")" "network rm"
export FAKE_RUN_STATUS=0 FAKE_DOCKER_LABEL=run1

good="$tmp/good.sh" bad="$tmp/bad.sh"
printf '%s\n' '#!/bin/sh' 'docker rm -fv "$id"' > "$good"
python3 "$gate" "$good" >/dev/null; assert_eq "static gate accepts combined volume flag" 0 "$?"
mutations=(
  'docker rm -f "$id"'
  'docker container rm --force "$id"'
  'docker rm --force "$id" || true'
  'command docker rm "$id" >/dev/null 2>&1'
  'docker rm -f "$id"; docker rm -fv "$other"'
  'docker rm -f "$id"; printf "%s" -v'
  'docker rm -fv "$id"; docker rm -f "$other"'
  'docker rm -f "$id" && docker rm -fv "$other"'
  'docker rm -fv "$id" || docker container rm -f "$other"'
  'docker rm -f "$id" | tee /dev/null'
  'value=$(docker rm -f "$id")'
  'docker rm -f -- "$id" -v'
  'docker --context test rm -f "$id"'
  'docker --host unix:///tmp/docker.sock container rm -f "$id"'
  'docker rm -fv "$id"; docker --context=test rm -f "$other"'
)
for mutation in "${mutations[@]}"; do
  printf '%s\n' '#!/bin/sh' "$mutation" > "$bad"
  python3 "$gate" "$bad" >/dev/null 2>&1; status=$?
  assert_eq "static gate rejects: $mutation" 1 "$status"
done

multi_good="$tmp/multi-good.sh"
printf '%s\n' '#!/bin/sh' 'docker rm -fv "$id"; docker container rm --force --volumes "$other"' > "$multi_good"
python3 "$gate" "$multi_good" >/dev/null
assert_eq "static gate accepts every safe removal on one line" 0 "$?"

global_good="$tmp/global-good.sh"
printf '%s\n' '#!/bin/sh' 'docker --context test rm -fv "$id"; docker -H unix:///tmp/docker.sock container rm --volumes "$other"' > "$global_good"
python3 "$gate" "$global_good" >/dev/null
assert_eq "static gate accepts safe removals with Docker global options" 0 "$?"

python_bad="$tmp/unsafe.py"
printf '%s\n' 'import os, subprocess' \
  'subprocess.run(["docker", "--context", "test", "rm", "-f", "cid"])' \
  'subprocess.Popen("docker container rm --force cid", shell=True)' \
  'subprocess.check_call(["docker", "rm", "-f", "cid"])' \
  'subprocess.check_output("docker rm -f cid", shell=True)' \
  'os.system("docker rm -f cid")' > "$python_bad"
python3 "$gate" "$python_bad" >/dev/null 2>&1; status=$?
assert_eq "static gate rejects literal unsafe Python Docker removals" 1 "$status"

python_good="$tmp/safe.py"
printf '%s\n' 'import os, subprocess' \
  'subprocess.run(["docker", "--context", "test", "rm", "-fv", "cid"])' \
  'subprocess.Popen("docker container rm --volumes cid", shell=True)' \
  'subprocess.check_call(["docker", "rm", "--volumes", "cid"])' \
  'subprocess.check_output("docker rm -fv cid", shell=True)' \
  'os.system("docker rm -v cid")' > "$python_good"
python3 "$gate" "$python_good" >/dev/null
assert_eq "static gate accepts covered literal safe Python removals" 0 "$?"

scratch_repo="$tmp/static-red-repo"
mkdir -p "$scratch_repo/scripts"
cp "$gate" "$scratch_repo/scripts/check_docker_test_cleanup.py"
printf '%s\n' '#!/bin/sh' 'docker rm -f "$future_id"' > "$scratch_repo/scripts/future-test.sh"
git -C "$scratch_repo" init -q
git -C "$scratch_repo" add scripts
(
  cd "$tmp"
  python3 "$scratch_repo/scripts/check_docker_test_cleanup.py"
) >/dev/null 2>&1
status=$?
assert_eq "default repository gate rejects an unsafe future script in isolated scratch repo" 1 "$status"

excluded_repo="$tmp/static-excluded-repo"
mkdir -p "$excluded_repo/scripts" "$excluded_repo/node_modules/pkg" "$excluded_repo/scratch"
cp "$gate" "$excluded_repo/scripts/check_docker_test_cleanup.py"
printf '%s\n' '#!/bin/sh' 'docker rm -fv "$owned"' > "$excluded_repo/scripts/safe.sh"
printf '%s\n' '#!/bin/sh' 'docker rm -f "$dependency"' > "$excluded_repo/node_modules/pkg/unsafe.sh"
printf '%s\n' '#!/bin/sh' 'docker rm -f "$scratch"' > "$excluded_repo/scratch/unsafe.sh"
git -C "$excluded_repo" init -q
git -C "$excluded_repo" add scripts
(
  cd "$tmp"
  python3 "$excluded_repo/scripts/check_docker_test_cleanup.py"
) >/dev/null 2>&1
status=$?
assert_eq "default gate excludes ignored dependency and explicit scratch trees" 0 "$status"

print_summary
