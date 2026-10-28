#!/usr/bin/env python3
"""Static regression checks for T108's mandatory, blocking CI entry points."""

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
INTEGRATION_CONFIG = json.loads(
    (ROOT / "backend/api/test/jest-integration.json").read_text(encoding="utf-8")
)
API_PACKAGE = json.loads((ROOT / "backend/api/package.json").read_text(encoding="utf-8"))


def strip_javascript_comments(source: str) -> str:
    """Remove // and /* */ comments while preserving comment tokens inside strings."""
    output = []
    index = 0
    quote = None
    escaped = False
    block_comment = False
    while index < len(source):
        char = source[index]
        following = source[index + 1] if index + 1 < len(source) else ""
        if block_comment:
            if char == "*" and following == "/":
                block_comment = False
                index += 2
            else:
                if char == "\n":
                    output.append(char)
                index += 1
            continue
        if quote:
            output.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            index += 1
            continue
        if char in ("'", '"', "`"):
            quote = char
            output.append(char)
            index += 1
            continue
        if char == "/" and following == "*":
            block_comment = True
            index += 2
            continue
        if char == "/" and following == "/":
            while index < len(source) and source[index] != "\n":
                index += 1
            continue
        output.append(char)
        index += 1
    if block_comment:
        raise AssertionError("unterminated JavaScript block comment")
    return "".join(output)


def workflow_job(workflow: str, name: str) -> str:
    """Return one active top-level job block, excluding sibling jobs and comments."""
    lines = workflow.splitlines()
    marker = f"  {name}:"
    matches = [index for index, line in enumerate(lines) if line == marker]
    if len(matches) != 1:
        raise AssertionError(f"expected exactly one active workflow job {name!r}, got {len(matches)}")
    start = matches[0]
    end = len(lines)
    for index in range(start + 1, len(lines)):
        line = lines[index]
        if re.match(r"^  [A-Za-z0-9_-]+:$", line):
            end = index
            break
    return "\n".join(
        line for line in lines[start:end] if not line.lstrip().startswith("#")
    )


def workflow_named_step(workflow: str, name: str) -> str:
    """Return one active named step; YAML comments cannot satisfy semantic assertions."""
    lines = workflow.splitlines()
    marker = f"      - name: {name}"
    matches = [index for index, line in enumerate(lines) if line == marker]
    if len(matches) != 1:
        raise AssertionError(f"expected exactly one active workflow step {name!r}, got {len(matches)}")
    start = matches[0]
    end = len(lines)
    for index in range(start + 1, len(lines)):
        line = lines[index]
        if line.startswith("      - ") or (line and not line.startswith("      ")):
            end = index
            break
    return "\n".join(
        line for line in lines[start:end] if not line.lstrip().startswith("#")
    )


