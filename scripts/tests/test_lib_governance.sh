#!/usr/bin/env bash
# Deterministic unit tests for scripts/lib_governance.sh. No git, no model
# calls -- pure function tests. Regression-tests the three exact blockers
# from scripts/.state/recovery_job_state.md's rejected prior attempt:
#   1. setback counter must compare stored-vs-current task id BEFORE
#      incrementing, so a different/unknown task never inherits a streak.
#   2. Task-ID parsing must require the mandated line to be the literal
#      first line, with no leading blank lines and no trailing text.
#   3. Marker parsing must require an exact full-line match with real
#      content, not a bare category tag or a substring buried in prose.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
# shellcheck disable=SC1091
source "$HERE/lib_test_helpers.sh"
# shellcheck disable=SC1091
source "$REPO/scripts/lib_governance.sh"

echo "== extract_task_id =="

assert_eq "exact first line T### is accepted" \
  "T036" "$(extract_task_id $'KEMFAI_TASK_ID: T036\nsome other text')"

assert_eq "exact first line NONE is accepted" \
  "NONE" "$(extract_task_id $'KEMFAI_TASK_ID: NONE\nno progress')"

assert_eq "blocker #2: leading blank line before the marker is UNKNOWN (not skipped)" \
  "UNKNOWN" "$(extract_task_id $'\nKEMFAI_TASK_ID: T036\nsome text')"

assert_eq "blocker #2: trailing text after the ID on the same line is UNKNOWN" \
  "UNKNOWN" "$(extract_task_id $'KEMFAI_TASK_ID: T036 — public plan page\nmore text')"

assert_eq "markdown-decorated prose claiming a task id is UNKNOWN" \
  "UNKNOWN" "$(extract_task_id $'Implemented Task ID: **T036** — plan page\nmore text')"

assert_eq "malformed id (not 3 digits) is UNKNOWN" \
  "UNKNOWN" "$(extract_task_id $'KEMFAI_TASK_ID: T36\ntext')"

assert_eq "marker found later in the message (not first line) is UNKNOWN" \
  "UNKNOWN" "$(extract_task_id $'Some preamble.\nKEMFAI_TASK_ID: T036')"

echo ""
echo "== extract_marker =="

OWNER_MSG=$'Some analysis text.\nKEMFAI_OWNER_ESCALATION: New plan tier changes billing behavior\nmore text'
assert_eq "well-formed full-line marker returns its content" \
  "New plan tier changes billing behavior" "$(extract_marker "$OWNER_MSG" "KEMFAI_OWNER_ESCALATION")"

BARE_TAG=$'Category considered: DECISION REQUEST: TECHNICALITY\nrest of message'
if extract_marker "$BARE_TAG" "KEMFAI_OWNER_ESCALATION" >/dev/null 2>&1; then
  RESULT="matched"
else
  RESULT="no-match"
fi
assert_eq "blocker #3: unrelated bare category tag never matches a different marker prefix" \
  "no-match" "$RESULT"

SUBSTRING_IN_PROSE=$'We discussed KEMFAI_TECH_QUESTION: mid-sentence but this is not a real marker line.'
if extract_marker "$SUBSTRING_IN_PROSE" "KEMFAI_TECH_QUESTION" >/dev/null 2>&1; then
  RESULT="matched"
else
  RESULT="no-match"
fi
assert_eq "blocker #3: marker substring embedded mid-line (not anchored) does not match" \
  "no-match" "$RESULT"

EMPTY_CONTENT=$'KEMFAI_TECH_QUESTION:\nrest'
if extract_marker "$EMPTY_CONTENT" "KEMFAI_TECH_QUESTION" >/dev/null 2>&1; then
  RESULT="matched"
else
  RESULT="no-match"
fi
assert_eq "blocker #3: marker with no content after the colon does not match" \
  "no-match" "$RESULT"

