#!/usr/bin/env bash
# KEMFAI - Autonomous SpecKit runner
# Decides which SpecKit stage to run next based on files present, runs it via
# Claude Code non-interactively, commits, and prints a short status brief.
set -euo pipefail

REPO=${KEMFAI_REPO:-/home/hermesops/kemfai}
FEATURE_DIR="$REPO/specs/001-saas-onboarding-shell"
STATE="$REPO/scripts/.state"
LOG_DIR="$REPO/scripts/logs"
mkdir -p "$LOG_DIR" "$STATE"
# shellcheck disable=SC1091
source "$REPO/scripts/lib_governance.sh"
TS=$(TZ=Asia/Dubai date '+%Y-%m-%d %H:%M %Z')
LOG="$LOG_DIR/$(TZ=Asia/Dubai date +%Y%m%d-%H%M).log"

# Executor prompts are assembled on disk and fed via stdin/file attachment,
# never as a single argv string -- a large arbiter resolution or rejection
# note embedded literally in argv can exceed Linux's MAX_ARG_STRLEN (~128KB)
# and fail execve with E2BIG before the executor ever runs.
PROMPT_TMP_DIR=$(mktemp -d)
trap 'rm -rf "$PROMPT_TMP_DIR"' EXIT

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
    TASK_TARGET="Execute the NEXT single unblocked task from specs/001-saas-onboarding-shell/tasks.md."
    if [ -n "${KEMFAI_PINNED_TASK:-}" ]; then
      TASK_TARGET="Continue Task ID ${KEMFAI_PINNED_TASK}, which is already in progress from a prior attempt. Do NOT switch to a different task."
    fi
    PROMPT="/speckit-implement ${TASK_TARGET} Rules: honor the ratified constitution (no Odoo core edits, DB-per-tenant, EN/AR from Day 1, deterministic accounting, config-driven entitlements/trial, feature flags gate incomplete modules). Implement a small vertical slice WITH its tests, run those tests, and only mark the task done in tasks.md if they actually pass.

MANDATORY OUTPUT CONTRACT (machine-parsed, follow exactly):
- The FIRST LINE of your final message must be exactly one of:
  KEMFAI_TASK_ID: T### (the task id you worked, e.g. KEMFAI_TASK_ID: T036)
  KEMFAI_TASK_ID: NONE (if you made no implementation progress)
  Nothing may precede this line (no blank line, no markdown) and nothing may follow the ID on that line.
- Ordinary technical/architecture/schema/API/localization/migration/test ambiguity is NOT a reason to stop. Make the most reasonable technical decision yourself using the constitution, spec and tasks.md as authority, note the decision briefly, and proceed.
- Only if you genuinely cannot safely proceed without a firm technical decision, add this exact line elsewhere in your message (do not guess destructively):
  KEMFAI_TECH_QUESTION: <one specific, concrete question a technical arbiter can resolve>
- Only stop for OWNER attention when the blocker is one of: a material product scope/behavior change, accounting/tax policy, legal/compliance exposure, or a change to a LOCKED baseline decision (docs/GATE0_DECISIONS.md or the ratified constitution). In that case add this exact line:
  KEMFAI_OWNER_ESCALATION: <one-line summary of the scope/policy/legal/locked-baseline issue>
Do not use KEMFAI_OWNER_ESCALATION for anything a competent engineer could decide technically."
    MSG='feat: SpecKit implement tick'
    REVIEW=1
    ;;
esac

# --- fix-until-accept: feed prior Codex feedback back into the SAME task ---
# KEMFAI_ARBITER_RESOLUTION_FILE / KEMFAI_FIX_NOTE_FILE (set by run_loop.sh)
# are file PATHS, never the content itself -- the content behind them was
# already validated as task-keyed there (read_task_keyed_state_to_file) and
# can legitimately be hundreds of KB. It is streamed straight into
# PROMPT_FILE below via `cat`, so it is never held as a single shell
# variable that could later be exported or handed to a subprocess as one
# oversized argv/environment string.
PROMPT_FILE="$PROMPT_TMP_DIR/executor_prompt.txt"
{
  if [ -s "$REPO/docs/REVIEW_LESSONS.md" ]; then
    printf 'RECURRING REVIEW LESSONS — every item below is a real rejection reason from earlier tasks in this repo. Avoid ALL of them; they re-trigger rejections:\n\n'
    cat "$REPO/docs/REVIEW_LESSONS.md"
    printf '\n---\n'
  fi
  if [ -n "${KEMFAI_ARBITER_RESOLUTION_FILE:-}" ] && [ -s "$KEMFAI_ARBITER_RESOLUTION_FILE" ]; then
    printf 'IMPORTANT: Codex, acting as independent technical arbiter, already resolved the blocking ambiguity for this SAME task. Implement EXACTLY this resolution; do not re-litigate or re-raise the same question:\n\n'
    cat "$KEMFAI_ARBITER_RESOLUTION_FILE"
    printf '\n---\n'
  elif [ -n "${KEMFAI_FIX_NOTE_FILE:-}" ] && [ -s "$KEMFAI_FIX_NOTE_FILE" ]; then
    printf 'IMPORTANT: The previous attempt at this SAME task was rejected or blocked. Address the feedback below and complete the SAME task properly (do not skip to another task). Feedback to address:\n\n'
    cat "$KEMFAI_FIX_NOTE_FILE"
    printf '\n---\n'
  fi
  printf '%s\n' "$PROMPT"
} > "$PROMPT_FILE"

