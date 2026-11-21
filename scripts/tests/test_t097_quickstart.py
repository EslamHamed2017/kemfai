#!/usr/bin/env python3
"""Deterministic T097 regression checks for the reconciled as-built quickstart."""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

import yaml


REPO = Path(__file__).resolve().parents[2]
QUICKSTART = REPO / "specs/001-saas-onboarding-shell/quickstart.md"
OPENAPI = REPO / "specs/001-saas-onboarding-shell/contracts/openapi.yaml"
COMPOSE = REPO / "infra/docker/docker-compose.yml"


class T097QuickstartTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.text = QUICKSTART.read_text()
        cls.openapi = yaml.safe_load(OPENAPI.read_text())
        cls.compose = yaml.safe_load(COMPOSE.read_text())

    def test_all_eight_walkthroughs_are_present_once(self) -> None:
        headings = re.findall(r"^### Walkthrough ([1-8]) —", self.text, re.MULTILINE)
        self.assertEqual(headings, list("12345678"))

    def test_compose_topology_is_current_and_not_an_extension_todo(self) -> None:
        expected = {"kemfai-db", "kemfai-odoo", "redis", "minio", "keycloak", "api", "frontend"}
        self.assertEqual(set(self.compose["services"]), expected)
        for service in expected:
            self.assertIn(f"`{service}`", self.text)
        self.assertNotRegex(self.text, r"(?i)extend .*docker-compose")
        self.assertIn("Compose does **not** run TypeORM migrations or `seed:dev`", self.text)
        for name in (
            "KEYCLOAK_USERS_CLIENT_SECRET",
            "KEMFAI_ODOO_MASTER_PASSWORD",
            "KEMFAI_TENANT_ADMIN_LOGIN",
            "KEMFAI_TENANT_ADMIN_PASSWORD",
            "KEMFAI_BANK_TRANSFER_INSTRUCTIONS_EN",
            "KEMFAI_BANK_TRANSFER_INSTRUCTIONS_AR",
        ):
            self.assertIn(f"`{name}`", self.text)

    def test_feature_flag_mechanics_and_surfaces_are_explicit(self) -> None:
        expected = {
            "module.accounts",
            "module.company_setup",
            "module.module_selection",
            "module.onboarding_checklist",
            "module.support_access",
        }
        documented = set(re.findall(r"^- `(module\.[a-z_]+)`$", self.text, re.MULTILINE))
        self.assertEqual(documented, expected)
        for path in ("/modules", "/checklist", "/support-access"):
            self.assertIn(path, self.text)
        self.assertIn("missing or disabled flag is fail-closed", self.text)
        self.assertIn("module-selection, checklist, and support-access surfaces", self.text)
        self.assertIn("guarded API calls return **404**", self.text)
        self.assertIn("test_t112_owned_fixture.sh backend", self.text)
        self.assertIn("test_t112_owned_fixture.sh ui", self.text)

    def test_trial_window_all_three_paths_and_bypasses_are_documented(self) -> None:
        for path in (
            "/companies/current/setup",
            "/modules/selection",
            "/onboarding/checklist",
        ):
            self.assertIn(path, self.text)
            self.assertIn(path, self.openapi["paths"])
        self.assertIn("An `Active` subscription", self.text)
        self.assertIn("resolved false value bypasses", self.text)
        self.assertIn("three FR-030a paths × two call shapes", self.text)
        self.assertIn("trial.expiry_sweep", self.text)
        self.assertIn("at most once per tenant", self.text)

    def test_locale_and_company_settings_remediation_are_documented(self) -> None:
        self.assertIn("PATCH /accounts/me/locale", self.text)
        self.assertIn("logging out, clearing client-only state, logging back in", self.text)
        self.assertIn("/company-settings", self.text)
        self.assertIn("GET`/`PUT /companies/current/settings", self.text)
        self.assertIn("returns **409**", self.text)
        for path in ("/accounts/me/locale", "/companies/current/settings"):
            self.assertIn(path, self.openapi["paths"])

    def test_security_and_cross_cutting_validation_entry_points_exist(self) -> None:
        required_paths = (
            "scripts/test_t096_security_hardening.sh",
            "scripts/test_t109_odoo_exposure.sh",
            "scripts/test_t112_owned_fixture.sh",
            "frontend/tests/e2e/status-text-label-not-colour-only.spec.ts",
            "backend/api/test/integration/trial-window-enforcement.integration-spec.ts",
            "frontend/tests/e2e/locale-persistence.spec.ts",
        )
        for relative in required_paths:
            self.assertTrue((REPO / relative).is_file(), relative)
            self.assertIn(Path(relative).name, self.text)
        self.assertIn("(cd frontend && npx playwright test)", self.text)
        self.assertIn("bash scripts/ci/test_odoo_addons.sh", self.text)
        addons = {path.name for path in (REPO / "backend/addons").iterdir() if path.is_dir() and path.name.startswith("kemfai_")}
        onboarding_addons = {
            "kemfai_tenant_core",
            "kemfai_company_setup",
            "kemfai_module_selection",
            "kemfai_onboarding_checklist",
        }
        self.assertTrue(onboarding_addons.issubset(addons))
        for phrase in (
            "300 seconds",
            "5 requests per minute",
            "10 requests per minute",
            "`Retry-After`",
            "scoped service account",
            "colour only",
        ):
            self.assertIn(phrase, self.text)

    def test_mfa_hosted_optional_flow_and_owned_walkthroughs_are_documented(self) -> None:
        for phrase in (
            "MFA is optional/non-blocking",
            "Keycloak's `CONFIGURE_TOTP` required action",
            "accepts no TOTP code from KEMFAI",
            "current Ready-state CTA links to `/mfa`",
        ):
            self.assertIn(phrase, self.text)
        for script in (
            "test_t039_live_auth.sh",
            "test_t103_live_locale.sh",
            "test_t041_t044_owned_live.sh",
            "test_t050_live.sh",
            "test_t054_live.sh",
            "test_t056_live_browser.sh",
            "test_t072_live.sh",
            "test_t071_live.sh",
            "test_t080_live_browser.sh",
            "test-us8-owned-live.sh",
            "test_t111_integration.sh",
        ):
            self.assertTrue((REPO / "scripts" / script).is_file(), script)
            self.assertIn(script, self.text)

    def test_billing_more_info_cycle_requires_customer_resubmission(self) -> None:
        self.assertIn("only `BillingAdmin` can read this review queue or perform decisions", self.text)
        self.assertIn("request-more-info → customer-resubmission cycle", self.text)
        self.assertIn("two consecutive internal decisions without resubmission", self.text)

    def test_locked_baseline_is_reconciled_without_silent_redecision(self) -> None:
        for phrase in (
            "Tenant DB — separate DB per customer from launch",
            "Billing V1 — manual bank transfer + Billing Admin activation",
            "Billing Phase 2 — Stripe behind KEMFAI Billing Service",
            "Languages — English + Arabic Day 1, full LTR/RTL",
            "Country Compliance — versioned country packs following applicable official regulations",
            "Accounting Policies — explicit Accounting Policy Matrix",
            "does not silently promote that dev choice into a new owner lock",
        ):
            self.assertIn(phrase, self.text)

    def test_documented_contract_paths_exist(self) -> None:
        contract_paths = set(self.openapi["paths"])
        documented = set(
            re.findall(
                r"(?<![\w.-])(/(?:public|accounts|tenants|companies|entitlements|modules|billing|internal|onboarding|support-access)/[A-Za-z0-9_{}./-]+)",
                self.text,
            )
        )
        missing = {path.rstrip(".,;)") for path in documented} - contract_paths
        self.assertEqual(missing, set())

    def test_documented_frontend_routes_exist_in_next_app(self) -> None:
        app = REPO / "frontend/src/app"
        implemented: set[str] = set()
        for source in app.rglob("*"):
            if source.name not in {"page.tsx", "route.ts"}:
                continue
            parts = [part for part in source.parent.relative_to(app).parts if not part.startswith("(")]
            implemented.add("/" + "/".join(parts) if parts else "/")

        contract_paths = set(self.openapi["paths"])
        documented = {
            token.split("?", 1)[0].split("#", 1)[0].rstrip(".,;)")
            for token in re.findall(r"`(/[^`\s]+)`", self.text)
        }
        ui_candidates = {
            route
            for route in documented
            if not route.startswith("/api/") and route not in contract_paths
        }
        missing = ui_candidates - implemented
        self.assertEqual(missing, set())
        self.assertNotIn("/tenant-status", self.text)
        self.assertNotIn("/internal/billing", self.text)
        for route in (
            "/plans",
            "/signup",
            "/verify",
            "/mfa",
            "/provisioning",
            "/setup-wizard",
            "/company-settings",
            "/modules",
            "/billing",
            "/billing-review",
            "/checklist",
            "/support-access",
            "/internal-auth/login",
        ):
            self.assertIn(route, implemented)
            if route == "/plans":
                self.assertIn("`http://localhost:3010/plans`", self.text)
            else:
                self.assertIn(f"`{route}", self.text)

    def test_compose_commands_match_published_ports_health_and_seed(self) -> None:
        self.assertIn("http://localhost:8090", self.text)
        self.assertNotIn("http://localhost:8069", self.text)
        self.assertIn("curl -fsS http://localhost:4000/", self.text)
        self.assertNotIn("localhost:4000/health", self.text)
        self.assertIn("`Growth (dev seed)`", self.text)
        self.assertIn("api npm run migration:run", self.text)
        self.assertIn("api npm run seed:dev", self.text)
        self.assertIn("REVOKE UPDATE, DELETE ON TABLE audit_event FROM kemfai_api", self.text)

    def test_company_settings_trial_scope_deviation_is_explicit(self) -> None:
        self.assertIn("Known non-Gate as-built deviation", self.text)
        self.assertIn("`GET` and `PUT /companies/current/settings` also carry", self.text)
        self.assertIn("they do not prove the additional company-settings deviation", self.text)

    def test_t096_and_t109_ownership_claims_match_their_runners(self) -> None:
        def active_shell(source: str) -> str:
            return "\n".join(
                line for line in source.splitlines() if line.strip() and not line.lstrip().startswith("#")
            )

        t096 = active_shell((REPO / "scripts/test_t096_security_hardening.sh").read_text())
        self.assertIn('--label "kemfai.fixture.owner=$OWNER"', t096)
        self.assertIn('-p 127.0.0.1::8080', t096)
        self.assertIn('REFUSING CLEANUP: owner mismatch', t096)
        self.assertIn('docker rm -fv -- "$NAME"', t096)
        self.assertIn('owned fixture cleanup verified', t096)
        self.assertNotRegex(t096, r"docker\s+compose(?:\s|$)")

        t109 = active_shell((REPO / "scripts/test_t109_odoo_exposure.sh").read_text())
        self.assertIn('RESOURCE_LABEL="kemfai.phase12.operation=$OPERATION_ID"', t109)
        self.assertEqual(t109.count('--label "$RESOURCE_LABEL"'), 2)
        self.assertIn('allocate_ports() {', t109)
        self.assertRegex(t109, r'(?m)^  allocate_ports$')
        self.assertIn('-p "127.0.0.1:$PG_PORT:5432"', t109)
        self.assertIn('-p "127.0.0.1:$REDIS_PORT:6379"', t109)
        self.assertEqual(t109.count('t071_owned_session_exec.py'), 2)
        self.assertEqual(t109.count('--hold-for-cleanup'), 2)
        self.assertEqual(t109.count('exec python3 -I "$SCRIPT_DIR/fixtures/t071_owned_session_exec.py"'), 2)
        self.assertEqual(
            t109.count(
                '--keep-env CONTROL_DB_HOST,CONTROL_DB_PORT,CONTROL_DB_USER,'
                'CONTROL_DB_PASSWORD,CONTROL_DB_NAME,REDIS_URL'
            ),
            1,
        )
        self.assertIn('terminate_owned_process_group "$NEXT_PID"', t109)
        self.assertIn('terminate_owned_process_group "$API_PID"', t109)
        self.assertIn('container_survivors=%s', t109)
        self.assertIn('process_or_resource_cleanup=%s', t109)
        self.assertNotRegex(t109, r"docker\s+compose(?:\s|$)")
        self.assertIn('T096 creates one uniquely named, owner-labelled Keycloak container', self.text)
        self.assertIn('T109 creates exact-labelled PostgreSQL/Redis containers', self.text)
        self.assertIn('None of these fixture commands uses or requires stopping the fixed development Compose project', self.text)

    def test_t039_t103_fixed_compose_flag_is_temporary_and_documented(self) -> None:
        for name in ("test_t039_live_auth.sh", "test_t103_live_locale.sh"):
            source = (REPO / "scripts" / name).read_text()
            self.assertIn('prior_accounts_flag="$(docker exec kemfai-db', source, name)
            self.assertIn("trap restore_accounts_flag EXIT", source, name)
            self.assertIn("INSERT INTO feature_flag(feature_key, enabled, notes)", source, name)
            self.assertIn("UPDATE feature_flag SET enabled=$prior_accounts_flag", source, name)
            self.assertIn("DELETE FROM feature_flag WHERE feature_key='module.accounts'", source, name)
        self.assertIn("T039 and T103 are the exceptions", self.text)
        self.assertIn("restore its exact prior state on exit", self.text)
        self.assertIn("they do not own or stop that Compose stack", self.text)
        provisioning = (REPO / "scripts/test_t041_t044_owned_live.sh").read_text()
        self.assertEqual(provisioning.count("psql -U odoo -d \"$control_db\" -Atqc 'SELECT 1'"), 2)
        self.assertNotIn('pg_isready -U odoo -d "$control_db"', provisioning)
        self.assertIn('"clientId":"kemfai-users"', provisioning)
        self.assertIn('"serviceAccountsEnabled":true', provisioning)
        self.assertIn('"realm-management":["manage-users","view-realm"]', provisioning)
        self.assertIn('KEYCLOAK_USERS_CLIENT_ID=kemfai-users', provisioning)
        self.assertIn('KEYCLOAK_USERS_CLIENT_SECRET="$kc_users_secret"', provisioning)
        browser_fixture = (REPO / "scripts/test_t056_live_browser.sh").read_text()
        self.assertEqual(browser_fixture.count('TOKEN="$(admin_token)"'), 2)
        self.assertIn('could not refresh scratch Keycloak admin token', browser_fixture)
        self.assertIn(
            "npx playwright test --config tests/e2e-live/playwright.live.config.ts tests/e2e-live/t056-real-browser.live.spec.ts",
            browser_fixture,
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