SHORT_CONTENT=$'KEMFAI_TECH_QUESTION: too\nrest'
if extract_marker "$SHORT_CONTENT" "KEMFAI_TECH_QUESTION" >/dev/null 2>&1; then
  RESULT="matched"
else
  RESULT="no-match"
fi
assert_eq "blocker #3: marker with a trivially short summary does not match" \
  "no-match" "$RESULT"

NO_MARKER=$'Nothing to see here.\nJust prose.'
if extract_marker "$NO_MARKER" "KEMFAI_OWNER_ESCALATION" >/dev/null 2>&1; then
  RESULT="matched"
else
  RESULT="no-match"
fi
assert_eq "absent marker returns no match" "no-match" "$RESULT"

echo ""
echo "== compute_setback (blocker #1) =="

read -r COUNT PERSIST < <(compute_setback "EMPTY" "0" "T036")
assert_eq "fresh task with no stored state starts at count 1" "1" "$COUNT"
assert_eq "fresh task with no stored state persists" "yes" "$PERSIST"

read -r COUNT PERSIST < <(compute_setback "T036" "1" "T036")
assert_eq "same task increments the existing count" "2" "$COUNT"
assert_eq "same task persists" "yes" "$PERSIST"

read -r COUNT PERSIST < <(compute_setback "T036" "2" "T099")
assert_eq "blocker #1: a DIFFERENT task resets to 1, never inheriting the prior task's count" "1" "$COUNT"
assert_eq "different task still persists (keyed to itself)" "yes" "$PERSIST"

read -r COUNT PERSIST < <(compute_setback "T036" "2" "UNKNOWN")
assert_eq "blocker #1: an UNKNOWN current task id is never counted" "0" "$COUNT"
assert_eq "blocker #1: an UNKNOWN current task id is never persisted (cannot pollute a real task's streak)" "no" "$PERSIST"

echo ""
echo "== read_setback_state / write_setback_state round-trip =="

TMP_STATE_FILE=$(mktemp)
trap 'rm -f "$TMP_STATE_FILE"' EXIT

read -r ID COUNT < <(read_setback_state "$TMP_STATE_FILE")
assert_eq "missing state file reads as sentinel EMPTY id" "EMPTY" "$ID"
assert_eq "missing state file reads as count 0" "0" "$COUNT"

write_setback_state "$TMP_STATE_FILE" "T036" "2" "REJECTED"
read -r ID COUNT < <(read_setback_state "$TMP_STATE_FILE")
assert_eq "round-trip preserves task id" "T036" "$ID"
assert_eq "round-trip preserves count" "2" "$COUNT"

echo ""
echo "== write_task_keyed_state / read_task_keyed_state (keying fix) =="

TMP_KEYED_FILE=$(mktemp)
trap 'rm -f "$TMP_KEYED_FILE"' EXIT

write_task_keyed_state "$TMP_KEYED_FILE" "T036" "1. Fix the bilingual column."
assert_eq "round-trip: content readable for the SAME task id it was keyed to" \
  "1. Fix the bilingual column." "$(read_task_keyed_state "$TMP_KEYED_FILE" "T036")"

if read_task_keyed_state "$TMP_KEYED_FILE" "T099" >/dev/null 2>&1; then
  RESULT="matched"
else
  RESULT="no-match"
fi
assert_eq "stale state: content keyed to a DIFFERENT task never reads for a mismatched task" "no-match" "$RESULT"

rm -f "$TMP_KEYED_FILE"
if read_task_keyed_state "$TMP_KEYED_FILE" "T036" >/dev/null 2>&1; then
  RESULT="matched"
else
  RESULT="no-match"
fi
assert_eq "missing state file never reads as valid content for any task" "no-match" "$RESULT"

printf 'This is a partially written/hand-edited file with no key header at all.\n' > "$TMP_KEYED_FILE"
if read_task_keyed_state "$TMP_KEYED_FILE" "T036" >/dev/null 2>&1; then
  RESULT="matched"
