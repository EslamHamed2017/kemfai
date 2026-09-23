#!/usr/bin/env bash
# Deterministic integration tests for the durable Claude<->Codex loop
# (scripts/run_loop.sh + scripts/run_next_step.sh + scripts/codex_arbiter.sh).
# Uses mocked claude/codex/opencode binaries (scripts/tests/mocks/) on an
# isolated scratch git repo -- no real model calls, no network, and the real
# KEMFAI repo/state/history is never touched.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL_REPO="$(cd "$HERE/../.." && pwd)"
# shellcheck disable=SC1091
source "$HERE/lib_test_helpers.sh"

export PATH="$HERE/mocks:$PATH"

SCRATCH_ROOT=$(mktemp -d)
trap 'rm -rf "$SCRATCH_ROOT"' EXIT

# new_scratch_repo NAME -> creates an isolated git repo with the minimal
# fixtures run_next_step.sh needs to reach the "implement" stage, and copies
# in the real (already-edited) governance scripts under test.
new_scratch_repo() {
  local name="$1"
  local dir="$SCRATCH_ROOT/$name"
  mkdir -p "$dir/scripts" "$dir/docs" "$dir/.specify/memory" "$dir/specs/001-saas-onboarding-shell"
  cp "$REAL_REPO/scripts/lib_governance.sh" "$dir/scripts/"
  cp "$REAL_REPO/scripts/run_next_step.sh" "$dir/scripts/"
  cp "$REAL_REPO/scripts/run_loop.sh" "$dir/scripts/"
  cp "$REAL_REPO/scripts/codex_review.sh" "$dir/scripts/"
  cp "$REAL_REPO/scripts/codex_arbiter.sh" "$dir/scripts/"
  printf '*.log\n/scripts/.state/\n' > "$dir/.gitignore"
  echo "mock constitution" > "$dir/.specify/memory/constitution.md"
  echo "mock gate0 decisions" > "$dir/docs/GATE0_DECISIONS.md"
  echo "# PROGRESS" > "$dir/docs/PROGRESS.md"
  echo "mock AGENTS" > "$dir/AGENTS.md"
  echo "# Tasks" > "$dir/specs/001-saas-onboarding-shell/tasks.md"
  echo "# Analysis" > "$dir/specs/001-saas-onboarding-shell/analysis.md"
  (
    cd "$dir"
    git init -q
    git config user.email test@kemfai.local
    git config user.name "KEMFAI Test"
    git add -A
    git commit -q -m "fixture: initial clean baseline"
  )
  printf '%s\n' "$dir"
}

# run_fire REPO_DIR MOCK_STATE_DIR [env assignments...] -> runs one run_loop.sh
# fire with the given env, capturing stdout+exit code into globals.
run_fire() {
  local repo_dir="$1" mock_state="$2"
  shift 2
  # No `set -e` is active in this test file; a plain assignment already
  # captures a non-zero exit without a set +e/-e guard.
  FIRE_OUT=$(KEMFAI_REPO="$repo_dir" MOCK_STATE_DIR="$mock_state" MOCK_REPO_DIR="$repo_dir" \
    KEMFAI_LOOP_LOCK="$mock_state/loop.lock" env "$@" bash "$repo_dir/scripts/run_loop.sh" 2>&1)
  FIRE_EC=$?
}

# ---------------------------------------------------------------------------
echo "== Scenario A: rejection feeds exact blockers back to the SAME task, then accepted =="
REPO_A=$(new_scratch_repo scenario_a)
STATE_A=$(mktemp -d)
printf 'ACCEPT\nACCEPT\n' > "$STATE_A/claude_sequence.txt"
printf 'REJECT\nACCEPT\n' > "$STATE_A/review_sequence.txt"

run_fire "$REPO_A" "$STATE_A" TASKS=1 ATTEMPTS=2 ARBITER_AFTER=5 MOCK_TASK_ID=T036

assert_eq "scenario A: run_loop exits 0" "0" "$FIRE_EC"
assert_contains "scenario A: attempt 1 was rejected and fed back for the SAME task" "$FIRE_OUT" "setback #1 for task T036 (REJECTED)"
assert_contains "scenario A: attempt 2 retried the SAME task and was accepted" "$FIRE_OUT" "LOOP: task T036 accepted"
assert_file_absent "scenario A: current_task.txt cleared after acceptance" "$REPO_A/scripts/.state/current_task.txt"
assert_file_absent "scenario A: setback_state.txt cleared after acceptance" "$REPO_A/scripts/.state/setback_state.txt"
assert_file_absent "scenario A: last_rejection.txt cleared after acceptance" "$REPO_A/scripts/.state/last_rejection.txt"

# ---------------------------------------------------------------------------
echo ""
echo "== Scenario B: repeated rejection invokes the arbiter; resolution persists across a SEPARATE fire =="
REPO_B=$(new_scratch_repo scenario_b)
STATE_B=$(mktemp -d)
printf 'ACCEPT\nACCEPT\nACCEPT\n' > "$STATE_B/claude_sequence.txt"
printf 'REJECT\nREJECT\nACCEPT\n' > "$STATE_B/review_sequence.txt"
printf 'RESOLVED\n' > "$STATE_B/arbiter_sequence.txt"

run_fire "$REPO_B" "$STATE_B" TASKS=1 ATTEMPTS=2 ARBITER_AFTER=2 MOCK_TASK_ID=T036

assert_eq "scenario B fire 1: exits 0 (bounded attempts, not owner escalation)" "0" "$FIRE_EC"
assert_contains "scenario B fire 1: setback #1 persisted" "$FIRE_OUT" "setback #1 for task T036 (REJECTED)"
assert_contains "scenario B fire 1: setback #2 reaches ARBITER_AFTER and invokes the arbiter" "$FIRE_OUT" "invoking Codex as independent technical arbiter"
assert_contains "scenario B fire 1: arbiter RESOLVED the SAME task" "$FIRE_OUT" "arbiter RESOLVED task T036"
assert_contains "scenario B fire 1: ends bounded (never owner attention) and will resume next fire" "$FIRE_OUT" "stop=attempts_bounded_this_fire"
assert_not_contains "scenario B fire 1: never claims owner escalation for ordinary technical rejection" "$FIRE_OUT" "stop=owner_escalation"
assert_file_exists "scenario B fire 1: current task stays pinned across fires" "$REPO_B/scripts/.state/current_task.txt"
assert_eq "scenario B fire 1: pinned task id is T036" "T036" "$(cat "$REPO_B/scripts/.state/current_task.txt")"
assert_file_exists "scenario B fire 1: arbiter resolution persisted for next fire" "$REPO_B/scripts/.state/last_resolution.txt"

