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
        self.assertEqual(step.get("env", {}).get("GITHUB_TOKEN"), "${{ github.token }}")
        self.assertTrue(
            BRANCH_PROTECTION_VALIDATOR.is_file(),
            f"missing intended T017 validator: {BRANCH_PROTECTION_VALIDATOR}",
        )
        source = BRANCH_PROTECTION_VALIDATOR.read_text(encoding="utf-8")
        self.assertIn("accounting-foundation-owned-live", source)
        self.assertRegex(source, r"\bcurl\b")
        self.assertIn("https://api.github.com/", source)
        self.assertIn("GITHUB_TOKEN", source)
        self.assertIn("Authorization: Bearer", source)
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
        self, payload: dict[str, Any], event: str = "pull_request", token: str = ""
    ) -> tuple[subprocess.CompletedProcess[str], str, str]:
        with tempfile.TemporaryDirectory(prefix="kemfai-af-gh-") as directory:
            fake_curl = Path(directory) / "curl"
            args_log = Path(directory) / "args.log"
            stdin_log = Path(directory) / "stdin.log"
            fake_curl.write_text(
                "#!/usr/bin/env bash\n"
                "printf '%s\\n' \"$GH_PAYLOAD\"\n"
                "printf '%s\\n' \"$*\" >\"$GH_ARGS_LOG\"\n"
                "cat >\"$GH_STDIN_LOG\"\n",
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
                "GH_STDIN_LOG": str(stdin_log),
                "GITHUB_TOKEN": token,
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
            stdin = stdin_log.read_text(encoding="utf-8") if stdin_log.exists() else ""
            return result, arguments, stdin

    def test_branch_protection_validator_accepts_only_the_exact_required_check(self) -> None:
        result, arguments, stdin = self._run_branch_protection_validator(
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
            "--disable --fail --silent --show-error --proto =https --tlsv1.2 -H Accept: application/vnd.github+json -H User-Agent: kemfai-branch-protection-verifier https://api.github.com/repos/owner/repository/branches/main",
        )
        self.assertNotRegex(arguments, r"(?i)(?:-X|--request|authorization|token|(?:^|\s)-L(?:\s|$)|--location)")
        self.assertEqual(stdin, "")

    def test_branch_protection_validator_authenticates_without_exposing_token_in_argv(self) -> None:
        result, arguments, stdin = self._run_branch_protection_validator(
            {
                "protected": True,
                "protection": {
                    "enabled": True,
                    "required_status_checks": {"contexts": [JOB_NAME]},
                },
            },
            token="github_pat-test.token",
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("--config -", arguments)
        self.assertNotIn("github_pat-test.token", arguments)
        self.assertNotRegex(arguments, r"(?i)authorization|bearer")
        self.assertEqual(stdin, 'header = "Authorization: Bearer github_pat-test.token"\n')

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

    def test_branch_protection_validator_skips_lookup_outside_merge_events(self) -> None:
        result, arguments, stdin = self._run_branch_protection_validator({}, event="push")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(arguments, "")
        self.assertEqual(stdin, "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
