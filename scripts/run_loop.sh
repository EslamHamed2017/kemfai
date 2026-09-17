#!/usr/bin/env bash
# KEMFAI loop runner: implement -> review -> FIX-UNTIL-ACCEPT within one fire.
# - Up to TASKS task-slots per fire (default 2)
# - Up to ATTEMPTS tries per task (default 3): on rejection the reviewer's
#   verdict is fed straight back into the next attempt of the SAME task.
# - Stops and asks for owner attention only if a task is still rejected
#   after ATTEMPTS tries, or on skip/runner failure.
set -uo pipefail

TASKS=${TASKS:-2}
ATTEMPTS=${ATTEMPTS:-3}
LOCK=/tmp/kemfai_loop.lock
REPO=/home/hermesops/kemfai
KEMFAI_FIX_NOTE=""
export KEMFAI_FIX_NOTE

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "LOOP: another KEMFAI run is still active — skipping this fire."
  exit 0
fi

extract_verdict() {
  awk '/running independent Codex review/{flag=1} flag' | head -c 4000
}

DONE=0
STOPPED=""

for t in $(seq 1 "$TASKS"); do
  for a in $(seq 1 "$ATTEMPTS"); do
    echo "=== LOOP task-slot $t/$TASKS attempt $a/$ATTEMPTS ($(TZ=Asia/Dubai date '+%H:%M %Z')) ==="
    OUT=$(bash "$REPO/scripts/run_next_step.sh" 2>&1)
    EC=$?
    echo "$OUT"

    if [ $EC -ne 0 ]; then
      echo "LOOP: runner failed (exit $EC) — stopping."
      echo "SUMMARY: tasks_completed=$DONE; stop=runner_error"
      exit $EC
    fi
    if echo "$OUT" | grep -q "STATUS: SKIPPED"; then
      echo "LOOP: tick skipped (dirty tree) — stopping."
      echo "SUMMARY: tasks_completed=$DONE; stop=skipped"
      exit 0
    fi
    if echo "$OUT" | grep -q "Codex REJECTED"; then
      if [ "$a" -eq "$ATTEMPTS" ]; then
        echo "LOOP: task STILL REJECTED after $ATTEMPTS attempts — stopping for owner attention."
        echo "$OUT" | extract_verdict > /tmp/kemfai_last_rejection.txt
        echo "SUMMARY: tasks_completed=$DONE; stop=still_rejected_after_${ATTEMPTS}_attempts"
        exit 0
      fi
      KEMFAI_FIX_NOTE=$(echo "$OUT" | extract_verdict)
      export KEMFAI_FIX_NOTE
      echo "LOOP: rejected on attempt $a — retrying SAME task now with reviewer feedback."
      continue
    fi

    # accepted (review passed), or non-implement stage / no changes
    DONE=$((DONE+1))
    KEMFAI_FIX_NOTE=""
    export KEMFAI_FIX_NOTE
    break
  done
done

echo "LOOP: finished — tasks completed this fire: $DONE"
echo "SUMMARY: tasks_completed=$DONE"