else
  RESULT="no-match"
fi
assert_eq "partial state: a file missing the KEMFAI_STATE_TASK_ID header is rejected outright" "no-match" "$RESULT"

if read_task_keyed_state "$TMP_KEYED_FILE" "" >/dev/null 2>&1; then
  RESULT="matched"
else
  RESULT="no-match"
fi
assert_eq "no task pinned (empty expected id) never reads any content" "no-match" "$RESULT"

BIG_CONTENT=$(head -c 8000 /dev/zero | tr '\0' 'x')
write_task_keyed_state "$TMP_KEYED_FILE" "T036" "$BIG_CONTENT"
READ_BACK=$(read_task_keyed_state "$TMP_KEYED_FILE" "T036")
assert_eq "no-trunc: an 8000-byte (>6000) feedback body round-trips at full length, no 4K/6K cut" \
  "8000" "${#READ_BACK}"
assert_eq "no-trunc: an 8000-byte feedback body round-trips byte-for-byte" "$BIG_CONTENT" "$READ_BACK"

rm -f "$TMP_KEYED_FILE"

echo ""
echo "== cap_state_content (global file-size safety, not content truncation) =="

SMALL=$(head -c 7000 /dev/zero | tr '\0' 'y')
assert_eq "content well under the safety ceiling passes through unchanged" "$SMALL" "$(cap_state_content "$SMALL")"

TOO_BIG=$(head -c 500 /dev/zero | tr '\0' 'z')
CAPPED=$(KEMFAI_STATE_MAX_BYTES=100 cap_state_content "$TOO_BIG")
assert_contains "only content exceeding the (overridden, small) ceiling is capped, with an explicit marker" \
  "$CAPPED" "[KEMFAI: content capped at 100 bytes"

echo ""
echo "== classify_owner_escalation (category-validation fix) =="

assert_eq "accounting/tax/billing content classifies as ACCOUNTING_TAX" \
  "ACCOUNTING_TAX" "$(classify_owner_escalation 'New plan tier changes billing behavior for existing customers.')"

assert_eq "GDPR/compliance content classifies as LEGAL_COMPLIANCE" \
  "LEGAL_COMPLIANCE" "$(classify_owner_escalation 'This raises a GDPR compliance concern for EU customers.')"

assert_eq "locked baseline / GATE0_DECISIONS content classifies as LOCKED_BASELINE" \
  "LOCKED_BASELINE" "$(classify_owner_escalation 'This would require changing the locked baseline in GATE0_DECISIONS.md.')"

assert_eq "product scope / customer-facing behavior content classifies as PRODUCT_SCOPE" \
  "PRODUCT_SCOPE" "$(classify_owner_escalation 'This is a material product scope change affecting customer-facing behavior.')"

if classify_owner_escalation "Need to refactor the shared utils module before proceeding" >/dev/null 2>&1; then
  RESULT="matched"
else
  RESULT="no-match"
fi
assert_eq "fake technical owner escalation: ordinary technical content never classifies into a real category" \
  "no-match" "$RESULT"

echo ""
echo "== classify_owner_escalation: overbroad-keyword false positives (governance blocker regression) =="
# Ordinary technical phrases that merely mention invoice/ledger/pricing/
# customer contract must never classify into a real escalation category.
# These are the four exact false positives from review plus technical
# tax/invoice variants.

if classify_owner_escalation "Added invoice_id column to the ledger reconciliation table and backfilled it." >/dev/null 2>&1; then
  RESULT="matched"
else
  RESULT="no-match"
fi
assert_eq "false positive #1: invoice/ledger schema migration is technical, not ACCOUNTING_TAX" \
  "no-match" "$RESULT"

if classify_owner_escalation "Refactored the ledger reconciliation query for performance and added an index." >/dev/null 2>&1; then
  RESULT="matched"
else
  RESULT="no-match"
