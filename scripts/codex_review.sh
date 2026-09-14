#!/usr/bin/env bash
# KEMFAI - Codex independent reviewer for an uncommitted implement tick.
# Reads the working-tree diff, sends it to Codex, and returns:
#   - stdout: full reviewer output (Claude/Codex-style)
#   - exit 0 if ACCEPT, exit 2 if REJECT, exit 3 if verdict missing
set -euo pipefail

REPO=/home/hermesops/kemfai
cd "$REPO"

DIFF_SUMMARY="$(git status --short; echo '----- diff-stat -----'; git --no-pager diff --stat; echo; echo '----- diff (first 400 lines) -----'; git --no-pager diff | head -400)"

PROMPT=$(cat <<'END_PROMPT'
You are the independent REVIEWER for KEMFAI (no model approves its own work). Claude just implemented one task from specs/001-saas-onboarding-shell/tasks.md and may have marked it done.

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
)

FULL_PROMPT="${PROMPT}

${DIFF_SUMMARY}"

OUT=$(codex exec --dangerously-bypass-approvals-and-sandbox "$FULL_PROMPT" 2>&1 | sed -n '/^codex$/,$p') || true
echo "$OUT"

VERDICT=$(echo "$OUT" | grep -oE 'REVIEW VERDICT: (ACCEPT|REJECT)' | tail -1)
if echo "$VERDICT" | grep -q ACCEPT; then
  exit 0
elif echo "$VERDICT" | grep -q REJECT; then
  exit 2
else
  exit 3
fi