run_fire "$REPO_B" "$STATE_B" TASKS=1 ATTEMPTS=2 ARBITER_AFTER=2 MOCK_TASK_ID=T036

assert_eq "scenario B fire 2: exits 0" "0" "$FIRE_EC"
assert_contains "scenario B fire 2: resumed the SAME pinned task" "$FIRE_OUT" "resuming pinned task T036"
assert_contains "scenario B fire 2: arbiter resolution led to acceptance" "$FIRE_OUT" "LOOP: task T036 accepted"
assert_file_absent "scenario B fire 2: all state cleared after final acceptance" "$REPO_B/scripts/.state/current_task.txt"
assert_file_absent "scenario B fire 2: resolution file cleared after final acceptance" "$REPO_B/scripts/.state/last_resolution.txt"

# ---------------------------------------------------------------------------
echo ""
echo "== Scenario C: arbiter itself judges the blocker out of technical scope -> real owner escalation =="
REPO_C=$(new_scratch_repo scenario_c)
STATE_C=$(mktemp -d)
printf 'ACCEPT\nACCEPT\n' > "$STATE_C/claude_sequence.txt"
printf 'REJECT\nREJECT\n' > "$STATE_C/review_sequence.txt"
printf 'ESCALATE\n' > "$STATE_C/arbiter_sequence.txt"

run_fire "$REPO_C" "$STATE_C" TASKS=1 ATTEMPTS=2 ARBITER_AFTER=2 MOCK_TASK_ID=T036

assert_eq "scenario C: exits 0" "0" "$FIRE_EC"
assert_contains "scenario C: arbiter ESCALATE stops the loop for real owner attention" "$FIRE_OUT" "stop=owner_escalation_via_arbiter"
assert_file_absent "scenario C: task state cleared (not auto-retried after owner escalation)" "$REPO_C/scripts/.state/current_task.txt"
assert_contains "scenario C: docs/PROGRESS.md records the arbiter owner escalation" "$(cat "$REPO_C/docs/PROGRESS.md")" "OWNER ESCALATION via arbiter"

# ---------------------------------------------------------------------------
echo ""
echo "== Scenario D: executor's own KEMFAI_OWNER_ESCALATION stops immediately, no retry =="
REPO_D=$(new_scratch_repo scenario_d)
STATE_D=$(mktemp -d)
printf 'OWNER_ESCALATION\n' > "$STATE_D/claude_sequence.txt"

run_fire "$REPO_D" "$STATE_D" TASKS=1 ATTEMPTS=2 ARBITER_AFTER=2 MOCK_TASK_ID=T036

assert_eq "scenario D: exits 0" "0" "$FIRE_EC"
assert_contains "scenario D: stops for real owner attention on first occurrence, no bounded retries" "$FIRE_OUT" "stop=owner_escalation"
assert_not_contains "scenario D: does not silently commit the escalation as done work" "$FIRE_OUT" "KEMFAI_RESULT: ACCEPTED"
assert_file_absent "scenario D: task state cleared" "$REPO_D/scripts/.state/current_task.txt"
assert_contains "scenario D: docs/PROGRESS.md records the owner escalation" "$(cat "$REPO_D/docs/PROGRESS.md")" "OWNER ESCALATION"

# ---------------------------------------------------------------------------
echo ""
echo "== Scenario E: ordinary KEMFAI_TECH_QUESTION is intercepted -- not committed, not skipped, SAME task retried =="
REPO_E=$(new_scratch_repo scenario_e)
STATE_E=$(mktemp -d)
printf 'TECH_QUESTION\nACCEPT\n' > "$STATE_E/claude_sequence.txt"
printf 'ACCEPT\n' > "$STATE_E/review_sequence.txt"

run_fire "$REPO_E" "$STATE_E" TASKS=1 ATTEMPTS=2 ARBITER_AFTER=5 MOCK_TASK_ID=T036

assert_eq "scenario E: exits 0" "0" "$FIRE_EC"
assert_contains "scenario E: tech question intercepted, not treated as owner escalation" "$FIRE_OUT" "setback #1 for task T036 (TECH_QUESTION)"
assert_not_contains "scenario E: never stops for owner on ordinary technical ambiguity" "$FIRE_OUT" "stop=owner_escalation"
assert_contains "scenario E: SAME task retried immediately and accepted" "$FIRE_OUT" "LOOP: task T036 accepted"
LOG_A=$(cat "$REPO_E/docs/PROGRESS.md")
assert_not_contains "scenario E: a mere tech question is never written to docs/PROGRESS.md as a Decision Request" "$LOG_A" "TECH_QUESTION"

# ---------------------------------------------------------------------------
echo ""
echo "== Scenario F: executor ignores the pinned task -- coerced back, keyed to the PINNED task =="
REPO_F=$(new_scratch_repo scenario_f)
STATE_F=$(mktemp -d)
printf 'OTHER_TASK\nACCEPT\n' > "$STATE_F/claude_sequence.txt"
printf 'ACCEPT\n' > "$STATE_F/review_sequence.txt"
mkdir -p "$REPO_F/scripts/.state"
printf 'T036\n' > "$REPO_F/scripts/.state/current_task.txt"
{
  echo "TASK_ID=T036"
  echo "COUNT=1"
  echo "KIND=REJECTED"
} > "$REPO_F/scripts/.state/setback_state.txt"

run_fire "$REPO_F" "$STATE_F" TASKS=1 ATTEMPTS=2 ARBITER_AFTER=99 MOCK_TASK_ID=T036

assert_eq "scenario F: exits 0" "0" "$FIRE_EC"
assert_contains "scenario F: pin violation detected and discarded" "$FIRE_OUT" "KEMFAI_RESULT: PIN_VIOLATION"
assert_contains "scenario F: setback keyed to the PINNED task T036, not the reported T099" "$FIRE_OUT" "setback #2 for task T036 (PIN_VIOLATION)"
assert_contains "scenario F: SAME pinned task eventually accepted" "$FIRE_OUT" "LOOP: task T036 accepted"

