#!/usr/bin/env python3
"""KEMFAI: deterministic final-response extractor for `opencode run --format json`.

Boundary contract (see scripts/run_next_step.sh and AGENTS.md): ONLY an
executor's FINAL assistant message text is governable. Everything else in the
raw event stream -- tool call inputs/outputs, command output, intermediate
assistant messages, reasoning, step bookkeeping -- is diagnostics-only and
must NEVER reach extract_task_id / classify_executor_signal.

Event shapes verified live against opencode 1.18.x `run --format json`
(raw NDJSON events, one JSON object per line; probe captures retained at
/tmp/opencode/verify and /tmp/opencode/verify2):

  {"type":"step_start", ...,"part":{"type":"step-start","messageID":"msg_...","sessionID":"ses_..."}}
  {"type":"tool_use",   ...,"part":{"type":"tool","tool":"bash",
                                     "state":{"output":"..."},"messageID":"msg_...","sessionID":"ses_..."}}
  {"type":"text",       ...,"part":{"type":"text","text":"...","messageID":"msg_...","sessionID":"ses_..."}}
  {"type":"reasoning",  ...,"part":{"type":"reasoning","text":"...","messageID":"msg_...","sessionID":"ses_..."}}
  {"type":"step_finish",...,"part":{"type":"step-finish","reason":"stop",   ...}}
                                       {"type":"step-finish","reason":"tool-calls",...}}

Tool results appear ONLY inside tool parts (part.state.output); the CLI emits
no tool-result text events of its own.

Trustworthiness contract (strengthened 2026-10-04 after two independent
review rejections -- first a truncated stream, then four fail-open paths:
event/part type confusion, malformed part session identity, interleaved
message ambiguity, and parts without message identity): exit 0 -- meaning
the extracted text may safely reach governance -- requires ALL of:

  1. every non-empty line is a valid JSON event object (any malformed,
     non-JSON, or trailing garbage line fails closed -- the runner captures
     the stream with 2>&1, so noise means stderr interleaved with events and
     the stream can no longer be trusted);
  2. STRICT event/part type pairing limited to the live-verified schema:
     top-level type MUST be one of step_start/tool_use/text/reasoning/
     step_finish and the part type MUST be its exact counterpart
     (step-start/tool/text/reasoning/step-finish). Any unknown top-level
     type or mismatched pairing is event/part type confusion and fails
     closed -- text is only ever taken from a genuine `text`/`text` event;
  3. every event carries the SAME non-empty top-level sessionID, and EVERY
     part carries a non-empty string sessionID equal to it (missing,
     non-string, empty, or contradictory part identity fails closed --
     identity is no longer checked only when it is already a string);
  4. EVERY part -- step-start and reasoning included -- carries a non-empty
     string messageID (ambiguous message identity fails closed);
  5. messages follow the verified sequential protocol: each message opens
     with a step-start part, may be followed by text/tool/reasoning parts,
     and is closed by exactly one step-finish part; a message may never
     interleave with another, reappear after another message started, start
     before the previous one closed, or carry activity after its own
     step-finish. Step-start and reasoning activity is tracked, so any
     interleaved or later message makes the stream ambiguous;
  6. exactly ONE step-finish part with reason "stop" exists, and it is the
     LAST non-empty line of the stream (a missing, truncated, duplicated,
     or non-terminal stop means the run or the capture is incomplete);
  7. that terminal stop closes the message that carries the final
     assistant text, and that message contains no tool parts of its own
     (an aborted mid-work or forged tail is not a final response).

Deliberately conservative on ambiguity: an intermediate assistant message
that quotes marker/Decision-Request text can never trigger governance,
because only the actual final response is ever extracted.

Fail-closed contract:
  exit 0 -> final response written to <final_out_file> (non-empty)
  exit 3 -> NO trustworthy final response (reason on stderr); output file
            is never written. The caller must treat the whole attempt as
            ungovernable: no classification, no review, no commit.
"""
import json
import sys

# Live-verified opencode 1.18.x event schema: top-level event type -> the
# ONLY part type it may carry. Anything outside this map (unknown event
# type, missing part, or mismatched pairing) is fail-closed.
VALID_EVENT_PART_TYPES = {
    "step_start": "step-start",
    "tool_use": "tool",
    "text": "text",
    "reasoning": "reasoning",
    "step_finish": "step-finish",
}


def _fail(reason):
    sys.stderr.write("extract_final_response: FAIL-CLOSED (%s)\n" % reason)
    return 3


