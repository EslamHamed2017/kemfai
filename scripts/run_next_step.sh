#!/usr/bin/env bash
# KEMFAI - Autonomous SpecKit runner
# Decides which SpecKit stage to run next based on files present, runs it via
# Claude Code non-interactively, commits, and prints a short status brief.
set -euo pipefail

REPO=/home/hermesops/kemfai
FEATURE_DIR="$REPO/specs/001-saas-onboarding-shell"
STATE="$REPO/scripts/.state"
LOG_DIR="$REPO/scripts/logs"
mkdir -p "$LOG_DIR" "$STATE"
TS=$(TZ=Asia/Dubai date '+%Y-%m-%d %H:%M %Z')
LOG="$LOG_DIR/$(TZ=Asia/Dubai date +%Y%m%d-%H%M).log"

cd "$REPO"

# --- decide next stage ---
next=""
if   [ ! -f "$FEATURE_DIR/tasks.md" ];    then next="tasks"
elif [ ! -f "$FEATURE_DIR/analysis.md" ]; then next="analyze"
else next="implement"
fi

echo "[$TS] next stage: $next" | tee -a "$LOG"

# --- guard: keep main runnable / clean tree required for a fresh commit ---
if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
  echo "[$TS] working tree dirty (tracked or untracked); skipping this tick" | tee -a "$LOG"
  echo "STATUS: SKIPPED (dirty tree)"
  exit 0
fi

# Snapshot the clean reviewed baseline. Executors are never allowed to make
# durable commits themselves; any such commit is converted back to a working-tree
# diff before independent review.
BASE_HEAD=$(git rev-parse HEAD)

# --- pick command per stage ---
case "$next" in
  tasks)
    PROMPT='/speckit-tasks Generate the tasks list for specs/001-saas-onboarding-shell. Honor the ratified constitution and the locked stack in docs/GATE0_DECISIONS.md (Next.js frontend, NestJS BFF, Odoo 18 Community with kemfai_* modules only, PostgreSQL DB-per-tenant, Keycloak, MinIO, OmniRoute). Break work into small independently deliverable vertical slices with Task ID, dependencies, acceptance criteria, and Primary/Backup/Reviewer roles per AGENTS.md. Trial/entitlement values remain admin-configurable (FR-030a). Follow the installed SpecKit tasks skill exactly.'
    MSG='docs: generate SpecKit tasks for Slice 1'
    ;;
  analyze)
    PROMPT='/speckit-analyze Run the SpecKit analyze pass on specs/001-saas-onboarding-shell against the ratified constitution. Report only genuine inconsistencies between constitution, spec, plan, contracts, data model and tasks. Do not implement code. IMPORTANT: after producing the report you MUST write it to specs/001-saas-onboarding-shell/analysis.md so the pipeline can advance; the file must contain the findings table and the date of the run.'
    MSG='docs: SpecKit analyze pass for Slice 1'
    ;;
  implement)
    PROMPT='/speckit-implement Execute the NEXT single unblocked task from specs/001-saas-onboarding-shell/tasks.md. Rules: honor the ratified constitution (no Odoo core edits, DB-per-tenant, EN/AR from Day 1, deterministic accounting, config-driven entitlements/trial, feature flags gate incomplete modules). Implement a small vertical slice WITH its tests, run those tests, and only mark the task done in tasks.md if they actually pass. State the Task ID you implemented on the first line of your final message. If the task is genuinely ambiguous on a business/product decision, do NOT guess: stop and append a short Decision Request to docs/PROGRESS.md and say so.'
    MSG='feat: SpecKit implement tick'
    REVIEW=1
    ;;
esac

# --- fix-until-accept: feed last reviewer verdict back into the same task ---
if [ -n "${KEMFAI_FIX_NOTE:-}" ]; then
  PROMPT="IMPORTANT: The previous attempt at this task was REJECTED by independent review. Fix the issues below and complete the SAME task properly (do not skip to another task). Reviewer verdict to address:\n\n${KEMFAI_FIX_NOTE}\n\n---\n${PROMPT}"
fi

# --- run executor with bounded time + real provider fallback ---
# Codex is primary because its output is the acceptance baseline; Gemini is intentionally excluded.
# OpenCode may return exit 0 even when the provider reports a quota/stream error,
# so both the exit code AND output text are checked. Every failed executor is
# rolled back before the next provider starts, preventing mixed partial edits.
EXECUTOR_TIMEOUT=${KEMFAI_EXECUTOR_TIMEOUT:-1800}
EXECUTOR_ORDER="codex glm claude" # fixed policy: ignore stale cron overrides
EXECUTOR=""
OUT=""
EC=1

