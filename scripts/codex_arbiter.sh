#!/usr/bin/env bash
# KEMFAI - Codex independent TECHNICAL ARBITER.
# Invoked by run_loop.sh only after a SAME task has racked up repeated
# rejections/technical questions. Gives ONE concrete resolution so the
# executor can proceed without owner attention. Strictly scoped: may not
# rule on product scope, accounting/tax policy, legal/compliance, or locked
# baseline changes -- those must come back as ESCALATE.
#   exit 0 -> RESOLVED (stdout carries the resolution)
#   exit 2 -> ESCALATE (owner attention genuinely required)
#   exit 3 -> arbiter unavailable / verdict missing
set -euo pipefail

REPO=${KEMFAI_REPO:-/home/hermesops/kemfai}
cd "$REPO"
# shellcheck disable=SC1091
source "$REPO/scripts/lib_governance.sh"

TASK_ID=${1:?usage: codex_arbiter.sh <TASK_ID> <context-file>}
CONTEXT_FILE=${2:?usage: codex_arbiter.sh <TASK_ID> <context-file>}
# The context file must be atomically keyed to THIS TASK_ID (write_task_keyed_state
# in run_loop.sh); a stale, partial, or hand-edited file fails the key check
# and yields nothing, so the arbiter never arbitrates blind on the wrong
# task's history. Full content is passed through -- no 6000-byte truncation.
CONTEXT=$(read_task_keyed_state "$CONTEXT_FILE" "$TASK_ID" || true)
if [ -z "$CONTEXT" ]; then
  echo "codex_arbiter: no valid keyed context for task $TASK_ID in $CONTEXT_FILE (missing/stale/mismatched) — refusing to arbitrate blind." >&2
  exit 3
fi

PROMPT=$(cat <<END_PROMPT
You are the independent TECHNICAL ARBITER for KEMFAI task ${TASK_ID}. This
task has been repeatedly rejected or blocked on an ordinary technical
ambiguity (architecture, schema, API, localization, migration, or test
design). Give ONE concrete, actionable resolution so the executor can
implement it without further back-and-forth.

Binding rules: .specify/memory/constitution.md, AGENTS.md, and the locked
stack in docs/GATE0_DECISIONS.md. Inspect specs/001-saas-onboarding-shell/tasks.md
and the current working tree yourself as needed.

Scope boundary: you may ONLY resolve ordinary technical/architecture/schema/
API/localization/migration/test questions. If the real blocker is actually a
material product scope/behavior change, accounting/tax policy, legal/
compliance exposure, or a change to a LOCKED baseline decision, do not decide
it yourself -- respond with ESCALATE instead.

Accumulated blocker/question history for this task:
---
${CONTEXT}
---

End your message with EXACTLY one of these two lines (nothing after it):
ARBITER VERDICT: RESOLVED
ARBITER VERDICT: ESCALATE

If RESOLVED, precede it with a short, concrete, numbered resolution the
executor can implement verbatim (exact schema/field/API/decision -- not more
open questions). If ESCALATE, precede it with a one-line reason naming which
escalation category applies (product scope, accounting/tax policy, legal/
compliance, or locked baseline).
END_PROMPT
)

set +e
RAW=$(timeout --signal=TERM --kill-after=30s "${KEMFAI_ARBITER_TIMEOUT:-900}s" codex exec --dangerously-bypass-approvals-and-sandbox "$PROMPT" 2>&1)
CODEX_EC=$?
set -e
OUT=$(printf '%s\n' "$RAW" | sed -n '/^codex$/,$p')
if [ $CODEX_EC -ne 0 ]; then
  printf '%s\n' "$RAW"
  exit 3
fi
echo "$OUT"

VERDICT=$(echo "$OUT" | grep -oE 'ARBITER VERDICT: (RESOLVED|ESCALATE)' | tail -1)
if echo "$VERDICT" | grep -q RESOLVED; then
  exit 0
elif echo "$VERDICT" | grep -q ESCALATE; then
  exit 2
else
  exit 3
fi
