#!/usr/bin/env python3
"""Mutation contract for the Accounting Foundation task-graph validator (T007).

The suite deliberately lands before T013. Until that validator exists, every case
fails for the same explicit reason rather than accidentally accepting an unchecked
mutation.
"""

from __future__ import annotations

import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
TASKS = ROOT / "specs/003-accounting-foundation/tasks.md"
VALIDATOR = ROOT / "scripts/fixtures/accounting_foundation_validate_tasks.py"
TASK_RE = re.compile(r"^- \[[ x]\] (T\d{3})(?: \[P\])?(?: \[US\d\])? ", re.MULTILINE)


class AccountingFoundationTaskGraphTests(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls) -> None:
        cls.baseline = TASKS.read_text(encoding="utf-8")
        ids = TASK_RE.findall(cls.baseline)
        cls_ids = [f"T{number:03d}" for number in range(1, 159)]
        if ids != cls_ids:
            raise AssertionError("accepted baseline must contain exact sequential T001-T158")
        for marker in ("SAFE-PROVEN", "PARTIAL-SAFE-ONLY", "BLOCKED-POLICY"):
            if marker not in cls.baseline:
                raise AssertionError(f"accepted baseline is missing {marker}")

    def require_validator(self) -> None:
        self.assertTrue(
            VALIDATOR.is_file(),
            f"missing intended T013 validator: {VALIDATOR.relative_to(ROOT)}",
        )

    def run_validator(self, text: str) -> subprocess.CompletedProcess[str]:
        self.require_validator()
        with tempfile.TemporaryDirectory(prefix="kemfai-af-t007-") as directory:
            candidate = Path(directory) / "tasks.md"
            candidate.write_text(text, encoding="utf-8")
            return subprocess.run(
                [sys.executable, str(VALIDATOR), str(candidate)],
                cwd=ROOT,
                text=True,
                capture_output=True,
                check=False,
            )

    def mutate(self, old: str, new: str) -> str:
        self.assertIn(old, self.baseline, f"mutation anchor drifted: {old}")
        return self.baseline.replace(old, new, 1)

    def assert_rejected(self, text: str) -> None:
        result = self.run_validator(text)
        self.assertNotEqual(
            result.returncode,
            0,
            "validator accepted a deliberately unsafe task graph",
        )

    def test_current_accepted_graph_is_valid(self) -> None:
        result = self.run_validator(self.baseline)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_missing_dependency_is_rejected(self) -> None:
        self.assert_rejected(self.mutate("Deps: T004, T005", "Deps: T004, T999"))

    def test_nonpreceding_dependency_and_cycle_are_rejected(self) -> None:
        self.assert_rejected(
            self.mutate(
                "T006 Add CI-structure tests in `scripts/tests/test_accounting_foundation_ci.py` — Deps: T004, T005",
                "T006 Add CI-structure tests in `scripts/tests/test_accounting_foundation_ci.py` — Deps: T007",
            )
        )

    def test_unsafe_parallel_label_is_rejected(self) -> None:
        self.assert_rejected(
            self.mutate(
                "T010 Implement `preflight|story-1|story-2|story-3|all|cleanup`",
                "T010 [P] Implement `preflight|story-1|story-2|story-3|all|cleanup`",
            )
        )

    def test_story_implementation_before_all_red_tests_is_rejected(self) -> None:
        self.assert_rejected(
            self.mutate(
                "T031 [US1] Create an install-neutral `kemfai_accounting` package skeleton in `backend/addons/kemfai_accounting/__init__.py`, `__manifest__.py`, `models/__init__.py`, and `tests/__init__.py` — Deps: T018–T030",
                "T031 [US1] Create an install-neutral `kemfai_accounting` package skeleton in `backend/addons/kemfai_accounting/__init__.py`, `__manifest__.py`, `models/__init__.py`, and `tests/__init__.py` — Deps: T018",
            )
        )

    def test_post_acceptance_implementation_is_rejected(self) -> None:
        self.assert_rejected(
            self.mutate(
                "T143 Run `python3 scripts/fixtures/accounting_foundation_validate_tasks.py",
                "T143 Implement posting service then run `python3 scripts/fixtures/accounting_foundation_validate_tasks.py",
            )
        )

    def test_import_or_data_target_before_creation_is_rejected(self) -> None:
        self.assert_rejected(
            self.mutate(
                "`models/__init__.py` imports no future model module",
                "`models/__init__.py` imports future `models/journal.py` before creation",
            )
        )

    def test_install_before_complete_models_imports_and_access_is_rejected(self) -> None:
        self.assert_rejected(
            self.mutate(
                "T045 [US1] Install or upgrade the complete `kemfai_accounting` addon during tenant provisioning in `backend/api/src/integrations/provisioning/tenant-provision.processor.ts` — Deps: T037, T044",
                "T045 [US1] Install or upgrade the complete `kemfai_accounting` addon during tenant provisioning in `backend/api/src/integrations/provisioning/tenant-provision.processor.ts` — Deps: T031",
            )
        )

    def test_acceptance_without_final_addon_upgrade_is_rejected(self) -> None:
        self.assert_rejected(
            self.mutate(
                "T142 [US3] Run required `accounting-foundation-owned-live` Story 3 acceptance and publish independently validated evidence — Deps: T141",
                "T142 [US3] Run required `accounting-foundation-owned-live` Story 3 acceptance and publish independently validated evidence — Deps: T119",
            )
        )

    def test_false_green_traceability_is_rejected(self) -> None:
        self.assert_rejected(
            self.mutate(
                "| FR-021 | **BLOCKED-POLICY** |",
                "| FR-021 | **SAFE-PROVEN** |",
            )
        )

    def test_completed_policy_gate_has_no_stale_pending_claims(self) -> None:
        stale_claims = (
            "matrix is pending Finance Owner approval",
            "No Owner-approved applicable matrix exists",
            "All seven locked category values remain an external owner gate",
            "because both are pending",
            "values remain unresolved in this specification",
        )
        quickstart = (
            ROOT / "specs/003-accounting-foundation/quickstart.md"
        ).read_text(encoding="utf-8")
        requirements_checklist = (
            ROOT / "specs/003-accounting-foundation/checklists/requirements.md"
        ).read_text(encoding="utf-8")
        specification = (
            ROOT / "specs/003-accounting-foundation/spec.md"
        ).read_text(encoding="utf-8")
        for claim in stale_claims:
            self.assertNotIn(claim, self.baseline)
            self.assertNotIn(claim, quickstart)
            self.assertNotIn(claim, requirements_checklist)
            self.assertNotIn(claim, specification)
        self.assertNotIn("Matrix remains unresolved", requirements_checklist)
        self.assertNotIn("Exactly one `[NEEDS CLARIFICATION]` marker exists", requirements_checklist)

    def test_reviewed_posting_addendum_has_no_stale_future_claims(self) -> None:
        posting_addendum = (
            ROOT / "specs/003-accounting-foundation/posting-addendum.md"
        ).read_text(encoding="utf-8")
        quickstart = (
            ROOT / "specs/003-accounting-foundation/quickstart.md"
        ).read_text(encoding="utf-8")
        research = (
            ROOT / "specs/003-accounting-foundation/research.md"
        ).read_text(encoding="utf-8")
        plan = (
            ROOT / "specs/003-accounting-foundation/plan.md"
        ).read_text(encoding="utf-8")

        self.assertIn("**Addendum version:** 1.1", posting_addendum)
        self.assertIn("**Status:** SPECIFICATION AMENDMENT CANDIDATE", posting_addendum)
        self.assertIn("exact-content independent re-review", posting_addendum)
        self.assertIn("any amendment invalidates that evidence", posting_addendum)
        for stale_claim in (
            "If the Finance Owner later approves the matrix",
            "create a new reviewed contract/model/quickstart addendum",
            "`accounting-policy-matrix.md` is pending",
            "posting remains disabled until its separately reviewed addendum",
            "`accounting-policy-matrix.md` no longer has pending rows",
        ):
            self.assertNotIn(stale_claim, quickstart)
            self.assertNotIn(stale_claim, research)
            self.assertNotIn(stale_claim, plan)

    def test_posting_conflict_audit_does_not_contradict_idempotency(self) -> None:
        posting_addendum = (
            ROOT / "specs/003-accounting-foundation/posting-addendum.md"
        ).read_text(encoding="utf-8")
        posting_tasks = (
            ROOT / "specs/003-accounting-foundation/posting-tasks.md"
        ).read_text(encoding="utf-8")

        self.assertIn(
            "cannot create another move, approval, receipt, or authoritative tenant mutation event",
            posting_addendum,
        )
        self.assertNotIn(
            "each conflict correlation creates one deduplicated authoritative denial audit event",
            posting_addendum,
        )
        self.assertIn(
            "Each complete denied-attempt identity creates one authoritative denial audit event",
            posting_addendum,
        )
        self.assertIn(
            "domain-separated denied-attempt identity",
            posting_addendum,
        )
        self.assertIn(
            "tenant, company, authenticated actor, action, scoped idempotency-key hash, "
            "denied request fingerprint, winning operation identifier and fingerprint, and correlation ID",
            posting_addendum,
        )
        self.assertIn(
            "A reused correlation ID with a different denied request fingerprint is a distinct attempt",
            posting_addendum,
        )
        for task_id in ("T163", "T190"):
            task = next(
                line for line in posting_tasks.splitlines() if f"] {task_id} " in line
            )
            self.assertIn(
                "zero financial, approval, receipt, and tenant-mutation loser rows",
                task,
            )
            self.assertIn(
                "exactly one authoritative denial audit event per domain-separated denied-attempt identity",
                task,
            )
            self.assertIn(
                "repeated delivery of the same denied-attempt identity is deduplicated",
                task,
            )
            self.assertIn(
                "tenant, company, authenticated actor, action, scoped-key hash, denied fingerprint and winning operation identifier/fingerprint",
                task,
            )

    def test_approved_reversal_policy_gate_is_reconciled(self) -> None:
        matrix = (
            ROOT / "specs/003-accounting-foundation/accounting-policy-matrix.md"
        ).read_text(encoding="utf-8")
        plan = (
            ROOT / "specs/003-accounting-foundation/plan.md"
        ).read_text(encoding="utf-8")

        self.assertIn("**Status:** APPROVED — v1.0", matrix)
        for approved_semantic in (
            "reversal date must be in an allowed period",
            "default journal is the original journal unless configured otherwise",
            "Maker–Checker applies when configured",
            "duplicate reversal/correction chains are prevented",
        ):
            self.assertIn(approved_semantic, matrix)
            self.assertIn(approved_semantic, plan)

    def test_reviewed_reversal_addendum_is_reconciled(self) -> None:
        reversal_addendum = (
            ROOT / "specs/003-accounting-foundation/reversal-addendum.md"
        ).read_text(encoding="utf-8")
        plan = (
            ROOT / "specs/003-accounting-foundation/plan.md"
        ).read_text(encoding="utf-8")

        for accepted_evidence in (
            "**Addendum version:** 1.0",
            "**Status:** INDEPENDENTLY REVIEWED",
            "**Independent review:** Codex — ACCEPT",
            "original posted entry is immutable",
            "equal and opposite",
            "true two-connection races",
            "## 11. Owned-live acceptance corpus",
            "cleanup receipts",
        ):
            self.assertIn(accepted_evidence, reversal_addendum)
        self.assertIn(
            "[`reversal-addendum.md`](./reversal-addendum.md) v1.0 is independently reviewed",
            plan,
        )
        self.assertIn(
            "No reversal implementation or production activation is authorized", plan
        )

    def test_approved_period_policy_gate_is_reconciled(self) -> None:
        matrix = (
            ROOT / "specs/003-accounting-foundation/accounting-policy-matrix.md"
        ).read_text(encoding="utf-8")
        plan = (
            ROOT / "specs/003-accounting-foundation/plan.md"
        ).read_text(encoding="utf-8")

        self.assertIn("**Status:** APPROVED — v1.0", matrix)
        for approved_semantic in (
            "`Open`: authorized posting/reversal/correction is allowed",
            "`Soft Close`: routine posting is blocked",
            "`Finance Review`: only approved adjustment workflows using Maker–Checker may proceed",
            "`Hard Close`: posting, reversal and correction are blocked",
            "Reopening requires separate permission, a mandatory reason and append-only audit history",
            "Accounting-date period evaluation cannot be bypassed by changing system time",
        ):
            self.assertIn(approved_semantic, matrix)
            self.assertIn(approved_semantic, plan)

    def test_reviewed_periods_addendum_is_reconciled(self) -> None:
        periods_addendum = (
            ROOT / "specs/003-accounting-foundation/periods-addendum.md"
        ).read_text(encoding="utf-8")
        plan = (
            ROOT / "specs/003-accounting-foundation/plan.md"
        ).read_text(encoding="utf-8")
        tasks = (
            ROOT / "specs/003-accounting-foundation/tasks.md"
        ).read_text(encoding="utf-8")

        for accepted_evidence in (
            "**Addendum version:** 1.0",
            "**Status:** INDEPENDENTLY REVIEWED",
            "**Independent review:** Codex — ACCEPT",
            "company-effective instant",
            "exactly one approved applicable matrix version",
            "Append-only history",
            "True two-connection tests",
            "## 11. Owned-live acceptance corpus",
            "zero survivors",
        ):
            self.assertIn(accepted_evidence, periods_addendum)
        self.assertIn(
            "[`periods-addendum.md`](./periods-addendum.md) v1.0 is independently reviewed",
            plan,
        )
        self.assertIn(
            "No period-control implementation or production activation is authorized",
            plan,
        )
        self.assertIn(
            "Approved policy plus independently reviewed Stories 4–7 addenda satisfy "
            "T151–T158, but Stories 4–7 remain non-executable until a new reviewed "
            "tests-first task graph is commissioned",
            tasks,
        )
        self.assertNotIn(
            "remain non-executable gate/addendum records until their separately "
            "reviewed specifications exist",
            tasks,
        )

    def test_reviewed_opening_balances_addendum_is_reconciled(self) -> None:
        opening_addendum = (
            ROOT / "specs/003-accounting-foundation/opening-balances-addendum.md"
        ).read_text(encoding="utf-8")
        plan = (
            ROOT / "specs/003-accounting-foundation/plan.md"
        ).read_text(encoding="utf-8")

        for accepted_evidence in (
            "**Addendum version:** 1.0",
            "**Status:** INDEPENDENTLY REVIEWED",
            "**Independent review:** Codex — ACCEPT",
            "Prepare → Validate → Preview/control totals → Approve where configured → Post",
            "true two-connection races",
            "## 12. Owned-live acceptance corpus",
            "cleanup receipts",
        ):
            self.assertIn(accepted_evidence, opening_addendum)
        self.assertIn(
            "[`opening-balances-addendum.md`](./opening-balances-addendum.md) v1.0 is independently reviewed",
            plan,
        )
        self.assertIn(
            "No opening-balance implementation or production activation is authorized",
            plan,
        )

    def test_validator_rejects_stale_policy_claim_after_completed_gate(self) -> None:
        stale = self.mutate(
            "Approved matrix v1.0 records version, approver, timestamp, global scope with Country Pack applicability, effective date, and amendment/history requirements.",
            "The company/localization/effective/approved matrix is pending Finance Owner approval.",
        )
        self.assert_rejected(stale)

    def test_executable_blocked_story_or_posting_implementation_is_rejected(self) -> None:
        self.assert_rejected(
            self.mutate(
                "T151 [US4] **BLOCKED GATE** Verify Finance Owner approval",
                "T151 [US4] Implement posting route and verify Finance Owner approval",
            )
        )

    def test_malformed_or_absolute_path_is_rejected(self) -> None:
        self.assert_rejected(
            self.mutate(
                "T008 Implement the exact-owned resource registry and dynamic port reservation in `backend/api/test/support/accounting-foundation-live-fixture.ts`",
                "T008 Implement the exact-owned resource registry and dynamic port reservation in `/tmp/accounting-foundation-live-fixture.ts`",
            )
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
