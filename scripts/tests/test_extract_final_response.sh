#!/usr/bin/env bash
# Deterministic unit tests for scripts/extract_final_response.py -- the
# boundary that isolates an opencode executor's FINAL assistant response from
# its full `--format json` NDJSON event stream.
#
# Regression context (scripts/logs/20261004-0830.log incident): the runner used
# to feed the WHOLE opencode formatted transcript (tool outputs + intermediate
# assistant text + final answer) into extract_task_id/classify_executor_signal.
# A tool result quoting old recovery_job_state.md Decision-Request text then
# triggered a spurious TECH_QUESTION and rolled back a real T049 change before
# review. These fixtures pin the exact production shapes:
#   - tool outputs and intermediate assistant messages quoting Decision
#     Request text are NEVER part of the governable final response;
#   - a genuine final response with a clean first-line task marker survives;
#   - anything ambiguous/aborted/missing fails CLOSED (exit 3, no output).
#
# Event shapes verified live against opencode 1.18.x `run --format json`:
#   {"type":"step_start",...,"part":{"type":"step-start","messageID":...}}
#   {"type":"tool_use",...,"part":{"type":"tool","state":{"output":...}}}
#   {"type":"text",...,"part":{"type":"text","text":...}}
#   {"type":"step_finish",...,"part":{"type":"step-finish","reason":...}}
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
# shellcheck disable=SC1091
source "$HERE/lib_test_helpers.sh"

EXTRACTOR="$REPO/scripts/extract_final_response.py"
FIXTURE_DIR=$(mktemp -d)
trap 'rm -rf "$FIXTURE_DIR"' EXIT

run_extractor() {
  local raw="$1" out="$2"
  EXTRACT_STDERR=$(python3 "$EXTRACTOR" "$raw" "$out" 2>&1)
  EXTRACT_EC=$?
}

# --- fixture 1: the exact production-incident shape -------------------------
# Tool output quotes stale recovery_job_state.md Decision-Request text, an
# INTERMEDIATE assistant message also quotes a Decision Request, and only the
# LAST message (no tool parts, nothing after it) is the real final response.
cat > "$FIXTURE_DIR/production_shape.ndjson" <<'EOF'
{"type":"step_start","timestamp":1791090974810,"sessionID":"ses_fixture","part":{"id":"prt_1","messageID":"msg_1","sessionID":"ses_fixture","type":"step-start"}}
{"type":"tool_use","timestamp":1791090974811,"sessionID":"ses_fixture","part":{"type":"tool","tool":"bash","callID":"call_1","state":{"status":"completed","input":{"command":"cat scripts/.state/recovery_job_state.md"},"output":"T044 1 REJECTED\n3. Decision-marker parsing is only prefix-matched. Lines such as DECISION REQUEST: TECHNICALITY or markers without the required summary are honored despite not matching the exact protocol.\nDecision Request: should VAT be prorated mid-cycle?","metadata":{"exit":0},"title":"cat recovery_job_state.md"},"id":"prt_2","sessionID":"ses_fixture","messageID":"msg_1"}}
{"type":"step_finish","timestamp":1791090974812,"sessionID":"ses_fixture","part":{"id":"prt_3","reason":"tool-calls","messageID":"msg_1","sessionID":"ses_fixture","type":"step-finish","tokens":{"total":10}}}
{"type":"step_start","timestamp":1791090974813,"sessionID":"ses_fixture","part":{"id":"prt_4","messageID":"msg_2","sessionID":"ses_fixture","type":"step-start"}}
{"type":"text","timestamp":1791090974814,"sessionID":"ses_fixture","part":{"id":"prt_5","messageID":"msg_2","sessionID":"ses_fixture","type":"text","text":"Stale state reviewed. Noting the prior Decision Request: which column stores the bilingual plan name was already settled -- no new decision needed, continuing."}}
{"type":"tool_use","timestamp":1791090974815,"sessionID":"ses_fixture","part":{"type":"tool","tool":"bash","callID":"call_2","state":{"status":"completed","input":{"command":"git status --porcelain"},"output":" M specs/001-saas-onboarding-shell/tasks.md\n?? backend/api/test/contract/company-setup.contract-spec.ts","metadata":{"exit":0},"title":"git status"},"id":"prt_6","sessionID":"ses_fixture","messageID":"msg_2"}}
{"type":"step_finish","timestamp":1791090974816,"sessionID":"ses_fixture","part":{"id":"prt_7","reason":"tool-calls","messageID":"msg_2","sessionID":"ses_fixture","type":"step-finish","tokens":{"total":10}}}
{"type":"step_start","timestamp":1791090974817,"sessionID":"ses_fixture","part":{"id":"prt_8","messageID":"msg_3","sessionID":"ses_fixture","type":"step-start"}}
{"type":"text","timestamp":1791090974818,"sessionID":"ses_fixture","part":{"id":"prt_9","messageID":"msg_3","sessionID":"ses_fixture","type":"text","text":"KEMFAI_TASK_ID: T049\n\nExecuted the next genuinely unblocked task: contract test added, 11/11 passing."}}
{"type":"step_finish","timestamp":1791090974819,"sessionID":"ses_fixture","part":{"id":"prt_10","reason":"stop","messageID":"msg_3","sessionID":"ses_fixture","type":"step-finish","tokens":{"total":10}}}
EOF

run_extractor "$FIXTURE_DIR/production_shape.ndjson" "$FIXTURE_DIR/out1.txt"
assert_eq "fixture 1 (production incident): extraction succeeds" "0" "$EXTRACT_EC"
assert_eq "fixture 1: final response is exactly the last message's text" \
  "KEMFAI_TASK_ID: T049

Executed the next genuinely unblocked task: contract test added, 11/11 passing." \
  "$(cat "$FIXTURE_DIR/out1.txt")"
if grep -q "Decision Request" "$FIXTURE_DIR/out1.txt"; then RESULT="leaked"; else RESULT="clean"; fi
assert_eq "fixture 1: Decision-Request noise from tool output/intermediate text NEVER reaches the final response" "clean" "$RESULT"

# --- fixture 2: minimal single-message stream (live-verified shape) ---------
cat > "$FIXTURE_DIR/minimal.ndjson" <<'EOF'
{"type":"step_start","timestamp":1,"sessionID":"s","part":{"id":"p1","messageID":"m1","sessionID":"s","type":"step-start"}}
{"type":"text","timestamp":2,"sessionID":"s","part":{"id":"p2","messageID":"m1","sessionID":"s","type":"text","text":"OK"}}
{"type":"step_finish","timestamp":3,"sessionID":"s","part":{"id":"p3","reason":"stop","messageID":"m1","sessionID":"s","type":"step-finish"}}
EOF
run_extractor "$FIXTURE_DIR/minimal.ndjson" "$FIXTURE_DIR/out2.txt"
assert_eq "fixture 2 (live-verified minimal stream): extraction succeeds" "0" "$EXTRACT_EC"
assert_eq "fixture 2: final response text extracted verbatim" "OK" "$(cat "$FIXTURE_DIR/out2.txt")"

