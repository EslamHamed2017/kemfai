#!/usr/bin/env python3
"""Fail-closed CI structure contract for the accounting-foundation live gate.

T006 intentionally lands before the T015--T017 workflow and validator wiring.  The
focused suite must therefore be red until that required job exists, but it must
remain importable and syntactically valid in the meantime.
"""

from __future__ import annotations

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
        176: "[P: GPT-5.6 Sol | B: Claude | R: Codex]",
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
        self, payload: dict[str, Any], event: str = "pull_request"
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
                "GITHUB_BASE_REF": "main",
                "GH_PAYLOAD": json.dumps(payload),
                "GH_ARGS_LOG": str(args_log),
                "GH_CONFIG_LOG": str(config_log),
                "GITHUB_TOKEN": "test-token-123",
            }
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

    def test_story_four_runtime_tasks_are_vertical_slices(self) -> None:
        posting_tasks = (
            ROOT / "specs/003-accounting-foundation/posting-tasks.md"
        ).read_text(encoding="utf-8")
        for number in range(177, 199):
            match = re.search(
                rf"^- \[ \] T{number:03d} .*?$",
                posting_tasks,
                flags=re.MULTILINE,
            )
            self.assertIsNotNone(match, f"missing Story 4 runtime task T{number:03d}")
            task = match.group(0).lower()
            self.assertIn("vertical slice", task, f"T{number:03d} is horizontally layered")
            self.assertIn(
                "next bff→nest→odoo→tenant audit",
                task,
                f"T{number:03d} does not cross the required runtime boundaries",
            )


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
        role_mutations = {
            "[P: Claude | B: GLM-5.2 | R: Gemini + Codex]":
                "[P: Gemini | B: GLM-5.2 | R: Gemini + Codex]",
            "[P: GPT-5.6 Sol | B: Claude | R: Codex]":
                "[P: Gemini | B: Claude | R: Gemini + Codex]",
        }
        for original, self_reviewed in role_mutations.items():
            matching_tasks = (174,) if original.startswith("[P: Claude") else (176, 209)
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
