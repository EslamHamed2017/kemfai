#!/usr/bin/env bash
# KEMFAI - Codex independent reviewer for an uncommitted implement tick.
# Reads the working-tree diff, sends it to Codex, and returns:
#   - stdout: full reviewer output (Claude/Codex-style)
#   - exit 0 if ACCEPT, exit 2 if REJECT, exit 3 if verdict missing
set -euo pipefail

REPO=${KEMFAI_REPO:-/home/hermesops/kemfai}
cd "$REPO"

# Secure scratch dir for the prompt fed to Codex and the final message it
# writes back; removed on every exit path. A large diff assembled here is
# never handed to codex as a single argv string (the prior design's
# FULL_PROMPT argv could exceed Linux's MAX_ARG_STRLEN for large diffs) --
# only ever via stdin from PROMPT_FILE.
REVIEW_TMP_DIR=$(mktemp -d)
trap 'rm -rf "$REVIEW_TMP_DIR"' EXIT
PROMPT_FILE="$REVIEW_TMP_DIR/prompt.txt"
LASTMSG_FILE="$REVIEW_TMP_DIR/last_message.txt"

{
  cat <<'END_PROMPT'
You are the independent REVIEWER for KEMFAI (no model approves its own work). An independent executor just implemented one task from specs/001-saas-onboarding-shell/tasks.md and may have marked it done.

Binding rules: .specify/memory/constitution.md and AGENTS.md. Constraints: Odoo 18 Community with kemfai_* modules and NO core edits; database-per-tenant; customer never sees native Odoo UI; EN+AR with full RTL; deterministic accounting and assistive-only AI; entitlement/trial/feature-flag values admin-configurable never hard-coded; feature flags gate incomplete modules; mandatory quality gates.

Inspect the actual working tree yourself (git diff/status and the changed files). Determine:
1. Which Task ID was implemented, and whether the code actually satisfies that task's acceptance criteria in specs/001-saas-onboarding-shell/tasks.md.
2. Whether its tests exist AND genuinely pass. Run them (npm test / pytest / odoo-bin test) if a runner is present. Do not accept "tests were added" without proof they pass.
3. Whether tasks.md was marked done prematurely.
4. Any constitution violation (core Odoo edits, hard-coded plan/limit/trial values, customer-visible Odoo UI leakage, tenant-isolation break, non-deterministic accounting, missing feature-flag gate).
5. Any obvious bug, security hole, or tenant-isolation leak.

End your message with EXACTLY one of these two lines (nothing after it):
REVIEW VERDICT: ACCEPT
REVIEW VERDICT: REJECT
If REJECT, precede it with a short numbered list of only genuine blockers. Be blunt.

Working-tree evidence follows (uncommitted):
END_PROMPT
  echo
  git status --short
  echo '----- unstaged diff-stat -----'
  git --no-pager diff --stat
  echo '----- staged diff-stat -----'
  git --no-pager diff --cached --stat
  echo
  echo '----- unstaged diff (first 400 lines) -----'
  git --no-pager diff | sed -n '1,400p'
  echo
  echo '----- staged diff (first 400 lines) -----'
  git --no-pager diff --cached | sed -n '1,400p'
} > "$PROMPT_FILE"

# Prompt goes in via stdin ("-" forces codex to read it, per `codex exec
# --help`), never as an argv string. `-o/--output-last-message` writes ONLY
# Codex's final response to LASTMSG_FILE, so the persisted verdict/blockers
# are never the full event/tool-call transcript -- just the actionable
# answer -- while the reviewer's full blocker text is preserved byte-for-byte.
set +e
RAW=$(timeout --signal=TERM --kill-after=30s "${KEMFAI_REVIEW_TIMEOUT:-1200}s" \
  codex exec --dangerously-bypass-approvals-and-sandbox -o "$LASTMSG_FILE" - < "$PROMPT_FILE" 2>&1)
CODEX_EC=$?
set -e
if [ $CODEX_EC -ne 0 ] || [ ! -s "$LASTMSG_FILE" ]; then
  printf '%s\n' "$RAW"
  exit 3
fi
OUT=$(cat "$LASTMSG_FILE")
echo "$OUT"

VERDICT=$(echo "$OUT" | grep -oE 'REVIEW VERDICT: (ACCEPT|REJECT)' | tail -1)
if echo "$VERDICT" | grep -q ACCEPT; then
  exit 0
elif echo "$VERDICT" | grep -q REJECT; then
  exit 2
else
  exit 3
fi