# ---------------------------------------------------------------------------
echo ""
echo "== Scenario G: a malformed/UNKNOWN task id never corrupts a real task's setback streak =="
REPO_G=$(new_scratch_repo scenario_g)
STATE_G=$(mktemp -d)
# No task is pinned yet, so nothing coerces the first attempt's task id.
# Attempt 1: malformed output (contract-violating, resolves to UNKNOWN) is
# rejected -- must NOT be persisted/keyed to anything. Attempt 2: a real,
# well-formed T036 rejection must start its OWN streak at #1, not inherit
# any count from the discarded UNKNOWN attempt. Attempt 3: T036 is accepted.
printf 'MALFORMED\nACCEPT\nACCEPT\n' > "$STATE_G/claude_sequence.txt"
printf 'REJECT\nREJECT\nACCEPT\n' > "$STATE_G/review_sequence.txt"

run_fire "$REPO_G" "$STATE_G" TASKS=1 ATTEMPTS=3 ARBITER_AFTER=5 MOCK_TASK_ID=T036

assert_eq "scenario G: exits 0" "0" "$FIRE_EC"
assert_contains "scenario G: the malformed/UNKNOWN attempt is not persisted or keyed" "$FIRE_OUT" "not persisted/keyed"
assert_contains "scenario G: the FIRST real keyed rejection on T036 starts at #1, not inheriting the discarded attempt" \
  "$FIRE_OUT" "setback #1 for task T036 (REJECTED)"
assert_not_contains "scenario G: never reaches #2 before a second real T036 rejection actually happens" \
  "$FIRE_OUT" "setback #2 for task T036"
assert_contains "scenario G: T036 eventually accepted" "$FIRE_OUT" "LOOP: task T036 accepted"

# ---------------------------------------------------------------------------
echo ""
echo "== Scenario H: mismatched Task ID with a fabricated escalation marker is STILL a pin violation, never an escalation =="
REPO_H=$(new_scratch_repo scenario_h)
STATE_H=$(mktemp -d)
printf 'OTHER_TASK_ESCALATION\nACCEPT\n' > "$STATE_H/claude_sequence.txt"
printf 'ACCEPT\n' > "$STATE_H/review_sequence.txt"
mkdir -p "$REPO_H/scripts/.state"
printf 'T036\n' > "$REPO_H/scripts/.state/current_task.txt"

run_fire "$REPO_H" "$STATE_H" TASKS=1 ATTEMPTS=2 ARBITER_AFTER=99 MOCK_TASK_ID=T036

assert_eq "scenario H: exits 0" "0" "$FIRE_EC"
assert_contains "scenario H: a mismatched task id with a real-category escalation marker is still flagged PIN_VIOLATION" \
  "$FIRE_OUT" "KEMFAI_RESULT: PIN_VIOLATION"
assert_not_contains "scenario H: never treated as an owner escalation just because the executor attached the marker" \
  "$FIRE_OUT" "stop=owner_escalation"
assert_not_contains "scenario H: docs/PROGRESS.md never records a bogus escalation for a pin-violating attempt" \
  "$(cat "$REPO_H/docs/PROGRESS.md")" "OWNER ESCALATION"
assert_contains "scenario H: SAME pinned task eventually accepted" "$FIRE_OUT" "LOOP: task T036 accepted"

# ---------------------------------------------------------------------------
echo ""
echo "== Scenario I: fake technical owner escalation is downgraded to a technical setback, loop keeps going =="
REPO_I=$(new_scratch_repo scenario_i)
STATE_I=$(mktemp -d)
printf 'FAKE_ESCALATION\nACCEPT\n' > "$STATE_I/claude_sequence.txt"
printf 'ACCEPT\n' > "$STATE_I/review_sequence.txt"

run_fire "$REPO_I" "$STATE_I" TASKS=1 ATTEMPTS=2 ARBITER_AFTER=5 MOCK_TASK_ID=T036

assert_eq "scenario I: exits 0" "0" "$FIRE_EC"
assert_contains "scenario I: bogus KEMFAI_OWNER_ESCALATION content is intercepted as an ordinary technical setback" \
  "$FIRE_OUT" "setback #1 for task T036 (TECH_QUESTION)"
assert_not_contains "scenario I: never stops the loop for owner attention on a fake/mislabeled escalation" \
  "$FIRE_OUT" "stop=owner_escalation"
assert_contains "scenario I: SAME task retried and accepted" "$FIRE_OUT" "LOOP: task T036 accepted"
assert_not_contains "scenario I: docs/PROGRESS.md never records a fake escalation" \
  "$(cat "$REPO_I/docs/PROGRESS.md")" "OWNER ESCALATION"

# ---------------------------------------------------------------------------
echo ""
echo "== Scenario J: legacy/plain Decision Request (ordinary technical) is intercepted without KEMFAI_TECH_QUESTION =="
REPO_J=$(new_scratch_repo scenario_j)
STATE_J=$(mktemp -d)
printf 'LEGACY_DR_TECH\nACCEPT\n' > "$STATE_J/claude_sequence.txt"
printf 'ACCEPT\n' > "$STATE_J/review_sequence.txt"

run_fire "$REPO_J" "$STATE_J" TASKS=1 ATTEMPTS=2 ARBITER_AFTER=5 MOCK_TASK_ID=T036

assert_eq "scenario J: exits 0" "0" "$FIRE_EC"
assert_contains "scenario J: a plain Decision Request with no strict marker is still intercepted as TECH_QUESTION" \
  "$FIRE_OUT" "setback #1 for task T036 (TECH_QUESTION)"
assert_not_contains "scenario J: never stops for owner attention" "$FIRE_OUT" "stop=owner_escalation"
assert_contains "scenario J: SAME task retried and accepted" "$FIRE_OUT" "LOOP: task T036 accepted"
assert_not_contains "scenario J: the intercepted attempt's own Decision Request text is never written to docs/PROGRESS.md" \
  "$(cat "$REPO_J/docs/PROGRESS.md")" "Decision Request"

# ---------------------------------------------------------------------------
echo ""
echo "== Scenario K: legacy/plain Decision Request naming a REAL escalation category stops for the owner =="
REPO_K=$(new_scratch_repo scenario_k)
STATE_K=$(mktemp -d)
printf 'LEGACY_DR_ESCALATION\n' > "$STATE_K/claude_sequence.txt"

run_fire "$REPO_K" "$STATE_K" TASKS=1 ATTEMPTS=2 ARBITER_AFTER=5 MOCK_TASK_ID=T036

assert_eq "scenario K: exits 0" "0" "$FIRE_EC"
assert_contains "scenario K: a legacy Decision Request naming a real category (accounting/tax) stops for real owner attention" \
  "$FIRE_OUT" "stop=owner_escalation"
