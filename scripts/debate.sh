#!/usr/bin/env bash
# KEMFAI - Claude vs Codex debate resolver.
# Usage: debate.sh "<the question / decision to resolve>"
# Runs: Claude proposes -> Codex critiques -> Claude revises -> Codex verdict
# Writes a decision record and prints a short brief.
set -euo pipefail

REPO=/home/hermesops/kemfai
QUESTION="${1:?usage: debate.sh \"question\"}"
TS=$(TZ=Asia/Dubai date '+%Y-%m-%d %H:%M %Z')
SLUG=$(echo "$QUESTION" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | cut -c1-50 | sed 's/-$//')
DIR="$REPO/docs/decisions"
WORK="$REPO/scripts/.debate"
mkdir -p "$DIR" "$WORK"
OUT="$DIR/$(TZ=Asia/Dubai date +%Y%m%d-%H%M)-$SLUG.md"

cd "$REPO"

CONTEXT='Project KEMFAI: multi-tenant accounting SaaS for Gulf+Egypt. Locked stack: Next.js frontend, NestJS BFF as the only customer-facing boundary, Odoo 18 Community with kemfai_* modules and NO core edits, PostgreSQL database-per-tenant, Keycloak auth, MinIO storage, OmniRoute AI. Binding rules live in .specify/memory/constitution.md and AGENTS.md. Key constraints: customer must never see native Odoo UI; English+Arabic with full RTL from day one; accounting posting is deterministic and AI is assistive only; plan/entitlement/trial values are admin-configurable and never hard-coded; mandatory quality gates Spec -> Accounting/Data -> Test -> Security/Tenant -> Acceptance; no agent approves its own work. Feature under work: specs/001-saas-onboarding-shell.'

echo "[$TS] DEBATE: $QUESTION"

# ---------- Round 1: Claude proposes ----------
claude -p "$CONTEXT

You are the PROPOSER in a two-model technical debate. Another model (Codex) will critique you, so be precise and honest.

QUESTION TO RESOLVE:
$QUESTION

Read the relevant repo files first. Then give:
1. RECOMMENDATION - one clear option, stated in one sentence.
2. WHY - the reasoning, tied to the constitution and the locked stack.
3. CONCRETE CHANGES - exact files and what changes in each.
4. RISKS - the honest downsides of your own recommendation.
5. REJECTED ALTERNATIVES - what you considered and why you dropped it.

Do not modify any file. Analysis only. Be concise and specific." \
  --permission-mode plan \
  --allowedTools 'Read,Glob,Grep,Bash' \
  --output-format text > "$WORK/r1_claude.txt" 2>&1 || true

# ---------- Round 2: Codex critiques ----------
codex exec --dangerously-bypass-approvals-and-sandbox "$CONTEXT

You are the CRITIC in a two-model technical debate. Claude proposed the following. Your job is to find what is wrong with it, not to be agreeable.

QUESTION:
$QUESTION

CLAUDE'S PROPOSAL:
$(cat "$WORK/r1_claude.txt")

Read the relevant repo files and verify the claims yourself. Then give:
1. FACTUAL ERRORS - anything Claude stated that the repo contradicts (quote the file).
2. CONSTITUTION VIOLATIONS - anything that breaks the binding rules.
3. MISSED RISKS - what Claude did not consider.
4. BETTER ALTERNATIVE - only if you genuinely have one; say NONE if Claude's approach is sound.
5. VERDICT - AGREE, AGREE WITH CHANGES, or DISAGREE, plus one sentence why.

Do not modify files. Be blunt and specific." 2>&1 | sed -n '/^codex$/,$p' > "$WORK/r2_codex.txt" || true

# ---------- Round 3: Claude revises ----------
claude -p "$CONTEXT

You are in round 3 of a technical debate. You proposed a solution; Codex critiqued it. Reconcile honestly - concede where Codex is right, defend where Codex is wrong, and cite files.

QUESTION:
$QUESTION

YOUR ORIGINAL PROPOSAL:
$(cat "$WORK/r1_claude.txt")

CODEX'S CRITIQUE:
$(cat "$WORK/r2_codex.txt")

Produce the FINAL AGREED PLAN:
1. POINTS CONCEDED - where Codex was right and what changes because of it.
2. POINTS DEFENDED - where Codex was wrong, with file evidence.
3. FINAL RECOMMENDATION - the reconciled decision in one sentence.
4. EXACT CHANGES - file by file, what to change.
5. OPEN QUESTIONS FOR THE OWNER - ONLY genuine business/product decisions a model must not make alone. If there are none, write NONE.

Do not modify any file yet. Analysis only." \
  --permission-mode plan \
  --allowedTools 'Read,Glob,Grep,Bash' \
  --output-format text > "$WORK/r3_claude.txt" 2>&1 || true

# ---------- Round 4: Codex final verdict ----------
codex exec --dangerously-bypass-approvals-and-sandbox "$CONTEXT

Final round. Claude has reconciled your critique into a final plan. Approve or reject it.

QUESTION:
$QUESTION

CLAUDE'S FINAL PLAN:
$(cat "$WORK/r3_claude.txt")

Respond with:
1. VERDICT - APPROVED or REJECTED.
2. REMAINING OBJECTIONS - anything still unresolved, or NONE.
3. OWNER DECISIONS NEEDED - genuine business decisions only, or NONE.

Keep it under 200 words." 2>&1 | sed -n '/^codex$/,$p' > "$WORK/r4_codex.txt" || true

# ---------- Record ----------
{
  echo "# Decision Record: $QUESTION"
  echo
  echo "**Date:** $TS"
  echo "**Method:** Claude proposes -> Codex critiques -> Claude reconciles -> Codex verdict"
  echo
  echo "---"
  echo
  echo "## Round 1 - Claude proposes"
  echo; cat "$WORK/r1_claude.txt"; echo
  echo "## Round 2 - Codex critiques"
  echo; cat "$WORK/r2_codex.txt"; echo
  echo "## Round 3 - Claude reconciles"
  echo; cat "$WORK/r3_claude.txt"; echo
  echo "## Round 4 - Codex verdict"
  echo; cat "$WORK/r4_codex.txt"; echo
} > "$OUT"

VERDICT=$(grep -iEm1 'APPROVED|REJECTED' "$WORK/r4_codex.txt" || echo "verdict unclear")

echo "=== DEBATE COMPLETE ==="
echo "Question: $QUESTION"
echo "Verdict:  $VERDICT"
echo "Record:   $OUT"
echo "--- Claude final recommendation ---"
sed -n '/FINAL RECOMMENDATION/,/EXACT CHANGES/p' "$WORK/r3_claude.txt" | head -20
echo "--- Owner decisions needed ---"
sed -n '/OWNER DECISIONS NEEDED/,$p' "$WORK/r4_codex.txt" | head -15
