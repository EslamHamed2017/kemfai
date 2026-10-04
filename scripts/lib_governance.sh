#!/usr/bin/env bash
# KEMFAI governance library: pure, deterministic helpers for the durable
# Claude<->Codex technical-resolution loop. Sourced by run_next_step.sh and
# run_loop.sh; also unit-tested directly with no real model calls
# (scripts/tests/test_lib_governance.sh).
#
# Contract enforced by an implement-stage executor's final message:
#   Line 1 (exact, nothing before or after it on that line):
#     KEMFAI_TASK_ID: T### | KEMFAI_TASK_ID: NONE
#   Anywhere else, at most one of (full line, >=8 chars of real content):
#     KEMFAI_TECH_QUESTION: <ordinary technical ambiguity needing arbitration>
#     KEMFAI_OWNER_ESCALATION: <material scope/accounting/legal/locked-baseline>
#
# FINAL-RESPONSE BOUNDARY (20261004-0830 incident fix): every function below
# that takes executor OUTPUT (extract_task_id, extract_unique_task_marker,
# classify_executor_signal, extract_legacy_decision_request) must be fed ONLY
# the executor's final assistant response -- never a tool/command/log
# transcript. Callers enforce this at the executor boundary
# (scripts/run_next_step.sh + scripts/extract_final_response.py); a tool
# result quoting stale Decision-Request text once produced a spurious
# TECH_QUESTION and rolled back a real T049 change before review.
set -uo pipefail

