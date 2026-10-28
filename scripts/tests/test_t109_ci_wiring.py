import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE_DIR = "${{ runner.temp }}/t109-evidence"


class T109CiWiringTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())
        cls.steps = cls.workflow["jobs"]["owned-frontend-live"]["steps"]
        cls.names = [step.get("name", "") for step in cls.steps]

    def test_generic_playwright_excludes_owned_t109_suite(self):
        config = (ROOT / "frontend/playwright.config.ts").read_text()
        self.assertIn("'**/full-surface-odoo-exposure-sweep.spec.ts'", config)
        self.assertIn("retries: 0", config)

    def test_owned_runner_and_independent_validators_are_ordered(self):
        pull = self.names.index("Pull T112 and US8 fixture images")
        run = self.names.index("T109 full-surface Odoo exposure owned fixture")
        backend = self.names.index("Validate T109 backend evidence independently")
        browser = self.names.index("Validate T109 browser evidence independently")
        upload = self.names.index("Upload T109 evidence")
        self.assertLess(pull, run)
        self.assertLess(run, backend)
        self.assertLess(backend, browser)
        self.assertLess(browser, upload)

        runner = self.steps[run]
        self.assertEqual(runner.get("if"), "always()")
        self.assertEqual(runner.get("run"), "bash scripts/test_t109_odoo_exposure.sh all")
        self.assertEqual(runner.get("env", {}).get("T109_EVIDENCE_DIR"), EVIDENCE_DIR)

    def test_backend_evidence_is_validated_by_an_independent_exact_step(self):
        step = self.steps[
            self.names.index("Validate T109 backend evidence independently")
        ]
        self.assertEqual(step.get("if"), "always()")
        self.assertEqual(step.get("shell"), "bash")
        self.assertEqual(step.get("env", {}).get("T109_EVIDENCE_DIR"), EVIDENCE_DIR)
        self.assertEqual(
            step.get("run"),
            'python3 scripts/fixtures/t109_validate_evidence.py backend '
            '"$T109_EVIDENCE_DIR/backend-jest.json"',
        )
        self.assertNotIn("continue-on-error", step)

    def test_browser_evidence_is_validated_by_an_independent_exact_step(self):
        step = self.steps[
            self.names.index("Validate T109 browser evidence independently")
        ]
        self.assertEqual(step.get("if"), "always()")
        self.assertEqual(step.get("shell"), "bash")
        self.assertEqual(step.get("env", {}).get("T109_EVIDENCE_DIR"), EVIDENCE_DIR)
        self.assertEqual(
            step.get("run"),
            'python3 scripts/fixtures/t109_validate_evidence.py browser '
            '"$T109_EVIDENCE_DIR/browser-summary.json"',
        )
        self.assertNotIn("continue-on-error", step)

    def test_t109_evidence_upload_is_fail_closed(self):
        upload = self.steps[self.names.index("Upload T109 evidence")]
        self.assertEqual(upload.get("if"), "always()")
        self.assertEqual(upload.get("uses"), "actions/upload-artifact@v4")
        self.assertEqual(upload["with"]["path"], EVIDENCE_DIR)
        self.assertEqual(upload["with"]["if-no-files-found"], "error")
        self.assertNotIn("continue-on-error", upload)


if __name__ == "__main__":
    unittest.main()