provider_failed_in_output() {
  printf '%s' "$1" | grep -qiE \
    "you.ve hit your .*limit|weekly/monthly limit exhausted|session limit .*resets|ai_apicallerror|oauth session expired|failed to authenticate|unexpected server error|selected model is at capacity|status.?429|stream error"
}

# Persist short circuit-breakers across cron ticks. Subscription limits are not
# helped by retrying every two hours, and repeated failures waste both time and
# quota on the remaining providers.
COOLDOWN_DIR="$REPO/scripts/.state/provider-cooldowns"
mkdir -p "$COOLDOWN_DIR"

provider_cooldown_remaining() {
  local candidate="$1" file="$COOLDOWN_DIR/$candidate.until" now until
  [ -f "$file" ] || return 1
  now=$(date +%s)
  until=$(tr -cd '0-9' < "$file")
  [ -n "$until" ] || return 1
  if [ "$until" -gt "$now" ]; then
    echo $((until - now))
    return 0
  fi
  rm -f "$file"
  return 1
}

mark_provider_cooldown() {
  local candidate="$1" output="$2" seconds=1800
  if printf '%s' "$output" | grep -qiE 'weekly/monthly limit exhausted|weekly .*limit'; then
    seconds=43200
  elif printf '%s' "$output" | grep -qiE 'oauth session expired|failed to authenticate'; then
    seconds=21600
  elif printf '%s' "$output" | grep -qiE 'session limit .*resets|you.ve hit your .*limit'; then
    seconds=7200
  fi
  printf '%s\n' "$(( $(date +%s) + seconds ))" > "$COOLDOWN_DIR/$candidate.until"
  echo "$seconds"
}

rollback_partial_executor_work() {
  # The initial guard guarantees there were no pre-existing untracked files.
  # Always restore BASE_HEAD as an executor may have committed and left a clean tree.
  if [ "$(git rev-parse HEAD)" != "$BASE_HEAD" ] || ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
    git reset --hard "$BASE_HEAD" >/dev/null 2>&1
    git clean -fd >/dev/null 2>&1
  fi
}

for candidate in $EXECUTOR_ORDER; do
  if remaining=$(provider_cooldown_remaining "$candidate"); then
    echo "[$TS] skipping executor $candidate: circuit breaker active for ${remaining}s" | tee -a "$LOG"
    continue
  fi
  echo "[$TS] trying executor: $candidate (timeout ${EXECUTOR_TIMEOUT}s)" | tee -a "$LOG"
  set +e
  case "$candidate" in
    codex)
      OUT=$(timeout --signal=TERM --kill-after=30s "${EXECUTOR_TIMEOUT}s" \
        codex exec --dangerously-bypass-approvals-and-sandbox "$PROMPT" 2>&1)
      EC=$?
      ;;
    glm)
      OUT=$(timeout --signal=TERM --kill-after=30s "${EXECUTOR_TIMEOUT}s" \
        opencode run --auto -m zai-coding/glm-5.2 "$PROMPT" 2>&1)
      EC=$?
      ;;
    claude)
      OUT=$(timeout --signal=TERM --kill-after=30s "${EXECUTOR_TIMEOUT}s" \
        claude -p "$PROMPT" \
          --permission-mode acceptEdits \
          --allowedTools 'Read,Write,Edit,Glob,Grep,Bash' \
          --output-format text 2>&1)
      EC=$?
      ;;
    *)
      OUT="unknown executor: $candidate"
      EC=64
      ;;
  esac
  set -e

  if [ $EC -eq 0 ] && ! provider_failed_in_output "$OUT"; then
    EXECUTOR="$candidate"
    export KEMFAI_EXECUTOR="$EXECUTOR"
    rm -f "$COOLDOWN_DIR/$candidate.until"
    echo "[$TS] executor succeeded: $EXECUTOR" | tee -a "$LOG"
    break
  fi

  if [ $EC -eq 124 ] || [ $EC -eq 137 ]; then
    echo "[$TS] executor $candidate timed out after ${EXECUTOR_TIMEOUT}s" | tee -a "$LOG"
  else
    echo "[$TS] executor $candidate unavailable/failed (exit $EC)" | tee -a "$LOG"
  fi
  if provider_failed_in_output "$OUT"; then
    cooldown=$(mark_provider_cooldown "$candidate" "$OUT")
    echo "[$TS] circuit breaker set for $candidate (${cooldown}s)" | tee -a "$LOG"
  fi
  EC=75
  rollback_partial_executor_work
done

if [ -z "$EXECUTOR" ]; then
  echo "[$TS] all executors failed this tick" | tee -a "$LOG"