assert_contains "scenario K: docs/PROGRESS.md records the escalation with its classified category" \
  "$(cat "$REPO_K/docs/PROGRESS.md")" "ACCOUNTING_TAX"

# ---------------------------------------------------------------------------
echo ""
echo "== Scenario L: >6000-byte reviewer feedback survives end-to-end with no 4K/6K truncation =="
REPO_L=$(new_scratch_repo scenario_l)
STATE_L=$(mktemp -d)
printf 'ACCEPT\nACCEPT\n' > "$STATE_L/claude_sequence.txt"
printf 'REJECT_LONG\nACCEPT\n' > "$STATE_L/review_sequence.txt"

run_fire "$REPO_L" "$STATE_L" TASKS=1 ATTEMPTS=2 ARBITER_AFTER=5 MOCK_TASK_ID=T036

assert_eq "scenario L: exits 0" "0" "$FIRE_EC"
assert_contains "scenario L: attempt 1 rejected and fed back for the SAME task" "$FIRE_OUT" "setback #1 for task T036 (REJECTED)"
assert_contains "scenario L: SAME task retried and accepted on attempt 2" "$FIRE_OUT" "LOOP: task T036 accepted"
PROMPT_2="$STATE_L/claude_prompt_2.txt"
assert_file_exists "scenario L: attempt 2's prompt to the executor was captured" "$PROMPT_2"
assert_contains "scenario L: the far end of the >6000-byte reviewer blocker list reached the next attempt's prompt intact" \
  "$(cat "$PROMPT_2" 2>/dev/null)" "LAST_LONG_BLOCKER_LINE_MARKER"
assert_contains "scenario L: line 150 of the long blocker list is present (nowhere near a 4K/6K cutoff)" \
  "$(cat "$PROMPT_2" 2>/dev/null)" "blocker line 150"

# ---------------------------------------------------------------------------
echo ""
echo "== Scenario M: stale resolution state (keyed to a DIFFERENT, leftover task) is never injected =="
REPO_M=$(new_scratch_repo scenario_m)
STATE_M=$(mktemp -d)
printf 'ACCEPT\n' > "$STATE_M/claude_sequence.txt"
printf 'ACCEPT\n' > "$STATE_M/review_sequence.txt"
mkdir -p "$REPO_M/scripts/.state"
printf 'T036\n' > "$REPO_M/scripts/.state/current_task.txt"
{
  echo "KEMFAI_STATE_TASK_ID: T099"
  echo "STALE_RESOLUTION_FOR_T099_MUST_NEVER_LEAK"
} > "$REPO_M/scripts/.state/last_resolution.txt"

run_fire "$REPO_M" "$STATE_M" TASKS=1 ATTEMPTS=2 ARBITER_AFTER=5 MOCK_TASK_ID=T036

assert_eq "scenario M: exits 0" "0" "$FIRE_EC"
assert_contains "scenario M: pinned task T036 still accepted normally" "$FIRE_OUT" "LOOP: task T036 accepted"
PROMPT_M1="$STATE_M/claude_prompt_1.txt"
assert_file_exists "scenario M: attempt 1's prompt was captured" "$PROMPT_M1"
assert_not_contains "scenario M: stale resolution content keyed to a DIFFERENT (leftover) task was never fed into T036's prompt" \
  "$(cat "$PROMPT_M1" 2>/dev/null)" "STALE_RESOLUTION_FOR_T099_MUST_NEVER_LEAK"

# ---------------------------------------------------------------------------
echo ""
echo "== Scenario N: partial/corrupted rejection state (no key header) is never injected =="
REPO_N=$(new_scratch_repo scenario_n)
STATE_N=$(mktemp -d)
printf 'ACCEPT\n' > "$STATE_N/claude_sequence.txt"
printf 'ACCEPT\n' > "$STATE_N/review_sequence.txt"
mkdir -p "$REPO_N/scripts/.state"
printf 'T036\n' > "$REPO_N/scripts/.state/current_task.txt"
printf 'PARTIAL_CONTENT_NO_HEADER_MARKER_MUST_NEVER_LEAK\n' > "$REPO_N/scripts/.state/last_rejection.txt"

run_fire "$REPO_N" "$STATE_N" TASKS=1 ATTEMPTS=2 ARBITER_AFTER=5 MOCK_TASK_ID=T036

assert_eq "scenario N: exits 0" "0" "$FIRE_EC"
assert_contains "scenario N: pinned task T036 still accepted normally" "$FIRE_OUT" "LOOP: task T036 accepted"
PROMPT_N1="$STATE_N/claude_prompt_1.txt"
assert_file_exists "scenario N: attempt 1's prompt was captured" "$PROMPT_N1"
assert_not_contains "scenario N: a partial/corrupted rejection file with no key header was never fed into T036's prompt" \
  "$(cat "$PROMPT_N1" 2>/dev/null)" "PARTIAL_CONTENT_NO_HEADER_MARKER_MUST_NEVER_LEAK"

# ---------------------------------------------------------------------------
echo ""
echo "== Scenario O: malformed (non-first-line) task id that is the ONE UNIQUE marker and matches the pin is normalized, never a pin violation or trusted escalation =="
# Superseded expectation (pre real-output hardening): this exact shape used
# to be flagged PIN_VIOLATION because extract_task_id is strict about the
# literal first line. Per the real-output hardening, a task id that appears
# later is normalized when it is the ONE UNIQUE marker and matches the pin
# -- and because the output still violated the format contract, its
# attached (real-category) escalation marker must never be trusted either;
# the executor's actual work goes through normal independent review instead
# (see also Scenario AB, which covers the same rule from lib_governance.sh's
# side with a different mock shape).
REPO_O=$(new_scratch_repo scenario_o)
STATE_O=$(mktemp -d)
printf 'MALFORMED_ESCALATION\n' > "$STATE_O/claude_sequence.txt"
printf 'ACCEPT\n' > "$STATE_O/review_sequence.txt"
mkdir -p "$REPO_O/scripts/.state"
printf 'T036\n' > "$REPO_O/scripts/.state/current_task.txt"

run_fire "$REPO_O" "$STATE_O" TASKS=1 ATTEMPTS=2 ARBITER_AFTER=99 MOCK_TASK_ID=T036