# --- fixture 3: tool-only stream (no assistant text anywhere) ---------------
cat > "$FIXTURE_DIR/tool_only.ndjson" <<'EOF'
{"type":"step_start","timestamp":1,"sessionID":"s","part":{"id":"p1","messageID":"m1","sessionID":"s","type":"step-start"}}
{"type":"tool_use","timestamp":2,"sessionID":"s","part":{"type":"tool","tool":"bash","state":{"status":"completed","output":"did work"},"id":"p2","sessionID":"s","messageID":"m1"}}
{"type":"step_finish","timestamp":3,"sessionID":"s","part":{"id":"p3","reason":"tool-calls","messageID":"m1","sessionID":"s","type":"step-finish"}}
EOF
rm -f "$FIXTURE_DIR/out3.txt"
run_extractor "$FIXTURE_DIR/tool_only.ndjson" "$FIXTURE_DIR/out3.txt"
assert_eq "fixture 3: a stream with no assistant text fails closed" "3" "$EXTRACT_EC"
assert_file_absent "fixture 3: no output file is written on failure" "$FIXTURE_DIR/out3.txt"

# --- fixture 4: last message has text AND tool parts (aborted mid-work) -----
cat > "$FIXTURE_DIR/text_then_tool.ndjson" <<'EOF'
{"type":"step_start","timestamp":1,"sessionID":"s","part":{"id":"p1","messageID":"m1","sessionID":"s","type":"step-start"}}
{"type":"text","timestamp":2,"sessionID":"s","part":{"id":"p2","messageID":"m1","sessionID":"s","type":"text","text":"KEMFAI_TASK_ID: T049\nLet me finish one more check first."}}
{"type":"tool_use","timestamp":3,"sessionID":"s","part":{"type":"tool","tool":"bash","state":{"status":"completed","output":"more work"},"id":"p3","sessionID":"s","messageID":"m1"}}
{"type":"step_finish","timestamp":4,"sessionID":"s","part":{"id":"p4","reason":"tool-calls","messageID":"m1","sessionID":"s","type":"step-finish"}}
EOF
rm -f "$FIXTURE_DIR/out4.txt"
run_extractor "$FIXTURE_DIR/text_then_tool.ndjson" "$FIXTURE_DIR/out4.txt"
assert_eq "fixture 4: last message still calling tools is NOT a final response (fail closed)" "3" "$EXTRACT_EC"
assert_file_absent "fixture 4: no output file on aborted-stream failure" "$FIXTURE_DIR/out4.txt"

# --- fixture 5: text message followed by a LATER tool-only message ----------
cat > "$FIXTURE_DIR/text_then_later_tool.ndjson" <<'EOF'
{"type":"step_start","timestamp":1,"sessionID":"s","part":{"id":"p1","messageID":"m1","sessionID":"s","type":"step-start"}}
{"type":"text","timestamp":2,"sessionID":"s","part":{"id":"p2","messageID":"m1","sessionID":"s","type":"text","text":"KEMFAI_TASK_ID: T049\nIntermediate words before another tool round."}}
{"type":"step_finish","timestamp":3,"sessionID":"s","part":{"id":"p3","reason":"tool-calls","messageID":"m1","sessionID":"s","type":"step-finish"}}
{"type":"step_start","timestamp":4,"sessionID":"s","part":{"id":"p4","messageID":"m2","sessionID":"s","type":"step-start"}}
{"type":"tool_use","timestamp":5,"sessionID":"s","part":{"type":"tool","tool":"bash","state":{"status":"completed","output":"still working"},"id":"p5","sessionID":"s","messageID":"m2"}}
EOF
rm -f "$FIXTURE_DIR/out5.txt"
run_extractor "$FIXTURE_DIR/text_then_later_tool.ndjson" "$FIXTURE_DIR/out5.txt"
assert_eq "fixture 5: intermediate text followed by later activity fails closed" "3" "$EXTRACT_EC"
assert_file_absent "fixture 5: no output file on intermediate-text failure" "$FIXTURE_DIR/out5.txt"

# --- fixture 6: non-JSON noise interleaved with valid events (fail closed) --
# CONTRACT CHANGE (independent-review rejection, 2026-10-04): the runner
# captures the stream with 2>&1, so non-JSON lines mean stderr interleaved
# with the event stream. Such a stream can no longer be trusted to identify
# the final response (the noise could hide or corrupt terminal events), so it
# now FAILS CLOSED; the raw log retains everything for diagnostics.
cat > "$FIXTURE_DIR/noisy.ndjson" <<'EOF'
warning: some stderr noise line
{"type":"step_start","timestamp":1,"sessionID":"s","part":{"id":"p1","messageID":"m1","sessionID":"s","type":"step-start"}}
{"type":"text","timestamp":2,"sessionID":"s","part":{"id":"p2","messageID":"m1","sessionID":"s","type":"text","text":"KEMFAI_TASK_ID: T049\nShould never be governable."}}
another non-json line
{"type":"step_finish","timestamp":3,"sessionID":"s","part":{"id":"p3","reason":"stop","messageID":"m1","sessionID":"s","type":"step-finish"}}
EOF
rm -f "$FIXTURE_DIR/out6.txt"
run_extractor "$FIXTURE_DIR/noisy.ndjson" "$FIXTURE_DIR/out6.txt"
assert_eq "fixture 6: interleaved non-JSON noise fails closed (contract change)" "3" "$EXTRACT_EC"
assert_file_absent "fixture 6: no output file on noisy stream" "$FIXTURE_DIR/out6.txt"
assert_contains "fixture 6: failure names the malformed line for diagnostics" \
  "$EXTRACT_STDERR" "FAIL-CLOSED"

# --- fixture 7: final message split into MULTIPLE text parts ----------------
cat > "$FIXTURE_DIR/multipart.ndjson" <<'EOF'
{"type":"step_start","timestamp":1,"sessionID":"s","part":{"id":"p1","messageID":"m1","sessionID":"s","type":"step-start"}}
{"type":"text","timestamp":2,"sessionID":"s","part":{"id":"p2","messageID":"m1","sessionID":"s","type":"text","text":"KEMFAI_TASK_ID: T049"}}
{"type":"text","timestamp":3,"sessionID":"s","part":{"id":"p3","messageID":"m1","sessionID":"s","type":"text","text":"Second block of the same final message."}}
{"type":"step_finish","timestamp":4,"sessionID":"s","part":{"id":"p4","reason":"stop","messageID":"m1","sessionID":"s","type":"step-finish"}}
EOF
run_extractor "$FIXTURE_DIR/multipart.ndjson" "$FIXTURE_DIR/out7.txt"
assert_eq "fixture 7: multipart final message extraction succeeds" "0" "$EXTRACT_EC"
assert_eq "fixture 7: first line stays intact (line-preserving join)" \
  "KEMFAI_TASK_ID: T049" "$(head -n1 "$FIXTURE_DIR/out7.txt")"
assert_contains "fixture 7: all parts of the final message are present" \
  "$(cat "$FIXTURE_DIR/out7.txt")" "Second block of the same final message."