fi
assert_eq "false positive #2: ledger query/index refactor is technical, not ACCOUNTING_TAX" \
  "no-match" "$RESULT"

if classify_owner_escalation "Updated the pricing calculation microservice API to return the new field." >/dev/null 2>&1; then
  RESULT="matched"
else
  RESULT="no-match"
fi
assert_eq "false positive #3: pricing microservice/API work is technical, not ACCOUNTING_TAX" \
  "no-match" "$RESULT"

if classify_owner_escalation "Added a customer contract reference field to the onboarding DTO." >/dev/null 2>&1; then
  RESULT="matched"
else
  RESULT="no-match"
fi
assert_eq "false positive #4: customer contract DTO/API field is technical, not LEGAL_COMPLIANCE" \
  "no-match" "$RESULT"

if classify_owner_escalation "Added a tax_rate column to the invoice schema and migrated existing rows." >/dev/null 2>&1; then
  RESULT="matched"
else
  RESULT="no-match"
fi
assert_eq "technical variant: tax field/invoice schema migration is technical, not ACCOUNTING_TAX" \
  "no-match" "$RESULT"

if classify_owner_escalation "Generated the invoice PDF export endpoint and wrote unit tests for it." >/dev/null 2>&1; then
  RESULT="matched"
else
  RESULT="no-match"
fi
assert_eq "technical variant: invoice PDF export endpoint/tests is technical, not ACCOUNTING_TAX" \
  "no-match" "$RESULT"

echo ""
echo "== classify_owner_escalation: valid phrasing for each permitted category still classifies =="

assert_eq "valid ACCOUNTING_TAX: explicit tax treatment/rate policy decision" \
  "ACCOUNTING_TAX" "$(classify_owner_escalation 'We need an owner decision on the tax treatment and applicable tax rate for prorated mid-cycle upgrades.')"

assert_eq "valid ACCOUNTING_TAX: explicit accounting policy decision" \
  "ACCOUNTING_TAX" "$(classify_owner_escalation 'This requires an accounting policy decision on revenue recognition timing.')"

assert_eq "valid LEGAL_COMPLIANCE: legal counsel + regulatory compliance exposure" \
  "LEGAL_COMPLIANCE" "$(classify_owner_escalation 'This needs legal counsel review -- it creates a regulatory compliance exposure for EU customers.')"

assert_eq "valid LEGAL_COMPLIANCE: customer contract liability exposure" \
  "LEGAL_COMPLIANCE" "$(classify_owner_escalation 'The customer contract terms create a liability exposure that needs legal sign-off.')"

assert_eq "valid PRODUCT_SCOPE: material product scope/behavior decision" \
  "PRODUCT_SCOPE" "$(classify_owner_escalation 'This is a material product scope change that removes supported behavior for existing customers.')"

assert_eq "valid LOCKED_BASELINE: explicit change to a locked/ratified decision" \
  "LOCKED_BASELINE" "$(classify_owner_escalation 'Implementing this would require changing the locked baseline recorded in GATE0_DECISIONS.md.')"

echo ""
echo "== extract_legacy_decision_request (legacy-DR interception fix) =="

DR_HEADING=$'KEMFAI_TASK_ID: T050\nHit ambiguity.\n\n## Decision Request - which column stores the bilingual name\n\nShould this be name_en/name_ar or jsonb?'
DR_EXTRACTED=$(extract_legacy_decision_request "$DR_HEADING")
assert_contains "markdown-heading legacy Decision Request is detected" "$DR_EXTRACTED" "Decision Request - which column"

DR_PHRASE=$'KEMFAI_TASK_ID: T050\nI am raising a Decision Request: should VAT be prorated mid-cycle?'
DR_EXTRACTED2=$(extract_legacy_decision_request "$DR_PHRASE")
assert_contains "explicit 'raising a Decision Request' phrasing is detected" "$DR_EXTRACTED2" "VAT be prorated"