assert_eq "scenario O: exits 0" "0" "$FIRE_EC"
assert_contains "scenario O: the one unique, pin-matching late marker is normalized" "$FIRE_OUT" "normalizing the task id"
assert_not_contains "scenario O: never flagged as a pin violation once normalized" "$FIRE_OUT" "KEMFAI_RESULT: PIN_VIOLATION"
assert_not_contains "scenario O: never treated as an owner escalation just because the executor attached the marker" \
  "$FIRE_OUT" "stop=owner_escalation"
assert_not_contains "scenario O: docs/PROGRESS.md never records a bogus escalation for normalized-but-non-conforming output" \
  "$(cat "$REPO_O/docs/PROGRESS.md")" "OWNER ESCALATION"
assert_contains "scenario O: sent through normal independent review and accepted on the first attempt" "$FIRE_OUT" "LOOP: task T036 accepted"

# ---------------------------------------------------------------------------
echo ""
echo "== Scenario P: absent first-line task id + valid-looking escalation marker is STILL a pin violation (blocker #1) =="
REPO_P=$(new_scratch_repo scenario_p)
STATE_P=$(mktemp -d)
printf 'ABSENT_ID_ESCALATION\nACCEPT\n' > "$STATE_P/claude_sequence.txt"
printf 'ACCEPT\n' > "$STATE_P/review_sequence.txt"
mkdir -p "$REPO_P/scripts/.state"
printf 'T036\n' > "$REPO_P/scripts/.state/current_task.txt"

run_fire "$REPO_P" "$STATE_P" TASKS=1 ATTEMPTS=2 ARBITER_AFTER=99 MOCK_TASK_ID=T036

assert_eq "scenario P: exits 0" "0" "$FIRE_EC"
assert_contains "scenario P: absent first-line task id with a real-category escalation marker is still flagged PIN_VIOLATION" \
  "$FIRE_OUT" "KEMFAI_RESULT: PIN_VIOLATION"
assert_not_contains "scenario P: never treated as an owner escalation just because the executor attached the marker" \
  "$FIRE_OUT" "stop=owner_escalation"
assert_not_contains "scenario P: docs/PROGRESS.md never records a bogus escalation for a pin-violating attempt with no id line" \
  "$(cat "$REPO_P/docs/PROGRESS.md")" "OWNER ESCALATION"
assert_contains "scenario P: SAME pinned task eventually accepted" "$FIRE_OUT" "LOOP: task T036 accepted"

# ---------------------------------------------------------------------------
echo ""
echo "== Scenario Q: arbiter ESCALATE classified as PRODUCT_SCOPE stops for real owner attention (blocker #2) =="
REPO_Q=$(new_scratch_repo scenario_q)
STATE_Q=$(mktemp -d)
printf 'ACCEPT\nACCEPT\n' > "$STATE_Q/claude_sequence.txt"
printf 'REJECT\nREJECT\n' > "$STATE_Q/review_sequence.txt"
printf 'ESCALATE_PRODUCT_SCOPE\n' > "$STATE_Q/arbiter_sequence.txt"

run_fire "$REPO_Q" "$STATE_Q" TASKS=1 ATTEMPTS=2 ARBITER_AFTER=2 MOCK_TASK_ID=T036

assert_eq "scenario Q: exits 0" "0" "$FIRE_EC"
assert_contains "scenario Q: arbiter ESCALATE with PRODUCT_SCOPE content stops the loop for real owner attention" \
  "$FIRE_OUT" "stop=owner_escalation_via_arbiter"
assert_contains "scenario Q: docs/PROGRESS.md records the classified PRODUCT_SCOPE category" \
  "$(cat "$REPO_Q/docs/PROGRESS.md")" "Category: PRODUCT_SCOPE"

# ---------------------------------------------------------------------------
echo ""
echo "== Scenario R: arbiter ESCALATE classified as ACCOUNTING_TAX stops for real owner attention (blocker #2) =="
REPO_R=$(new_scratch_repo scenario_r)
STATE_R=$(mktemp -d)
printf 'ACCEPT\nACCEPT\n' > "$STATE_R/claude_sequence.txt"
printf 'REJECT\nREJECT\n' > "$STATE_R/review_sequence.txt"
printf 'ESCALATE_ACCOUNTING_TAX\n' > "$STATE_R/arbiter_sequence.txt"

run_fire "$REPO_R" "$STATE_R" TASKS=1 ATTEMPTS=2 ARBITER_AFTER=2 MOCK_TASK_ID=T036

assert_eq "scenario R: exits 0" "0" "$FIRE_EC"
assert_contains "scenario R: arbiter ESCALATE with ACCOUNTING_TAX content stops the loop for real owner attention" \
  "$FIRE_OUT" "stop=owner_escalation_via_arbiter"
assert_contains "scenario R: docs/PROGRESS.md records the classified ACCOUNTING_TAX category" \
  "$(cat "$REPO_R/docs/PROGRESS.md")" "Category: ACCOUNTING_TAX"

# ---------------------------------------------------------------------------
echo ""
echo "== Scenario S: arbiter ESCALATE classified as LEGAL_COMPLIANCE stops for real owner attention (blocker #2) =="
REPO_S=$(new_scratch_repo scenario_s)
STATE_S=$(mktemp -d)
printf 'ACCEPT\nACCEPT\n' > "$STATE_S/claude_sequence.txt"
printf 'REJECT\nREJECT\n' > "$STATE_S/review_sequence.txt"
printf 'ESCALATE_LEGAL_COMPLIANCE\n' > "$STATE_S/arbiter_sequence.txt"

run_fire "$REPO_S" "$STATE_S" TASKS=1 ATTEMPTS=2 ARBITER_AFTER=2 MOCK_TASK_ID=T036

assert_eq "scenario S: exits 0" "0" "$FIRE_EC"
assert_contains "scenario S: arbiter ESCALATE with LEGAL_COMPLIANCE content stops the loop for real owner attention" \
  "$FIRE_OUT" "stop=owner_escalation_via_arbiter"
assert_contains "scenario S: docs/PROGRESS.md records the classified LEGAL_COMPLIANCE category" \
  "$(cat "$REPO_S/docs/PROGRESS.md")" "Category: LEGAL_COMPLIANCE"

# ---------------------------------------------------------------------------
echo ""
echo "== Scenario T: fake technical arbiter ESCALATE (no real category) is downgraded, loop continues SAME task (blocker #2) =="
REPO_T=$(new_scratch_repo scenario_t)
STATE_T=$(mktemp -d)
printf 'ACCEPT\nACCEPT\nACCEPT\n' > "$STATE_T/claude_sequence.txt"
printf 'REJECT\nREJECT\nACCEPT\n' > "$STATE_T/review_sequence.txt"
printf 'ESCALATE_FAKE_TECH\n' > "$STATE_T/arbiter_sequence.txt"