# --- run executor with bounded time + real provider fallback ---
# Claude is primary, GLM is fallback, and independent Codex review remains mandatory; Gemini is excluded.
# OpenCode may return exit 0 even when the provider reports a quota/stream error,
# so both the exit code AND output text are checked. Every failed executor is
# rolled back before the next provider starts, preventing mixed partial edits.
EXECUTOR_TIMEOUT=${KEMFAI_EXECUTOR_TIMEOUT:-1800}
EXECUTOR_ORDER="claude glm" # fixed policy: Claude primary, GLM fallback; Codex reviews only
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
    glm)
      # opencode's `run` positional message is a plain argv string with no
      # documented stdin mode, so the (potentially large) prompt is handed
      # over via its file-attachment flag (-f) instead of embedding it in
      # argv, where it could exceed MAX_ARG_STRLEN.
      OUT=$(timeout --signal=TERM --kill-after=30s "${EXECUTOR_TIMEOUT}s" \
        opencode run --auto -m zai-coding/glm-5.2 \
          -f "$PROMPT_FILE" \
          "Follow the complete task instructions in the attached file exactly." 2>&1)
      EC=$?
      ;;
    claude)
      # `claude -p` with no positional prompt argument reads the prompt from
      # stdin ("useful for pipes" per --help) -- so the prompt never has to
      # be a single argv string regardless of size.
      OUT=$(timeout --signal=TERM --kill-after=30s "${EXECUTOR_TIMEOUT}s" \
        claude -p \
          --permission-mode acceptEdits \
          --allowedTools 'Read,Write,Edit,Glob,Grep,Bash' \
          --output-format text < "$PROMPT_FILE" 2>&1)
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

