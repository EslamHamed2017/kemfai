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
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "[$TS] working tree dirty; skipping this tick" | tee -a "$LOG"
  echo "STATUS: SKIPPED (dirty tree)"
  exit 0
fi

# --- pick command per stage ---
case "$next" in
  tasks)
    PROMPT='/speckit-tasks Generate the tasks list for specs/001-saas-onboarding-shell. Honor the ratified constitution and the locked stack in docs/GATE0_DECISIONS.md (Next.js frontend, NestJS BFF, Odoo 18 Community with kemfai_* modules only, PostgreSQL DB-per-tenant, Keycloak, MinIO, OmniRoute). Break work into small independently deliverable vertical slices with Task ID, dependencies, acceptance criteria, and Primary/Backup/Reviewer roles per AGENTS.md. Trial/entitlement values remain admin-configurable (FR-030a). Follow the installed SpecKit tasks skill exactly.'
    MSG='docs: generate SpecKit tasks for Slice 1'
    ;;
  analyze)
    PROMPT='/speckit-analyze Run the SpecKit analyze pass on specs/001-saas-onboarding-shell against the ratified constitution. Report only genuine inconsistencies between constitution, spec, plan, contracts, data model and tasks. Do not implement code.'
    MSG='docs: SpecKit analyze pass for Slice 1'
    ;;
  implement)
    PROMPT='/speckit-implement Execute the NEXT single unblocked task from specs/001-saas-onboarding-shell/tasks.md. Rules: honor the ratified constitution (no Odoo core edits, DB-per-tenant, EN/AR from Day 1, deterministic accounting, config-driven entitlements/trial). Small vertical slice with tests. Update tasks.md to mark the task done. If the task has ambiguity, stop and add a short Decision Request note to docs/PROGRESS.md instead of guessing.'
    MSG='feat: SpecKit implement tick'
    ;;
esac

# --- run Claude ---
set +e
OUT=$(claude -p "$PROMPT" \
  --permission-mode acceptEdits \
  --allowedTools 'Read,Write,Edit,Glob,Grep,Bash' \
  --output-format text 2>&1)
EC=$?
set -e
echo "$OUT" | tee -a "$LOG" >/dev/null
echo "[$TS] claude exit: $EC" | tee -a "$LOG"

# --- commit if anything changed ---
CHANGED=""
if ! git diff --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
  git add -A
  if git -c user.email='eslam.berkawy@gmail.com' -c user.name='Eslam El Berkawy' \
       commit -m "$MSG" >/dev/null 2>&1; then
    CHANGED=$(git log -1 --oneline)
  fi
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
  echo "Claude output (tail):"
  echo "$TAIL"
  echo "---"
  echo "Log: $LOG"
} | tee -a "$LOG"