run_fire "$REPO_T" "$STATE_T" TASKS=1 ATTEMPTS=3 ARBITER_AFTER=2 MOCK_TASK_ID=T036

assert_eq "scenario T: exits 0" "0" "$FIRE_EC"
assert_contains "scenario T: arbiter ESCALATE with no real category is treated as a technical setback, not owner escalation" \
  "$FIRE_OUT" "treating as an ordinary technical setback"
assert_not_contains "scenario T: never stops the loop for owner attention on a fake arbiter escalation" \
  "$FIRE_OUT" "stop=owner_escalation"
assert_contains "scenario T: SAME task keeps retrying and is eventually accepted" "$FIRE_OUT" "LOOP: task T036 accepted"
assert_not_contains "scenario T: docs/PROGRESS.md never records a fake arbiter escalation" \
  "$(cat "$REPO_T/docs/PROGRESS.md")" "OWNER ESCALATION via arbiter"

# ---------------------------------------------------------------------------
echo ""
echo "== Scenario U: executor's own overbroad-keyword false-positive escalation is downgraded (governance blocker regression) =="
# An executor KEMFAI_OWNER_ESCALATION marker that merely mentions invoice/
# ledger/customer contract/pricing in ordinary technical wording must
# downgrade to a technical setback, exactly like scenario I's fake
# escalation -- applying the (category) fix identically on the executor
# side, not just the arbiter side.
REPO_U=$(new_scratch_repo scenario_u)
STATE_U=$(mktemp -d)
printf 'FALSE_POSITIVE_ESCALATION\nACCEPT\n' > "$STATE_U/claude_sequence.txt"
printf 'ACCEPT\n' > "$STATE_U/review_sequence.txt"

run_fire "$REPO_U" "$STATE_U" TASKS=1 ATTEMPTS=2 ARBITER_AFTER=5 MOCK_TASK_ID=T036

assert_eq "scenario U: exits 0" "0" "$FIRE_EC"
assert_contains "scenario U: overbroad-keyword (invoice/ledger/pricing/customer contract) executor escalation is intercepted as an ordinary technical setback" \
  "$FIRE_OUT" "setback #1 for task T036 (TECH_QUESTION)"
assert_not_contains "scenario U: never stops the loop for owner attention on an overbroad-keyword false positive" \
  "$FIRE_OUT" "stop=owner_escalation"
assert_contains "scenario U: SAME task retried and accepted" "$FIRE_OUT" "LOOP: task T036 accepted"
assert_not_contains "scenario U: docs/PROGRESS.md never records a false-positive escalation" \
  "$(cat "$REPO_U/docs/PROGRESS.md")" "OWNER ESCALATION"

# ---------------------------------------------------------------------------
echo ""
echo "== Scenario V: arbiter's overbroad-keyword false-positive ESCALATE is downgraded (governance blocker regression) =="
# Same false-positive wording as scenario U, but arriving via the arbiter's
# ESCALATE verdict instead of the executor's own marker -- confirms the
# (category) fix applies identically to executor and arbiter.
REPO_V=$(new_scratch_repo scenario_v)
STATE_V=$(mktemp -d)
printf 'ACCEPT\nACCEPT\nACCEPT\n' > "$STATE_V/claude_sequence.txt"
printf 'REJECT\nREJECT\nACCEPT\n' > "$STATE_V/review_sequence.txt"
printf 'ESCALATE_FALSE_POSITIVE_TECH\n' > "$STATE_V/arbiter_sequence.txt"

run_fire "$REPO_V" "$STATE_V" TASKS=1 ATTEMPTS=3 ARBITER_AFTER=2 MOCK_TASK_ID=T036

assert_eq "scenario V: exits 0" "0" "$FIRE_EC"
assert_contains "scenario V: arbiter ESCALATE mentioning invoice/ledger/pricing/customer contract in technical wording is treated as an ordinary technical setback" \
  "$FIRE_OUT" "treating as an ordinary technical setback"
assert_not_contains "scenario V: never stops the loop for owner attention on an overbroad-keyword arbiter false positive" \
  "$FIRE_OUT" "stop=owner_escalation"
assert_contains "scenario V: SAME task keeps retrying and is eventually accepted" "$FIRE_OUT" "LOOP: task T036 accepted"
assert_not_contains "scenario V: docs/PROGRESS.md never records a false-positive arbiter escalation" \
  "$(cat "$REPO_V/docs/PROGRESS.md")" "OWNER ESCALATION via arbiter"

# ---------------------------------------------------------------------------
echo ""
echo "== Scenario W: arbiter ESCALATE classified as LOCKED_BASELINE stops for real owner attention (blocker #2) =="
REPO_W=$(new_scratch_repo scenario_w)
STATE_W=$(mktemp -d)
printf 'ACCEPT\nACCEPT\n' > "$STATE_W/claude_sequence.txt"
printf 'REJECT\nREJECT\n' > "$STATE_W/review_sequence.txt"
printf 'ESCALATE_LOCKED_BASELINE\n' > "$STATE_W/arbiter_sequence.txt"

run_fire "$REPO_W" "$STATE_W" TASKS=1 ATTEMPTS=2 ARBITER_AFTER=2 MOCK_TASK_ID=T036

assert_eq "scenario W: exits 0" "0" "$FIRE_EC"
assert_contains "scenario W: arbiter ESCALATE with LOCKED_BASELINE content stops the loop for real owner attention" \
  "$FIRE_OUT" "stop=owner_escalation_via_arbiter"
assert_contains "scenario W: docs/PROGRESS.md records the classified LOCKED_BASELINE category" \
  "$(cat "$REPO_W/docs/PROGRESS.md")" "Category: LOCKED_BASELINE"

