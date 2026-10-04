# Tasks: KEMFAI Runner Recovery (Infrastructure-Only)

**Input**: `specs/002-runner-recovery/spec.md` (requirements FR-1…FR-6).

**Provenance**: This tasks file and its spec were added on 2026-10-04 AFTER
independent Codex review rejected the first repair revision for lacking any
Task ID/acceptance criteria. The work was performed under owner authorization
recorded in `/home/hermesops/kemfai-runner-repair-instructions.md`
(infrastructure repair only). No prior SpecKit approval is claimed or
invented. The original 113 tasks in
`specs/001-saas-onboarding-shell/tasks.md` are NOT modified by this file in
any way (no renumbering, no criteria edits, no checkbox changes).

**Role legend**: same as `specs/001-saas-onboarding-shell/tasks.md`
(Claude = Spec/Frontend, GLM = Backend builder, Codex = Reviewer).
No task's Reviewer equals its Primary.

---

- [x] T114 Runner final-response boundary: deterministic, fail-closed
  extraction of the executor's final assistant response
  - Files: `scripts/extract_final_response.py`, `scripts/run_next_step.sh`
    (boundary invocation only), `scripts/lib_governance.sh`
    (final-response-boundary contract header for the OUTPUT-consuming
    helpers; pre-existing `extract_unique_task_marker` occurrence-count fix —
    the old `sort -u` collapsed repeated identical markers into "one",
    normalizing output its own contract and scenario AE declare ambiguous;
    covered by `test_lib_governance.sh` 76 checks),
    `scripts/tests/test_extract_final_response.sh`,
    `scripts/tests/test_run_loop_integration.sh`, `scripts/tests/mocks/opencode`,
    `scripts/tests/mocks/claude`, `scripts/tests/run_all.sh`, `AGENTS.md`
    (governance-hardening documentation bullet), `specs/002-runner-recovery/`
    (this spec/tasks pair).
  - **Dependencies**: None (infrastructure; independent of
    specs/001-saas-onboarding-shell task set).
  - **Acceptance Criteria** (all must be independently verified):
    1. *(FR-1 final-answer boundary)* Only the final assistant response ever
       reaches `extract_task_id`/`classify_executor_signal`; a stream whose
       tool output or intermediate text quotes Decision-Request/marker noise
       still reaches review when its true final response is clean
       (unit fixtures 1/9; scenarios AF, AK).
    2. *(FR-2 raw log retention)* Every tick log retains the complete raw
       executor stream, marked diagnostics-only, including on fail-closed
       outcomes (scenarios AJ, AL assert the retained log).
    3. *(FR-3 robust terminal stop)* Exit 0 requires exactly one
       `step_finish(reason="stop")` as the LAST non-empty line, closing the
       text-bearing final message; truncated (fixture 12), trailing-garbage
       (fixture 13), trailing-event (fixture 14), wrong-reason (fixture 15),
       duplicate-stop (fixture 19), and stop-on-text-less-message (fixture 20)
       streams all fail closed.
    4. *(FR-4 fail-closed malformed/ambiguous)* Any non-JSON/non-object line
       (fixtures 6, 11, 13), mixed/missing session identity (fixtures 16, 18),
       or part without messageID (fixture 17) fails closed with exit 3 and no
       output file; the runner then rolls back fully with no classification,
       review, or commit (scenario AL: exit 4 "runner failed", clean tree).
    5. *(FR-5 reviewer gates)* Independent Codex review against these
       criteria; implementer does not approve its own work; this checkbox is
       changed ONLY by that independent acceptance (owner-ratified pipeline).
    6. *(FR-6 regression tests, red-first)* Two red-first rounds, both
       preserved as history: (revision 2) regressions written and proven
       failing against the pre-fix extractor (20 unit + 6 integration checks
       red), then fixed; (cycle 1) the second independent-review rejection's
       four fail-open blockers — event/part type confusion, malformed part
       session identity, interleaved message ambiguity, parts without
       messageID — were reproduced as fixtures 21–30 (reviewer probe streams
       embedded verbatim plus neighboring variants) and proven failing
       against the then-current extractor
       (`test_extract_final_response.sh`: 89 checks, **32 red**; evidence
       `/home/hermesops/kemfai-runner-repair-cycle1-red.log`), then fixed
       under the strict event/part-type pairing, part-identity, and
       sequential message-protocol contract (fixtures 29/30 replay the
       live-captured opencode 1.18.x streams to pin that verified valid
       events still pass). Full suite `bash scripts/tests/run_all.sh` passes
       deterministically (**360 checks, 0 failed**: `test_lib_governance.sh`
       76, `test_extract_final_response.sh` 89,
       `test_run_loop_integration.sh` 195); `bash -n` clean on all changed
       shell scripts; `python3 -m py_compile
       scripts/extract_final_response.py` clean; `git diff --check` clean.
    7. *(scope guard)* No product/accounting/entitlement/UI/tenant code
       changed; `specs/001-saas-onboarding-shell/tasks.md` untouched by this
       change set; `scripts/run_loop.sh` and `scripts/.state/` untouched;
       nothing committed/pushed/deployed.
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

## Notes

- T114 is deliberately left UNCHECKED until independent Codex acceptance
  against the criteria above; per spec provenance, the implementation
  predates this task document (owner-authorized repair) and that history is
  recorded honestly rather than retroactively approved.
- Cycle 1 (2026-10-04): a second independent review round
  (`/home/hermesops/kemfai-runner-repair-review-final.log`) rejected the
  revision-2 extractor for four reproduced fail-open paths. They were fixed
  red-first (89 checks, 32 red, evidence
  `/home/hermesops/kemfai-runner-repair-cycle1-red.log`) by rewriting the
  extractor with strict top-level/part-type pairing, mandatory non-empty
  string `sessionID`/`messageID` on every part (step-start and reasoning
  included), and a sequential message-protocol state machine that tracks
  step-start and reasoning activity so any interleaved or later message
  makes the stream ambiguous. Current evidence: full suite 360 checks
  (76/89/195), 0 failed; recorded in Revision 3 of
  `/home/hermesops/kemfai-runner-repair-result.md`. Acceptance still pending.


## T114 infrastructure recovery — independently accepted

Independent Codex review: /home/hermesops/kemfai-runner-repair-review-final.log
Final verdict: REVIEW VERDICT: ACCEPT. Reviewer executed 360 governance checks
(76/89/195), shell syntax, extractor compilation, diff whitespace validation,
and adversarial truncated/malformed-tail, identity, event-type, interleaving
and terminal-finish probes. All four previous fail-open blockers resolved.
Only standalone infrastructure T114 completed; original onboarding tasks unchanged.
No product/accounting/legal/locked-baseline changes or deploy/push.
Product T049 smoke is a separate pending gate.