# extract_task_id OUTPUT
# Strict: only the literal first line counts. No skipping leading blank
# lines, no scanning the rest of the message, no trailing text after the ID.
# This is what blocker #2 (recovery_job_state.md) required.
extract_task_id() {
  local first_line
  first_line=$(printf '%s\n' "$1" | head -n1 | tr -d '\r')
  if [[ "$first_line" =~ ^KEMFAI_TASK_ID:\ (T[0-9]{3})$ ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
  elif [[ "$first_line" == "KEMFAI_TASK_ID: NONE" ]]; then
    printf '%s\n' "NONE"
  else
    printf '%s\n' "UNKNOWN"
  fi
}

# extract_unique_task_marker OUTPUT
# Scans the ENTIRE output (any line, not just the mandated first line) for
# full-line "KEMFAI_TASK_ID: T###" or "KEMFAI_TASK_ID: NONE" markers. Prints
# the id and returns 0 only if EXACTLY ONE marker OCCURRENCE appears anywhere;
# prints nothing and returns 1 for zero markers or any repeated/multiple markers,
# even when repeated occurrences carry the same value. (Occurrence semantics,
# not distinct-value semantics: the old sort -u implementation collapsed two
# identical markers into "one" and normalized output that the contract below
# explicitly declares ambiguous -- a pre-existing defect fixed alongside the
# final-response boundary work, in the fail-closed direction.) This backs
# the narrow real-output hardening: a normally-compliant model occasionally
# emits its KEMFAI_TASK_ID marker after some preamble instead of as the
# literal first line. That is still a contract violation and must not be
# silently accepted in general -- but when a task is already pinned and
# exactly one marker occurrence exists and it equals the pin, the caller may
# choose to normalize the task id rather than discard genuinely-correct
# work as an UNKNOWN pin violation. Multiple, mismatched, or wholly absent
# markers are NEVER normalized by this function -- it only ever reports
# "exactly one occurrence or nothing," leaving all ambiguity/mismatch
# judgment to the caller.
extract_unique_task_marker() {
  local output="$1" matches count
  matches=$(printf '%s\n' "$output" | grep -oE '^KEMFAI_TASK_ID: (T[0-9]{3}|NONE)$' || true)
  [ -n "$matches" ] || return 1
  count=$(printf '%s\n' "$matches" | grep -c '^.\+$' || true)
  [ "$count" -eq 1 ] || return 1
  printf '%s\n' "$matches" | sed -E 's/^KEMFAI_TASK_ID: //'
}

# extract_marker OUTPUT PREFIX
# Strict full-line match with a required minimum-length summary. Rejects
# bare category tags (e.g. "PREFIX: TECHNICALITY") and substrings buried in
# prose, per blocker #3 (recovery_job_state.md). Prints the summary text
# only (without the "PREFIX: " part); prints nothing and returns 1 if absent.
extract_marker() {
  local output="$1" prefix="$2" line
  line=$(printf '%s\n' "$output" | grep -E "^${prefix}: .{8,}$" | head -n1) || true
  if [ -z "$line" ]; then
    return 1
  fi
  printf '%s\n' "${line#"${prefix}: "}"
}

# compute_setback STORED_TASK_ID STORED_COUNT CURRENT_TASK_ID
# Prints "NEW_COUNT SHOULD_PERSIST" (space separated).
# Compares stored vs current task id BEFORE deciding whether to increment or
# reset -- this is blocker #1's exact fix (recovery_job_state.md): the old
# code incremented first and compared after, so a different still-pending
# task silently inherited the previous task's count. An UNKNOWN current task
# id (malformed/missing executor output) is never persisted, so it can never
# pollute or inherit a real task's streak.
compute_setback() {
  local stored_id="$1" stored_count="$2" current_id="$3"
  if [ "$current_id" = "UNKNOWN" ]; then
    printf '%s %s\n' "0" "no"
    return 0
  fi
  if [ "$stored_id" = "$current_id" ] && [ -n "$stored_id" ]; then
    printf '%s %s\n' "$((stored_count + 1))" "yes"
  else
    printf '%s %s\n' "1" "yes"
  fi
}

# read_setback_state FILE -> prints "TASK_ID COUNT" (defaults "EMPTY" 0).
# "EMPTY" is a sentinel meaning no state is stored yet; it can never equal a
# real task id or the normalized UNKNOWN/NONE keys used by callers, so a
# fresh/missing state file always reads as "not the same task."
read_setback_state() {
  local file="$1" id="" count="0"
  if [ -f "$file" ]; then
    id=$(awk -F= '$1=="TASK_ID"{print $2}' "$file" | tail -n1)
    count=$(awk -F= '$1=="COUNT"{print $2}' "$file" | tail -n1)
    [[ "$count" =~ ^[0-9]+$ ]] || count=0
  fi
  [ -n "$id" ] || id="EMPTY"
  printf '%s %s\n' "$id" "$count"
}

# write_setback_state FILE TASK_ID COUNT KIND
write_setback_state() {
  local file="$1" id="$2" count="$3" kind="$4"
  {
    printf 'TASK_ID=%s\n' "$id"
    printf 'COUNT=%s\n' "$count"
    printf 'KIND=%s\n' "$kind"
  } > "$file"
}

# --- second-review hardening -------------------------------------------
# The functions below close five independent-review blockers found in the
# durable loop's task-keying and owner-escalation handling:
#   (keying)     last_rejection.txt/last_resolution.txt must be atomically
#                keyed to and validated against current_task.txt so stale,
#                partial, or hand-edited state can never leak into a
#                different or newer task.
#   (pin-first)  pinned-task validation must happen BEFORE any owner-
#                escalation marker is trusted; a mismatched Task ID is a
#                pin violation, never an escalation.
#   (category)   a bare KEMFAI_OWNER_ESCALATION marker is never trusted on
#                its own -- its content must classify against one of the
#                four real categories from AGENTS.md (product scope/
#                behavior, accounting/tax policy, legal/compliance, or a
#                locked-baseline change). Anything else is downgraded to an
#                ordinary technical setback.
#   (legacy-DR)  a legacy/plain "Decision Request" (still documented in
#                AGENTS.md/constitution.md) must be intercepted even when
#                the executor omits KEMFAI_TECH_QUESTION, classified the
#                same way, and never allowed to fall through to review/
#                commit/skip untouched.
#   (no-trunc)   reviewer blockers and arbiter resolutions must survive
#                end-to-end without an arbitrary 4K/6K cut; only a large
#                global safety ceiling (KEMFAI_STATE_MAX_BYTES) applies.

# KEMFAI_STATE_MAX_BYTES: a disk/memory safety net against pathological or
# runaway output -- NOT a feedback-fidelity limit. Ordinary reviewer
# blockers and arbiter resolutions (even well over 6000 bytes) are always
# written and read back in full; only content anywhere near this ceiling is
# ever capped.
KEMFAI_STATE_MAX_BYTES=${KEMFAI_STATE_MAX_BYTES:-1048576}

# cap_state_content CONTENT -> prints CONTENT unchanged unless it exceeds
# KEMFAI_STATE_MAX_BYTES, in which case it is cut to that many bytes with a
# trailing, explicit marker noting the cap was applied. Never a silent
# 4000/6000-byte truncation of ordinary-sized feedback.
cap_state_content() {
  local content="$1" size
  size=${#content}
  if [ "$size" -le "$KEMFAI_STATE_MAX_BYTES" ]; then
    printf '%s' "$content"
  else
    printf '%s' "${content:0:$KEMFAI_STATE_MAX_BYTES}"
    printf '\n[KEMFAI: content capped at %s bytes for on-disk safety]\n' "$KEMFAI_STATE_MAX_BYTES"
  fi
}

# write_task_keyed_state FILE TASK_ID CONTENT
# Atomically (temp file + rename, so a concurrent reader never observes a
# half-written file) writes CONTENT to FILE prefixed with a
# KEMFAI_STATE_TASK_ID header. This is the "keying" half of the (keying)
# fix: a reader can then validate the content actually belongs to the task
# it is about to be fed back into before trusting it.
write_task_keyed_state() {
  local file="$1" task_id="$2" content="$3" tmp
  tmp=$(mktemp "${file}.XXXXXX")
  {
    printf 'KEMFAI_STATE_TASK_ID: %s\n' "$task_id"
    cap_state_content "$content"
    printf '\n'
  } > "$tmp"
  mv -f "$tmp" "$file"
}

# read_task_keyed_state FILE EXPECTED_TASK_ID
# Prints the content ONLY if the file's stored task id exactly matches
# EXPECTED_TASK_ID; returns 1 (prints nothing) otherwise. This covers every
# stale/partial/manual case from the (keying) fix:
#   - a different (stale) task's leftover feedback: stored id != expected.
#   - a partially written/corrupted/hand-edited file with no valid
#     "KEMFAI_STATE_TASK_ID: <id>" first line: no match, rejected outright.
#   - a missing file, or no task currently pinned: nothing to read.
read_task_keyed_state() {
  local file="$1" expected="$2" first_line stored_id
  [ -n "$expected" ] || return 1
  [ -f "$file" ] || return 1
  first_line=$(head -n1 "$file" 2>/dev/null | tr -d '\r')
  if [[ "$first_line" =~ ^KEMFAI_STATE_TASK_ID:\ (.+)$ ]]; then
    stored_id="${BASH_REMATCH[1]}"
  else
    return 1
  fi
  [ "$stored_id" = "$expected" ] || return 1
  tail -n +2 "$file"
}

# read_task_keyed_state_to_file FILE EXPECTED_TASK_ID OUT_FILE
# Same validation as read_task_keyed_state, but streams the validated
# content straight to OUT_FILE on disk instead of returning it as a shell
# string. This is the core of the E2BIG fix: callers (run_loop.sh) that
# used to do `VAR=$(read_task_keyed_state ...); export VAR` were exporting
# arbitrarily large (here, 372KB) resolution/rejection content as a single
# environment string, and execve() rejects any single argv/envp string over
# Linux's MAX_ARG_STRLEN (~128KB) with E2BIG -- so every subsequent `bash
# run_next_step.sh` invocation failed before any executor even ran. Callers
# now export only OUT_FILE's path (always small) and let the executor read
# the content itself via stdin/cat, so there is no size at which this can
# ever hit an OS argument/environment limit again.
# Prints nothing; returns 0 and writes OUT_FILE only on a valid key match
# (missing/stale/partial input leaves OUT_FILE untouched), 1 otherwise.
read_task_keyed_state_to_file() {
  local file="$1" expected="$2" out_file="$3" first_line stored_id
  [ -n "$expected" ] || return 1
  [ -f "$file" ] || return 1
  first_line=$(head -n1 "$file" 2>/dev/null | tr -d '\r')
  if [[ "$first_line" =~ ^KEMFAI_STATE_TASK_ID:\ (.+)$ ]]; then
    stored_id="${BASH_REMATCH[1]}"
  else
    return 1
  fi
  [ "$stored_id" = "$expected" ] || return 1
  tail -n +2 "$file" > "$out_file"
  return 0
}

# classify_owner_escalation TEXT
# Deterministic classifier for the (category) fix: prints one of
# PRODUCT_SCOPE, ACCOUNTING_TAX, LEGAL_COMPLIANCE, LOCKED_BASELINE and
# returns 0 if TEXT plausibly names one of the four real owner-escalation
# categories from AGENTS.md; returns 1 (prints nothing) for ordinary
# technical content. Callers must downgrade a failed classification to an
# ordinary technical setback -- a KEMFAI_OWNER_ESCALATION marker (or a
# legacy Decision Request) is never trusted just because it exists.
#
# Deliberately NOT a bare single-keyword match. An earlier version matched
# on any occurrence of words like "invoice", "ledger", "pricing", or
# "customer contract" -- so ordinary technical work (an invoice schema
# migration, a ledger table index, a pricing microservice refactor, a
# customer contract DTO field) was falsely flagged as an owner escalation.
# Each category below instead requires wording that names an actual
# POLICY/TREATMENT/RATE/OBLIGATION/EXPOSURE/SCOPE *decision*, not just a
# domain noun: e.g. "tax policy"/"tax rate" (not bare "tax field"/"invoice"),
# "legal counsel"/"regulatory compliance exposure" (not bare "contract DTO"),
# a material product-behavior/scope change, or an explicit locked-baseline
# change. Ordinary API/schema/migration/index/DTO/UI/test/refactor work that
# happens to mention these domains must still classify as technical.
classify_owner_escalation() {
  local text="$1" lower
  lower=$(printf '%s' "$text" | tr '[:upper:]' '[:lower:]')

  # ACCOUNTING_TAX: an accounting or tax POLICY/TREATMENT/RATE decision.
  # Never bare "invoice", "ledger", "schema", "table", or "tax field".
  if printf '%s' "$lower" | grep -qE \
    '(\btax (policy|treatment|rate|rules?|law)\b|\btaxation (policy|treatment)\b|\baccounting (policy|treatment|standard|method)\b|revenue recognition|\bgaap\b|\bifrs\b|financial statement|\bvat (rate|policy|treatment|registration)\b|billing (policy|behavior|rate|cycle)|pricing (policy|model|strategy|structure|change|decision)|price (tier|change|plan)|plan tier|entitlement (limit|value)|trial (length|period))'; then
    printf '%s\n' "ACCOUNTING_TAX"
    return 0
  fi

  # LEGAL_COMPLIANCE: a legal-counsel or regulatory-compliance
  # OBLIGATION/EXPOSURE decision. Never bare "contract", "DTO", or "API".
  if printf '%s' "$lower" | grep -qE \
    '(legal counsel|legal (review|sign-?off|advice|opinion|risk)|regulatory (compliance|obligation|exposure|requirement|risk)|compliance (obligation|exposure|requirement|risk)|\bgdpr\b.{0,40}(complian|obligat|exposure|requirement|breach|risk|consent)|(complian|obligat|exposure|requirement|breach|risk|consent).{0,40}\bgdpr\b|privacy policy (change|update|decision|revision)|data protection (obligation|requirement|exposure|decision)|audit requirement|liabilit(y|ies) (exposure|risk)|customer contract.{0,40}(obligation|exposure|liabilit|breach|terms exposure)|(obligation|exposure|liabilit|breach).{0,40}customer contract|terms of service (change|update|revision|decision))'; then
    printf '%s\n' "LEGAL_COMPLIANCE"
    return 0
  fi

  if printf '%s' "$lower" | grep -qE \
    '(locked baseline|gate0_decisions|ratified constitution|locked decision|change the locked stack|core stack change)'; then
    printf '%s\n' "LOCKED_BASELINE"
    return 0
  fi

  if printf '%s' "$lower" | grep -qE \
    '(product scope|scope change|business requirement|customer-facing behavior|feature scope|requirement change|out of scope|new product capability|changes (existing )?behavior for (customers|users)|material (product|behavior) change)'; then
    printf '%s\n' "PRODUCT_SCOPE"
    return 0
  fi

  return 1
}

# extract_legacy_decision_request OUTPUT
# Detects the legacy/plain "Decision Request" pattern still documented in
# AGENTS.md ("If ambiguous, raise a Decision Request") and
# constitution.md, for executors that comply with that older instruction
# instead of (or in addition to) emitting KEMFAI_TECH_QUESTION (the
# (legacy-DR) fix). Matches only affirmative announcements -- a heading
# ("## Decision Request - ..."), an explicit "raise/raising/file/filed a
# Decision Request", or "Decision Request:" followed by content -- so
# prose that merely references the concept in passing (e.g. "no Decision
# Request was needed") is never misfired on. Prints from the matching line
# to the end of OUTPUT; returns 1 (prints nothing) if no such line exists.
extract_legacy_decision_request() {
  local output="$1" line_no
  line_no=$(printf '%s\n' "$output" | grep -inE \
    '(^#{0,6}[[:space:]]*Decision Request\b|\b(raising|raise|filing|filed)[[:space:]]+an?[[:space:]]+Decision Request\b|Decision Request:[[:space:]]*[^[:space:]])' \
    | head -n1 | cut -d: -f1)
  if [ -z "$line_no" ]; then
    return 1
  fi
  printf '%s\n' "$output" | tail -n "+$line_no"
}

# classify_executor_signal OUTPUT -> prints "KIND\nCATEGORY\nTEXT" (KIND:
# OWNER_ESCALATION|TECH_QUESTION|NONE; CATEGORY is one of
# classify_owner_escalation's labels or the literal NONE). Returns 1 for
# KIND=NONE. This is the single, testable decision point combining the
# (pin-first ordering is the caller's job -- see run_next_step.sh),
# (category), and (legacy-DR) fixes:
#   1. A strict KEMFAI_OWNER_ESCALATION marker is category-validated; if it
#      doesn't classify, its content is treated as an ordinary
#      KEMFAI_TECH_QUESTION instead (never trusted on its own).
#   2. Else a strict KEMFAI_TECH_QUESTION marker is used as-is.
#   3. Else a legacy plain Decision Request (no strict marker at all) is
#      detected, category-validated the same way, and always intercepted
#      as either OWNER_ESCALATION or TECH_QUESTION -- never left to fall
#      through to the normal review/commit/skip path.
#   4. Else there is no actionable signal at all.
classify_executor_signal() {
  local output="$1" owner_raw tech_raw legacy_raw category
  owner_raw=$(extract_marker "$output" "KEMFAI_OWNER_ESCALATION" 2>/dev/null || true)
  if [ -n "$owner_raw" ]; then
    if category=$(classify_owner_escalation "$owner_raw"); then
      printf 'OWNER_ESCALATION\n%s\n%s\n' "$category" "$owner_raw"
    else
      printf 'TECH_QUESTION\nNONE\n%s\n' "$owner_raw"
    fi
    return 0
  fi

  tech_raw=$(extract_marker "$output" "KEMFAI_TECH_QUESTION" 2>/dev/null || true)
  if [ -n "$tech_raw" ]; then
    printf 'TECH_QUESTION\nNONE\n%s\n' "$tech_raw"
    return 0
  fi

  legacy_raw=$(extract_legacy_decision_request "$output" 2>/dev/null || true)
  if [ -n "$legacy_raw" ]; then
    if category=$(classify_owner_escalation "$legacy_raw"); then
      printf 'OWNER_ESCALATION\n%s\n%s\n' "$category" "$legacy_raw"
    else
      printf 'TECH_QUESTION\nNONE\n%s\n' "$legacy_raw"
    fi
    return 0
  fi

  printf 'NONE\nNONE\n\n'
  return 1
}