# --- governance: task-id contract, tech-question interception, owner escalation ---
# Ordinary technical/architecture/schema/API/localization/migration/test
# ambiguity must never stop the loop for owner attention (AGENTS.md). Only a
# material product scope/behavior change, accounting/tax policy, legal/
# compliance exposure, or a locked-baseline change may escalate to the owner.
#
# Order matters here (independent-review fixes, see lib_governance.sh):
#   1. Pin discipline is checked and enforced FIRST, before any escalation
#      or question marker is even inspected. A mismatched Task ID means the
#      executor's entire output -- including any owner-escalation claim --
#      is not trustworthy for the pinned task, so it is ALWAYS a pin
#      violation, never an escalation.
#   2. Only once pin discipline passes is the executor's signal classified:
#      a KEMFAI_OWNER_ESCALATION marker is never trusted on its own -- its
#      content must validate against one of the four real categories, else
#      it is downgraded to an ordinary technical setback. A legacy/plain
#      "Decision Request" (still documented in AGENTS.md/constitution.md)
#      is intercepted and classified the same way even without
#      KEMFAI_TECH_QUESTION, so it can never slip through to review/commit.
if [ "$next" = "implement" ] && [ -n "$EXECUTOR" ] && [ $EC -eq 0 ]; then
  RESULT_TASK_ID=$(extract_task_id "$OUT")

  # No exemption for UNKNOWN/malformed/absent task ids: when a task is
  # pinned, ANY first-line id that is not an exact match -- including
  # UNKNOWN (malformed, absent, or otherwise unparseable) -- is a pin
  # violation. Exempting UNKNOWN here would let a contract-violating
  # response fall through to classify_executor_signal below, where a
  # fabricated owner-escalation/legacy-Decision-Request marker could be
  # trusted despite the executor never proving which task it was even
  # working on.
  #
  # Narrow real-output hardening: a real executor occasionally emits its
  # KEMFAI_TASK_ID marker after some preamble instead of as the mandated
  # literal first line. When a task IS pinned and extract_unique_task_marker
  # finds EXACTLY ONE UNIQUE marker anywhere in the output and it equals the
  # pin, the id is normalized so genuinely-correct work is not discarded as
  # a pin violation. Multiple/mismatched/absent markers are NEVER
  # normalized. Because the output still violated the format contract, its
  # escalation/tech-question markers are never trusted either -- normalized
  # output always falls straight through to the normal independent-review
  # path below, exactly as if no marker had been present at all.
  NORMALIZED_FROM_MALFORMED=""
  if [ "$RESULT_TASK_ID" = "UNKNOWN" ] && [ -n "${KEMFAI_PINNED_TASK:-}" ]; then
    if UNIQUE_MARKER=$(extract_unique_task_marker "$OUT") && [ "$UNIQUE_MARKER" = "$KEMFAI_PINNED_TASK" ]; then
      RESULT_TASK_ID="$UNIQUE_MARKER"
      NORMALIZED_FROM_MALFORMED="1"
      echo "[$TS] executor output violated the first-line KEMFAI_TASK_ID contract, but exactly one unique task marker ($UNIQUE_MARKER) exists and matches the pinned task -- normalizing the task id and sending this output through normal independent review only (no escalation/tech-question marker from this non-conforming output is trusted)." | tee -a "$LOG"
    fi
  fi

  PIN_VIOLATION=""
  if [ -n "${KEMFAI_PINNED_TASK:-}" ] && [ "$RESULT_TASK_ID" != "$KEMFAI_PINNED_TASK" ]; then
    PIN_VIOLATION="1"
  fi

  if [ -n "$PIN_VIOLATION" ]; then
    echo "[$TS] executor ignored pinned task $KEMFAI_PINNED_TASK and reported $RESULT_TASK_ID instead - discarding (pin violation takes priority over any escalation/question marker)" | tee -a "$LOG"
    echo "KEMFAI_RESULT_TASK_ID: $KEMFAI_PINNED_TASK"
    echo "KEMFAI_RESULT: PIN_VIOLATION"
    echo "KEMFAI_RESULT_DETAIL: executor ignored pinned task $KEMFAI_PINNED_TASK and reported $RESULT_TASK_ID"
    rollback_partial_executor_work
    echo "STATUS: PIN_VIOLATION"
    exit 0
  fi

  if [ -n "$NORMALIZED_FROM_MALFORMED" ]; then
    SIGNAL_KIND="NONE"
  else
    SIGNAL_OUT=$(classify_executor_signal "$OUT" || true)
    SIGNAL_KIND=$(printf '%s\n' "$SIGNAL_OUT" | sed -n '1p')
    SIGNAL_CATEGORY=$(printf '%s\n' "$SIGNAL_OUT" | sed -n '2p')
    SIGNAL_TEXT=$(printf '%s\n' "$SIGNAL_OUT" | tail -n +3)
  fi

  if [ "$SIGNAL_KIND" = "OWNER_ESCALATION" ]; then
    echo "[$TS] KEMFAI_RESULT: OWNER_ESCALATION ($SIGNAL_CATEGORY) - $SIGNAL_TEXT" | tee -a "$LOG"
    echo "KEMFAI_RESULT_TASK_ID: $RESULT_TASK_ID"
    echo "KEMFAI_RESULT: OWNER_ESCALATION"
    echo "KEMFAI_RESULT_DETAIL: $SIGNAL_TEXT"
    rollback_partial_executor_work
    {
      echo ""
      echo "## OWNER ESCALATION - $TS"
      echo ""
      echo "Task ID: $RESULT_TASK_ID"
      echo "Category: $SIGNAL_CATEGORY"
      echo "Reason (material product scope/behavior, accounting/tax policy, legal/compliance, or locked-baseline change):"
      echo ""
      echo "$SIGNAL_TEXT"
    } >> docs/PROGRESS.md
    git add docs/PROGRESS.md
    git -c user.email='eslam.berkawy@gmail.com' -c user.name='Eslam El Berkawy' \
      commit -m "docs: owner escalation for $RESULT_TASK_ID ($TS)" >/dev/null 2>&1 || true
    echo "STATUS: OWNER_ESCALATION"
    exit 0
  fi

  if [ "$SIGNAL_KIND" = "TECH_QUESTION" ]; then
    echo "[$TS] KEMFAI_RESULT: TECH_QUESTION - $SIGNAL_TEXT" | tee -a "$LOG"
    echo "KEMFAI_RESULT_TASK_ID: $RESULT_TASK_ID"
    echo "KEMFAI_RESULT: TECH_QUESTION"
    echo "KEMFAI_RESULT_DETAIL: $SIGNAL_TEXT"
    # Intercepted: not committed, not reviewed, not skipped -- the SAME task
    # stays pinned for the next attempt via run_loop.sh's persisted state.
    # This branch also catches a mislabeled KEMFAI_OWNER_ESCALATION that
    # failed category validation and any legacy plain Decision Request that
    # classified as ordinary technical content.
    rollback_partial_executor_work
    echo "STATUS: TECH_QUESTION"
    exit 0
  fi

  # No escalation/question marker and no legacy Decision Request: fall
  # through to the normal review flow below, but always report the task id
  # so run_loop.sh can key state.
  echo "KEMFAI_RESULT_TASK_ID: $RESULT_TASK_ID"
fi

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
      echo "KEMFAI_RESULT: REJECTED"
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
if [ "$next" = "implement" ] && [ -n "$CHANGED" ]; then
  echo "KEMFAI_RESULT: ACCEPTED"
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