# ---------------------------------------------------------------------------
echo ""
echo "== Scenario X: a >300KB keyed arbiter resolution never triggers E2BIG and reaches the mocked executor via file/stdin, intact to its far end =="
# Regression test for the actual production incident: a real
# scripts/.state/last_resolution.txt was 372046 bytes. The old design
# exported its content as KEMFAI_ARBITER_RESOLUTION and execve'd
# `bash run_next_step.sh` -- a single environment string over Linux's
# MAX_ARG_STRLEN (~128KB) fails with E2BIG before any executor runs. If that
# regressed, this fire would fail non-zero (or claude_prompt_1.txt would
# never be created at all) instead of completing normally.
REPO_X=$(new_scratch_repo scenario_x)
STATE_X=$(mktemp -d)
mkdir -p "$REPO_X/scripts/.state"
printf 'T036\n' > "$REPO_X/scripts/.state/current_task.txt"
BIG_RESOLUTION=$(head -c 320000 /dev/zero | tr '\0' 'r')
BIG_RESOLUTION="${BIG_RESOLUTION}
FAR_END_UNIQUE_MARKER_ZZZ999"
(
  cd "$REPO_X"
  # shellcheck disable=SC1091
  source scripts/lib_governance.sh
  write_task_keyed_state "scripts/.state/last_resolution.txt" "T036" "$BIG_RESOLUTION"
)
KEYED_SIZE=$(wc -c < "$REPO_X/scripts/.state/last_resolution.txt")
printf 'ACCEPT\n' > "$STATE_X/claude_sequence.txt"
printf 'ACCEPT\n' > "$STATE_X/review_sequence.txt"

run_fire "$REPO_X" "$STATE_X" TASKS=1 ATTEMPTS=1 ARBITER_AFTER=5 MOCK_TASK_ID=T036

assert_eq "scenario X: seeded resolution file is genuinely >300KB (production incident size class)" "1" "$([ "$KEYED_SIZE" -gt 300000 ] && echo 1 || echo 0)"
assert_eq "scenario X: run_loop does not crash (no E2BIG) despite a >300KB keyed resolution" "0" "$FIRE_EC"
assert_contains "scenario X: pinned task resumed normally" "$FIRE_OUT" "resuming pinned task T036"
assert_contains "scenario X: SAME pinned task accepted with the huge resolution fed to the executor" "$FIRE_OUT" "LOOP: task T036 accepted"
PROMPT_X1="$STATE_X/claude_prompt_1.txt"
assert_file_exists "scenario X: attempt 1's prompt was captured (proves the executor actually ran, not blocked by E2BIG)" "$PROMPT_X1"
assert_contains "scenario X: the far end (300KB+ in) of the huge resolution reached the mocked executor via file/stdin intact" \
  "$(cat "$PROMPT_X1" 2>/dev/null)" "FAR_END_UNIQUE_MARKER_ZZZ999"

# ---------------------------------------------------------------------------
echo ""
echo "== Scenario Y: a >300KB STALE resolution keyed to a DIFFERENT task never leaks into the pinned task's prompt =="
REPO_Y=$(new_scratch_repo scenario_y)
STATE_Y=$(mktemp -d)
mkdir -p "$REPO_Y/scripts/.state"
printf 'T036\n' > "$REPO_Y/scripts/.state/current_task.txt"
BIG_STALE=$(head -c 320000 /dev/zero | tr '\0' 's')
BIG_STALE="${BIG_STALE}
STALE_FAR_END_MARKER_MUST_NEVER_LEAK_888"
(
  cd "$REPO_Y"
  # shellcheck disable=SC1091
  source scripts/lib_governance.sh
  write_task_keyed_state "scripts/.state/last_resolution.txt" "T099" "$BIG_STALE"
)
printf 'ACCEPT\n' > "$STATE_Y/claude_sequence.txt"
printf 'ACCEPT\n' > "$STATE_Y/review_sequence.txt"

run_fire "$REPO_Y" "$STATE_Y" TASKS=1 ATTEMPTS=1 ARBITER_AFTER=5 MOCK_TASK_ID=T036

assert_eq "scenario Y: exits 0" "0" "$FIRE_EC"
assert_contains "scenario Y: pinned task T036 still accepted normally" "$FIRE_OUT" "LOOP: task T036 accepted"
PROMPT_Y1="$STATE_Y/claude_prompt_1.txt"
assert_file_exists "scenario Y: attempt 1's prompt was captured" "$PROMPT_Y1"
assert_not_contains "scenario Y: a >300KB stale resolution keyed to a DIFFERENT task never reaches T036's prompt" \
  "$(cat "$PROMPT_Y1" 2>/dev/null)" "STALE_FAR_END_MARKER_MUST_NEVER_LEAK_888"

# ---------------------------------------------------------------------------
echo ""
echo "== Scenario Z: independent review/arbiter prompts are fed via stdin, never argv, and no real model/network call occurs =="
# codex_review.sh/codex_arbiter.sh now pipe their prompt via stdin and read
# only the -o/--output-last-message file for the verdict. The mock codex
# captures the stdin it received; assert it actually got the real prompt
# text (not an empty/placeholder argv) and that the persisted rejection
# never contains the mock's simulated discarded transcript noise -- i.e.
# only the final actionable answer survives into governance state.
REPO_Z=$(new_scratch_repo scenario_z)
STATE_Z=$(mktemp -d)
printf 'ACCEPT\nACCEPT\n' > "$STATE_Z/claude_sequence.txt"
printf 'REJECT\nACCEPT\n' > "$STATE_Z/review_sequence.txt"

run_fire "$REPO_Z" "$STATE_Z" TASKS=1 ATTEMPTS=2 ARBITER_AFTER=5 MOCK_TASK_ID=T036

assert_eq "scenario Z: exits 0" "0" "$FIRE_EC"
assert_contains "scenario Z: reviewer was actually invoked and rejected via stdin-fed prompt" "$FIRE_OUT" "setback #1 for task T036 (REJECTED)"
assert_file_exists "scenario Z: codex mock captured a real stdin prompt (proves stdin feed works, not empty argv)" "$STATE_Z/codex_stdin_prompt.txt"
assert_contains "scenario Z: the stdin-fed reviewer prompt contains the real instructions" \
  "$(cat "$STATE_Z/codex_stdin_prompt.txt" 2>/dev/null)" "independent REVIEWER for KEMFAI"
assert_not_contains "scenario Z: discarded Codex transcript/tool-call noise never survives into persisted governance state" \
  "$FIRE_OUT" "MOCK_TRANSCRIPT_NOISE_MARKER"
assert_contains "scenario Z: SAME task retried and accepted" "$FIRE_OUT" "LOOP: task T036 accepted"

# ---------------------------------------------------------------------------
echo ""
echo "== Scenario AA: real-output hardening -- a late (non-first-line) but unique, pin-matching task marker is normalized and sent through normal review =="
REPO_AA=$(new_scratch_repo scenario_aa)
STATE_AA=$(mktemp -d)
mkdir -p "$REPO_AA/scripts/.state"
printf 'T036\n' > "$REPO_AA/scripts/.state/current_task.txt"
printf 'LATE_MARKER_MATCH\n' > "$STATE_AA/claude_sequence.txt"
printf 'ACCEPT\n' > "$STATE_AA/review_sequence.txt"