# --- fixture 8: empty / whitespace-only final text --------------------------
cat > "$FIXTURE_DIR/empty_text.ndjson" <<'EOF'
{"type":"step_start","timestamp":1,"sessionID":"s","part":{"id":"p1","messageID":"m1","sessionID":"s","type":"step-start"}}
{"type":"text","timestamp":2,"sessionID":"s","part":{"id":"p2","messageID":"m1","sessionID":"s","type":"text","text":"   "}}
{"type":"step_finish","timestamp":3,"sessionID":"s","part":{"id":"p3","reason":"stop","messageID":"m1","sessionID":"s","type":"step-finish"}}
EOF
rm -f "$FIXTURE_DIR/out8.txt"
run_extractor "$FIXTURE_DIR/empty_text.ndjson" "$FIXTURE_DIR/out8.txt"
assert_eq "fixture 8: whitespace-only final text fails closed" "3" "$EXTRACT_EC"
assert_file_absent "fixture 8: no output file on empty final text" "$FIXTURE_DIR/out8.txt"

# --- fixture 9: reasoning parts never leak into the final response ----------
cat > "$FIXTURE_DIR/reasoning.ndjson" <<'EOF'
{"type":"step_start","timestamp":1,"sessionID":"s","part":{"id":"p1","messageID":"m1","sessionID":"s","type":"step-start"}}
{"type":"reasoning","timestamp":2,"sessionID":"s","part":{"id":"p2","messageID":"m1","sessionID":"s","type":"reasoning","text":"thinking about a Decision Request: should VAT be prorated?"}}
{"type":"text","timestamp":3,"sessionID":"s","part":{"id":"p3","messageID":"m1","sessionID":"s","type":"text","text":"KEMFAI_TASK_ID: T049\nClean final answer."}}
{"type":"step_finish","timestamp":4,"sessionID":"s","part":{"id":"p4","reason":"stop","messageID":"m1","sessionID":"s","type":"step-finish"}}
EOF
run_extractor "$FIXTURE_DIR/reasoning.ndjson" "$FIXTURE_DIR/out9.txt"
assert_eq "fixture 9: reasoning parts are ignored, final text extracted" "0" "$EXTRACT_EC"
if grep -q "Decision Request" "$FIXTURE_DIR/out9.txt"; then RESULT="leaked"; else RESULT="clean"; fi
assert_eq "fixture 9: reasoning content never reaches the final response" "clean" "$RESULT"

# --- fixture 10: missing input file / wrong argc (fail closed) --------------
rm -f "$FIXTURE_DIR/out10.txt"
run_extractor "$FIXTURE_DIR/does_not_exist.ndjson" "$FIXTURE_DIR/out10.txt"
assert_eq "fixture 10: missing raw stream file fails closed" "3" "$EXTRACT_EC"
assert_file_absent "fixture 10: no output file on missing input" "$FIXTURE_DIR/out10.txt"

rm -f "$FIXTURE_DIR/out11.txt"
EXTRACT_STDERR=$(python3 "$EXTRACTOR" 2>&1)
EXTRACT_EC=$?
assert_eq "fixture 10: wrong argument count fails closed" "3" "$EXTRACT_EC"

# --- fixture 11: non-JSON garbage stream (fail closed, never guess) ---------
printf 'total garbage\nnot json at all\n' > "$FIXTURE_DIR/garbage.ndjson"
rm -f "$FIXTURE_DIR/out12.txt"
run_extractor "$FIXTURE_DIR/garbage.ndjson" "$FIXTURE_DIR/out12.txt"
assert_eq "fixture 11: a wholly non-JSON stream fails closed" "3" "$EXTRACT_EC"
assert_file_absent "fixture 11: no output file for garbage input" "$FIXTURE_DIR/out12.txt"

# --- fixtures 12-20: terminal-stop + fail-closed stream contract ------------
# Independent-review rejection (2026-10-04): the extractor accepted a
# TRUNCATED stream (final text present, terminal step_finish(stop) missing)
# as a governable final response. The strengthened contract: exit 0 requires
# exactly one step_finish(reason="stop"), it must be the LAST non-empty line,
# it must close the text-bearing final message, every line must be a valid
# JSON event of ONE sessionID, and every text/tool/step-finish part must
# carry a messageID. Anything else fails closed.

# fixture 12: TRUNCATED stream -- the reviewer's reproduced rejection case:
# final-looking text emitted, then the stream ends with NO terminal event.
cat > "$FIXTURE_DIR/truncated.ndjson" <<'EOF'
{"type":"step_start","timestamp":1,"sessionID":"s","part":{"id":"p1","messageID":"m1","sessionID":"s","type":"step-start"}}
{"type":"tool_use","timestamp":2,"sessionID":"s","part":{"type":"tool","tool":"bash","state":{"status":"completed","output":"work"},"id":"p2","sessionID":"s","messageID":"m1"}}
{"type":"step_finish","timestamp":3,"sessionID":"s","part":{"id":"p3","reason":"tool-calls","messageID":"m1","sessionID":"s","type":"step-finish"}}
{"type":"step_start","timestamp":4,"sessionID":"s","part":{"id":"p4","messageID":"m2","sessionID":"s","type":"step-start"}}
{"type":"text","timestamp":5,"sessionID":"s","part":{"id":"p5","messageID":"m2","sessionID":"s","type":"text","text":"KEMFAI_TASK_ID: T049\nStream cut before the terminal event."}}
EOF
rm -f "$FIXTURE_DIR/out13.txt"
run_extractor "$FIXTURE_DIR/truncated.ndjson" "$FIXTURE_DIR/out13.txt"
assert_eq "fixture 12: truncated stream (no terminal step_finish) fails closed" "3" "$EXTRACT_EC"
assert_file_absent "fixture 12: no output file for truncated stream" "$FIXTURE_DIR/out13.txt"
assert_contains "fixture 12: failure names the missing terminal event" \
  "$EXTRACT_STDERR" "terminal step_finish"

# fixture 13: trailing NON-JSON garbage AFTER the terminal stop.
cat > "$FIXTURE_DIR/trailing_garbage.ndjson" <<'EOF'
{"type":"step_start","timestamp":1,"sessionID":"s","part":{"id":"p1","messageID":"m1","sessionID":"s","type":"step-start"}}
{"type":"text","timestamp":2,"sessionID":"s","part":{"id":"p2","messageID":"m1","sessionID":"s","type":"text","text":"KEMFAI_TASK_ID: T049\nDone."}}
{"type":"step_finish","timestamp":3,"sessionID":"s","part":{"id":"p3","reason":"stop","messageID":"m1","sessionID":"s","type":"step-finish"}}
trailing corrupt line, not json
EOF
rm -f "$FIXTURE_DIR/out14.txt"
run_extractor "$FIXTURE_DIR/trailing_garbage.ndjson" "$FIXTURE_DIR/out14.txt"
assert_eq "fixture 13: trailing non-JSON data after the terminal stop fails closed" "3" "$EXTRACT_EC"
assert_file_absent "fixture 13: no output file on trailing garbage" "$FIXTURE_DIR/out14.txt"