DR_NEGATIVE=$'KEMFAI_TASK_ID: T050\nOnly a paraphrase, so no Decision Request was needed. Proceeding normally.'
if extract_legacy_decision_request "$DR_NEGATIVE" >/dev/null 2>&1; then
  RESULT="matched"
else
  RESULT="no-match"
fi
assert_eq "prose merely referencing the concept (none actually raised) is never misfired on" "no-match" "$RESULT"

echo ""
echo "== classify_executor_signal (routing fix: pin-first is the caller's job; this covers categorization) =="

REAL_ESCALATION=$'KEMFAI_TASK_ID: T036\nFound a blocker.\nKEMFAI_OWNER_ESCALATION: New plan tier changes billing behavior'
SIG=$(classify_executor_signal "$REAL_ESCALATION")
assert_eq "a real-category KEMFAI_OWNER_ESCALATION marker classifies as OWNER_ESCALATION" \
  "OWNER_ESCALATION" "$(printf '%s\n' "$SIG" | sed -n '1p')"
assert_eq "its category is reported (not NONE)" "ACCOUNTING_TAX" "$(printf '%s\n' "$SIG" | sed -n '2p')"

FAKE_ESCALATION=$'KEMFAI_TASK_ID: T036\nFound a blocker.\nKEMFAI_OWNER_ESCALATION: Need to refactor the shared utils module before proceeding'
SIG2=$(classify_executor_signal "$FAKE_ESCALATION")
assert_eq "blocker #3: a KEMFAI_OWNER_ESCALATION marker with ordinary technical content is downgraded to TECH_QUESTION" \
  "TECH_QUESTION" "$(printf '%s\n' "$SIG2" | sed -n '1p')"
assert_contains "the downgraded signal still carries the original text for feedback" \
  "$(printf '%s\n' "$SIG2" | tail -n +3)" "refactor the shared utils module"

STRICT_TECH_Q=$'KEMFAI_TASK_ID: T036\nKEMFAI_TECH_QUESTION: Which column holds the bilingual display name?'
SIG3=$(classify_executor_signal "$STRICT_TECH_Q")
assert_eq "a strict KEMFAI_TECH_QUESTION marker classifies as TECH_QUESTION" \
  "TECH_QUESTION" "$(printf '%s\n' "$SIG3" | sed -n '1p')"

LEGACY_TECH=$'KEMFAI_TASK_ID: T036\n\n## Decision Request - which column stores the bilingual name\n\nname_en/name_ar or jsonb?'
SIG4=$(classify_executor_signal "$LEGACY_TECH")
assert_eq "blocker #4: a plain/legacy Decision Request with ordinary technical content is intercepted as TECH_QUESTION" \
  "TECH_QUESTION" "$(printf '%s\n' "$SIG4" | sed -n '1p')"

LEGACY_ESCALATION=$'KEMFAI_TASK_ID: T036\n\n## Decision Request - accounting and tax policy for prorated billing\n\nThis changes how VAT is calculated mid-cycle.'
SIG5=$(classify_executor_signal "$LEGACY_ESCALATION")
assert_eq "blocker #4: a plain/legacy Decision Request with real escalation-category content is intercepted as OWNER_ESCALATION" \
  "OWNER_ESCALATION" "$(printf '%s\n' "$SIG5" | sed -n '1p')"
assert_eq "its category is classified correctly" "ACCOUNTING_TAX" "$(printf '%s\n' "$SIG5" | sed -n '2p')"

NO_SIGNAL=$'KEMFAI_TASK_ID: T036\nImplemented the task cleanly, no ambiguity.'
if classify_executor_signal "$NO_SIGNAL" >/dev/null 2>&1; then
  RESULT="matched"
else
  RESULT="no-match"
fi
assert_eq "clean output with no marker and no legacy Decision Request classifies as NONE" "no-match" "$RESULT"

print_summary
