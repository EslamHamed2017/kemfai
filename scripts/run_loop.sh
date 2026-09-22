#!/usr/bin/env bash
# KEMFAI loop runner: implement -> review -> FIX-UNTIL-ACCEPT within one fire.
#
# Durable Claude<->Codex technical-resolution loop (see AGENTS.md):
# - Current task identity, rejection feedback, and arbiter resolutions are
#   persisted in scripts/.state/ so the SAME task resumes across fires, not
#   just across attempts within a single fire.
# - Ordinary technical/architecture/schema/API/localization/migration/test
#   ambiguity never stops the loop for owner attention: a rejection's exact
#   Codex blockers (or the executor's own technical question) are fed back
#   to the SAME task; once the SAME task racks up ARBITER_AFTER setbacks,
#   Codex is invoked as an independent technical arbiter for one concrete
#   resolution, which is then fed back to the SAME task.
# - Only KEMFAI_OWNER_ESCALATION -- a material product scope/behavior
#   change, accounting/tax policy, legal/compliance exposure, or a
#   locked-baseline change -- raised by the executor or upheld by the
#   arbiter, stops the loop for real owner attention.
# - Up to TASKS task-slots per fire (default 1), up to ATTEMPTS tries per
#   task per fire (default 2). Exhausting ATTEMPTS on an ordinary technical
#   setback ends only THIS fire; the SAME task resumes automatically next
#   fire because its identity and setback state persist on disk.
set -uo pipefail

REPO=${KEMFAI_REPO:-/home/hermesops/kemfai}
TASKS=${TASKS:-1}
ATTEMPTS=${ATTEMPTS:-2}
ARBITER_AFTER=${ARBITER_AFTER:-2}
LOCK=${KEMFAI_LOOP_LOCK:-/tmp/kemfai_loop.lock}
STATE="$REPO/scripts/.state"
mkdir -p "$STATE"
# shellcheck disable=SC1091
source "$REPO/scripts/lib_governance.sh"

CURRENT_TASK_FILE="$STATE/current_task.txt"
SETBACK_FILE="$STATE/setback_state.txt"
REJECTION_FILE="$STATE/last_rejection.txt"
RESOLUTION_FILE="$STATE/last_resolution.txt"

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "LOOP: another KEMFAI run is still active — skipping this fire."
  exit 0
fi

extract_verdict() {
  awk '/running independent Codex review/{flag=1} flag'
}

# extract_result_field OUTPUT MARKER -> value of the LAST "MARKER: value" line
extract_result_field() {
  printf '%s\n' "$1" | grep -oE "^${2}: .*$" | tail -1 | sed -E "s/^${2}: //"
}

clear_task_state() {
  rm -f "$CURRENT_TASK_FILE" "$SETBACK_FILE" "$REJECTION_FILE" "$RESOLUTION_FILE"
}

DONE=0