# fixture 14: trailing VALID event AFTER the terminal stop (session continued
# or capture raced -- the stop is not the stream's terminal event).
cat > "$FIXTURE_DIR/trailing_event.ndjson" <<'EOF'
{"type":"step_start","timestamp":1,"sessionID":"s","part":{"id":"p1","messageID":"m1","sessionID":"s","type":"step-start"}}
{"type":"text","timestamp":2,"sessionID":"s","part":{"id":"p2","messageID":"m1","sessionID":"s","type":"text","text":"KEMFAI_TASK_ID: T049\nDone."}}
{"type":"step_finish","timestamp":3,"sessionID":"s","part":{"id":"p3","reason":"stop","messageID":"m1","sessionID":"s","type":"step-finish"}}
{"type":"step_start","timestamp":4,"sessionID":"s","part":{"id":"p4","messageID":"m2","sessionID":"s","type":"step-start"}}
EOF
rm -f "$FIXTURE_DIR/out15.txt"
run_extractor "$FIXTURE_DIR/trailing_event.ndjson" "$FIXTURE_DIR/out15.txt"
assert_eq "fixture 14: any event after the terminal stop fails closed" "3" "$EXTRACT_EC"
assert_file_absent "fixture 14: no output file when events follow the stop" "$FIXTURE_DIR/out15.txt"

# fixture 15: final message terminated by step_finish(reason="tool-calls"):
# a step-finish is present and last, but it is NOT a terminal stop.
cat > "$FIXTURE_DIR/wrong_reason.ndjson" <<'EOF'
{"type":"step_start","timestamp":1,"sessionID":"s","part":{"id":"p1","messageID":"m1","sessionID":"s","type":"step-start"}}
{"type":"text","timestamp":2,"sessionID":"s","part":{"id":"p2","messageID":"m1","sessionID":"s","type":"text","text":"KEMFAI_TASK_ID: T049\nText without a stop reason."}}
{"type":"step_finish","timestamp":3,"sessionID":"s","part":{"id":"p3","reason":"tool-calls","messageID":"m1","sessionID":"s","type":"step-finish"}}
EOF
rm -f "$FIXTURE_DIR/out16.txt"
run_extractor "$FIXTURE_DIR/wrong_reason.ndjson" "$FIXTURE_DIR/out16.txt"
assert_eq "fixture 15: last event step_finish(tool-calls) is not a terminal stop (fail closed)" "3" "$EXTRACT_EC"
assert_file_absent "fixture 15: no output file without reason=stop" "$FIXTURE_DIR/out16.txt"

# fixture 16: ambiguous session identity -- events from two different sessions.
cat > "$FIXTURE_DIR/two_sessions.ndjson" <<'EOF'
{"type":"step_start","timestamp":1,"sessionID":"s1","part":{"id":"p1","messageID":"m1","sessionID":"s1","type":"step-start"}}
{"type":"text","timestamp":2,"sessionID":"s1","part":{"id":"p2","messageID":"m1","sessionID":"s1","type":"text","text":"KEMFAI_TASK_ID: T049\nFrom session one."}}
{"type":"step_finish","timestamp":3,"sessionID":"s2","part":{"id":"p3","reason":"stop","messageID":"m1","sessionID":"s2","type":"step-finish"}}
EOF
rm -f "$FIXTURE_DIR/out17.txt"
run_extractor "$FIXTURE_DIR/two_sessions.ndjson" "$FIXTURE_DIR/out17.txt"
assert_eq "fixture 16: mixed sessionIDs fail closed (ambiguous stream identity)" "3" "$EXTRACT_EC"
assert_file_absent "fixture 16: no output file on mixed sessions" "$FIXTURE_DIR/out17.txt"

# fixture 17: ambiguous message identity -- text part without a messageID.
cat > "$FIXTURE_DIR/no_message_id.ndjson" <<'EOF'
{"type":"step_start","timestamp":1,"sessionID":"s","part":{"id":"p1","messageID":"m1","sessionID":"s","type":"step-start"}}
{"type":"text","timestamp":2,"sessionID":"s","part":{"id":"p2","type":"text","text":"KEMFAI_TASK_ID: T049\nUnattributable text."}}
{"type":"step_finish","timestamp":3,"sessionID":"s","part":{"id":"p3","reason":"stop","messageID":"m1","sessionID":"s","type":"step-finish"}}
EOF
rm -f "$FIXTURE_DIR/out18.txt"
run_extractor "$FIXTURE_DIR/no_message_id.ndjson" "$FIXTURE_DIR/out18.txt"
assert_eq "fixture 17: text part without messageID fails closed (ambiguous message identity)" "3" "$EXTRACT_EC"
assert_file_absent "fixture 17: no output file on unattributable text" "$FIXTURE_DIR/out18.txt"

# fixture 18: event missing the top-level sessionID entirely.
cat > "$FIXTURE_DIR/no_session_id.ndjson" <<'EOF'
{"type":"step_start","timestamp":1,"sessionID":"s","part":{"id":"p1","messageID":"m1","sessionID":"s","type":"step-start"}}
{"type":"text","timestamp":2,"sessionID":"s","part":{"id":"p2","messageID":"m1","sessionID":"s","type":"text","text":"KEMFAI_TASK_ID: T049\nText."}}
{"type":"step_finish","timestamp":3,"part":{"id":"p3","reason":"stop","messageID":"m1","sessionID":"s","type":"step-finish"}}
EOF
rm -f "$FIXTURE_DIR/out19.txt"
run_extractor "$FIXTURE_DIR/no_session_id.ndjson" "$FIXTURE_DIR/out19.txt"
assert_eq "fixture 18: event without sessionID fails closed (ambiguous stream identity)" "3" "$EXTRACT_EC"
assert_file_absent "fixture 18: no output file on missing session identity" "$FIXTURE_DIR/out19.txt"

# fixture 19: TWO terminal stop events (duplicate/ambiguous terminal).
cat > "$FIXTURE_DIR/double_stop.ndjson" <<'EOF'
{"type":"step_start","timestamp":1,"sessionID":"s","part":{"id":"p1","messageID":"m1","sessionID":"s","type":"step-start"}}
{"type":"text","timestamp":2,"sessionID":"s","part":{"id":"p2","messageID":"m1","sessionID":"s","type":"text","text":"KEMFAI_TASK_ID: T049\nFirst."}}
{"type":"step_finish","timestamp":3,"sessionID":"s","part":{"id":"p3","reason":"stop","messageID":"m1","sessionID":"s","type":"step-finish"}}
{"type":"text","timestamp":4,"sessionID":"s","part":{"id":"p4","messageID":"m2","sessionID":"s","type":"text","text":"KEMFAI_TASK_ID: T049\nSecond."}}
{"type":"step_finish","timestamp":5,"sessionID":"s","part":{"id":"p5","reason":"stop","messageID":"m2","sessionID":"s","type":"step-finish"}}
EOF
rm -f "$FIXTURE_DIR/out20.txt"
run_extractor "$FIXTURE_DIR/double_stop.ndjson" "$FIXTURE_DIR/out20.txt"
assert_eq "fixture 19: more than one step_finish(stop) fails closed" "3" "$EXTRACT_EC"
assert_file_absent "fixture 19: no output file on duplicate terminal events" "$FIXTURE_DIR/out20.txt"