class TestT108CiWiring(unittest.TestCase):
    def test_pr_targets_and_all_four_commands_are_blocking(self) -> None:
        self.assertRegex(WORKFLOW, r"pull_request:\s*\n\s+branches: \[main, develop\]")
        for command in (
            "npm run test:contract -- --runInBand",
            "npm run test:integration -- --runInBand",
            "npx playwright test",
            "bash scripts/ci/test_odoo_addons.sh",
        ):
            self.assertEqual(1, WORKFLOW.count(command), command)
        self.assertNotIn("continue-on-error", WORKFLOW)
        self.assertNotIn("|| true", WORKFLOW)
        self.assertNotRegex(WORKFLOW, r"echo .*accounting")

    def test_github_owned_prerequisites_match_exact_runner_dependencies(self) -> None:
        governance_job = workflow_job(WORKFLOW, "governance-cleanup-regression")
        setup = workflow_named_step(governance_job, "Set up Node for governance")
        self.assertRegex(setup, r"(?m)^        uses: actions/setup-node@v4$")
        self.assertRegex(setup, r"(?m)^          node-version: \$\{\{ env\.NODE_VERSION \}\}$")
        self.assertRegex(setup, r"(?m)^          cache: npm$")
        self.assertRegex(
            setup, r"(?m)^          cache-dependency-path: backend/api/package-lock.json$"
        )
        install = workflow_named_step(
            governance_job, "Install backend dependencies for governance"
        )
        self.assertRegex(install, r"(?m)^        working-directory: backend/api$")
        self.assertRegex(install, r"(?m)^        run: npm ci --ignore-scripts$")
        governance = workflow_named_step(governance_job, "Run T108 governance regressions")
        self.assertRegex(governance, r"(?m)^        run: bash scripts/tests/run_all.sh$")
        self.assertLess(governance_job.index("Set up Node for governance"), governance_job.index("Install backend dependencies for governance"))
        self.assertLess(governance_job.index("Install backend dependencies for governance"), governance_job.index("Run T108 governance regressions"))

        frontend_job = workflow_job(WORKFLOW, "owned-frontend-live")
        images = workflow_named_step(frontend_job, "Pull T112 and US8 fixture images")
        pulls = set(re.findall(r"(?m)^          docker pull (\S+)$", images))
        self.assertEqual({"postgres:16", "postgres:16-alpine", "redis:7-alpine"}, pulls)
        us8 = workflow_named_step(frontend_job, "US8 support access owned live fixture")
        self.assertRegex(us8, r"(?m)^        if: always\(\)$")
        self.assertLess(frontend_job.index("Pull T112 and US8 fixture images"), frontend_job.index("T112 feature flag UI owned fixture"))
        self.assertLess(frontend_job.index("T112 feature flag UI owned fixture"), frontend_job.index("US8 support access owned live fixture"))

    def _assert_t093_owned_redis(self, suite: str, harness: str) -> None:
        active_suite = strip_javascript_comments(suite)
        active_harness = "\n".join(
            line for line in harness.splitlines() if not line.lstrip().startswith("#")
        )
        self.assertRegex(
            active_suite,
            r"(?m)^const HEALTHY_REDIS_URL = process\.env\.REDIS_URL \?\? 'redis://127\.0\.0\.1:6379/14';$",
        )
        self.assertRegex(
            active_suite,
            r"(?m)^    process\.env\.REDIS_URL = HEALTHY_REDIS_URL;$",
        )
        self.assertRegex(
            active_harness,
            r'(?m)^export REDIS_URL="redis://127\.0\.0\.1:\$redis_port/14"$',
        )
        self.assertRegex(
            active_harness,
            r'(?m)^    \.\/node_modules\/\.bin\/jest --config test/jest-t093\.json --runInBand \\',
        )

    def test_t093_selected_suite_consumes_exact_owned_redis_url(self) -> None:
        suite = (ROOT / "backend/api/test/integration/billing-decision-notification-delivery.integration-spec.ts").read_text()
        harness = (ROOT / "scripts/test_t093_owned_fixture.sh").read_text()
        self._assert_t093_owned_redis(suite, harness)

        hardcoded = suite.replace(
            "const HEALTHY_REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/14';",
            "const HEALTHY_REDIS_URL = 'redis://127.0.0.1:6379/14';\n// process.env.REDIS_URL ??",
            1,
        )
        with self.assertRaises(AssertionError):
            self._assert_t093_owned_redis(hardcoded, harness)

        block_hidden_declaration = suite.replace(
            "const HEALTHY_REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/14';",
            "const HEALTHY_REDIS_URL = 'redis://127.0.0.1:6379/14';\n/* const HEALTHY_REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/14'; */",
            1,
        )
        with self.assertRaises(AssertionError):
            self._assert_t093_owned_redis(block_hidden_declaration, harness)

        hardcoded_assignment = suite.replace(
            "    process.env.REDIS_URL = HEALTHY_REDIS_URL;",
            "    process.env.REDIS_URL = 'redis://127.0.0.1:6379/14';\n    // process.env.REDIS_URL = HEALTHY_REDIS_URL;",
            1,
        )
        with self.assertRaises(AssertionError):
            self._assert_t093_owned_redis(hardcoded_assignment, harness)

        block_hidden_assignment = suite.replace(
            "    process.env.REDIS_URL = HEALTHY_REDIS_URL;",
            "    process.env.REDIS_URL = 'redis://127.0.0.1:6379/14';\n    /* process.env.REDIS_URL = HEALTHY_REDIS_URL; */",
            1,
        )
        with self.assertRaises(AssertionError):
            self._assert_t093_owned_redis(block_hidden_assignment, harness)

        static_export = harness.replace(
            'export REDIS_URL="redis://127.0.0.1:$redis_port/14"',
            'export REDIS_URL="redis://127.0.0.1:6379/14"\n# export REDIS_URL="redis://127.0.0.1:$redis_port/14"',
            1,
        )
        with self.assertRaises(AssertionError):
            self._assert_t093_owned_redis(suite, static_export)

    def test_ci_has_safety_and_determinism_guards(self) -> None:
        for required in (
            "permissions:\n  contents: read",
            "timeout-minutes:",
            "cache-dependency-path:",
            "--health-cmd",
            "npx playwright install --with-deps chromium",
            "odoo:18.0",
        ):
            self.assertIn(required, WORKFLOW)
        self.assertNotIn("secrets.", WORKFLOW)

    def test_generic_integration_suite_has_no_silent_live_skips(self) -> None:
        self.assertEqual(
            "node test/run-integration-isolated.js",
            API_PACKAGE["scripts"]["test:integration"],
        )
        gated = set()
        for path in (ROOT / "backend/api/test/integration").glob("*.integration-spec.ts"):
            text = path.read_text(encoding="utf-8")
            if "describe.skip" in text:
                gated.add(f"/test/integration/{path.name}$")
        # T093's final verifier consumes T093_CAPTURE_JSONL and is intentionally owned by
        # scripts/test_t093_audit_source_linkage.sh. It must never run as an unobserved generic
        # suite; every other generic exclusion must still be justified by describe.skip.
        t093_verifier = "/test/integration/audit-source-linkage.integration-spec.ts$"
        ignored = set(INTEGRATION_CONFIG["testPathIgnorePatterns"])
        self.assertIn(t093_verifier, ignored)
        self.assertEqual(gated, ignored - {t093_verifier})
        dedicated = (ROOT / "scripts/test_t093_owned_fixture.sh").read_text(
            encoding="utf-8"
        )
        self.assertIn("T093_CAPTURE_JSONL", dedicated)
        self.assertIn("jest-t093.json", dedicated)

    def test_odoo_runner_invokes_and_proves_each_addon(self) -> None:
        runner = (ROOT / "scripts/ci/test_odoo_addons.sh").read_text(encoding="utf-8")
        for required in (
            "find \"$addons_dir\"",
            "odoo-bin()",
            "--test-enable",
            "--test-tags \"/$addon\"",
            "--http-port=0",
            "0 failed, 0 error\\(s\\)",
        ):
            self.assertIn(required, runner)
        self.assertNotIn("|| true", runner)

    def test_generic_playwright_excludes_only_the_owned_live_fixture(self) -> None:
        config = (ROOT / "frontend/playwright.config.ts").read_text(encoding="utf-8")
        for fixture in ("feature-flag-ui-gating.spec.ts", "us8-support-access.spec.ts"):
            self.assertIn(f"'**/{fixture}'", config)
        self.assertIn("workers: 1", config)
        self.assertIn("retries: 0", config)
        owned = (ROOT / "frontend/tests/e2e-live/playwright.t112-live.config.ts").read_text(
            encoding="utf-8"
        )
        self.assertIn("testMatch: /feature-flag-ui-gating\\.spec\\.ts/", owned)
        us8 = (ROOT / "frontend/tests/e2e-live/playwright.us8-live.config.ts").read_text(
            encoding="utf-8"
        )
        self.assertIn("testMatch: /us8-support-access\\.spec\\.ts/", us8)

    def test_every_generic_exclusion_has_a_blocking_owned_ci_gate(self) -> None:
        config = json.loads((ROOT / "backend/api/test/jest-integration.json").read_text())
        excluded = set(config["testPathIgnorePatterns"])
        expected_owned = {
            "/test/integration/checklist-liveness.integration-spec.ts$": "bash scripts/test_t074_live_browser.sh",
            "/test/integration/company-mutation-handoff.integration-spec.ts$": "bash scripts/test_t055_durable_handoff.sh",
            "/test/integration/company-setup-live.integration-spec.ts$": "bash scripts/test_t054_live.sh",
            "/test/integration/company-setup-validation.integration-spec.ts$": "bash scripts/test_t050_live.sh",
            "/test/integration/module-selection-live.integration-spec.ts$": "bash scripts/test_t072_live.sh",
            "/test/integration/tenant-isolation.integration-spec.ts$": "bash scripts/test_t041_t044_owned_live.sh",
            "/test/integration/tenant-provisioning-live.integration-spec.ts$": "bash scripts/test_t041_t044_owned_live.sh",
            "/test/integration/audit-source-linkage.integration-spec.ts$": "bash scripts/test_t093_owned_fixture.sh",
        }
        self.assertEqual(excluded, set(expected_owned))
        workflow = (ROOT / ".github/workflows/ci.yml").read_text()
        for pattern, command in expected_owned.items():
            self.assertIn(command, workflow, f"{pattern} lacks a blocking owned CI command")
        self.assertIn("KEMFAI_LIVE_MODE: t080", workflow)
        self.assertNotIn("continue-on-error", workflow)

    def _assert_owned_artifact_step(self, workflow: str, label: str, path: str) -> None:
        block = workflow_named_step(workflow, label)
        self.assertRegex(block, r"(?m)^        if: always\(\)$", label)
        self.assertRegex(
            block, r"(?m)^        uses: actions/upload-artifact@v4$", label
        )
        self.assertRegex(block, rf"(?m)^          path: {re.escape(path)}$", label)
        self.assertRegex(
            block, r"(?m)^          if-no-files-found: error$", label
        )
        self.assertEqual(1, block.count("${{ runner.temp }}/"), label)

    def test_owned_playwright_and_odoo_cleanup_are_blocking_ci_gates(self) -> None:
        workflow = (ROOT / ".github/workflows/ci.yml").read_text()
        self.assertIn("bash scripts/test_t112_owned_fixture.sh ui", workflow)
        self.assertIn("bash scripts/test-us8-owned-live.sh", workflow)
        self.assertEqual(workflow.count("uses: actions/upload-artifact@v4"), 3)
        artifacts = (
            ("Upload T112 evidence", "${{ runner.temp }}/t112-evidence"),
            ("Upload US8 evidence", "${{ runner.temp }}/us8-evidence"),
            ("Upload T093 evidence", "${{ runner.temp }}/t093-evidence"),
        )
        for label, path in artifacts:
            self._assert_owned_artifact_step(workflow, label, path)

        # Mutation proof: a commented key is not YAML semantics and must fail closed.
        mutated = workflow.replace(
            "      - name: Upload T112 evidence\n        if: always()",
            "      - name: Upload T112 evidence\n        # if: always()",
            1,
        )
        with self.assertRaises(AssertionError):
            self._assert_owned_artifact_step(
                mutated, "Upload T112 evidence", "${{ runner.temp }}/t112-evidence"
            )
        aggregate = (ROOT / "scripts/tests/run_all.sh").read_text()
        self.assertIn('bash "$HERE/test_t108_odoo_cleanup.sh"', aggregate)
        odoo = (ROOT / "scripts/ci/test_odoo_addons.sh").read_text()
        self.assertIn("drop_owned_database", odoo)
        self.assertIn("survived DROP", odoo)


if __name__ == "__main__":
    unittest.main()