def main(argv):
    if len(argv) != 3:
        return _fail(
            "usage: extract_final_response.py <raw_ndjson_file> <final_out_file>"
        )
    raw_path, out_path = argv[1], argv[2]
    try:
        fh = open(raw_path, "r", encoding="utf-8", errors="replace")
    except OSError as exc:
        return _fail("cannot read raw stream: %s" % exc)

    stream_session = None
    texts = {}         # messageID -> [non-empty text parts, in event order]
    tools = {}         # messageID -> tool-part occurrence count
    stop_events = 0    # count of step-finish parts with reason "stop"
    current_mid = None  # message whose parts we are currently reading
    current_closed = False  # has current_mid already seen its step-finish?
    seen_mids = set()  # every messageID observed (revisits are ambiguous)
    last_etype = None  # top-level type of the last non-empty line
    last_reason = None  # step-finish reason of the last non-empty line
    index = 0

    with fh:
        for lineno, line in enumerate(fh, 1):
            stripped = line.strip()
            if not stripped:
                continue
            index += 1
            try:
                event = json.loads(stripped)
            except ValueError:
                return _fail(
                    "line %d is not valid JSON (malformed/corrupt/trailing "
                    "stream data)" % lineno
                )
            if not isinstance(event, dict):
                return _fail(
                    "line %d is valid JSON but not an event object" % lineno
                )
            sid = event.get("sessionID")
            if not isinstance(sid, str) or not sid:
                return _fail(
                    "line %d carries no sessionID (ambiguous stream identity)"
                    % lineno
                )
            if stream_session is None:
                stream_session = sid
            elif sid != stream_session:
                return _fail(
                    "line %d mixes sessionIDs %s and %s (ambiguous stream "
                    "identity)" % (lineno, stream_session, sid)
                )
            etype = event.get("type")
            expected_ptype = VALID_EVENT_PART_TYPES.get(etype)
            if expected_ptype is None:
                return _fail(
                    "line %d has unknown top-level event type %r (outside "
                    "the live-verified opencode event schema)" % (lineno, etype)
                )
            part = event.get("part")
            if not isinstance(part, dict):
                return _fail(
                    "line %d %s event carries no part object" % (lineno, etype)
                )
            ptype = part.get("type")
            if ptype != expected_ptype:
                return _fail(
                    "line %d event/part type confusion: top-level %r cannot "
                    "carry a %r part (only %r/%s pairs are governable)"
                    % (lineno, etype, ptype, etype, expected_ptype)
                )
            psid = part.get("sessionID")
            if not isinstance(psid, str) or not psid:
                return _fail(
                    "line %d %s part sessionID is missing or not a non-empty "
                    "string (ambiguous identity)" % (lineno, ptype)
                )
            if psid != stream_session:
                return _fail(
                    "line %d part sessionID %r contradicts stream sessionID "
                    "%r (ambiguous identity)" % (lineno, psid, stream_session)
                )
            mid = part.get("messageID")
            if not isinstance(mid, str) or not mid:
                return _fail(
                    "line %d %s part carries no messageID (ambiguous message "
                    "identity)" % (lineno, ptype)
                )

            # (5) Sequential message protocol: no interleaving, no revisits,
            # every message opens with step-start and closes once.
            if mid == current_mid:
                if current_closed:
                    return _fail(
                        "line %d carries %s activity for message %s after "
                        "its step-finish (malformed message sequencing)"
                        % (lineno, ptype, mid)
                    )
            else:
                if mid in seen_mids:
                    return _fail(
                        "line %d interleaved message %s reappears after "
                        "another message started (ambiguous final message)"
                        % (lineno, mid)
                    )
                if current_mid is not None and not current_closed:
                    return _fail(
                        "line %d starts message %s before message %s was "
                        "closed by a step-finish (ambiguous interleaving)"
                        % (lineno, mid, current_mid)
                    )
                if ptype != "step-start":
                    return _fail(
                        "line %d message %s opens with a %s part instead of "
                        "step-start (outside the verified event protocol)"
                        % (lineno, mid, ptype)
                    )
                seen_mids.add(mid)
                current_mid = mid
                current_closed = False

            if ptype == "text":
                text = part.get("text")
                if not isinstance(text, str):
                    return _fail(
                        "line %d text part carries a non-string text field "
                        "(malformed part)" % lineno
                    )
                if text.strip():
                    texts.setdefault(mid, []).append(text)
            elif ptype == "tool":
                tools[mid] = tools.get(mid, 0) + 1
            elif ptype == "step-finish":
                reason = part.get("reason")
                if not isinstance(reason, str) or not reason:
                    return _fail(
                        "line %d step-finish part carries no string reason "
                        "(malformed part)" % lineno
                    )
                current_closed = True
                if reason == "stop":
                    stop_events += 1
            # step-start and reasoning parts are tracked activity only:
            # they can never contribute text to the final response.

            last_etype = etype
            last_reason = part.get("reason")

    if index == 0:
        return _fail("empty event stream")

    # (6) The stream must END with the single terminal step_finish(stop).
    if not (last_etype == "step_finish" and last_reason == "stop"):
        return _fail(
            'stream does not end with a terminal step_finish(reason="stop") '
            "event (missing/truncated terminal event or trailing data)"
        )
    if stop_events != 1:
        return _fail(
            "expected exactly one terminal step_finish(\"stop\") event, "
            "found %d (ambiguous terminal)" % stop_events
        )
    final_mid = current_mid

    # (7) The terminal stop must close the message that bears the final text.
    if not texts.get(final_mid):
        return _fail(
            "the terminal stop closes message %s, which carries no assistant "
            "text (not a final response)" % final_mid
        )
    if tools.get(final_mid, 0) > 0:
        return _fail(
            "the terminal message %s also contains tool calls "
            "(aborted mid-work, not a final response)" % final_mid
        )

    # Join the final message's text parts line-preservingly: each part starts
    # on its own line so no marker line can ever be forged by concatenation.
    final_text = "\n".join(texts[final_mid])
    if not final_text.strip():
        return _fail("final response is empty/whitespace")

    try:
        with open(out_path, "w", encoding="utf-8") as out:
            out.write(final_text)
            if not final_text.endswith("\n"):
                out.write("\n")
    except OSError as exc:
        return _fail("cannot write final response: %s" % exc)

    sys.stderr.write(
        "extract_final_response: ok (terminal stop closes message %s after "
        "%d text part(s); %d text-bearing message(s); session %s)\n"
        % (final_mid, len(texts[final_mid]), len(texts), stream_session)
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