# fixture 20: terminal stop closes a message with NO text while an earlier
# message carries text -- the stop does not close the final text-bearing msg.
cat > "$FIXTURE_DIR/stop_wrong_message.ndjson" <<'EOF'
{"type":"step_start","timestamp":1,"sessionID":"s","part":{"id":"p1","messageID":"m1","sessionID":"s","type":"step-start"}}
{"type":"text","timestamp":2,"sessionID":"s","part":{"id":"p2","messageID":"m1","sessionID":"s","type":"text","text":"KEMFAI_TASK_ID: T049\nThe only text."}}
{"type":"step_finish","timestamp":3,"sessionID":"s","part":{"id":"p3","reason":"tool-calls","messageID":"m1","sessionID":"s","type":"step-finish"}}
{"type":"step_start","timestamp":4,"sessionID":"s","part":{"id":"p4","messageID":"m2","sessionID":"s","type":"step-start"}}
{"type":"step_finish","timestamp":5,"sessionID":"s","part":{"id":"p5","reason":"stop","messageID":"m2","sessionID":"s","type":"step-finish"}}
EOF
rm -f "$FIXTURE_DIR/out21.txt"
run_extractor "$FIXTURE_DIR/stop_wrong_message.ndjson" "$FIXTURE_DIR/out21.txt"
assert_eq "fixture 20: terminal stop closing a text-less message fails closed" "3" "$EXTRACT_EC"
assert_file_absent "fixture 20: no output file when the stop closes no text" "$FIXTURE_DIR/out21.txt"

# --- fixtures 21-30: strict event/part schema, identity, and sequencing -----
# Independent-review rejection (cycle 1, 2026-10-04): the extractor failed
# OPEN on four reproduced paths -- (1) event/part type confusion (top-level
# "tool_use" carrying a part of type "text" was extracted as governable final
# text), (2) malformed part session identity (numeric part.sessionID, or a
# terminal part missing sessionID, passed), (3) interleaved message ambiguity
# (a step_start for m2 between m1's final-looking text and m1's stop passed),
# (4) parts without message identity (a step-start part without messageID
# passed). Strengthened contract: strict top-level/part-type pairing limited
# to the live-verified opencode 1.18.x schema (step_start/step-start,
# text/text, tool_use/tool, step_finish/step-finish, reasoning/reasoning);
# every part carries a non-empty string sessionID equal to the stream session
# and a non-empty string messageID (step-start and reasoning included); and
# messages follow the verified sequential protocol -- each opens with
# step-start, closes with step-finish, never interleaves or reappears --
# so step-start and reasoning activity make ambiguity visible.
# Fixtures 21/23/25/27 embed the reviewer's EXACT probe streams; 22/24/26/28
# cover rigorous neighboring failure paths; 29/30 replay the REAL live-captured
# opencode 1.18.x streams to pin that verified valid events still pass.

