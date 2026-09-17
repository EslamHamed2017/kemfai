#!/usr/bin/env bash
# KEMFAI batch runner: executes up to N sequential autonomous ticks (default 2).
# Stops early on: review rejection, skipped tick (dirty tree), or script failure.
# Uses flock so overlapping cron fires never run two builds concurrently.
set -uo pipefail

MAX_TICKS=${1:-2}
LOCK=/tmp/kemfai_batch.lock
REPO=/home/hermesops/kemfai

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "BATCH: another KEMFAI batch is still running — skipping this fire."
  exit 0
fi

for i in $(seq 1 "$MAX_TICKS"); do
  echo "=== BATCH tick $i/$MAX_TICKS ($(TZ=Asia/Dubai date '+%H:%M %Z')) ==="
  OUT=$(bash "$REPO/scripts/run_next_step.sh" 2>&1)
  EC=$?
  echo "$OUT"

  if [ $EC -ne 0 ]; then
    echo "BATCH: tick $i failed (exit $EC) — stopping batch."
    exit $EC
  fi
  if echo "$OUT" | grep -q "Codex REJECTED"; then
    echo "BATCH: tick $i was REJECTED by review — stopping batch (tree reverted)."
    exit 0
  fi
  if echo "$OUT" | grep -q "STATUS: SKIPPED"; then
    echo "BATCH: tick $i skipped (dirty tree) — stopping batch."
    exit 0
  fi
done

echo "BATCH: completed $MAX_TICKS ticks successfully."