for t in $(seq 1 "$TASKS"); do
  for a in $(seq 1 "$ATTEMPTS"); do
    echo "=== LOOP task-slot $t/$TASKS attempt $a/$ATTEMPTS ($(TZ=Asia/Dubai date '+%H:%M %Z')) ==="

    KEMFAI_PINNED_TASK=""
    [ -s "$CURRENT_TASK_FILE" ] && KEMFAI_PINNED_TASK=$(cat "$CURRENT_TASK_FILE")
    export KEMFAI_PINNED_TASK
    if [ -n "$KEMFAI_PINNED_TASK" ]; then
      echo "LOOP: resuming pinned task $KEMFAI_PINNED_TASK (persisted across ticks)."
    fi

    # Arbiter resolutions take priority over raw rejection/question feedback;
    # never send both for the same attempt. Both files are atomically keyed
    # to the task id they were written for (write_task_keyed_state /
    # read_task_keyed_state, lib_governance.sh) and validated here against
    # the CURRENTLY pinned task -- a stale (different-task), partial, or
    # hand-edited file can never be fed into this attempt: it simply fails
    # the key check and reads as empty, no matter how or why it was written.
    KEMFAI_ARBITER_RESOLUTION=""
    if [ -n "$KEMFAI_PINNED_TASK" ]; then
      KEMFAI_ARBITER_RESOLUTION=$(read_task_keyed_state "$RESOLUTION_FILE" "$KEMFAI_PINNED_TASK" || true)
    fi
    export KEMFAI_ARBITER_RESOLUTION

    KEMFAI_FIX_NOTE=""
    if [ -z "$KEMFAI_ARBITER_RESOLUTION" ] && [ -n "$KEMFAI_PINNED_TASK" ]; then
      KEMFAI_FIX_NOTE=$(read_task_keyed_state "$REJECTION_FILE" "$KEMFAI_PINNED_TASK" || true)
    fi
    export KEMFAI_FIX_NOTE

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

    RESULT=$(extract_result_field "$OUT" "KEMFAI_RESULT")
    RESULT_TASK_ID=$(extract_result_field "$OUT" "KEMFAI_RESULT_TASK_ID")
    RESULT_DETAIL=$(extract_result_field "$OUT" "KEMFAI_RESULT_DETAIL")

    if [ "$RESULT" = "ACCEPTED" ]; then
      DONE=$((DONE+1))
      clear_task_state
      echo "LOOP: task ${RESULT_TASK_ID:-unknown} accepted — state cleared."
      break
    fi

    if [ "$RESULT" = "OWNER_ESCALATION" ]; then
      echo "LOOP: OWNER ESCALATION for ${RESULT_TASK_ID:-unknown} — ${RESULT_DETAIL:-see docs/PROGRESS.md}. Stopping for real owner attention."
      clear_task_state
      echo "SUMMARY: tasks_completed=$DONE; stop=owner_escalation"
      exit 0
    fi

    if [ "$RESULT" = "TECH_QUESTION" ] || [ "$RESULT" = "PIN_VIOLATION" ] || [ "$RESULT" = "REJECTED" ]; then
      # Ordinary technical setback. Normalize NONE (no progress reported) the
      # same as UNKNOWN (malformed/missing id): neither is a real task
      # identity, so neither may be keyed, persisted, or inherit/pollute a
      # real task's setback streak.
      CURRENT_ID="${RESULT_TASK_ID:-UNKNOWN}"
      [ "$CURRENT_ID" = "NONE" ] && CURRENT_ID="UNKNOWN"

      read -r STORED_ID STORED_COUNT < <(read_setback_state "$SETBACK_FILE")
      read -r NEW_COUNT SHOULD_PERSIST < <(compute_setback "$STORED_ID" "$STORED_COUNT" "$CURRENT_ID")

      if [ "$SHOULD_PERSIST" = "yes" ]; then
        write_setback_state "$SETBACK_FILE" "$CURRENT_ID" "$NEW_COUNT" "$RESULT"
        printf '%s\n' "$CURRENT_ID" > "$CURRENT_TASK_FILE"
        if [ "$RESULT" = "REJECTED" ]; then
          REJ_CONTENT=$(echo "$OUT" | extract_verdict)
        else
          REJ_CONTENT=$(printf 'Task %s — %s\n' "$CURRENT_ID" "${RESULT_DETAIL:-$RESULT}")
        fi
        write_task_keyed_state "$REJECTION_FILE" "$CURRENT_ID" "$REJ_CONTENT"
        rm -f "$RESOLUTION_FILE"
        echo "LOOP: setback #$NEW_COUNT for task $CURRENT_ID ($RESULT) — persisted feedback for SAME task."
      else
        echo "LOOP: setback with no resolvable task id (result=$RESULT) — not persisted/keyed, retrying without state changes."
      fi

      if [ "$SHOULD_PERSIST" = "yes" ] && [ "$NEW_COUNT" -ge "$ARBITER_AFTER" ]; then
        echo "LOOP: task $CURRENT_ID setback #$NEW_COUNT >= ARBITER_AFTER=$ARBITER_AFTER — invoking Codex as independent technical arbiter."
        # No `set -e` is active in this script, so the plain assignment below
        # already captures a non-zero exit without needing a set +e/-e guard
        # (which would otherwise leak `-e` on permanently from this point).
        ARBITER_OUT=$(bash "$REPO/scripts/codex_arbiter.sh" "$CURRENT_ID" "$REJECTION_FILE" 2>&1)
        ARBITER_EC=$?
        echo "$ARBITER_OUT"
        if [ $ARBITER_EC -eq 0 ]; then
          write_task_keyed_state "$RESOLUTION_FILE" "$CURRENT_ID" "$ARBITER_OUT"
          rm -f "$REJECTION_FILE"
          write_setback_state "$SETBACK_FILE" "$CURRENT_ID" "0" "RESOLVED"
          echo "LOOP: arbiter RESOLVED task $CURRENT_ID — resolution persisted, retrying SAME task."
        elif [ $ARBITER_EC -eq 2 ]; then
          # An arbiter ESCALATE is never trusted on its own -- exactly like
          # an executor's KEMFAI_OWNER_ESCALATION marker, its content must
          # classify against the same four real categories
          # (classify_owner_escalation, lib_governance.sh). An arbiter that
          # mislabels an ordinary technical blocker as ESCALATE must not be
          # able to stop the loop for owner attention; it is downgraded to
          # an ordinary technical setback and the SAME task keeps retrying.
          if ARBITER_CATEGORY=$(classify_owner_escalation "$ARBITER_OUT"); then
            echo "LOOP: arbiter judged this an OWNER ESCALATION ($ARBITER_CATEGORY) for $CURRENT_ID — stopping for real owner attention."
            TS=$(TZ=Asia/Dubai date '+%Y-%m-%d %H:%M %Z')
            {
              echo ""
              echo "## OWNER ESCALATION via arbiter - $TS"
              echo ""
              echo "Task ID: $CURRENT_ID"
              echo "Category: $ARBITER_CATEGORY"
              echo '```'
              echo "$ARBITER_OUT" | tail -50
              echo '```'
            } >> "$REPO/docs/PROGRESS.md"
            (cd "$REPO" && git add docs/PROGRESS.md && \
              git -c user.email='eslam.berkawy@gmail.com' -c user.name='Eslam El Berkawy' \
                commit -m "docs: arbiter owner escalation for $CURRENT_ID ($TS)" >/dev/null 2>&1 || true)
            clear_task_state
            echo "SUMMARY: tasks_completed=$DONE; stop=owner_escalation_via_arbiter"
            exit 0
          else
            echo "LOOP: arbiter ESCALATE for $CURRENT_ID did not classify into a real owner-escalation category (product scope, accounting/tax, legal/compliance, or locked baseline) — treating as an ordinary technical setback, continuing SAME task."
          fi
        else
          echo "LOOP: arbiter unavailable (exit $ARBITER_EC) — keeping setback state, will retry a later tick."
        fi
      fi

      if [ "$a" -eq "$ATTEMPTS" ]; then
        echo "LOOP: bounded attempts ($ATTEMPTS) reached this fire for an ordinary technical setback — NOT stopping for owner. SAME task (${CURRENT_ID}) resumes next fire."
        echo "SUMMARY: tasks_completed=$DONE; stop=attempts_bounded_this_fire; task=${CURRENT_ID}"
        exit 0
      fi
      echo "LOOP: retrying SAME task now (attempt $((a+1))/$ATTEMPTS)."
      continue
    fi

    # Non-implement stage, no changes, or an unrecognized result: nothing to
    # retry -- move on.
    echo "LOOP: tick completed with no actionable setback (result='${RESULT:-none}')."
    DONE=$((DONE+1))
    break
  done
done

echo "LOOP: finished — tasks completed this fire: $DONE"
echo "SUMMARY: tasks_completed=$DONE"