run_fire "$REPO_AA" "$STATE_AA" TASKS=1 ATTEMPTS=2 ARBITER_AFTER=5 MOCK_TASK_ID=T036

assert_eq "scenario AA: exits 0" "0" "$FIRE_EC"
assert_contains "scenario AA: malformed-but-pin-matching output is normalized instead of discarded" \
  "$FIRE_OUT" "normalizing the task id"
assert_not_contains "scenario AA: never flagged as a pin violation" "$FIRE_OUT" "KEMFAI_RESULT: PIN_VIOLATION"
assert_contains "scenario AA: proceeds through normal independent review and is accepted" "$FIRE_OUT" "LOOP: task T036 accepted"

# ---------------------------------------------------------------------------
echo ""
echo "== Scenario AB: real-output hardening -- a late, unique, pin-matching marker with a REAL-CATEGORY escalation marker is still NOT trusted =="
REPO_AB=$(new_scratch_repo scenario_ab)
STATE_AB=$(mktemp -d)
mkdir -p "$REPO_AB/scripts/.state"
printf 'T036\n' > "$REPO_AB/scripts/.state/current_task.txt"
printf 'LATE_MARKER_MATCH_FAKE_ESCALATION\n' > "$STATE_AB/claude_sequence.txt"
printf 'ACCEPT\n' > "$STATE_AB/review_sequence.txt"

run_fire "$REPO_AB" "$STATE_AB" TASKS=1 ATTEMPTS=2 ARBITER_AFTER=5 MOCK_TASK_ID=T036

assert_eq "scenario AB: exits 0" "0" "$FIRE_EC"
assert_contains "scenario AB: normalized despite the attached escalation marker" "$FIRE_OUT" "normalizing the task id"
assert_not_contains "scenario AB: the escalation marker from non-conforming output is never trusted" "$FIRE_OUT" "stop=owner_escalation"
assert_not_contains "scenario AB: never flagged as a pin violation" "$FIRE_OUT" "KEMFAI_RESULT: PIN_VIOLATION"
assert_contains "scenario AB: sent through normal independent review and accepted instead of escalated" "$FIRE_OUT" "LOOP: task T036 accepted"
assert_not_contains "scenario AB: docs/PROGRESS.md never records a bogus escalation from malformed-but-normalized output" \
  "$(cat "$REPO_AB/docs/PROGRESS.md")" "OWNER ESCALATION"

# ---------------------------------------------------------------------------
echo ""
echo "== Scenario AC: real-output hardening -- MULTIPLE different late markers are never normalized, remain a pin violation =="
REPO_AC=$(new_scratch_repo scenario_ac)
STATE_AC=$(mktemp -d)
mkdir -p "$REPO_AC/scripts/.state"
printf 'T036\n' > "$REPO_AC/scripts/.state/current_task.txt"
printf 'LATE_MARKER_MULTIPLE\nACCEPT\n' > "$STATE_AC/claude_sequence.txt"
printf 'ACCEPT\n' > "$STATE_AC/review_sequence.txt"

run_fire "$REPO_AC" "$STATE_AC" TASKS=1 ATTEMPTS=2 ARBITER_AFTER=99 MOCK_TASK_ID=T036

assert_eq "scenario AC: exits 0" "0" "$FIRE_EC"
assert_not_contains "scenario AC: never normalized when multiple different markers are present" "$FIRE_OUT" "normalizing the task id"
assert_contains "scenario AC: multiple different late markers remain a pin violation" "$FIRE_OUT" "KEMFAI_RESULT: PIN_VIOLATION"
assert_contains "scenario AC: SAME pinned task eventually accepted on retry" "$FIRE_OUT" "LOOP: task T036 accepted"

# ---------------------------------------------------------------------------
echo ""
echo "== Scenario AD: real-output hardening -- a single late marker that MISMATCHES the pin is never normalized, remains a pin violation =="
REPO_AD=$(new_scratch_repo scenario_ad)
STATE_AD=$(mktemp -d)
mkdir -p "$REPO_AD/scripts/.state"
printf 'T036\n' > "$REPO_AD/scripts/.state/current_task.txt"
printf 'LATE_MARKER_MISMATCH\nACCEPT\n' > "$STATE_AD/claude_sequence.txt"
printf 'ACCEPT\n' > "$STATE_AD/review_sequence.txt"

run_fire "$REPO_AD" "$STATE_AD" TASKS=1 ATTEMPTS=2 ARBITER_AFTER=99 MOCK_TASK_ID=T036

assert_eq "scenario AD: exits 0" "0" "$FIRE_EC"
assert_not_contains "scenario AD: never normalized when the single late marker mismatches the pin" "$FIRE_OUT" "normalizing the task id"
assert_contains "scenario AD: mismatched late marker remains a pin violation" "$FIRE_OUT" "KEMFAI_RESULT: PIN_VIOLATION"
assert_contains "scenario AD: SAME pinned task eventually accepted on retry" "$FIRE_OUT" "LOOP: task T036 accepted"

# ---------------------------------------------------------------------------
echo ""
echo "== Scenario AE: repeated identical late task markers are ambiguous and remain a pin violation =="
REPO_AE=$(new_scratch_repo scenario_ae)
STATE_AE=$(mktemp -d)
mkdir -p "$REPO_AE/scripts/.state"
printf 'T036\n' > "$REPO_AE/scripts/.state/current_task.txt"
printf 'LATE_MARKER_DUPLICATE_SAME\nACCEPT\n' > "$STATE_AE/claude_sequence.txt"
printf 'ACCEPT\n' > "$STATE_AE/review_sequence.txt"

run_fire "$REPO_AE" "$STATE_AE" TASKS=1 ATTEMPTS=2 ARBITER_AFTER=99 MOCK_TASK_ID=T036

assert_eq "scenario AE: exits 0" "0" "$FIRE_EC"
assert_not_contains "scenario AE: repeated identical markers are never normalized" "$FIRE_OUT" "normalizing the task id"
assert_contains "scenario AE: repeated identical markers remain a pin violation" "$FIRE_OUT" "KEMFAI_RESULT: PIN_VIOLATION"
assert_contains "scenario AE: SAME pinned task eventually accepted on retry" "$FIRE_OUT" "LOOP: task T036 accepted"

print_summary