# fixture 21: reviewer probe 1 EXACT -- top-level tool_use carrying a TEXT
# part (event/part type confusion); text must never be extracted from it.
cat > "$FIXTURE_DIR/type_confusion.ndjson" <<'EOF'
{"type":"step_start","sessionID":"s","part":{"type":"step-start","messageID":"m","sessionID":"s"}}
{"type":"tool_use","sessionID":"s","part":{"type":"text","messageID":"m","sessionID":"s","text":"KEMFAI_TASK_ID: T049\\nTYPE CONFUSION"}}
{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","messageID":"m","sessionID":"s","reason":"stop"}}
EOF
rm -f "$FIXTURE_DIR/out22.txt"
run_extractor "$FIXTURE_DIR/type_confusion.ndjson" "$FIXTURE_DIR/out22.txt"
assert_eq "fixture 21: tool_use event carrying a text part fails closed (type confusion)" "3" "$EXTRACT_EC"
assert_file_absent "fixture 21: no output file on event/part type confusion" "$FIXTURE_DIR/out22.txt"
assert_contains "fixture 21: failure names the type confusion" \
  "$EXTRACT_STDERR" "type confusion"

# fixture 22: type-confusion matrix -- every mismatched pairing of a known
# top-level event type with the WRONG part type, plus an unknown top-level
# event type, each embedded in an otherwise well-formed stream.
cat > "$FIXTURE_DIR/mismatch_open.ndjson" <<'EOF'
{"type":"step_start","sessionID":"s","part":{"type":"text","messageID":"m","sessionID":"s","text":"KEMFAI_TASK_ID: T049\\nCONFUSED OPEN"}}
{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","messageID":"m","sessionID":"s","reason":"stop"}}
EOF
rm -f "$FIXTURE_DIR/out23.txt"
run_extractor "$FIXTURE_DIR/mismatch_open.ndjson" "$FIXTURE_DIR/out23.txt"
assert_eq "fixture 22a: step_start event carrying a text part fails closed" "3" "$EXTRACT_EC"
assert_file_absent "fixture 22a: no output file on step_start/text confusion" "$FIXTURE_DIR/out23.txt"

cat > "$FIXTURE_DIR/mismatch_finish.ndjson" <<'EOF'
{"type":"step_start","sessionID":"s","part":{"type":"step-start","messageID":"m","sessionID":"s"}}
{"type":"step_finish","sessionID":"s","part":{"type":"text","messageID":"m","sessionID":"s","text":"KEMFAI_TASK_ID: T049\\nFINISH CARRYING TEXT"}}
{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","messageID":"m","sessionID":"s","reason":"stop"}}
EOF
rm -f "$FIXTURE_DIR/out24.txt"
run_extractor "$FIXTURE_DIR/mismatch_finish.ndjson" "$FIXTURE_DIR/out24.txt"
assert_eq "fixture 22b: step_finish event carrying a text part fails closed" "3" "$EXTRACT_EC"
assert_file_absent "fixture 22b: no output file on step_finish/text confusion" "$FIXTURE_DIR/out24.txt"

cat > "$FIXTURE_DIR/mismatch_terminal.ndjson" <<'EOF'
{"type":"step_start","sessionID":"s","part":{"type":"step-start","messageID":"m","sessionID":"s"}}
{"type":"text","sessionID":"s","part":{"type":"text","messageID":"m","sessionID":"s","text":"KEMFAI_TASK_ID: T049\\nREAL TEXT"}}
{"type":"text","sessionID":"s","part":{"type":"step-finish","messageID":"m","sessionID":"s","reason":"stop"}}
EOF
rm -f "$FIXTURE_DIR/out25.txt"
run_extractor "$FIXTURE_DIR/mismatch_terminal.ndjson" "$FIXTURE_DIR/out25.txt"
assert_eq "fixture 22c: text event carrying a step-finish part fails closed (forged terminal)" "3" "$EXTRACT_EC"
assert_file_absent "fixture 22c: no output file on forged terminal part" "$FIXTURE_DIR/out25.txt"

cat > "$FIXTURE_DIR/unknown_event_type.ndjson" <<'EOF'
{"type":"message_updated","sessionID":"s","part":{"type":"text","messageID":"m","sessionID":"s","text":"KEMFAI_TASK_ID: T049\\nUNKNOWN EVENT TYPE"}}
{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","messageID":"m","sessionID":"s","reason":"stop"}}
EOF
rm -f "$FIXTURE_DIR/out26.txt"
run_extractor "$FIXTURE_DIR/unknown_event_type.ndjson" "$FIXTURE_DIR/out26.txt"
assert_eq "fixture 22d: unknown top-level event type carrying text fails closed" "3" "$EXTRACT_EC"
assert_file_absent "fixture 22d: no output file on unknown event type" "$FIXTURE_DIR/out26.txt"

# fixture 23: reviewer probe 2 EXACT -- text part with a NUMERIC part
# sessionID and a terminal part MISSING part sessionID.
cat > "$FIXTURE_DIR/bad_part_sid.ndjson" <<'EOF'
{"type":"step_start","sessionID":"s","part":{"type":"step-start","messageID":"m","sessionID":"s"}}
{"type":"text","sessionID":"s","part":{"type":"text","messageID":"m","sessionID":7,"text":"KEMFAI_TASK_ID: T049\\nBAD PART SID TYPE"}}
{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","messageID":"m","reason":"stop"}}
EOF
rm -f "$FIXTURE_DIR/out27.txt"
run_extractor "$FIXTURE_DIR/bad_part_sid.ndjson" "$FIXTURE_DIR/out27.txt"
assert_eq "fixture 23: numeric/missing part sessionID fails closed (malformed identity)" "3" "$EXTRACT_EC"
assert_file_absent "fixture 23: no output file on malformed part session identity" "$FIXTURE_DIR/out27.txt"
assert_contains "fixture 23: failure names the malformed part identity" \
  "$EXTRACT_STDERR" "part sessionID"

# fixture 24: part-session identity variants -- numeric sessionID on the
# step-start part, a text part missing sessionID entirely, an empty-string
# part sessionID, and a contradicting string part sessionID.
cat > "$FIXTURE_DIR/numeric_start_sid.ndjson" <<'EOF'
{"type":"step_start","sessionID":"s","part":{"type":"step-start","messageID":"m","sessionID":7}}
{"type":"text","sessionID":"s","part":{"type":"text","messageID":"m","sessionID":"s","text":"KEMFAI_TASK_ID: T049\\nNUMERIC START SID"}}
{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","messageID":"m","sessionID":"s","reason":"stop"}}
EOF
rm -f "$FIXTURE_DIR/out28.txt"
run_extractor "$FIXTURE_DIR/numeric_start_sid.ndjson" "$FIXTURE_DIR/out28.txt"
assert_eq "fixture 24a: numeric sessionID on a step-start part fails closed" "3" "$EXTRACT_EC"
assert_file_absent "fixture 24a: no output file on numeric step-start sessionID" "$FIXTURE_DIR/out28.txt"

cat > "$FIXTURE_DIR/missing_part_sid.ndjson" <<'EOF'
{"type":"step_start","sessionID":"s","part":{"type":"step-start","messageID":"m","sessionID":"s"}}
{"type":"text","sessionID":"s","part":{"type":"text","messageID":"m","text":"KEMFAI_TASK_ID: T049\\nMISSING PART SID"}}
{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","messageID":"m","sessionID":"s","reason":"stop"}}
EOF
rm -f "$FIXTURE_DIR/out29.txt"
run_extractor "$FIXTURE_DIR/missing_part_sid.ndjson" "$FIXTURE_DIR/out29.txt"
assert_eq "fixture 24b: text part missing sessionID fails closed" "3" "$EXTRACT_EC"
assert_file_absent "fixture 24b: no output file on missing part sessionID" "$FIXTURE_DIR/out29.txt"

cat > "$FIXTURE_DIR/empty_part_sid.ndjson" <<'EOF'
{"type":"step_start","sessionID":"s","part":{"type":"step-start","messageID":"m","sessionID":"s"}}
{"type":"text","sessionID":"s","part":{"type":"text","messageID":"m","sessionID":"","text":"KEMFAI_TASK_ID: T049\\nEMPTY PART SID"}}
{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","messageID":"m","sessionID":"s","reason":"stop"}}
EOF
rm -f "$FIXTURE_DIR/out30.txt"
run_extractor "$FIXTURE_DIR/empty_part_sid.ndjson" "$FIXTURE_DIR/out30.txt"
assert_eq "fixture 24c: empty-string part sessionID fails closed" "3" "$EXTRACT_EC"
assert_file_absent "fixture 24c: no output file on empty part sessionID" "$FIXTURE_DIR/out30.txt"

cat > "$FIXTURE_DIR/contradicting_part_sid.ndjson" <<'EOF'
{"type":"step_start","sessionID":"s","part":{"type":"step-start","messageID":"m","sessionID":"s"}}
{"type":"text","sessionID":"s","part":{"type":"text","messageID":"m","sessionID":"other","text":"KEMFAI_TASK_ID: T049\\nCONTRADICTING PART SID"}}
{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","messageID":"m","sessionID":"s","reason":"stop"}}
EOF
rm -f "$FIXTURE_DIR/out31.txt"
run_extractor "$FIXTURE_DIR/contradicting_part_sid.ndjson" "$FIXTURE_DIR/out31.txt"
assert_eq "fixture 24d: contradicting string part sessionID fails closed" "3" "$EXTRACT_EC"
assert_file_absent "fixture 24d: no output file on contradicting part sessionID" "$FIXTURE_DIR/out31.txt"

# fixture 25: reviewer probe 3 EXACT -- a step_start for m2 BETWEEN m1's
# final-looking text and m1's stop (interleaved message ambiguity).
cat > "$FIXTURE_DIR/interleaved_start.ndjson" <<'EOF'
{"type":"step_start","sessionID":"s","part":{"type":"step-start","messageID":"m1","sessionID":"s"}}
{"type":"text","sessionID":"s","part":{"type":"text","messageID":"m1","sessionID":"s","text":"KEMFAI_TASK_ID: T049\\nINTERLEAVED"}}
{"type":"step_start","sessionID":"s","part":{"type":"step-start","messageID":"m2","sessionID":"s"}}
{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","messageID":"m1","sessionID":"s","reason":"stop"}}
EOF
rm -f "$FIXTURE_DIR/out32.txt"
run_extractor "$FIXTURE_DIR/interleaved_start.ndjson" "$FIXTURE_DIR/out32.txt"
assert_eq "fixture 25: another message starting between final text and stop fails closed" "3" "$EXTRACT_EC"
assert_file_absent "fixture 25: no output file on interleaved message start" "$FIXTURE_DIR/out32.txt"

# fixture 26: interleaving variants -- a reasoning part of m2 after m1's
# text, a new message opening while the previous one is still unclosed, and
# a closed message REAPPEARING after the next message started.
cat > "$FIXTURE_DIR/interleaved_reasoning.ndjson" <<'EOF'
{"type":"step_start","sessionID":"s","part":{"type":"step-start","messageID":"m1","sessionID":"s"}}
{"type":"text","sessionID":"s","part":{"type":"text","messageID":"m1","sessionID":"s","text":"KEMFAI_TASK_ID: T049\\nREASONING INTERLEAVE"}}
{"type":"reasoning","sessionID":"s","part":{"type":"reasoning","messageID":"m2","sessionID":"s","text":"another message is thinking"}}
{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","messageID":"m1","sessionID":"s","reason":"stop"}}
EOF
rm -f "$FIXTURE_DIR/out33.txt"
run_extractor "$FIXTURE_DIR/interleaved_reasoning.ndjson" "$FIXTURE_DIR/out33.txt"
assert_eq "fixture 26a: another message's reasoning after the final text fails closed" "3" "$EXTRACT_EC"
assert_file_absent "fixture 26a: no output file on interleaved reasoning activity" "$FIXTURE_DIR/out33.txt"

cat > "$FIXTURE_DIR/unclosed_prior_message.ndjson" <<'EOF'
{"type":"step_start","sessionID":"s","part":{"type":"step-start","messageID":"m1","sessionID":"s"}}
{"type":"tool_use","sessionID":"s","part":{"type":"tool","tool":"bash","state":{"status":"completed","output":"x"},"messageID":"m1","sessionID":"s"}}
{"type":"step_start","sessionID":"s","part":{"type":"step-start","messageID":"m2","sessionID":"s"}}
{"type":"text","sessionID":"s","part":{"type":"text","messageID":"m2","sessionID":"s","text":"KEMFAI_TASK_ID: T049\\nUNCLOSED PRIOR MESSAGE"}}
{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","messageID":"m2","sessionID":"s","reason":"stop"}}
EOF
rm -f "$FIXTURE_DIR/out34.txt"
run_extractor "$FIXTURE_DIR/unclosed_prior_message.ndjson" "$FIXTURE_DIR/out34.txt"
assert_eq "fixture 26b: new message opening before the previous one is closed fails closed" "3" "$EXTRACT_EC"
assert_file_absent "fixture 26b: no output file on unclosed prior message" "$FIXTURE_DIR/out34.txt"

cat > "$FIXTURE_DIR/revisited_message.ndjson" <<'EOF'
{"type":"step_start","sessionID":"s","part":{"type":"step-start","messageID":"m1","sessionID":"s"}}
{"type":"text","sessionID":"s","part":{"type":"text","messageID":"m1","sessionID":"s","text":"first message text"}}
{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","messageID":"m1","sessionID":"s","reason":"tool-calls"}}
{"type":"step_start","sessionID":"s","part":{"type":"step-start","messageID":"m2","sessionID":"s"}}
{"type":"text","sessionID":"s","part":{"type":"text","messageID":"m1","sessionID":"s","text":"KEMFAI_TASK_ID: T049\\nREVISITED AFTER m2 STARTED"}}
{"type":"text","sessionID":"s","part":{"type":"text","messageID":"m2","sessionID":"s","text":"final"}}
{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","messageID":"m2","sessionID":"s","reason":"stop"}}
EOF
rm -f "$FIXTURE_DIR/out35.txt"
run_extractor "$FIXTURE_DIR/revisited_message.ndjson" "$FIXTURE_DIR/out35.txt"
assert_eq "fixture 26c: a closed message reappearing after the next message started fails closed" "3" "$EXTRACT_EC"
assert_file_absent "fixture 26c: no output file on revisited message" "$FIXTURE_DIR/out35.txt"

# fixture 27: reviewer probe 4 EXACT -- a step-start part WITHOUT messageID.
cat > "$FIXTURE_DIR/missing_start_mid.ndjson" <<'EOF'
{"type":"step_start","sessionID":"s","part":{"type":"step-start","sessionID":"s"}}
{"type":"text","sessionID":"s","part":{"type":"text","messageID":"m","sessionID":"s","text":"KEMFAI_TASK_ID: T049\\nMISSING START MID"}}
{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","messageID":"m","sessionID":"s","reason":"stop"}}
EOF
rm -f "$FIXTURE_DIR/out36.txt"
run_extractor "$FIXTURE_DIR/missing_start_mid.ndjson" "$FIXTURE_DIR/out36.txt"
assert_eq "fixture 27: step-start part without messageID fails closed" "3" "$EXTRACT_EC"
assert_file_absent "fixture 27: no output file on step-start without message identity" "$FIXTURE_DIR/out36.txt"

# fixture 28: message-identity variants -- reasoning part without messageID,
# numeric messageID on a step-start part, a tool part without messageID, and
# a text part with a non-string text field.
cat > "$FIXTURE_DIR/reasoning_no_mid.ndjson" <<'EOF'
{"type":"step_start","sessionID":"s","part":{"type":"step-start","messageID":"m","sessionID":"s"}}
{"type":"reasoning","sessionID":"s","part":{"type":"reasoning","sessionID":"s","text":"no message id"}}
{"type":"text","sessionID":"s","part":{"type":"text","messageID":"m","sessionID":"s","text":"KEMFAI_TASK_ID: T049\\nREASONING NO MID"}}
{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","messageID":"m","sessionID":"s","reason":"stop"}}
EOF
rm -f "$FIXTURE_DIR/out37.txt"
run_extractor "$FIXTURE_DIR/reasoning_no_mid.ndjson" "$FIXTURE_DIR/out37.txt"
assert_eq "fixture 28a: reasoning part without messageID fails closed" "3" "$EXTRACT_EC"
assert_file_absent "fixture 28a: no output file on reasoning without message identity" "$FIXTURE_DIR/out37.txt"

cat > "$FIXTURE_DIR/numeric_start_mid.ndjson" <<'EOF'
{"type":"step_start","sessionID":"s","part":{"type":"step-start","messageID":7,"sessionID":"s"}}
{"type":"text","sessionID":"s","part":{"type":"text","messageID":"m","sessionID":"s","text":"KEMFAI_TASK_ID: T049\\nNUMERIC START MID"}}
{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","messageID":"m","sessionID":"s","reason":"stop"}}
EOF
rm -f "$FIXTURE_DIR/out38.txt"
run_extractor "$FIXTURE_DIR/numeric_start_mid.ndjson" "$FIXTURE_DIR/out38.txt"
assert_eq "fixture 28b: numeric messageID on a step-start part fails closed" "3" "$EXTRACT_EC"
assert_file_absent "fixture 28b: no output file on numeric step-start messageID" "$FIXTURE_DIR/out38.txt"

cat > "$FIXTURE_DIR/tool_no_mid.ndjson" <<'EOF'
{"type":"step_start","sessionID":"s","part":{"type":"step-start","messageID":"m1","sessionID":"s"}}
{"type":"tool_use","sessionID":"s","part":{"type":"tool","tool":"bash","state":{"status":"completed","output":"x"},"sessionID":"s"}}
{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","messageID":"m1","sessionID":"s","reason":"tool-calls"}}
{"type":"step_start","sessionID":"s","part":{"type":"step-start","messageID":"m2","sessionID":"s"}}
{"type":"text","sessionID":"s","part":{"type":"text","messageID":"m2","sessionID":"s","text":"KEMFAI_TASK_ID: T049\\nTOOL NO MID"}}
{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","messageID":"m2","sessionID":"s","reason":"stop"}}
EOF
rm -f "$FIXTURE_DIR/out39.txt"
run_extractor "$FIXTURE_DIR/tool_no_mid.ndjson" "$FIXTURE_DIR/out39.txt"
assert_eq "fixture 28c: tool part without messageID fails closed (guard)" "3" "$EXTRACT_EC"
assert_file_absent "fixture 28c: no output file on tool part without message identity" "$FIXTURE_DIR/out39.txt"

cat > "$FIXTURE_DIR/non_string_text.ndjson" <<'EOF'
{"type":"step_start","sessionID":"s","part":{"type":"step-start","messageID":"m","sessionID":"s"}}
{"type":"text","sessionID":"s","part":{"type":"text","messageID":"m","sessionID":"s","text":7}}
{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","messageID":"m","sessionID":"s","reason":"stop"}}
EOF
rm -f "$FIXTURE_DIR/out40.txt"
run_extractor "$FIXTURE_DIR/non_string_text.ndjson" "$FIXTURE_DIR/out40.txt"
assert_eq "fixture 28d: text part with a non-string text field fails closed (guard)" "3" "$EXTRACT_EC"
assert_file_absent "fixture 28d: no output file on non-string text field" "$FIXTURE_DIR/out40.txt"

# fixture 29: EXACT replay of the live-captured opencode 1.18.x multi-message
# tool session (/tmp/opencode/verify2/events.ndjson, probe 2026-10-04).
# Guards against overcorrection: verified REAL valid events must still pass.
cat > "$FIXTURE_DIR/live_capture_replay.ndjson" <<'EOF'
{"type":"step_start","timestamp":1791090994630,"sessionID":"ses_efaa85f59ffenk8gadDDvytS5s","part":{"id":"prt_10557ad88001B8vtAskOO07aho","messageID":"msg_10557a458001Mm7SW0eUfpLQ5Q","sessionID":"ses_efaa85f59ffenk8gadDDvytS5s","type":"step-start"}}
{"type":"tool_use","timestamp":1791090994979,"sessionID":"ses_efaa85f59ffenk8gadDDvytS5s","part":{"type":"tool","tool":"bash","callID":"call_6004b2d038bc40bbabc15ae9","state":{"status":"completed","input":{"command":"echo hello-tool-verify"},"output":"hello-tool-verify\n","metadata":{"output":"hello-tool-verify\n","exit":0,"truncated":false},"title":"echo hello-tool-verify","time":{"start":1791090994726,"end":1791090994759}},"id":"prt_10557adab0010zYumFYr8bhOfy","sessionID":"ses_efaa85f59ffenk8gadDDvytS5s","messageID":"msg_10557a458001Mm7SW0eUfpLQ5Q"}}
{"type":"step_finish","timestamp":1791090994980,"sessionID":"ses_efaa85f59ffenk8gadDDvytS5s","part":{"id":"prt_10557ae81001B9E2Fa7gnYD6Ml","reason":"tool-calls","messageID":"msg_10557a458001Mm7SW0eUfpLQ5Q","sessionID":"ses_efaa85f59ffenk8gadDDvytS5s","type":"step-finish","tokens":{"total":7113,"input":281,"output":15,"reasoning":33,"cache":{"write":0,"read":6784}},"cost":0}}
{"type":"step_start","timestamp":1791090996489,"sessionID":"ses_efaa85f59ffenk8gadDDvytS5s","part":{"id":"prt_10557b4ec001u2LdJJHQ733oBm","messageID":"msg_10557af130013kt4GqT1DnItJc","sessionID":"ses_efaa85f59ffenk8gadDDvytS5s","type":"step-start"}}
{"type":"text","timestamp":1791090996489,"sessionID":"ses_efaa85f59ffenk8gadDDvytS5s","part":{"id":"prt_10557b4ef001DNKDgDywcGUJSQ","messageID":"msg_10557af130013kt4GqT1DnItJc","sessionID":"ses_efaa85f59ffenk8gadDDvytS5s","type":"text","text":"DONE","time":{"start":1791090996463,"end":1791090996468}}}
{"type":"step_finish","timestamp":1791090996489,"sessionID":"ses_efaa85f59ffenk8gadDDvytS5s","part":{"id":"prt_10557b4fa001ZG0dvBtQ2IMo9C","reason":"stop","messageID":"msg_10557af130013kt4GqT1DnItJc","sessionID":"ses_efaa85f59ffenk8gadDDvytS5s","type":"step-finish","tokens":{"total":7125,"input":82,"output":3,"reasoning":0,"cache":{"write":0,"read":7040}},"cost":0}}
EOF
run_extractor "$FIXTURE_DIR/live_capture_replay.ndjson" "$FIXTURE_DIR/out41.txt"
assert_eq "fixture 29: real live-captured opencode stream (tool session) still extracts" "0" "$EXTRACT_EC"
assert_eq "fixture 29: live capture final response is exactly DONE" "DONE" "$(cat "$FIXTURE_DIR/out41.txt")"

# fixture 30: EXACT replay of the live-captured minimal opencode 1.18.x
# session (/tmp/opencode/verify/events.ndjson, probe 2026-10-04).
cat > "$FIXTURE_DIR/live_capture_minimal.ndjson" <<'EOF'
{"type":"step_start","timestamp":1791090974810,"sessionID":"ses_efaa8ad92ffeYvy3bmz5R9QZvy","part":{"id":"prt_105576037001WBFWWUZ12eD2Z2","messageID":"msg_105575666001sTYAiGNOyHFLQF","sessionID":"ses_efaa8ad92ffeYvy3bmz5R9QZvy","type":"step-start"}}
{"type":"text","timestamp":1791090974811,"sessionID":"ses_efaa8ad92ffeYvy3bmz5R9QZvy","part":{"id":"prt_10557603b0014uFe2cjE8mVp5b","messageID":"msg_105575666001sTYAiGNOyHFLQF","sessionID":"ses_efaa8ad92ffeYvy3bmz5R9QZvy","type":"text","text":"OK","time":{"start":1791090974779,"end":1791090974784}}}
{"type":"step_finish","timestamp":1791090974811,"sessionID":"ses_efaa8ad92ffeYvy3bmz5R9QZvy","part":{"id":"prt_105576047001NR7QUnKeq95jPZ","reason":"stop","messageID":"msg_105575666001sTYAiGNOyHFLQF","sessionID":"ses_efaa8ad92ffeYvy3bmz5R9QZvy","type":"step-finish","tokens":{"total":7052,"input":265,"output":3,"reasoning":0,"cache":{"write":0,"read":6784}},"cost":0}}
EOF
run_extractor "$FIXTURE_DIR/live_capture_minimal.ndjson" "$FIXTURE_DIR/out42.txt"
assert_eq "fixture 30: real live-captured minimal opencode stream still extracts" "0" "$EXTRACT_EC"
assert_eq "fixture 30: live minimal capture final response is exactly OK" "OK" "$(cat "$FIXTURE_DIR/out42.txt")"

print_summary
