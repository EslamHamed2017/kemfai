#!/usr/bin/env python3
"""Fail-closed CI structure contract for the accounting-foundation live gate.

T006 intentionally lands before the T015--T017 workflow and validator wiring.  The
focused suite must therefore be red until that required job exists, but it must
remain importable and syntactically valid in the meantime.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tempfile
import sys
import unittest
from pathlib import Path
from typing import Any

import yaml


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_PATH = ROOT / ".github/workflows/ci.yml"
BRANCH_PROTECTION_VALIDATOR = (
    ROOT / "scripts/fixtures/accounting_foundation_verify_branch_protection.py"
)
JOB_NAME = "accounting-foundation-owned-live"
EVIDENCE_DIR = "${{ runner.temp }}/accounting-foundation-evidence"


def _workflow() -> dict[str, Any]:
    loaded = yaml.safe_load(WORKFLOW_PATH.read_text(encoding="utf-8"))
    if not isinstance(loaded, dict) or not isinstance(loaded.get("jobs"), dict):
        raise AssertionError("CI workflow must contain a jobs mapping")
    return loaded


def _job() -> dict[str, Any]:
    job = _workflow()["jobs"].get(JOB_NAME)
    if not isinstance(job, dict):
        raise AssertionError(
            "missing intended T015 CI job: accounting-foundation-owned-live"
        )
    return job


def _steps(job: dict[str, Any]) -> list[dict[str, Any]]:
    steps = job.get("steps")
    if not isinstance(steps, list) or not steps:
        raise AssertionError(f"{JOB_NAME} must have non-empty steps")
    if not all(isinstance(step, dict) for step in steps):
        raise AssertionError(f"{JOB_NAME} contains a malformed step")
    return steps


def _named_step(job: dict[str, Any], name: str) -> tuple[int, dict[str, Any]]:
    matches = [
        (index, step)
        for index, step in enumerate(_steps(job))
        if step.get("name") == name
    ]
    if len(matches) != 1:
        raise AssertionError(f"expected exactly one {name!r} step, got {len(matches)}")
    return matches[0]


def _job_text(job: dict[str, Any]) -> str:
    return yaml.safe_dump(job, sort_keys=False)


def _story_four_task(posting_tasks: str, number: int) -> str:
    matches = re.findall(
        rf"^- \[ \] T{number:03d} .*?$", posting_tasks, re.MULTILINE
    )
    if len(matches) != 1:
        raise AssertionError(f"expected exactly one Story 4 task T{number:03d}")
    return matches[0].lower()


def _story_four_task_block(posting_tasks: str, number: int) -> str:
    matches = re.findall(
        rf"(^- \[ \] T{number:03d} .*$(?:\n(?:(?:[ \t]+.*)|[ \t]*$))*)",
        posting_tasks,
        re.MULTILINE,
    )
    if len(matches) != 1:
        raise AssertionError(f"expected exactly one Story 4 task block T{number:03d}")
    return matches[0].rstrip().lower()


def _assert_story_four_graph_structure(posting_tasks: str) -> None:
    task_lines: dict[int, str] = {}
    for match in re.finditer(r"^- \[ \] T(\d{3}) (.*?)$", posting_tasks, re.MULTILINE):
        number = int(match.group(1))
        if number in task_lines:
            raise AssertionError(f"duplicate Story 4 task T{number:03d}")
        task_lines[number] = match.group(0)

    expected = list(range(159, 212))
    if sorted(task_lines) != expected or list(task_lines) != expected:
        raise AssertionError("Story 4 task IDs must be exactly T159–T211 in sequence")

    dependency_graph: dict[int, set[int]] = {}
    for number, line in task_lines.items():
        match = re.search(r"— Deps: (.*?); AC:", line)
        if match is None:
            raise AssertionError(f"T{number:03d} has no parseable dependency list")
        dependencies: set[int] = set()
        for token in (part.strip() for part in match.group(1).split(",")):
            range_match = re.fullmatch(r"T(\d{3})[–-]T?(\d{3})", token)
            single_match = re.fullmatch(r"T(\d{3})", token)
            if range_match:
                start, end = map(int, range_match.groups())
                if start > end:
                    raise AssertionError(f"T{number:03d} has a reversed dependency range")
                dependencies.update(range(start, end + 1))
            elif single_match:
                dependencies.add(int(single_match.group(1)))
            else:
                raise AssertionError(f"T{number:03d} has an invalid dependency token: {token}")
        dependency_graph[number] = {dependency for dependency in dependencies if dependency >= 159}
        future = sorted(dependency for dependency in dependency_graph[number] if dependency >= number)
        if future:
            raise AssertionError(
                f"T{number:03d} has nonpreceding dependency T{future[0]:03d}"
            )

    if dependency_graph[177] != set(range(159, 177)):
        raise AssertionError("T177 must depend on the complete T159–T176 barrier")

    semantic_prerequisites = {
        180: {179},  # Arabic/RTL slice consumes T179 receipt and recovery semantics.
        189: {178, 183},  # Rounding covers both immediate and maker-checker posting paths.
        193: {187, 188, 189},  # Selector races consume policy, period, rounding, and FX slices.
    }
    for number, required in semantic_prerequisites.items():
        missing = sorted(required - dependency_graph[number])
        if missing:
            raise AssertionError(
                f"T{number:03d} omits semantic prerequisite T{missing[0]:03d}"
            )

    visiting: set[int] = set()
    visited: set[int] = set()

    def visit(number: int) -> None:
        if number in visiting:
            raise AssertionError(f"Story 4 dependency cycle includes T{number:03d}")
        if number in visited:
            return
        visiting.add(number)
        for dependency in dependency_graph[number]:
            if dependency not in dependency_graph:
                raise AssertionError(f"T{number:03d} depends on missing T{dependency:03d}")
            visit(dependency)
        visiting.remove(number)
        visited.add(number)

    for number in expected:
        visit(number)


def _assert_story_four_replay_audit_contract(posting_tasks: str) -> None:
    requirements = {
        166: ("each exact replay correlation", "one deduplicated `posting.replayed` platform event", "no second tenant mutation event"),
        175: ("per-correlation replay-event counts", "no second tenant mutation event"),
        190: ("each exact replay correlation", "one deduplicated `posting.replayed` platform event", "no second tenant mutation event"),
        200: ("per-correlation replay-event counts", "no second tenant mutation event"),
        205: ("per-correlation replay-event counts", "no second tenant mutation event"),
    }
    quantified_posting_replay_tasks = (175, 190, 200, 205)
    replay_corpus_requirements = (
        "at least 100 distinct posting operations",
        "each replayed with its original operation identifier",
        "persisted unique operation identifiers and replay counts",
        "one financial result per distinct operation",
        "altered-payload reuse rejection for every operation",
    )
    for number, phrases in requirements.items():
        task = _story_four_task_block(posting_tasks, number)
        for phrase in phrases:
            if phrase.lower() not in task:
                raise AssertionError(f"T{number:03d} omits replay audit requirement: {phrase}")
    for number in quantified_posting_replay_tasks:
        task = _story_four_task_block(posting_tasks, number)
        for phrase in replay_corpus_requirements:
            if phrase not in task:
                raise AssertionError(
                    f"T{number:03d} omits SC-003 replay corpus requirement: {phrase}"
                )


def _assert_story_four_checker_review_contract(posting_tasks: str) -> None:
    requirements = {
        159: (
            "the seven exact story 4 routes",
            "get /v1/accounting/posting-approvals?status=pending",
            "get /v1/accounting/posting-approvals/{approvalid}",
        ),
        167: (
            "scope-filtered pending-approval collection",
            "approval detail read",
            "without mutation",
        ),
        168: (
            "non-mutating checker preview",
            "final locked recomputation",
        ),
        182: (
            "scope-filtered pending-approval collection",
            "authorized approval detail read",
            "without mutation",
        ),
        183: (
            "previewdigest",
            "final locked recomputation exactly matches the checker-confirmed preview",
            "marks the candidate stale",
            "zero ledger effect",
        ),
        189: (
            "preview computation",
            "final locked recomputation",
            "exactly matches the checker-confirmed preview",
            "marks the candidate stale",
            "zero ledger effect",
        ),
    }
    for number, phrases in requirements.items():
        task = _story_four_task_block(posting_tasks, number)
        for phrase in phrases:
            if phrase not in task:
                raise AssertionError(
                    f"T{number:03d} omits checker review contract: {phrase}"
                )


def _assert_story_four_approval_revalidation_and_usability_contract(
    posting_tasks: str,
) -> None:
    requirements = {
        163: ("maker authority", "posting master deactivation", "draft/candidate integrity"),
        175: ("maker authority revocation", "posting master deactivation"),
        183: (
            "maker's post authority/scope",
            "draft/candidate integrity",
            "posting masters",
            "unauthorized checker fails closed without changing the still-pending candidate",
            "only changed draft/candidate or invalidated execution facts mark it stale",
        ),
        200: (
            "trained accountant creating, validating, and submitting",
            "five-line manual entry",
            "no more than 3 minutes",
            "both english and arabic",
            "during moderated acceptance",
            "excluding approval wait time",
        ),
        205: (
            "trained accountant creating, validating, and submitting",
            "five-line manual entry",
            "no more than 3 minutes",
            "both english and arabic",
            "during moderated acceptance",
            "excluding approval wait time",
        ),
    }
    for number, phrases in requirements.items():
        task = _story_four_task_block(posting_tasks, number)
        for phrase in phrases:
            if phrase.lower() not in task:
                raise AssertionError(
                    f"T{number:03d} omits approval/usability requirement: {phrase}"
                )


def _assert_story_four_vertical_slice_semantics(posting_tasks: str) -> None:
    if "Every runtime task T177–T195 is an independently reviewable" not in posting_tasks:
        raise AssertionError("runtime vertical-slice range must end before acceptance gates")
    for number in range(177, 196):
        task = _story_four_task(posting_tasks, number)
        if "vertical slice" not in task:
            raise AssertionError(f"T{number:03d} is horizontally layered")
        if "browser ui→next bff→nest→odoo→tenant audit" not in task:
            raise AssertionError(f"T{number:03d} omits a required runtime boundary")

    for number in range(196, 199):
        task = _story_four_task(posting_tasks, number)
        if "acceptance gate" not in task:
            raise AssertionError(f"T{number:03d} is not classified as a gate")
        if "vertical slice" in task:
            raise AssertionError(
                f"T{number:03d} disguises verification as implementation"
            )

    forbidden_semantics = (
        r"production posting is (?:now )?enabled",
        r"module\.accounting_posting=true",
        r"routes are mounted",
        r"backend posting (?:may execute|happens) before the human ui",
        r"no human ui or explicit confirmation is required",
        r"defers implementation to the acceptance gates",
        r"accepted as a backend-only task",
        r"acceptance gate implements deferred",
        r"accessibility implementation is postponed",
        r"acceptance gate completes the accessibility fixes",
    )
    lowered = posting_tasks.lower()
    for pattern in forbidden_semantics:
        if re.search(pattern, lowered):
            raise AssertionError(f"contradictory Story 4 semantics: {pattern}")


def _assert_story_four_addendum_identity(
    posting_tasks: str, addendum_bytes: bytes
) -> None:
    expected_blob_oid = "0bcbf4967902946b992183a957b79f0db69420a8"
    expected_digest = (
        "78d144ce46dbe41e6538db763108849352890ffae3346e4fb8ff6fdec7e7d1a0"
    )
    blob_oid = hashlib.sha1(
        f"blob {len(addendum_bytes)}\0".encode("ascii") + addendum_bytes
    ).hexdigest()
    digest = hashlib.sha256(addendum_bytes).hexdigest()
    if blob_oid != expected_blob_oid or digest != expected_digest:
        raise AssertionError(
            "Story 4 normative addendum drifted from the reviewed contract"
        )
    if f"Git blob OID `{expected_blob_oid}`" not in posting_tasks:
        raise AssertionError("Story 4 task graph omits the commissioned addendum blob")
    if f"SHA-256 digest `{expected_digest}`" not in posting_tasks:
        raise AssertionError("Story 4 task graph omits the commissioned addendum digest")


def _assert_story_four_vertical_slice_contract(posting_tasks: str) -> None:
    _assert_story_four_graph_structure(posting_tasks)
    _assert_story_four_replay_audit_contract(posting_tasks)
    _assert_story_four_checker_review_contract(posting_tasks)
    _assert_story_four_approval_revalidation_and_usability_contract(posting_tasks)
    commissioned_document_digest = (
        "e5b2e3319bd25c463f29b268be78e4ad97f7e954ca1449f68d6c826845af9b65"
    )
    if (
        hashlib.sha256(posting_tasks.encode("utf-8")).hexdigest()
        != commissioned_document_digest
    ):
        raise AssertionError(
            "Story 4 commissioning document drifted from the reviewed contract"
        )

    commissioned_runtime_digest = (
        "8f42f3eab2b2fa315973dff438992a46fee9fe15129f596845fc530296501d0b"
    )
    runtime_tasks = "\n".join(
        _story_four_task_block(posting_tasks, number)
        for number in range(177, 199)
    )
    if hashlib.sha256(runtime_tasks.encode("utf-8")).hexdigest() != commissioned_runtime_digest:
        raise AssertionError("Story 4 runtime/gate block drifted from the reviewed contract")

    if "Every runtime task T177–T195 is an independently reviewable" not in posting_tasks:
        raise AssertionError("runtime vertical-slice range must end before acceptance gates")
    for number in range(177, 196):
        task = _story_four_task(posting_tasks, number)
        if "vertical slice" not in task:
            raise AssertionError(f"T{number:03d} is horizontally layered")
        if "browser ui→next bff→nest→odoo→tenant audit" not in task:
            raise AssertionError(f"T{number:03d} omits a required runtime boundary")

    # These six lines are the reviewed commissioning contract. Exact matching is
    # intentional: free-form prose cannot be validated fail-closed with keyword
    # or regex inference. Any wording drift requires explicit re-commissioning.
    commissioned_tasks = {
        178: '- [ ] t178 [us4] [p: glm-5.2 | b: claude | r: codex] deliver the authorized english immediate-posting command happy-path vertical slice across browser ui→next bff→nest→odoo→tenant audit — deps: t177; ac: one balanced draft uses the non-mutating posting-preview read to show the minimum impact summary and unselected explicit confirmation bound to its exact strong draft etag and server preview digest, then re-resolves every locked preview input, fails closed on drift, posts atomically, returns only public uuid/receipt data, mirrors audit, and passes focused accessibility/contract/integration/browser tests while production remains disabled.',
        181: '- [ ] t181 [us4] [p: glm-5.2 | b: claude | r: codex] deliver the english maker human ui, impact review, explicit confirmation, and pending-approval request vertical slice across browser ui→next bff→nest→odoo→tenant audit — deps: t177; ac: one human-confirmed applicable approval configuration first uses the non-mutating posting-preview read and binds the request to its exact strong draft etag and server preview digest; after client bindings match, every locked input is re-resolved so changed but still valid preview inputs conflict with `409`, invalid execution facts fail validation with `422`, and neither outcome creates approval or ledger state; only an unchanged valid preview creates one immutable pending approval, request receipt, and authoritative audit event atomically with zero ledger movement, deterministic replay/conflict, preserved input on failure, and focused accessibility/browser tests.',
        183: "- [ ] t183 [us4] [p: glm-5.2 | b: claude | r: codex] deliver the english distinct-checker human ui, frozen-evidence review, explicit confirmation, and approval-to-post vertical slice across browser ui→next bff→nest→odoo→tenant audit — deps: t181, t182; ac: a non-maker checker with approve scope explicitly confirms and posts the frozen candidate once in one guarded transaction that revalidates the maker's post authority/scope, checker authority/scope, exact draft/candidate integrity, and company-scoped policy, period, posting masters, dimensions, source, fx, rounding, and approval facts; the approval body supplies the canonical `previewdigest` from the detail response with the exact strong approval etag, and the final locked recomputation exactly matches the checker-confirmed preview and digest or marks the candidate stale with zero ledger effect; self-approval or an unauthorized checker fails closed without changing the still-pending candidate; only changed draft/candidate or invalidated execution facts mark it stale without ledger effect, receipt plus tenant/platform audit complete before success, input survives failure, and focused accessibility/browser tests pass.",
        196: '- [ ] t196 [us4] [p: claude | b: glm-5.2 | r: codex] run the immediate-post/read/source accessibility acceptance gate across the complete real candidate path — deps: t179, t180, t185, t186; ac: en/ltr and ar/rtl keyboard flow, semantic headings/tables, linked errors, focus, live status, visible focus, axe, and 200% zoom pass without retrofitting or waiving any slice-level accessibility requirement.',
        197: '- [ ] t197 [us4] [p: claude | b: glm-5.2 | r: codex] run the maker/checker/recovery accessibility acceptance gate across the complete real candidate path — deps: t182, t184, t194, t195; ac: both locales pass keyboard, focus, linked-error, live-status, axe, and 200%-zoom checks for pending, checker, stale, failure, and recovery states without clipping, traps, retrofits, or waivers.',
        198: '- [ ] t198 [us4] [p: glm-5.2 | b: claude | r: codex] run the integrated story 4 candidate acceptance gate across browser ui→next bff→nest→odoo→tenant audit in disposable upgraded tenant dbs — deps: t177–t197; ac: additive install/upgrade, static, contract, odoo, nestjs, frontend, accessibility, migration, race, failure, recovery, and playwright discovery suites pass nonzero with zero failed/skipped/unexpected/flaky while production entitlement remains false, posting-preview, pending-approval collection, approval-detail, and mutation routes are absent, and authorized posted-entry and source-traversal reads remain mounted.',
    }
    for number, commissioned in commissioned_tasks.items():
        if _story_four_task(posting_tasks, number) != commissioned:
            raise AssertionError(
                f"T{number:03d} drifted from the reviewed commissioning contract"
            )

    for number in range(196, 199):
        task = _story_four_task(posting_tasks, number)
        if "acceptance gate" not in task:
            raise AssertionError(f"T{number:03d} is not classified as a gate")
        if "vertical slice" in task:
            raise AssertionError(
                f"T{number:03d} disguises verification as implementation"
            )

    _assert_story_four_vertical_slice_semantics(posting_tasks)


def _assert_story_four_gemini_gate_contract(posting_tasks: str) -> None:
    contradiction_patterns = (
        r"gemini(?: cross-checks?)?.{0,32}(?:prohibited|forbidden|not required|not mandatory|need not)",
        r"(?:cross-check|result).{0,24}(?:optional|advisory and never blocks)",
        r"findings.{0,20}(?:need not clear|may remain uncleared)",
        r"production(?: activation| go-live)?.{0,24}(?:is authorized|may be activated|can be activated|is permitted)",
    )
    lowered = posting_tasks.lower()
    for pattern in contradiction_patterns:
        if re.search(pattern, lowered):
            raise AssertionError(f"contradictory Gemini gate language: {pattern}")

    ownership = (
        "| Tests, frontend, evidence | Claude | GLM-5.2 | Codex, plus Gemini "
        "for Constitution/Spec/Plan/Tasks consistency cross-checks |"
    )
    ownership_rows = [
        line
        for line in posting_tasks.splitlines()
        if line.startswith("| Tests, frontend, evidence |")
    ]
    if ownership_rows != [ownership]:
        raise AssertionError("Gemini consistency ownership must be exact and unique")

    tasks: dict[int, str] = {}
    for number in (174, 176, 209):
        matches = re.findall(
            rf"^- \[ \] T{number:03d} .*?$", posting_tasks, re.MULTILINE
        )
        if len(matches) != 1:
            raise AssertionError(
                f"expected exactly one consistency gate T{number:03d}, got {len(matches)}"
            )
        tasks[number] = matches[0]

    expected_roles = {
        174: "[P: Claude | B: GLM-5.2 | R: Gemini + Codex]",
        176: "[P: GPT-5.6 Sol | B: Claude | R: Gemini + Codex]",
        209: "[P: GPT-5.6 Sol | B: Claude | R: Codex]",
    }
    for number, roles in expected_roles.items():
        if roles not in tasks[number]:
            raise AssertionError(
                f"T{number:03d} must keep Gemini cross-check independent of implementers"
            )
    if "Constitution/Spec/Plan/Tasks consistency" not in tasks[174]:
        raise AssertionError("T174 omits mandatory consistency scope")
    if (
        "Gemini cross-checker and Codex reviewer are independent of the primary and backup"
        not in tasks[174]
    ):
        raise AssertionError("T174 does not explicitly prohibit self-review")

    required_gate_text = {
        176: (
            "passed Gemini Constitution/Spec/Plan/Tasks consistency cross-check "
            "bound to the exact commissioning baseline"
        ),
        209: (
            "passed Gemini Constitution/Spec/Plan/Tasks consistency cross-check "
            "bound to the exact T208 head"
        ),
    }
    for number, requirement in required_gate_text.items():
        gate = tasks[number]
        if requirement not in gate:
            raise AssertionError(f"T{number:03d} lacks positive exact-head semantics")
        if "The cross-check is mandatory and blocking" not in gate:
            raise AssertionError(f"T{number:03d} permits an optional/advisory cross-check")
        if "missing, stale, non-passed, or uncleared cross-check evidence blocks" not in gate:
            raise AssertionError(f"T{number:03d} does not fail closed")

    if "cannot mutate production entitlement/routes" not in tasks[176]:
        raise AssertionError("T176 weakens production-disable safety")
    if "production remains disabled" not in tasks[209]:
        raise AssertionError("T209 weakens production-disable safety")


def _assert_story_four_rounding_contract(posting_tasks: str) -> None:
    required_by_task = {
        164: (
            "within-tolerance configured rounding",
            "transparent rounding line",
            "exact amount, account, rule version, actor, and original totals",
            "official currency precision",
            "applicable company/currency rounding configuration",
            "configured rounding account",
            "never silently truncates or transforms",
        ),
        168: (
            "rounding line if any",
            "immediate and maker-checker paths",
            "before unselected maker confirmation",
            "non-mutating checker preview",
            "final locked recomputation",
        ),
        175: (
            "within-tolerance configured rounding",
            "above-tolerance rejection",
            "official currency precision",
            "applicable company/currency rounding configuration",
            "configured rounding account",
            "never silently truncates or transforms",
            "maker-to-checker preview and approval-time recomputation",
        ),
        189: (
            "within configured minor-unit tolerance",
            "one transparent rounding line",
            "exact amount, account, rule version, actor, and original totals",
            "previewed before human confirmation",
            "both maker and checker",
            "non-mutating preview computation",
            "final locked recomputation",
            "exactly matches the checker-confirmed preview",
            "marks the candidate stale with zero ledger effect",
            "missing configuration, representational loss, or a difference above tolerance is rejected",
            "official currency precision",
            "applicable company/currency rounding configuration",
            "configured rounding account",
            "never silently truncates or transforms",
        ),
        200: (
            "configured-rounding success",
            "rounding-line preview",
            "official currency precision",
            "applicable company/currency rounding configuration",
            "configured rounding account",
            "never silently truncates or transforms",
            "maker-to-checker preview and recomputation",
        ),
    }
    for number, requirements in required_by_task.items():
        task = _story_four_task(posting_tasks, number)
        for requirement in requirements:
            if requirement not in task:
                raise AssertionError(
                    f"T{number:03d} omits locked rounding behavior: {requirement}"
                )


def _assert_story_four_commissioning_evidence_contract(posting_tasks: str) -> None:
    required_document_text = (
        "This document is a specification-only",
        "The commissioning PR also contains executable CI lifecycle repairs and graph-lock meta-tests",
        "Base main SHA:",
        "Commissioned graph identity:",
        "committed Git blob OID and SHA-256 digest",
        "Implementation candidate head:",
        "Base-main, graph-content, normative-addendum, Accounting Policy Matrix, or T151/T152 acceptance-record drift requires rebase, re-review, and re-commissioning",
        "Expected implementation commits that do not alter those inputs are not commissioning drift",
        "fail-closed red-evidence manifest",
        "task ID and test path",
        "exact command",
        "graph blob OID and SHA-256 digest",
        "posting addendum blob OID and SHA-256 digest",
        "Accounting Policy Matrix blob OID and SHA-256 digest",
        "T151/T152 acceptance-record blob OID and SHA-256 digest",
        "cross-checker identity, independence, scope, findings, decision, and time",
        "exit status",
        "discovered test count",
        "expected failure assertion and observed failure reason",
    )
    for requirement in required_document_text:
        if requirement not in posting_tasks:
            raise AssertionError(
                f"Story 4 commissioning evidence contract omits: {requirement}"
            )

    t176 = re.findall(r"^- \[ \] T176 .*?$", posting_tasks, re.MULTILINE)
    if len(t176) != 1:
        raise AssertionError(f"expected exactly one T176 gate, got {len(t176)}")
    for requirement in (
        "complete fail-closed red-evidence manifest",
        "placeholder, already-green, undiscovered, or wrong-reason failures block",
        "base main SHA, commissioned graph blob OID and SHA-256 digest",
        "posting addendum blob OID and SHA-256 digest",
        "Accounting Policy Matrix blob OID and SHA-256 digest",
        "T151/T152 acceptance-record blob OID and SHA-256 digest",
        "cross-checker identity, independence, scope, findings, decision, and time",
    ):
        if requirement not in t176[0]:
            raise AssertionError(f"T176 omits: {requirement}")


class AccountingFoundationCiStructureTests(unittest.TestCase):
    maxDiff = None

    def test_owned_live_job_is_unconditional_for_pull_requests(self) -> None:
        workflow = _workflow()
        job = _job()
        self.assertNotIn("if", job, "the required job cannot be opt-in or conditional")
        self.assertNotIn(
            "needs", job, "an unrelated/skipped prerequisite cannot suppress the gate"
        )
        self.assertNotIn("workflow_dispatch", _job_text(job).lower())

        pull_request = workflow.get("pull_request")
        if pull_request is None:
            # PyYAML 1.1 interprets the plain YAML key `on` as boolean True.
            triggers = workflow.get("on", workflow.get(True, {}))
            pull_request = (
                triggers.get("pull_request") if isinstance(triggers, dict) else None
            )
        self.assertIsNotNone(pull_request, "the workflow must run for pull requests")

    def test_job_has_no_continue_on_error_retry_or_bypass_path(self) -> None:
        job = _job()
        text = _job_text(job)
        self.assertNotIn("continue-on-error", text)
        self.assertNotIn("--passWithNoTests", text)
        self.assertNotRegex(text, r"(?im)(?:^|[;&| ])(?:retry|until)\b")
        self.assertNotRegex(text, r"(?m)\|\|\s*(?:true|:|exit\s+0)\b")
        self.assertNotRegex(text, r"(?im)\bretries\s*:\s*[1-9][0-9]*\b")
        self.assertNotRegex(text, r"(?im)\b(?:allow[-_ ]?failure|soft[-_ ]?fail)\b")
        self.assertNotRegex(
            text,
            r"(?im)\b(?:max_?attempts|backoff)\b|"
            r"\bfor\s+(?:attempt|try|i)\s+in\s+(?:\$\(seq|\{[0-9])|"
            r"^\s*while\s+",
        )

    def test_job_has_no_mock_or_network_interception_mode(self) -> None:
        text = _job_text(_job())
        for forbidden in (
            r"(?i)\bmock(?:ed|ing|s)?\b",
            r"(?i)\b(?:route|request)[-_ ]?intercept(?:ion)?\b",
            r"(?i)\b(?:fake|stub)[-_ ]?(?:api|odoo|backend)\b",
            r"(?i)KEMFAI_AF_(?:MOCK|INTERCEPT|OFFLINE)",
        ):
            self.assertNotRegex(text, forbidden)

    def test_runner_context_is_not_used_in_job_level_environment(self) -> None:
        job = _job()
        job_env = job.get("env", {})
        self.assertIsInstance(job_env, dict)
        self.assertNotIn(
            "KEMFAI_AF_EVIDENCE_DIR",
            job_env,
            "runner.temp is unavailable when a job-level environment is evaluated",
        )
        self.assertNotIn("${{ runner.", _job_text({"env": job_env}))

    def test_owned_runner_and_validator_are_distinct_ordered_steps(self) -> None:
        job = _job()
        run_index, run = _named_step(job, "Run accounting foundation owned live")
        validate_index, validate = _named_step(
            job, "Validate accounting foundation evidence independently"
        )
        self.assertLess(run_index, validate_index)
        self.assertEqual(
            run.get("run"), "bash scripts/test_accounting_foundation_owned_live.sh all"
        )
        self.assertNotIn("if", run)
        self.assertEqual(run.get("env", {}).get("KEMFAI_AF_EVIDENCE_DIR"), EVIDENCE_DIR)

        self.assertEqual(validate.get("if"), "always()")
        self.assertEqual(validate.get("shell"), "bash")
        self.assertEqual(
            validate.get("run"),
            'python3 scripts/fixtures/accounting_foundation_validate_evidence.py '
            '"$KEMFAI_AF_EVIDENCE_DIR"',
        )
        self.assertEqual(
            validate.get("env", {}).get("KEMFAI_AF_EVIDENCE_DIR"), EVIDENCE_DIR
        )
        self.assertNotIn("continue-on-error", validate)

    def test_evidence_upload_is_always_run_and_missing_files_are_errors(self) -> None:
        job = _job()
        validate_index, _ = _named_step(
            job, "Validate accounting foundation evidence independently"
        )
        upload_index, upload = _named_step(job, "Upload accounting foundation evidence")
        self.assertLess(validate_index, upload_index)
        self.assertEqual(upload.get("if"), "always()")
        self.assertEqual(upload.get("uses"), "actions/upload-artifact@v4")
        self.assertEqual(upload.get("with", {}).get("path"), EVIDENCE_DIR)
        self.assertEqual(upload.get("with", {}).get("if-no-files-found"), "error")
        self.assertNotIn("continue-on-error", upload)

    def test_database_backed_suites_have_an_owned_postgres_service(self) -> None:
        job = _job()
        postgres = job.get("services", {}).get("postgres")
        self.assertIsInstance(
            postgres, dict, "database-backed accounting suites require a job-owned PostgreSQL service"
        )
        self.assertEqual(postgres.get("image"), "postgres:16.10-alpine")
        self.assertEqual(postgres.get("ports"), ["5432:5432"])
        service_env = postgres.get("env", {})
        job_env = job.get("env", {})
        expected = {
            "CONTROL_DB_HOST": "127.0.0.1",
            "CONTROL_DB_PORT": 5432,
            "CONTROL_DB_USER": "kemfai_af_ci",
            "CONTROL_DB_PASSWORD": "${{ format('ci-fixture-{0}-{1}', github.run_id, github.run_attempt) }}",
            "CONTROL_DB_NAME": "kemfai_af_ci",
        }
        for name, value in expected.items():
            with self.subTest(variable=name):
                self.assertEqual(job_env.get(name), value)
        self.assertEqual(service_env.get("POSTGRES_USER"), expected["CONTROL_DB_USER"])
        self.assertEqual(service_env.get("POSTGRES_PASSWORD"), expected["CONTROL_DB_PASSWORD"])
        self.assertIn("github.run_id", expected["CONTROL_DB_PASSWORD"])
        self.assertNotIn("test_only", expected["CONTROL_DB_PASSWORD"])
        self.assertEqual(service_env.get("POSTGRES_DB"), expected["CONTROL_DB_NAME"])
        self.assertEqual(job_env.get("KEMFAI_CI_DB_HOST"), expected["CONTROL_DB_HOST"])
        self.assertEqual(job_env.get("KEMFAI_CI_DB_PORT"), expected["CONTROL_DB_PORT"])
        self.assertEqual(job_env.get("KEMFAI_CI_DB_USER"), expected["CONTROL_DB_USER"])
        self.assertEqual(job_env.get("KEMFAI_CI_DB_PASSWORD"), expected["CONTROL_DB_PASSWORD"])
        self.assertIn("pg_isready", str(postgres.get("options", "")))

    def test_queue_backed_contract_suite_has_an_owned_redis_service(self) -> None:
        job = _job()
        redis = job.get("services", {}).get("redis")
        self.assertIsInstance(
            redis, dict, "AppModule contract startup requires a job-owned Redis service"
        )
        self.assertEqual(redis.get("image"), "redis:7.4.7-alpine")
        self.assertEqual(redis.get("ports"), ["6379:6379"])
        self.assertIn("redis-cli ping", str(redis.get("options", "")))

        redis_url = job.get("env", {}).get("REDIS_URL")
        self.assertEqual(redis_url, "redis://127.0.0.1:6379/15")

    def test_suites_are_discovered_inside_the_required_job(self) -> None:
        text = _job_text(_job())
        required_wiring = {
            "contract suite": "accounting-foundation.contract-spec.ts",
            "tenant integration suite":
                "accounting-tenant-isolation.integration-spec.ts",
            "audit failure integration suite":
                "accounting-audit-failure.integration-spec.ts",
            "Odoo discovery and tests": "scripts/ci/test_odoo_addons.sh",
            "COA frontend unit suite": "accounting-coa.spec.tsx",
            "dimensions frontend unit suite": "accounting-dimensions.spec.tsx",
            "journal/currency frontend unit suite":
                "accounting-journals-currencies.spec.tsx",
            "draft frontend unit suite": "accounting-drafts.spec.tsx",
            "owned Playwright config": "playwright.accounting-foundation.config.ts",
        }
        for description, token in required_wiring.items():
            with self.subTest(description=description):
                self.assertIn(token, text)

        runner_index, _ = _named_step(_job(), "Run accounting foundation owned live")
        for index, step in enumerate(_steps(_job())):
            command = str(step.get("run", ""))
            if any(token in command for token in required_wiring.values()):
                self.assertLess(
                    index,
                    runner_index,
                    "suite discovery must fail before live evidence",
                )

    def test_live_integration_suites_are_only_discovered_before_owned_fixture(self) -> None:
        _, step = _named_step(
            _job(), "Discover Accounting Foundation owned integration suites"
        )
        command = str(step.get("run", ""))
        self.assertIn("--listTests", command)
        self.assertIn("accounting-tenant-isolation.integration-spec.ts", command)
        self.assertIn("accounting-audit-failure.integration-spec.ts", command)
        self.assertNotIn("test:integration:nonlive", command)
        self.assertIn("expected", command)
        self.assertIn("discovered", command)

    def test_live_playwright_is_only_discovered_before_owned_fixture(self) -> None:
        _, step = _named_step(_job(), "Discover Accounting Foundation Playwright journey")
        command = str(step.get("run", ""))
        self.assertIn("playwright test", command)
        self.assertIn("playwright.accounting-foundation.config.ts", command)
        self.assertIn("--list", command)

    def test_suite_commands_reject_zero_results(self) -> None:
        job = _job()
        text = _job_text(job)
        self.assertNotRegex(
            text,
            r"(?i)(?:passWithNoTests|allow[-_ ]?empty|no[-_ ]?tests[-_ ]?ok|"
            r"skip(?:ped)?[-_ ]?ok|unexpected[-_ ]?ok|flaky[-_ ]?ok)",
        )
        self.assertNotRegex(text, r"(?i)\b(?:describe|test|it)\.skip\b")
        self.assertNotRegex(text, r"(?im)^\s*(?:run:\s*)?echo\b[^\n]*accounting")

        executable_patterns = {
            "contract": (
                r"npm\b[^\n]*test:contract[^\n]*"
                r"accounting-foundation\.contract-spec\.ts"
            ),
            "integration discovery": (
                r"(?s)npx\s+jest.*?--listTests.*?"
                r"accounting-(?:tenant-isolation|audit-failure)\.integration-spec\.ts"
            ),
            "Odoo": r"bash scripts/ci/test_odoo_addons\.sh",
            "frontend unit": (
                r"npm\b[^\n]*(?:test|run test)[^\n]*"
                r"accounting-(?:coa|dimensions|journals-currencies|drafts)\.spec\.tsx"
            ),
            "Playwright": (
                r"playwright test[^\n]*playwright\.accounting-foundation\.config\.ts"
            ),
        }
        for description, pattern in executable_patterns.items():
            with self.subTest(executable=description):
                self.assertRegex(text, pattern)

        discovery_tokens = (
            "accounting-foundation.contract-spec.ts",
            "accounting-tenant-isolation.integration-spec.ts",
            "accounting-audit-failure.integration-spec.ts",
            "scripts/ci/test_odoo_addons.sh",
            "accounting-coa.spec.tsx",
            "accounting-dimensions.spec.tsx",
            "accounting-journals-currencies.spec.tsx",
            "accounting-drafts.spec.tsx",
            "playwright.accounting-foundation.config.ts",
        )
        discovery_steps = [
            step
            for step in _steps(job)
            if any(token in str(step.get("run", "")) for token in discovery_tokens)
        ]
        self.assertGreaterEqual(
            len(discovery_steps),
            5,
            "contract, integration, Odoo, frontend unit, and Playwright discovery "
            "must be independently visible in the required job",
        )
        for step in discovery_steps:
            self.assertNotIn("continue-on-error", step)
            self.assertNotIn("if", step, "suite discovery cannot be conditional")

    def test_branch_protection_validator_is_wired_and_read_only(self) -> None:
        job = _job()
        _, step = _named_step(job, "Verify accounting foundation branch protection")
        self.assertEqual(
            step.get("run"),
            "python3 scripts/fixtures/"
            "accounting_foundation_verify_branch_protection.py",
        )
        self.assertNotIn("continue-on-error", step)
        self.assertTrue(
            BRANCH_PROTECTION_VALIDATOR.is_file(),
            f"missing intended T017 validator: {BRANCH_PROTECTION_VALIDATOR}",
        )
        source = BRANCH_PROTECTION_VALIDATOR.read_text(encoding="utf-8")
        self.assertIn("accounting-foundation-owned-live", source)
        self.assertRegex(source, r"\bcurl\b")
        self.assertIn("https://api.github.com/", source)
        self.assertIn("GITHUB_TOKEN", source)
        self.assertIn("input=f", source)
        self.assertIn("{token}", source)
        self.assertEqual(
            step.get("env"),
            {
                "GITHUB_TOKEN": "${{ github.token }}",
                "KEMFAI_BRANCH_PROTECTION_BRANCH": "main",
            },
        )
        mutation_pattern = (
            r"(?i)(?:--method|-X)[\"',\s]*(?:POST|PUT|PATCH|DELETE)\b|"
            r"\bgh\s+api\b[^\n]*(?:--input|-f|--field|--raw-field)\b|"
            r"\bgh\s+(?:repo\s+edit|pr\s+merge|secret|variable)\b|"
            r"\bcurl\b[^\n]*api\.github\.com[^\n]*"
            r"(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b"
        )
        self.assertNotRegex(
            source,
            mutation_pattern,
            "branch-protection verification must never mutate GitHub",
        )
        self.assertNotRegex(
            source,
            r"(?i)[\"'](?:POST|PUT|PATCH|DELETE)[\"']",
            "the read-only validator cannot issue a mutating HTTP method",
        )
        self.assertNotRegex(
            _job_text(job),
            mutation_pattern,
            "the required CI job must not mutate external GitHub settings",
        )
        subprocess.run(
            [sys.executable, "-m", "py_compile", str(BRANCH_PROTECTION_VALIDATOR)],
            cwd=ROOT,
            check=True,
        )


    def _run_branch_protection_validator(
        self,
        payload: dict[str, Any],
        event: str = "pull_request",
        base_ref: str = "main",
        configured_branch: str | None = None,
    ) -> tuple[subprocess.CompletedProcess[str], str, str]:
        with tempfile.TemporaryDirectory(prefix="kemfai-af-gh-") as directory:
            fake_curl = Path(directory) / "curl"
            args_log = Path(directory) / "args.log"
            config_log = Path(directory) / "config.log"
            fake_curl.write_text(
                "#!/usr/bin/env bash\n"
                "cat >\"$GH_CONFIG_LOG\"\n"
                "printf '%s\\n' \"$GH_PAYLOAD\"\n"
                "printf '%s\\n' \"$*\" >\"$GH_ARGS_LOG\"\n",
                encoding="utf-8",
            )
            fake_curl.chmod(0o755)
            env = {
                **os.environ,
                "PATH": f"{directory}:{os.environ.get('PATH', '')}",
                "GITHUB_EVENT_NAME": event,
                "GITHUB_REPOSITORY": "owner/repository",
                "GITHUB_BASE_REF": base_ref,
                "GH_PAYLOAD": json.dumps(payload),
                "GH_ARGS_LOG": str(args_log),
                "GH_CONFIG_LOG": str(config_log),
                "GITHUB_TOKEN": "test-token-123",
            }
            if configured_branch is not None:
                env["KEMFAI_BRANCH_PROTECTION_BRANCH"] = configured_branch
            else:
                env.pop("KEMFAI_BRANCH_PROTECTION_BRANCH", None)
            result = subprocess.run(
                [sys.executable, str(BRANCH_PROTECTION_VALIDATOR)],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            arguments = args_log.read_text(encoding="utf-8") if args_log.exists() else ""
            config = config_log.read_text(encoding="utf-8") if config_log.exists() else ""
            return result, arguments, config

    def test_branch_protection_validator_accepts_only_the_exact_required_check(self) -> None:
        result, arguments, config = self._run_branch_protection_validator(
            {
                "protected": True,
                "protection": {
                    "enabled": True,
                    "required_status_checks": {
                        "contexts": [],
                        "checks": [{"context": JOB_NAME, "app_id": 1}],
                    },
                },
            }
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(
            arguments.strip(),
            "--disable --fail --silent --show-error --proto =https --tlsv1.2 --config - -H Accept: application/vnd.github+json -H User-Agent: kemfai-branch-protection-verifier https://api.github.com/repos/owner/repository/branches/main",
        )
        self.assertNotRegex(arguments, r"(?i)(?:-X|--request|authorization|token|(?:^|\s)-L(?:\s|$)|--location)")
        self.assertIn("test-token-123", config)
        self.assertNotIn("*" * 3, config)

    def test_branch_protection_validator_prefers_explicit_branch_over_pr_base(self) -> None:
        result, arguments, _ = self._run_branch_protection_validator(
            {
                "protected": True,
                "protection": {
                    "enabled": True,
                    "required_status_checks": {"contexts": [JOB_NAME]},
                },
            },
            base_ref="develop",
            configured_branch="main",
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(
            "https://api.github.com/repos/owner/repository/branches/main",
            arguments,
        )
        self.assertNotIn("/branches/develop", arguments)

    def test_branch_protection_validator_fails_closed_when_check_is_missing(self) -> None:
        result, _, _ = self._run_branch_protection_validator(
            {
                "protected": True,
                "protection": {
                    "enabled": True,
                    "required_status_checks": {"contexts": ["another-check"]},
                },
            }
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("FAIL", result.stderr)

    def test_branch_protection_validator_fails_closed_when_branch_is_unprotected(self) -> None:
        result, _, _ = self._run_branch_protection_validator(
            {"protected": False, "protection": {"enabled": False}}
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("FAIL", result.stderr)

    def test_branch_protection_validator_checks_push_events(self) -> None:
        result, arguments, config = self._run_branch_protection_validator(
            {
                "protected": True,
                "protection": {
                    "enabled": True,
                    "required_status_checks": {"contexts": [JOB_NAME]},
                },
            },
            event="push",
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("https://api.github.com/repos/owner/repository/branches/main", arguments)
        self.assertIn("test-token-123", config)


    def test_story_four_graph_structure_rejects_missing_ids(self) -> None:
        posting_tasks = (
            ROOT / "specs/003-accounting-foundation/posting-tasks.md"
        ).read_text(encoding="utf-8")
        missing = re.sub(r"^- \[ \] T180 .*?\n", "", posting_tasks, count=1, flags=re.MULTILINE)
        with self.assertRaisesRegex(AssertionError, "exactly T159–T211"):
            _assert_story_four_graph_structure(missing)

    def test_story_four_graph_structure_rejects_nonpreceding_dependencies(self) -> None:
        posting_tasks = (
            ROOT / "specs/003-accounting-foundation/posting-tasks.md"
        ).read_text(encoding="utf-8")
        future_dependency = posting_tasks.replace(
            "— Deps: T177; AC: One balanced",
            "— Deps: T179; AC: One balanced",
            1,
        )
        with self.assertRaisesRegex(AssertionError, "nonpreceding dependency"):
            _assert_story_four_graph_structure(future_dependency)

    def test_story_four_graph_structure_rejects_cycles(self) -> None:
        posting_tasks = (
            ROOT / "specs/003-accounting-foundation/posting-tasks.md"
        ).read_text(encoding="utf-8")
        cycle = posting_tasks.replace(
            "— Deps: T177; AC: One balanced",
            "— Deps: T179; AC: One balanced",
            1,
        )
        with self.assertRaisesRegex(AssertionError, "cycle|nonpreceding dependency"):
            _assert_story_four_graph_structure(cycle)

    def test_story_four_graph_structure_requires_complete_t177_barrier(self) -> None:
        posting_tasks = (
            ROOT / "specs/003-accounting-foundation/posting-tasks.md"
        ).read_text(encoding="utf-8")
        incomplete = posting_tasks.replace("— Deps: T159–T176; AC:", "— Deps: T159–T175; AC:", 1)
        with self.assertRaisesRegex(AssertionError, "T177.*T159–T176"):
            _assert_story_four_graph_structure(incomplete)

    def test_story_four_commissioning_evidence_contract_is_unambiguous(self) -> None:
        posting_tasks = (
            ROOT / "specs/003-accounting-foundation/posting-tasks.md"
        ).read_text(encoding="utf-8")
        _assert_story_four_commissioning_evidence_contract(posting_tasks)

    def test_story_four_runtime_graph_enforces_vertical_slice_contract(self) -> None:
        posting_tasks = (
            ROOT / "specs/003-accounting-foundation/posting-tasks.md"
        ).read_text(encoding="utf-8")
        _assert_story_four_vertical_slice_contract(posting_tasks)

    def test_story_four_graph_preserves_locked_rounding_contract(self) -> None:
        posting_tasks = (
            ROOT / "specs/003-accounting-foundation/posting-tasks.md"
        ).read_text(encoding="utf-8")
        _assert_story_four_rounding_contract(posting_tasks)

    def test_story_four_normative_addendum_identity_matches_current_content(self) -> None:
        posting_tasks = (
            ROOT / "specs/003-accounting-foundation/posting-tasks.md"
        ).read_text(encoding="utf-8")
        addendum_bytes = (
            ROOT / "specs/003-accounting-foundation/posting-addendum.md"
        ).read_bytes()
        _assert_story_four_addendum_identity(posting_tasks, addendum_bytes)
        self.assertIn("at the independently reviewed graph-review head", posting_tasks)

    def test_story_four_v11_amendment_is_reconciled_with_plan_and_gate_history(self) -> None:
        plan = (ROOT / "specs/003-accounting-foundation/plan.md").read_text(
            encoding="utf-8"
        )
        posting_addendum = (
            ROOT / "specs/003-accounting-foundation/posting-addendum.md"
        ).read_text(encoding="utf-8")

        self.assertIn(
            "posting-addendum.md`](./posting-addendum.md) v1.1 amendment candidate",
            plan,
        )
        self.assertIn(
            "T152 remains the completed historical review record for v1.0",
            plan,
        )
        self.assertIn(
            "v1.1 must receive exact-content independent review before Story 4 runtime implementation",
            plan,
        )
        self.assertNotIn(
            "ambiguities are resolved before T152 is checked complete",
            posting_addendum,
        )
        self.assertIn(
            "T152 remains the completed historical review record for v1.0",
            posting_addendum,
        )

    def test_story_four_normative_addendum_identity_rejects_semantic_mutation(self) -> None:
        posting_tasks = (
            ROOT / "specs/003-accounting-foundation/posting-tasks.md"
        ).read_text(encoding="utf-8")
        addendum_bytes = (
            ROOT / "specs/003-accounting-foundation/posting-addendum.md"
        ).read_bytes()
        weakened = addendum_bytes + (
            b"\nProduction posting routes are mounted and enabled by default.\n"
        )
        with self.assertRaisesRegex(AssertionError, "normative addendum drifted"):
            _assert_story_four_addendum_identity(posting_tasks, weakened)

    def test_story_four_checker_review_contract_is_non_mutating_and_revalidated(self) -> None:
        posting_tasks = (
            ROOT / "specs/003-accounting-foundation/posting-tasks.md"
        ).read_text(encoding="utf-8")
        _assert_story_four_checker_review_contract(posting_tasks)
        posting_addendum = (
            ROOT / "specs/003-accounting-foundation/posting-addendum.md"
        ).read_text(encoding="utf-8")
        for phrase in (
            "GET /v1/accounting/posting-approvals?status=pending",
            "GET /v1/accounting/posting-approvals/{approvalId}",
            "non-mutating preview evidence",
            "canonical `previewDigest`",
            "approval command body includes the exact `previewDigest`",
            "strong approval ETag covers the preview digest inputs",
            "final recomputation under the guarded transaction locks",
            "exactly matches the checker-confirmed preview",
            "marks the candidate stale with zero ledger effect",
        ):
            self.assertIn(phrase, posting_addendum)

    def test_story_four_immediate_post_binds_confirmation_to_preview(self) -> None:
        posting_addendum = (
            ROOT / "specs/003-accounting-foundation/posting-addendum.md"
        ).read_text(encoding="utf-8")
        posting_tasks = (
            ROOT / "specs/003-accounting-foundation/posting-tasks.md"
        ).read_text(encoding="utf-8")
        for phrase in (
            "GET /v1/accounting/drafts/{draftId}/posting-preview",
            "post request body includes the exact `previewDigest`",
            "immediate-post preview and confirmation",
            "current-state drift is never reclassified as a client-binding mismatch",
            "Only a mismatch at that client-binding step returns `412`",
            "changed but still valid preview inputs return `409`",
            "invalid execution facts return `422`",
        ):
            self.assertIn(phrase, posting_addendum)
        for phrase in (
            "digest-bound immediate-post confirmation",
            "immediate-post preview-input drift",
        ):
            self.assertIn(phrase, posting_tasks)

    def test_story_four_immediate_post_status_precedence_is_deterministic(self) -> None:
        posting_addendum = (
            ROOT / "specs/003-accounting-foundation/posting-addendum.md"
        ).read_text(encoding="utf-8")
        post_contract = posting_addendum.split("### 3.2 Post request", 1)[1].split(
            "### 3.3 Approval review", 1
        )[0]
        for phrase in (
            "first compares the submitted `If-Match` and `previewDigest`",
            "immutable server-issued preview record",
            "Only a mismatch at that client-binding step returns `412`",
            "After those preconditions match",
            "changed but still valid preview inputs return `409`",
        ):
            self.assertIn(phrase, post_contract)

    def test_story_four_maker_approval_request_binds_the_preview_contract(self) -> None:
        posting_tasks = (
            ROOT / "specs/003-accounting-foundation/posting-tasks.md"
        ).read_text(encoding="utf-8")
        task = _story_four_task_block(posting_tasks, 181)
        for phrase in (
            "exact strong draft etag and server preview digest",
            "changed but still valid preview inputs conflict",
            "invalid execution facts fail validation",
        ):
            self.assertIn(phrase, task)

    def test_story_four_approval_status_precedence_is_deterministic(self) -> None:
        posting_addendum = (
            ROOT / "specs/003-accounting-foundation/posting-addendum.md"
        ).read_text(encoding="utf-8")
        approval_contract = posting_addendum.split(
            "### 3.3 Approval review", 1
        )[1].split("### 3.4 Outcomes", 1)[0].lower()
        for phrase in (
            "checker authorization is evaluated before candidate staleness",
            "remains pending",
            "changed but still valid execution facts",
            "return `409`",
            "invalid execution facts",
            "return `422`",
        ):
            self.assertIn(phrase, approval_contract)

    def test_story_four_current_authorization_precedes_idempotent_replay(self) -> None:
        posting_addendum = (
            ROOT / "specs/003-accounting-foundation/posting-addendum.md"
        ).read_text(encoding="utf-8")
        maker_transaction = posting_addendum.split(
            "### 6.2 Pending-approval transaction", 1
        )[1].split("### 6.3 Immediate-post", 1)[0].lower()
        posting_transaction = posting_addendum.split(
            "### 6.3 Immediate-post or approval-post transaction", 1
        )[1].split("### 6.4 Mirror", 1)[0].lower()

        self.assertLess(
            maker_transaction.index("verifies the human maker's current `post` authority"),
            maker_transaction.index("replays an existing actor-bound matching receipt"),
        )
        self.assertLess(
            posting_transaction.index("verifies current command authorization"),
            posting_transaction.index("replays an existing actor-bound matching receipt"),
        )
        for contract in (maker_transaction, posting_transaction):
            self.assertIn(
                "authorization revoked since the original command cannot retrieve its terminal outcome",
                contract,
            )

    def test_story_four_disabled_route_behavior_is_explicit_per_operation(self) -> None:
        posting_addendum = (
            ROOT / "specs/003-accounting-foundation/posting-addendum.md"
        ).read_text(encoding="utf-8")
        route_contract = posting_addendum.split(
            "## 3. Boundary and routes", 1
        )[1].split("### 3.1 Command headers", 1)[0]
        for phrase in (
            "posting-preview, pending-approval collection, approval-detail, and mutation routes are absent",
            "posted-entry and source-traversal reads remain mounted",
        ):
            self.assertIn(phrase, route_contract)

    def test_story_four_historical_reads_precede_first_posting_slice(self) -> None:
        posting_tasks = (
            ROOT / "specs/003-accounting-foundation/posting-tasks.md"
        ).read_text(encoding="utf-8")
        first_runtime = _story_four_task_block(posting_tasks, 177).lower()
        first_posting = _story_four_task_block(posting_tasks, 178).lower()
        for required_read in (
            "delivers the complete immutable posted-entry read",
            "bidirectional source-traversal read",
        ):
            self.assertIn(required_read, first_runtime)
            self.assertNotIn(required_read, first_posting)

    def test_story_four_disabled_route_policy_is_commissioned_end_to_end(self) -> None:
        posting_tasks = (
            ROOT / "specs/003-accounting-foundation/posting-tasks.md"
        ).read_text(encoding="utf-8")
        route_absence = (
            "posting-preview, pending-approval collection, approval-detail, "
            "and mutation routes are absent"
        )
        route_availability = "posted-entry and source-traversal reads remain mounted"
        for task_number in (160, 167, 173, 177, 198, 203, 208, 210):
            with self.subTest(task=task_number):
                task_block = _story_four_task_block(posting_tasks, task_number)
                self.assertIn(route_absence, task_block)
                self.assertIn(route_availability, task_block)
        commissioning_baseline = posting_tasks.split("## Ownership", 1)[0].lower()
        self.assertIn(route_absence, commissioning_baseline)
        self.assertIn(route_availability, commissioning_baseline)

    def test_story_four_pending_approval_locks_and_recomputes_all_selectors(self) -> None:
        posting_addendum = (
            ROOT / "specs/003-accounting-foundation/posting-addendum.md"
        ).read_text(encoding="utf-8")
        pending_transaction = posting_addendum.split(
            "### 6.2 Pending-approval transaction", 1
        )[1].split("### 6.3 Immediate-post", 1)[0]
        for phrase in (
            "shared mutation-compatible selector/version locks for policy, period, "
            "entry classification, approval, rounding, FX, dimension, source, "
            "master-data, and authority selectors",
            "re-resolves every locked selector",
            "recomputes the maker-visible preview and canonical digest",
        ):
            self.assertIn(phrase, pending_transaction)

    def test_story_four_locks_every_mutable_preview_selector(self) -> None:
        posting_addendum = (
            ROOT / "specs/003-accounting-foundation/posting-addendum.md"
        ).read_text(encoding="utf-8")
        posting_tasks = (
            ROOT / "specs/003-accounting-foundation/posting-tasks.md"
        ).read_text(encoding="utf-8")
        for phrase in (
            "shared mutation-compatible selector/version locks",
            "rounding, FX, dimension, source, master-data, and authority selectors",
            "phantom or overlapping configuration rows",
        ):
            self.assertIn(phrase, posting_addendum)
        for phrase in (
            "rounding/FX/dimension/source/master-data/authority selector changes",
            "true two-connection/two-transaction",
        ):
            self.assertIn(phrase, posting_tasks)

    def test_story_four_rounding_contract_rejects_generic_impact_line(self) -> None:
        posting_tasks = (
            ROOT / "specs/003-accounting-foundation/posting-tasks.md"
        ).read_text(encoding="utf-8")
        weakened = posting_tasks.replace("rounding line if any", "impact line if any", 1)
        self.assertNotEqual(weakened, posting_tasks)
        with self.assertRaisesRegex(AssertionError, "T168.*rounding line if any"):
            _assert_story_four_rounding_contract(weakened)


    def test_story_four_vertical_slice_contract_rejects_mutation_before_human_ui(self) -> None:
        posting_tasks = (
            ROOT / "specs/003-accounting-foundation/posting-tasks.md"
        ).read_text(encoding="utf-8")
        task = re.search(r"^- \[ \] T178 .*?$", posting_tasks, re.MULTILINE)
        self.assertIsNotNone(task)
        contradictions = (
            " Backend posting may execute before the human UI or explicit confirmation.",
            " Backend posting happens before the human UI or explicit confirmation.",
            " No human UI or explicit confirmation is required.",
        )
        for suffix in contradictions:
            contradiction = posting_tasks.replace(
                task.group(0), task.group(0) + suffix, 1
            )
            with self.subTest(suffix=suffix):
                with self.assertRaises(AssertionError):
                    _assert_story_four_vertical_slice_semantics(contradiction)

    def test_story_four_vertical_slice_contract_rejects_uncommissioned_runtime_drift(self) -> None:
        posting_tasks = (
            ROOT / "specs/003-accounting-foundation/posting-tasks.md"
        ).read_text(encoding="utf-8")
        mutations = {
            177: " Set module.accounting_posting=true and mount posting routes.",
            179: " No human UI or explicit confirmation is required.",
            195: " This slice defers implementation to the acceptance gates.",
        }
        for number, suffix in mutations.items():
            task = re.search(
                rf"^- \[ \] T{number:03d} .*?$", posting_tasks, re.MULTILINE
            )
            self.assertIsNotNone(task)
            contradiction = posting_tasks.replace(
                task.group(0), task.group(0) + suffix, 1
            )
            with self.subTest(number=number):
                with self.assertRaises(AssertionError):
                    _assert_story_four_vertical_slice_semantics(contradiction)

    def test_story_four_vertical_slice_contract_rejects_continuation_drift(self) -> None:
        posting_tasks = (
            ROOT / "specs/003-accounting-foundation/posting-tasks.md"
        ).read_text(encoding="utf-8")
        mutations = {
            177: "\n  Set module.accounting_posting=true and mount posting routes.",
            179: "\n  No human UI or explicit confirmation is required.",
            188: "\n  This may be accepted as a backend-only task with no human UI.",
            195: "\n  This slice defers implementation to the acceptance gates.",
        }
        for number, continuation in mutations.items():
            task = re.search(
                rf"^- \[ \] T{number:03d} .*?$", posting_tasks, re.MULTILINE
            )
            self.assertIsNotNone(task)
            contradiction = posting_tasks.replace(
                task.group(0), task.group(0) + continuation, 1
            )
            with self.subTest(number=number):
                with self.assertRaises(AssertionError):
                    _assert_story_four_vertical_slice_semantics(contradiction)

    def test_story_four_vertical_slice_contract_rejects_activation_outside_task_blocks(self) -> None:
        posting_tasks = (
            ROOT / "specs/003-accounting-foundation/posting-tasks.md"
        ).read_text(encoding="utf-8")
        policy = (
            "Every runtime task T177–T195 is an independently reviewable, "
            "non-production vertical slice"
        )
        mutations = (
            posting_tasks + (
                "\nProduction posting is enabled; module.accounting_posting=true "
                "and routes are mounted.\n"
            ),
            posting_tasks.replace(
                "- [ ] T178",
                "Production posting is enabled and routes are mounted.\n- [ ] T178",
                1,
            ),
            posting_tasks.replace(
                policy,
                policy + "; production posting is now enabled",
                1,
            ),
        )
        for contradiction in mutations:
            with self.subTest(mutation=contradiction[-100:]):
                with self.assertRaises(AssertionError):
                    _assert_story_four_vertical_slice_semantics(contradiction)

    def test_story_four_vertical_slice_contract_rejects_deferred_gate_implementation(self) -> None:
        posting_tasks = (
            ROOT / "specs/003-accounting-foundation/posting-tasks.md"
        ).read_text(encoding="utf-8")
        task = re.search(r"^- \[ \] T196 .*?$", posting_tasks, re.MULTILINE)
        self.assertIsNotNone(task)
        contradictions = (
            " This acceptance gate implements deferred accessibility retrofits.",
            " Accessibility implementation is postponed to this acceptance gate.",
            " This acceptance gate completes the accessibility fixes omitted by the runtime slices.",
        )
        for suffix in contradictions:
            contradiction = posting_tasks.replace(
                task.group(0), task.group(0) + suffix, 1
            )
            with self.subTest(suffix=suffix):
                with self.assertRaises(AssertionError):
                    _assert_story_four_vertical_slice_semantics(contradiction)

    def test_story_four_graph_requires_gemini_consistency_cross_check(self) -> None:
        posting_tasks = (
            ROOT / "specs/003-accounting-foundation/posting-tasks.md"
        ).read_text(encoding="utf-8")
        _assert_story_four_gemini_gate_contract(posting_tasks)

    def test_story_four_gemini_gate_rejects_contradictory_language(self) -> None:
        posting_tasks = (
            ROOT / "specs/003-accounting-foundation/posting-tasks.md"
        ).read_text(encoding="utf-8")
        mutations = (
            "Gemini cross-checks are prohibited",
            "Gemini cross-checks are forbidden",
            "Gemini need not run or pass",
            "Gemini is not required to run or pass",
            "The cross-check is optional",
            "The result is advisory and never blocks",
            "Findings need not clear",
            "Production activation is authorized",
            "Production may be activated",
            "Production go-live is permitted",
        )
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                with self.assertRaises(AssertionError):
                    _assert_story_four_gemini_gate_contract(
                        posting_tasks + "\n" + mutation
                    )

    def test_story_four_gemini_gate_rejects_self_review(self) -> None:
        posting_tasks = (
            ROOT / "specs/003-accounting-foundation/posting-tasks.md"
        ).read_text(encoding="utf-8")
        role_mutations = (
            (
                "[P: Claude | B: GLM-5.2 | R: Gemini + Codex]",
                "[P: Gemini | B: GLM-5.2 | R: Gemini + Codex]",
                (174,),
            ),
            (
                "[P: GPT-5.6 Sol | B: Claude | R: Gemini + Codex]",
                "[P: Gemini | B: Claude | R: Gemini + Codex]",
                (176,),
            ),
            (
                "[P: GPT-5.6 Sol | B: Claude | R: Codex]",
                "[P: Gemini | B: Claude | R: Gemini + Codex]",
                (209,),
            ),
        )
        for original, self_reviewed, matching_tasks in role_mutations:
            for number in matching_tasks:
                task_pattern = rf"(^- \[ \] T{number:03d} .*?$)"
                task = re.search(task_pattern, posting_tasks, re.MULTILINE)
                self.assertIsNotNone(task)
                mutated_task = task.group(0).replace(original, self_reviewed, 1)
                self_review = posting_tasks.replace(task.group(0), mutated_task, 1)
                with self.subTest(number=number):
                    with self.assertRaises(AssertionError):
                        _assert_story_four_gemini_gate_contract(self_review)

    def test_story_four_gemini_gate_rejects_conflicting_duplicates(self) -> None:
        posting_tasks = (
            ROOT / "specs/003-accounting-foundation/posting-tasks.md"
        ).read_text(encoding="utf-8")
        duplicate_task = (
            posting_tasks
            + "\n- [ ] T174 [US4] [P: Gemini | B: GLM-5.2 | R: Gemini + Codex] "
            + "Conflicting self-reviewed task.\n"
        )
        conflicting_owner = (
            posting_tasks
            + "\n| Tests, frontend, evidence | Gemini | GLM-5.2 | Gemini |\n"
        )
        for mutation in (duplicate_task, conflicting_owner):
            with self.subTest(mutation=mutation[-120:]):
                with self.assertRaises(AssertionError):
                    _assert_story_four_gemini_gate_contract(mutation)



if __name__ == "__main__":
    unittest.main(verbosity=2)