fi

# Some coding agents obey repository-level instructions to commit. Undo only the
# commit boundary (keep every file change) so independent review still happens.
if [ -n "$EXECUTOR" ] && [ "$(git rev-parse HEAD)" != "$BASE_HEAD" ]; then
  echo "[$TS] executor created commit(s); converting them back to uncommitted changes for review" | tee -a "$LOG"
  git reset --mixed "$BASE_HEAD" >/dev/null
fi

echo "$OUT" | tee -a "$LOG" >/dev/null
echo "[$TS] executor: ${EXECUTOR:-none}; exit: $EC" | tee -a "$LOG"

# --- safety: never let a stage repeat forever silently ---
if [ "$next" = "analyze" ] && [ ! -f "$FEATURE_DIR/analysis.md" ]; then
  {
    echo "# Slice 1 Analyze Report (captured by runner)"
    echo
    echo "Run: $TS"
    echo "Note: Claude did not write analysis.md itself; runner captured its output below."
    echo
    echo '```'
    echo "$OUT"
    echo '```'
  } > "$FEATURE_DIR/analysis.md"
  echo "[$TS] runner captured analyze output into analysis.md" | tee -a "$LOG"
fi

# --- commit only reviewed work: on failed implement, revert partial changes ---
if [ "$next" = "implement" ] && [ $EC -ne 0 ]; then
  if [ "$(git rev-parse HEAD)" != "$BASE_HEAD" ] || ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
    echo "[$TS] implement stage failed (exit $EC) — restoring reviewed baseline" | tee -a "$LOG"
    git reset --hard "$BASE_HEAD" >/dev/null 2>&1
    git clean -fd >/dev/null 2>&1
  fi
fi

# --- independent review by Codex (no model approves its own work) ---
if [ "${REVIEW:-0}" = "1" ] && [ $EC -eq 0 ]; then
  if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
    echo "[$TS] running independent Codex review of implement tick" | tee -a "$LOG"
    set +e
    REVIEW_OUT=$(bash scripts/codex_review.sh 2>&1)
    REVIEW_EXIT=$?
    set -e
    echo "$REVIEW_OUT" | tee -a "$LOG"
    if [ $REVIEW_EXIT -eq 2 ]; then
      echo "[$TS] Codex REJECTED - reverting working tree" | tee -a "$LOG"
      git reset --hard HEAD >/dev/null 2>&1
      git clean -fd >/dev/null 2>&1
      {
        echo ""
        echo "## Rejected implement tick - $TS"
        echo ""
        echo "Codex rejected the last implement attempt and working tree was reverted. Reviewer verdict:"
        echo ""
        echo '```'
        echo "$REVIEW_OUT" | tail -50
        echo '```'
      } >> docs/PROGRESS.md
      git add docs/PROGRESS.md
      git -c user.email='eslam.berkawy@gmail.com' -c user.name='Eslam El Berkawy' \
        commit -m "docs: record rejected implement tick ($TS)" >/dev/null 2>&1 || true
      echo "[$TS] Exiting after rejection" | tee -a "$LOG"
      exit 0
    elif [ $REVIEW_EXIT -ne 0 ]; then
      echo "[$TS] independent review unavailable (exit $REVIEW_EXIT) — reverting; no unreviewed commit allowed" | tee -a "$LOG"
      git reset --hard HEAD >/dev/null 2>&1
      git clean -fd >/dev/null 2>&1
      exit $REVIEW_EXIT
    fi
  fi
fi


CHANGED=""
if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
  git add -A
  if git -c user.email='eslam.berkawy@gmail.com' -c user.name='Eslam El Berkawy' \
       commit -m "$MSG" >/dev/null 2>&1; then
    CHANGED=$(git log -1 --oneline)
  fi
fi

# --- an implement tick is successful only when a reviewed commit exists ---
if [ "$next" = "implement" ] && [ -z "$CHANGED" ]; then
  echo "STATUS: FAILED (no reviewed commit produced)" | tee -a "$LOG"
  exit 4
fi

# --- final brief printed to stdout (delivered by cron) ---
TAIL=$(echo "$OUT" | tail -8)
{
  echo "KEMFAI autonomous tick — $TS"
  echo "Stage: $next"
  echo "Exit:  $EC"
  if [ -n "$CHANGED" ]; then
    echo "Commit: $CHANGED"
  else
    echo "Commit: (no changes)"
  fi
  echo "---"
  echo "Executor output (tail):"
  echo "$TAIL"
  echo "---"
  echo "Log: $LOG"
} | tee -a "$LOG"
