# Spec: KEMFAI Runner Recovery (Infrastructure-Only)

**Spec ID**: 002-runner-recovery
**Type**: Infrastructure recovery (owner-authorized), NOT onboarding product scope
**Date added**: 2026-10-04

## 1. Provenance (honest record — no invented prior approval)

This spec did NOT exist when the work it covers was first performed. It was
added retroactively on 2026-10-04, AFTER an independent Codex review rejected
the first revision of the runner-repair change set with (among others) this
blocker: the change had no Task ID or acceptance criteria in any `tasks.md`,
violating "NO SPEC → NO TASK ID → NO IMPLEMENTATION → NO TEST → NO MERGE".

The underlying work was performed under explicit owner authorization recorded
in `/home/hermesops/kemfai-runner-repair-instructions.md` (owner: Islam /
eslam.berkawy@gmail.com), which authorized repairing the stuck autonomous
runner after the 20261004-0830 incident. That authorization predates and
covers the infrastructure repair; it is NOT product/onboarding scope approval
and is NOT a waiver of the SpecKit pipeline or the independent-acceptance
gate. This document exists so the already-authorized infrastructure recovery
has an honest spec and an auditable task (T114) that independent review can
accept or reject on explicit criteria.

## 2. Problem being recovered

`scripts/run_next_step.sh` fed the ENTIRE opencode executor transcript (tool
outputs, command output, intermediate assistant text, final answer) into
governance (`extract_task_id` / `classify_executor_signal`). In incident
`scripts/logs/20261004-0830.log`, a tool result quoting stale
`recovery_job_state.md` Decision-Request text triggered a spurious
TECH_QUESTION and rolled back a genuine T049 change before review. A
follow-up independent review then rejected the first repair revision because
the deterministic boundary it introduced (`scripts/extract_final_response.py`)
still accepted truncated/malformed streams as governable final responses, and
because the repair work itself lacked a spec/task identity.

## 3. Scope

- IN scope: `scripts/run_next_step.sh` final-response boundary, raw-stream
  capture/retention, `scripts/extract_final_response.py`, the deterministic
  test suite under `scripts/tests/` (mocks, unit + integration scenarios),
  and this spec/tasks pair. Infrastructure only.
- OUT of scope: any product, UX, accounting, tax, entitlement, UI, tenant,
  or localization behavior; any change to the 113 tasks in
  `specs/001-saas-onboarding-shell/tasks.md` (task criteria, checkboxes,
  dependencies, or numbering); `scripts/run_loop.sh` orchestration policy;
  `scripts/.state/` contents; credentials; deploy/push.

## 4. Requirements (acceptance criteria are normative)

- **FR-1 Final-answer boundary**: Governance may ever see ONLY the executor's
  final assistant response. Tool outputs, command output, reasoning parts,
  step bookkeeping, and intermediate assistant messages (even ones quoting
  Decision-Request/marker text) are diagnostics-only and can never reach
  `extract_task_id` / `classify_executor_signal`.
- **FR-2 Raw log retention**: The complete raw executor stream is always
  written to the tick log (failed or not), clearly marked as
  diagnostics-only, so every fail-closed decision remains auditable.
- **FR-3 Robust terminal-stop requirement**: A stream is governable only if
  it ends with exactly ONE `step_finish(reason="stop")` event as the last
  non-empty line, closing the message that carries the final text. Missing,
  truncated, duplicated, or non-terminal stop events are NOT governable.
- **FR-4 Fail-closed on malformed/truncated/ambiguous streams**: Any
  non-JSON or non-object line (including trailing garbage), mixed or missing
  session identities, parts without message identity, a final message that
  contains tool calls, or later activity from another message after the final
  text must produce NO governable output (extractor exit 3, no output file);
  the runner must then treat the attempt exactly like an executor failure:
  rollback, no classification, no review, no commit.
- **FR-5 Reviewer gates**: The extractor change is accepted only through
  independent Codex review against T114's acceptance criteria (this spec's
  tasks.md); the implementer never approves its own implementation, and T114
  stays unchecked until that independent acceptance.
- **FR-6 Regression tests**: Deterministic (no real model calls) unit
  fixtures pinning live-verified opencode 1.18.x `--format json` event
  shapes, plus integration scenarios proving: truncated/malformed streams
  never reach review or commit and are fully rolled back with logs retained;
  clean final responses (including Decision-Request noise in tool output and
  intermediate text) still reach review; genuine final TECH_QUESTION /
  OWNER_ESCALATION markers are still honored; pin discipline is unchanged.
  Regressions are written FIRST and proven failing against the pre-fix code.

## 5. Relations to baseline documents

This spec does not modify `docs/KEMFAI_Blueprint_v1.0` or
`docs/KEMFAI_Implementation_Spec_v1.1_FINAL`. It operationalizes the
AGENTS.md "Governance hardening" contract (final-response boundary,
fail-closed extraction, keyed state, pin-first ordering) for the runner
infrastructure.
