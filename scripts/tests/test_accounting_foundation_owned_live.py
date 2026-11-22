#!/usr/bin/env python3
"""Guardrail contract for the accounting-foundation exact-owned live runner.

These tests intentionally precede ``scripts/test_accounting_foundation_owned_live.sh``.
They are source-contract tests because starting Docker or mutating a shared host is not
safe in this unit-test layer.  T010 must make them green without weakening the checks.
"""

from __future__ import annotations

import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / "scripts/test_accounting_foundation_owned_live.sh"


class AccountingFoundationOwnedLiveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = RUNNER.read_text() if RUNNER.is_file() else ""

    def require_runner(self) -> str:
        self.assertTrue(
            RUNNER.is_file(),
            "missing intended T010 runner: scripts/test_accounting_foundation_owned_live.sh",
        )
        return self.source

    def test_reserves_distinct_dynamic_loopback_ports_for_every_listener(self) -> None:
        source = self.require_runner()
        self.assertIn("reserve_loopback_ports.py", source)
        self.assertRegex(source, r"(?m)^\s*(?:coproc\s+)?[A-Za-z0-9_]*PORT")
        for service in ("pg", "redis", "keycloak", "odoo", "api", "frontend"):
            self.assertRegex(source.lower(), rf"\b{service}(?:_port| port|\")")
        self.assertRegex(source, r"127\.0\.0\.1:\$\{?[A-Za-z_][A-Za-z0-9_]*_PORT")
        self.assertRegex(source, r"(?:sort\s+-u|len\s*\(\s*set\s*\(|duplicate port)")
        self.assertNotRegex(
            source,
            r"(?:-p|--publish)(?:=|\s+)[\"']?(?:(?:127\.0\.0\.1|0\.0\.0\.0):)?[0-9]{2,5}:",
            "fixed published ports are forbidden",
        )
        self.assertNotRegex(
            source,
            r"(?:-p|--publish)(?:=|\s+)[\"']?0\.0\.0\.0:",
            "listeners must bind only to loopback",
        )

    def test_refuses_shared_or_reused_resources(self) -> None:
        source = self.require_runner()
        self.assertIn("KEMFAI_AF_RUN_ID", source)
        self.assertIn("KEMFAI_AF_OWNERSHIP_LABEL", source)
        self.assertRegex(source, r"label=.*KEMFAI_AF_OWNERSHIP_LABEL")
        self.assertRegex(
            source,
            re.compile(r"label(?:led)? .*already exists|reused ownership label|pre-existing labelled", re.I),
        )
        self.assertNotRegex(source, r"docker\s+compose(?:\s|$)")
        self.assertNotIn("infra/.env", source)
        self.assertNotRegex(source, r"(?m)^\s*(?:PG|REDIS|KEYCLOAK|ODOO|API|FRONTEND)_PORT=[0-9]+\s*$")

    def test_all_readiness_waits_are_bounded_and_resource_specific(self) -> None:
        source = self.require_runner()
        self.assertNotRegex(source, r"(?m)^\s*(?:while\s+(?:true|:)|until\s+[^;]+;?\s*do)")
        self.assertRegex(source, r"(?:timeout|deadline|max_attempts|seq\s+1\s+[0-9]+)", re.I)
        probes = {
            "stable SQL": r"SELECT\s+1",
            "Redis": r"PONG",
            "Keycloak": r"keycloak",
            "Tenant A database": r"tenant[_ -]?a[_ -]?db",
            "Tenant B database": r"tenant[_ -]?b[_ -]?db",
            "Odoo": r"odoo",
            "Nest": r"nest|api[_ -]?(?:health|ready)",
            "Next": r"next|frontend[_ -]?(?:health|ready)",
            "User A session": r"user[_ -]?a",
            "User B session": r"user[_ -]?b",
        }
        for description, pattern in probes.items():
            self.assertRegex(
                source,
                re.compile(pattern, re.I),
                f"missing bounded readiness proof for {description}",
            )
        self.assertNotRegex(source, r"docker\s+inspect[^\n]*(?:Running|running).*(?:ready|readiness)")

    def test_installs_exit_and_signal_traps_before_first_mutation(self) -> None:
        source = self.require_runner()
        trap = re.search(r"(?m)^\s*trap\s+[^\n]+\bEXIT\b", source)
        self.assertIsNotNone(trap, "cleanup EXIT trap is required")
        for signal in ("INT", "TERM"):
            self.assertRegex(source, rf"(?m)^\s*trap\s+[^\n]+\b{signal}\b")
        mutation = re.search(
            r"(?m)^\s*(?:docker\s+(?:run|create|network\s+create|volume\s+create)|"
            r"createdb\b|dropdb\b|mkdir\b|mktemp\b|"
            r"curl\s+.*(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE))",
            source,
        )
        self.assertIsNotNone(mutation, "runner has no identifiable owned-resource mutation")
        assert trap is not None and mutation is not None
        self.assertLess(trap.start(), mutation.start(), "trap must be installed before the first mutation")

    def test_publishable_logs_are_redacted_and_secrets_stay_private(self) -> None:
        source = self.require_runner()
        self.assertRegex(source, r"umask\s+0?77")
        self.assertRegex(source, r"(?:mktemp -d|mkdir[^\n]*(?:-m|--mode)[= ]700)")
        self.assertRegex(source, r"(?m)^\s*(?:redact|redact_stream|sanitize)\s*\(\)")
        self.assertRegex(source, r"(?:record_secret|register_secret|secrets_file)")
        self.assertIn("secret-scan.json", source)
        self.assertNotRegex(source, r"(?m)^\s*set\s+-[^\n]*x")
        self.assertNotRegex(source, r"(?m)^\s*(?:echo|printf)[^\n]*\$(?:PASSWORD|TOKEN|SECRET|CLIENT_SECRET)\b")
        self.assertNotRegex(
            source,
            r"(?mi)^\s*[A-Z0-9_]*(?:PASSWORD|TOKEN|SECRET)[A-Z0-9_]*="
            r"[\"']?(?!\$|\$\(|\$\{|<|`)[^\s\"']{8,}",
            "credentials must be generated or read from the private secret store",
        )

    def test_cleanup_is_registry_scoped_and_exact_label_only(self) -> None:
        source = self.require_runner()
        self.assertRegex(source, r"(?:resource_registry|fixture-registry\.json|registered_resources)")
        for command in ("docker ps -aq", "docker network ls -q", "docker volume ls -q"):
            self.assertRegex(
                source,
                re.escape(command) + r'[^\n]*--filter\s+[\"]label=\$\{?KEMFAI_AF_OWNERSHIP_LABEL',
            )
        for forbidden in (
            r"docker\s+system\s+prune",
            r"docker\s+(?:container|network|volume)?\s*prune",
            r"docker\s+rm[^\n]*\$\(docker\s+ps",
            r"docker\s+kill[^\n]*\$\(docker\s+ps",
            r"pkill\b",
            r"killall\b",
            r"dropdb\s+--all",
            r"DROP\s+DATABASE\s+(?:IF\s+EXISTS\s+)?(?:postgres|template0|template1|\$\([^)]*SELECT)",
        ):
            self.assertNotRegex(source, forbidden, f"broad cleanup is forbidden: {forbidden}")

    def _story_one_capture(self) -> dict[str, dict]:
        operation_ids = ["op-create", "op-draft", "op-validate"]
        return {
            "story-1-state.json": {
                "status": "passed",
                "productionPath": True,
                "persistedStateVerified": True,
                "captureSource": "persisted-queries",
                "databases": [
                    {"name": "tenant_a_db", "tenantId": "tenant-a", "companyIds": ["company-a1", "company-a2"], "persistedQueryId": "query-db-a"},
                    {"name": "tenant_b_db", "tenantId": "tenant-b", "companyIds": ["company-b1"], "persistedQueryId": "query-db-b"},
                ],
                "account": {"id": "11111111-1111-4111-8111-111111111111", "database": "tenant_a_db", "companyId": "company-a1", "persistedQueryId": "query-account"},
                "draft": {"id": "22222222-2222-4222-8222-222222222222", "state": "draft", "database": "tenant_a_db", "companyId": "company-a1", "persistedQueryId": "query-draft"},
                "parentRejection": {"code": "ACCOUNT_NOT_POSTING", "lineIndex": 0, "persistedDraftUnchanged": True, "ledgerEffect": "none", "receiptId": "receipt-parent", "auditEventId": "audit-parent"},
                "race": {"kind": "simultaneous", "barrierId": "barrier-1", "participants": 2, "maxStartSkewMs": 4, "transactionIds": ["tx-left", "tx-right"], "winnerCount": 1, "staleCount": 1, "versionDelta": 1, "persistedWinnerQueryId": "query-race-winner"},
            },
            "scope-and-authorization.json": {
                "status": "passed",
                "tenantBResourceId": "33333333-3333-4333-8333-333333333333",
                "tenantBResourceFetchedByUserB": True,
                "userBFetchPersistedQueryId": "query-user-b",
                "sameResourceAttemptedByUserA": True,
                "sameResourceOpaquelyDeniedToUserA": True,
                "ordinaryAuthenticatedPath": True,
                "foreignFieldsDisclosed": False,
                "denialAuditQueryId": "query-denial-audit",
            },
            "no-ledger-effect.json": {
                "status": "passed",
                "postingProbe": {"capabilityStatus": 200, "postingFeatureEnabled": False, "forbiddenRouteStatus": 404},
                "databases": [
                    {"name": "tenant_a_db", "beforeHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "afterHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "beforeMoveCount": 0, "afterMoveCount": 0, "beforeLineCount": 0, "afterLineCount": 0, "beforeBalanceHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "afterBalanceHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "persistedQueryId": "query-ledger-a"},
                    {"name": "tenant_b_db", "beforeHash": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", "afterHash": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", "beforeMoveCount": 0, "afterMoveCount": 0, "beforeLineCount": 0, "afterLineCount": 0, "beforeBalanceHash": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", "afterBalanceHash": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", "persistedQueryId": "query-ledger-b"},
                ],
            },
            "audit-and-receipts.json": {
                "status": "passed",
                "acceptedMutations": len(operation_ids),
                "tenantAuditEvents": len(operation_ids),
                "operationReceipts": len(operation_ids),
                "platformMirrorsComplete": True,
                "dedupeStateComplete": True,
                "acceptedMutationIds": operation_ids,
                "tenantAuditOperationIds": operation_ids,
                "operationReceiptOperationIds": operation_ids,
                "platformMirrorOperationIds": operation_ids,
                "auditReceiptLinks": [{"operationId": operation_id, "auditEventId": f"audit-{operation_id}", "receiptAuditEventId": f"audit-{operation_id}"} for operation_id in operation_ids],
                "persistedQueryIds": ["query-audit", "query-receipt", "query-mirror"],
            },
        }

    def _validate_story_one_capture(self, artifacts: dict[str, dict]) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory(prefix="af-story-one-capture-") as directory:
            root = Path(directory)
            for name, payload in artifacts.items():
                (root / name).write_text(json.dumps(payload) + "\n", encoding="utf-8")
            return subprocess.run(
                ["bash", str(RUNNER), "validate-story-1-capture", str(root)],
                cwd=ROOT,
                text=True,
                capture_output=True,
            )

    def test_story_one_journey_captures_final_ledgers_after_all_mutations(self) -> None:
        journey = (ROOT / "frontend/tests/e2e-live/accounting-foundation.live.spec.ts").read_text()
        story_one = journey[journey.index("test.describe.serial('Accounting Foundation Story 1"):journey.index("type JourneyResource")]
        final_snapshot = "journey.ledgerAfter = { tenantA: await ledgerSnapshot(tenantADb), tenantB: await ledgerSnapshot(tenantBDb) };"
        self.assertEqual(story_one.count(final_snapshot), 1)
        self.assertGreater(story_one.index(final_snapshot), story_one.index("validationResult.errors"))
        helper = (ROOT / "scripts/fixtures/accounting_foundation_capture_story_one.py").read_text()
        self.assertIn("'afterHash':x_after['hash']", helper)
        self.assertIn("'afterMoveCount':x_after['moves']", helper)
        self.assertIn("'afterLineCount':x_after['lines']", helper)
        self.assertIn("'afterBalanceHash':x_after['balanceHash']", helper)

    def test_story_one_capture_emits_validator_complete_ledger_proof(self) -> None:
        helper = (ROOT / "scripts/fixtures/accounting_foundation_capture_story_one.py").read_text()
        for field in (
            "beforeMoveCount",
            "afterMoveCount",
            "beforeLineCount",
            "afterLineCount",
            "beforeBalanceHash",
            "afterBalanceHash",
        ):
            self.assertIn(field, helper)

    def test_story_one_capture_uses_observed_posting_probe(self) -> None:
        helper = (ROOT / "scripts/fixtures/accounting_foundation_capture_story_one.py").read_text()
        journey = (ROOT / "frontend/tests/e2e-live/accounting-foundation.live.spec.ts").read_text()
        self.assertIn("journey.postingProbe", journey)
        self.assertIn("journey.get('postingProbe')", helper)
        self.assertNotIn("'actionPostInvocations':0", helper)
        self.assertNotIn("'postingFeatureEnabled':False", helper)

    def test_story_one_capture_preserves_audit_receipt_cardinality_and_linkage(self) -> None:
        helper = (ROOT / "scripts/fixtures/accounting_foundation_capture_story_one.py").read_text()
        self.assertIn("auditReceiptLinks", helper)
        self.assertIn("len(audit_rows)==len(accepted)", helper)
        self.assertIn("len(receipt_rows)==len(accepted)", helper)
        self.assertIn("receipt['audit_event_uuid']==audit['public_id']", helper)

    def test_story_one_capture_rejects_reused_audit_event_identity(self) -> None:
        artifacts = self._story_one_capture()
        links = artifacts["audit-and-receipts.json"]["auditReceiptLinks"]
        links[1]["auditEventId"] = links[0]["auditEventId"]
        links[1]["receiptAuditEventId"] = links[0]["auditEventId"]
        result = self._validate_story_one_capture(artifacts)
        self.assertNotEqual(result.returncode, 0, msg=result.stdout + result.stderr)
        self.assertIn("FAIL", (result.stdout + result.stderr).upper())

    def test_story_one_capture_accepts_persisted_simultaneous_evidence(self) -> None:
        result = self._validate_story_one_capture(self._story_one_capture())
        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)

    def test_story_one_capture_rejects_malformed_ledger_proof(self) -> None:
        mutations = (
            ("missing hashes", lambda item: (item.pop("beforeHash"), item.pop("afterHash"))),
            ("null move counts", lambda item: (item.__setitem__("beforeMoveCount", None), item.__setitem__("afterMoveCount", None))),
            ("string line counts", lambda item: (item.__setitem__("beforeLineCount", "0"), item.__setitem__("afterLineCount", "0"))),
            ("negative move counts", lambda item: (item.__setitem__("beforeMoveCount", -1), item.__setitem__("afterMoveCount", -1))),
            ("invalid balance hashes", lambda item: (item.__setitem__("beforeBalanceHash", "not-a-sha256"), item.__setitem__("afterBalanceHash", "not-a-sha256"))),
        )
        for label, mutate in mutations:
            with self.subTest(label=label):
                artifacts = self._story_one_capture()
                mutate(artifacts["no-ledger-effect.json"]["databases"][0])
                result = self._validate_story_one_capture(artifacts)
                self.assertNotEqual(result.returncode, 0, msg=result.stdout + result.stderr)
                self.assertIn("FAIL", (result.stdout + result.stderr).upper())

    def test_story_one_capture_rejects_response_only_evidence(self) -> None:
        artifacts = self._story_one_capture()
        artifacts["story-1-state.json"]["captureSource"] = "http-responses"
        result = self._validate_story_one_capture(artifacts)
        self.assertNotEqual(result.returncode, 0, msg=result.stdout + result.stderr)
        self.assertIn("FAIL", (result.stdout + result.stderr).upper())

    def test_story_one_capture_rejects_sequential_race_evidence(self) -> None:
        artifacts = self._story_one_capture()
        artifacts["story-1-state.json"]["race"]["kind"] = "sequential"
        result = self._validate_story_one_capture(artifacts)
        self.assertNotEqual(result.returncode, 0, msg=result.stdout + result.stderr)
        self.assertIn("FAIL", (result.stdout + result.stderr).upper())

    def test_story_one_provisions_owned_identities_control_plane_and_sessions(self) -> None:
        source = self.require_runner()
        provision = re.search(r"(?ms)^provision_story_one_stack\(\) \{(?P<body>.*?)^\}", source)
        self.assertIsNotNone(provision)
        body = provision.group("body")
        for marker in (
            "prepare_owned_keycloak_realm",
            "provision_story_one_tenants",
            "provision_story_one_identities",
            "seed_story_one_control_plane",
            "create_story_one_sessions",
            "start_owned_api",
            "start_owned_frontend",
        ):
            self.assertIn(marker, body)
        ordered = [body.index(marker) for marker in (
            "prepare_owned_keycloak_realm",
            "provision_story_one_tenants",
            "provision_story_one_identities",
            "seed_story_one_control_plane",
            "create_story_one_sessions",
            "start_owned_api",
            "start_owned_frontend",
        )]
        self.assertEqual(ordered, sorted(ordered))

    def test_story_one_owned_tokens_and_sessions_are_registered_and_secret(self) -> None:
        source = self.require_runner()
        for marker in (
            "KEMFAI_AF_USER_A_TOKEN",
            "KEMFAI_AF_USER_B_TOKEN",
            "KEMFAI_AF_USER_A_SESSION",
            "KEMFAI_AF_USER_B_SESSION",
            "KEMFAI_AF_SESSION_COOKIE_NAME",
        ):
            self.assertIn(f"export {marker}", source)
        self.assertRegex(source, r'register_secret "\$KEMFAI_AF_USER_A_TOKEN"')
        self.assertRegex(source, r'register_secret "\$KEMFAI_AF_USER_B_TOKEN"')
        for permission in ("accounting.coa.view", "accounting.coa.create", "accounting.coa.edit"):
            self.assertIn(permission, source)
        self.assertIn('kemfai:session:${KEMFAI_AF_USER_A_SESSION}', source)
        self.assertIn('kemfai:session:${KEMFAI_AF_USER_B_SESSION}', source)

    def test_story_one_control_plane_matches_signed_tenants_and_owned_databases(self) -> None:
        source = self.require_runner()
        seed = re.search(r"(?ms)^seed_story_one_control_plane\(\) \{(?P<body>.*?)^\}", source)
        self.assertIsNotNone(seed)
        body = seed.group("body")
        for marker in (
            'INSERT INTO "account"',
            'INSERT INTO "tenant"',
            'KEMFAI_AF_TENANT_A_ID',
            'KEMFAI_AF_TENANT_B_ID',
            'KEMFAI_AF_TENANT_A_DB',
            'KEMFAI_AF_TENANT_B_DB',
            "module.accounting_foundation",
        ):
            self.assertIn(marker, body)

    def test_story_one_waits_for_database_and_migrates_before_api_start(self) -> None:
        source = self.require_runner()
        provision = re.search(r"(?ms)^provision_story_one_stack\(\) \{(?P<body>.*?)^\}", source)
        self.assertIsNotNone(provision)
        body = provision.group("body")
        for marker in ("wait_for_owned_postgres", "npm run migration:run", "start_owned_api"):
            self.assertIn(marker, body)
        self.assertLess(body.index("wait_for_owned_postgres"), body.index("npm run migration:run"))
        self.assertLess(body.index("npm run migration:run"), body.index("start_owned_api"))

    def test_all_mode_publishes_every_full_validator_artifact(self) -> None:
        source = self.require_runner()
        required = {
            "fixture-registry.json",
            "readiness.json",
            "playwright.json",
            "playwright-summary.json",
            "api-contract-summary.json",
            "failure-injection.json",
            "odoo-exposure-scan.json",
        }
        for artifact in sorted(required):
            self.assertIn(artifact, source, f"full owned-live runner never publishes {artifact}")
        self.assertIn('"cleanupComplete": initial_status == 0 and cleanup_status == 0', source)
        self.assertIn('"independentCatalogChecks": cleanup_status == 0', source)

    def test_frontend_build_finishes_before_server_process_is_backgrounded(self) -> None:
        source = self.require_runner()
        frontend = re.search(r"(?ms)^start_owned_frontend\(\) \{(?P<body>.*?)^\}", source)
        self.assertIsNotNone(frontend)
        body = frontend.group("body")
        self.assertRegex(
            body,
            re.compile(
                r'npm run build >"\$KEMFAI_AF_EVIDENCE_DIR/frontend-build\.log" 2>&1\n'
                r"\s*\)\n\s*\(\n\s*cd \"\$ROOT/frontend\""
            ),
            "the production build must finish before the registered Next server process starts",
        )

    def test_story_one_http_readiness_retries_each_owned_service(self) -> None:
        source = self.require_runner()
        readiness = re.search(r"(?ms)^bounded_readiness\(\) \{(?P<body>.*?)^\}", source)
        self.assertIsNotNone(readiness)
        body = readiness.group("body")
        for url in (
            '$KEYCLOAK_URL/realms/kemfai-customers/.well-known/openid-configuration',
            '$API_URL/',
            '$FRONTEND_URL/',
        ):
            self.assertIn(f'bounded_http_readiness "{url}"', body)
        self.assertIn("odoo_db_service_ready", body)

    def test_story_one_odoo_failure_captures_redacted_container_evidence(self) -> None:
        source = self.require_runner()
        readiness = re.search(r"(?ms)^odoo_db_service_ready\(\) \{(?P<body>.*?)^\}", source)
        self.assertIsNotNone(readiness)
        body = readiness.group("body")
        self.assertIn('docker inspect "$KEMFAI_AF_ODOO_CONTAINER"', body)
        self.assertIn('docker logs --tail 300 "$KEMFAI_AF_ODOO_CONTAINER"', body)
        self.assertIn('| redact >"$KEMFAI_AF_EVIDENCE_DIR/odoo-readiness.log"', body)

    def test_story_one_odoo_readiness_avoids_uninitialized_control_database(self) -> None:
        source = self.require_runner()
        self.assertIn('local db_prefix="${KEMFAI_AF_RUN_ID//-/_}"', source)
        self.assertIn('dbfilter = ^${db_prefix}_tenant_[ab]$', source)
        self.assertIn('chmod 644 "$odoo_conf"', source)
        self.assertRegex(source, r"(?ms)^odoo_db_service_ready\(\) \{.*service.*db.*method.*list")
        readiness = re.search(r"(?ms)^bounded_readiness\(\) \{(?P<body>.*?)^\}", source)
        self.assertIsNotNone(readiness)
        self.assertIn("odoo_db_service_ready", readiness.group("body"))
        self.assertNotIn('$ODOO_URL/web/database/list', readiness.group("body"))

    def test_story_one_odoo_data_tmpfs_is_writable_by_non_root_process(self) -> None:
        source = self.require_runner()
        self.assertIn('--tmpfs /var/lib/odoo:rw,nosuid,mode=1777,size=512m', source)

    def test_story_one_starts_odoo_with_private_config_not_invalid_cli_option(self) -> None:
        source = self.require_runner()
        self.assertNotIn('--admin-passwd=', source)
        self.assertIn('odoo_conf="$private_dir/odoo.conf"', source)
        self.assertIn('-v "$odoo_conf:/etc/odoo/odoo.conf:ro"', source)
        self.assertRegex(source, r"odoo:18\.0(?: \\\n)?\s+odoo -c /etc/odoo/odoo\.conf")

    def test_story_one_provisions_two_registered_tenant_databases_before_readiness(self) -> None:
        source = self.require_runner()
        provision = re.search(r"(?ms)^provision_story_one_stack\(\) \{(?P<body>.*?)^\}", source)
        self.assertIsNotNone(provision)
        body = provision.group("body")
        self.assertIn("provision_story_one_tenants", body)
        self.assertLess(body.index("provision_story_one_tenants"), body.index("start_owned_api"))
        tenant_provision = re.search(r"(?ms)^provision_story_one_tenants\(\) \{(?P<body>.*?)^\}", source)
        self.assertIsNotNone(tenant_provision)
        tenant_body = tenant_provision.group("body")
        for marker in (
            "KEMFAI_AF_TENANT_A_DB",
            "KEMFAI_AF_TENANT_B_DB",
            "kemfai_accounting",
            'register_resource database',
        ):
            self.assertIn(marker, tenant_body)

    def test_story_one_database_readiness_uses_owned_credentials(self) -> None:
        source = self.require_runner()
        readiness = re.search(r"(?ms)^bounded_readiness\(\) \{(?P<body>.*?)^\}", source)
        self.assertIsNotNone(readiness)
        body = readiness.group("body")
        self.assertIn('psql -U "$KEMFAI_AF_DB_USER" -d kemfai_control', body)

    def test_story_one_execution_is_self_contained(self) -> None:
        source = self.require_runner()
        self.assertNotRegex(
            source,
            r"KEMFAI_AF_STORY_.*COMMAND",
            "Story execution must not depend on externally supplied commands that CI does not wire",
        )
        self.assertRegex(source, r"(?m)^run_story_one\(\) \{")
        self.assertRegex(source, r"(?m)^\s*story-1\) [^\n]*run_story_one")

    def test_keycloak_readiness_is_bounded_and_captures_timeout_diagnostics(self) -> None:
        source = self.require_runner()
        readiness = re.search(
            r"(?ms)^bounded_http_readiness\(\) \{(?P<body>.*?)^\}", source
        )
        self.assertIsNotNone(readiness)
        body = readiness.group("body")
        self.assertIn("seq 1 240", body)
        self.assertIn("docker inspect", body)
        self.assertIn("{{.State.Running}}", body)
        self.assertIn("break", body)
        self.assertIn("docker logs --tail 300", body)
        self.assertIn("| redact", body)
        self.assertIn("start-dev --import-realm --verbose", source)
        self.assertIn(
            'Keycloak "kemfai-af-${KEMFAI_AF_RUN_ID}-keycloak"', source
        )

    def test_keycloak_realm_import_uses_a_private_container_readable_volume(self) -> None:
        source = self.require_runner()
        stack = re.search(
            r"(?ms)^provision_story_one_stack\(\) \{(?P<body>.*?)^\}", source
        )
        self.assertIsNotNone(stack)
        body = stack.group("body")
        self.assertIn('register_resource volume "$keycloak_import_volume"', body)
        self.assertLess(
            body.index('register_resource volume "$keycloak_import_volume"'),
            body.index('for container in "$postgres" "$redis" "$keycloak" "$odoo"'),
            "reverse-order cleanup must remove containers before their mounted volume",
        )
        self.assertIn(
            'docker volume create --label "$KEMFAI_AF_OWNERSHIP_LABEL" '
            '"$keycloak_import_volume"',
            body,
        )
        self.assertIn('--user 0:0', body)
        self.assertIn('-i -v "$keycloak_import_volume:/import"', body)
        self.assertIn('<"$realm_file"', body)
        self.assertIn('chown 1000:0', body)
        self.assertIn('chmod 600', body)
        self.assertIn(
            '-v "$keycloak_import_volume:/opt/keycloak/data/import:ro"', body
        )
        self.assertNotIn(
            '-v "$realm_file:/opt/keycloak/data/import/kemfai-customers-realm.json:ro"',
            body,
        )

    def test_story_one_runs_live_isolation_and_failure_suites_inside_owned_stack(self) -> None:
        story = re.search(r"(?ms)^run_story_one\(\) \{(?P<body>.*?)^\}", self.source)
        self.assertIsNotNone(story)
        body = story.group("body")
        fault_index = body.index("start_fault_control")
        integration_index = body.index("accounting-tenant-isolation.integration-spec.ts")
        self.assertLess(fault_index, integration_index)
        for marker in (
            "accounting-tenant-isolation.integration-spec.ts",
            "accounting-audit-failure.integration-spec.ts",
            'KEMFAI_AF_API_BASE_URL="$API_URL"',
            'KEMFAI_AF_FAULT_CONTROL_URL="$FAULT_CONTROL_URL"',
            "CONTROL_DB_NAME=kemfai_control",
        ):
            self.assertIn(marker, body)

    def test_story_one_captures_persisted_evidence_after_browser_execution(self) -> None:
        source = self.require_runner()
        self.assertRegex(source, r"(?m)^capture_story_one_evidence\(\) \{")
        story = re.search(r"(?ms)^run_story_one\(\) \{(?P<body>.*?)^\}", source)
        self.assertIsNotNone(story)
        body = story.group("body")
        self.assertIn("npx playwright test", body)
        self.assertIn("capture_story_one_evidence", body)
        self.assertLess(body.index("npx playwright test"), body.index("capture_story_one_evidence"))
        for artifact in (
            "story-1-state.json",
            "scope-and-authorization.json",
            "no-ledger-effect.json",
            "audit-and-receipts.json",
        ):
            self.assertIn(artifact, source)

    def test_story_one_provisions_every_owned_service_before_readiness(self) -> None:
        source = self.require_runner()
        self.assertRegex(source, r"(?m)^provision_story_one_stack\(\) \{")
        story = re.search(r"(?ms)^run_story_one\(\) \{(?P<body>.*?)^\}", source)
        self.assertIsNotNone(story)
        body = story.group("body")
        self.assertIn("provision_story_one_stack", body)
        self.assertLess(body.index("provision_story_one_stack"), body.index("bounded_readiness"))
        for service in ("postgres", "redis", "keycloak", "odoo"):
            self.assertRegex(
                source,
                rf"(?ms)^provision_story_one_stack\(\) \{{.*docker run.*{service}",
                f"Story 1 must create its exact-owned {service} service",
            )
        self.assertRegex(source, r"(?ms)^provision_story_one_stack\(\) \{.*start_owned_api")
        self.assertRegex(source, r"(?ms)^provision_story_one_stack\(\) \{.*start_owned_frontend")

    def test_reused_evidence_rejection_does_not_run_uninitialized_cleanup(self) -> None:
        self.require_runner()
        with tempfile.TemporaryDirectory(prefix="af-existing-evidence-") as directory:
            result = subprocess.run(
                ["bash", str(RUNNER), "story-1"],
                cwd=ROOT,
                env={**__import__("os").environ, "KEMFAI_AF_EVIDENCE_DIR": directory},
                text=True,
                capture_output=True,
            )
        output = result.stdout + result.stderr
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("evidence directory already exists", output)
        self.assertNotIn("Traceback", output)

    def test_story_two_runs_owned_browser_journey_before_persisted_capture(self) -> None:
        source = self.require_runner()
        story = re.search(r"(?ms)^run_story_two\(\) \{(?P<body>.*?)^\}", source)
        self.assertIsNotNone(story)
        body = story.group("body")
        for marker in (
            "provision_story_one_stack",
            "bounded_readiness",
            "npx playwright test",
            "Accounting Foundation Story 2",
            "capture_story_two_evidence",
        ):
            self.assertIn(marker, body)
        self.assertNotIn("story-2 is unavailable", body)
        self.assertLess(body.index("npx playwright test"), body.index("capture_story_two_evidence"))

    def test_story_two_real_rpc_suite_receives_private_fault_control_environment(self) -> None:
        source = self.require_runner()
        story = re.search(r"(?ms)^run_story_two\(\) \{(?P<body>.*?)^\}", source)
        self.assertIsNotNone(story)
        body = story.group("body")
        for marker in (
            "test/integration/accounting-live.integration-spec.ts",
            'KEMFAI_AF_API_BASE_URL="$API_URL"',
            'KEMFAI_AF_FAULT_CONTROL_URL="$FAULT_CONTROL_URL"',
            'KEMFAI_AF_ODOO_URL="$ODOO_URL"',
            'KEMFAI_AF_ODOO_LOGIN="$KEMFAI_AF_ODOO_LOGIN"',
            'KEMFAI_AF_ODOO_PASSWORD="$KEMFAI_AF_ODOO_PASSWORD"',
            'KEMFAI_AF_TENANT_A_DB="$KEMFAI_AF_TENANT_A_DB"',
            'KEMFAI_AF_TENANT_B_DB="$KEMFAI_AF_TENANT_B_DB"',
            "start_fault_control",
        ):
            self.assertIn(marker, body)
        self.assertRegex(source, r"(?m)^\s*FAULT_CONTROL_PORT=")
        self.assertRegex(source, r"(?m)^start_fault_control\(\) \{")
        self.assertIn("accounting_foundation_fault_control.py", source)
        self.assertIn("KEMFAI_ACCOUNTING_TEST_FAULTS=1", source)

    def test_story_two_capture_uses_browser_facts_and_persisted_queries(self) -> None:
        source = self.require_runner()
        capture = re.search(r"(?ms)^capture_story_two_evidence\(\) \{(?P<body>.*?)^\}", source)
        self.assertIsNotNone(capture)
        body = capture.group("body")
        for marker in (
            "story-two-journey.json",
            "accounting_foundation_capture_story_two.py",
            "story-2-state.json",
            "--topology",
        ):
            self.assertIn(marker, body)
        helper = ROOT / "scripts/fixtures/accounting_foundation_capture_story_two.py"
        self.assertTrue(helper.is_file(), "Story 2 persisted-query capture helper is required")
        helper_source = helper.read_text(encoding="utf-8")
        for marker in (
            'captureSource": "persisted-queries"',
            "kemfai.dimension.definition",
            "kemfai.dimension.value",
            "kemfai.dimension.rule",
            "kemfai.account.draft",
            "payload_json",
            "account.move",
            "accounting_mutation_handoff",
        ):
            self.assertIn(marker, helper_source)

    def test_story_two_audit_targets_include_mutations_not_seeded_definitions(self) -> None:
        from scripts.fixtures.accounting_foundation_capture_story_two import audit_targets

        tenant_a, tenant_b = audit_targets({
            "definitions": {"project": "seed-project", "costCenter": "seed-cost-center"},
            "values": {"project": "value-project", "costCenter": "value-cost-center"},
            "rules": {"rule-project": 1, "rule-cost-center": 1},
            "races": {"sameKey": {"resourceId": "raced-definition"}},
            "scope": {
                "companyA2": {"exactForeignId": "company-a1-definition"},
                "tenantB": {"exactForeignId": "tenant-b-definition"},
            },
        })

        self.assertEqual(tenant_a, {
            "value-project", "value-cost-center", "rule-project", "rule-cost-center",
            "raced-definition", "company-a1-definition",
        })
        self.assertEqual(tenant_b, {"tenant-b-definition"})
        self.assertNotIn("seed-project", tenant_a)
        self.assertNotIn("seed-cost-center", tenant_a)

    def test_later_browser_journeys_rotate_runtime_credentials_after_long_integration_suites(self) -> None:
        source = self.require_runner()
        self.assertRegex(source, r"(?m)^refresh_owned_browser_credentials\(\) \{")
        refresh = re.search(
            r"(?ms)^refresh_owned_browser_credentials\(\) \{(?P<body>.*?)^\}", source
        )
        self.assertIsNotNone(refresh)
        refresh_body = refresh.group("body")
        self.assertIn("provision_story_one_identities", refresh_body)
        self.assertIn("create_story_one_sessions", refresh_body)
        self.assertLess(
            refresh_body.index("provision_story_one_identities"),
            refresh_body.index("create_story_one_sessions"),
        )
        for function_name in ("run_story_two", "run_story_three"):
            story = re.search(
                rf"(?ms)^{function_name}\(\) \{{(?P<body>.*?)^\}}", source
            )
            self.assertIsNotNone(story)
            body = story.group("body")
            self.assertIn("refresh_owned_browser_credentials", body)
            self.assertLess(
                body.index("npm run test:integration:nonlive"),
                body.index("refresh_owned_browser_credentials"),
            )
            self.assertLess(
                body.index("refresh_owned_browser_credentials"),
                body.index("npx playwright test"),
            )

    def test_story_three_runs_owned_journey_and_captures_financial_safety_evidence(self) -> None:
        source = self.require_runner()
        story = re.search(r"(?ms)^run_story_three\(\) \{(?P<body>.*?)^\}", source)
        self.assertIsNotNone(story)
        body = story.group("body")
        for marker in (
            "bounded_readiness",
            "Accounting Foundation Story 3",
            "story-three-journey.json",
            "capture_story_three_evidence",
        ):
            self.assertIn(marker, body)
        self.assertNotIn("story-3 is unavailable", body)
        self.assertLess(body.index("npx playwright test"), body.index("capture_story_three_evidence"))

        capture = re.search(r"(?ms)^capture_story_three_evidence\(\) \{(?P<body>.*?)^\}", source)
        self.assertIsNotNone(capture)
        capture_body = capture.group("body")
        for marker in (
            "story-3-state.json",
            "story-3-no-ledger-effect.json",
            "exactAmounts",
            "configurationSnapshot",
            "postingMethodProbes",
            "postingFeatureEnabled",
            "journalVersion",
            "currencyVersion",
            "draftSameKey",
            "validationSameKey",
            "tenant-audit-create-failure",
            "ledgerBefore",
            "ledgerAfter",
        ):
            self.assertIn(marker, capture_body)

    def test_story_three_capture_executes_embedded_python_and_writes_both_db_hashes(self) -> None:
        source = self.require_runner()
        match = re.search(
            r"(?ms)^capture_story_three_evidence\(\) \{.*?<<'PY_STORY_THREE'\n(?P<python>.*?)^PY_STORY_THREE$",
            source,
        )
        self.assertIsNotNone(match)
        code = match.group("python")
        story = {
            "story3": {
                "exactAmounts": [{"transactionDebit": "10.00001"}],
                "exactMetadata": [{"transactionCurrencyCode": "USD"}],
                "configurationSnapshot": {"journal": {"version": 1}},
                "ledgerBefore": {
                    "tenantA": {"moves": 0, "lines": 0, "hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "balanceHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
                    "tenantB": {"moves": 0, "lines": 0, "hash": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", "balanceHash": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"},
                },
                "ledgerAfter": {
                    "tenantA": {"moves": 0, "lines": 0, "hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "balanceHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
                    "tenantB": {"moves": 0, "lines": 0, "hash": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", "balanceHash": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"},
                },
                "raceLedgerBefore": [{"moves": 0}, {"moves": 0}],
                "raceLedgerAfter": [{"moves": 0}, {"moves": 0}],
                "races": {
                    "journalVersion": {"starts": [1, 2], "statuses": [200, 412]},
                    "currencyVersion": {"starts": [1, 2], "statuses": [412, 200]},
                    "draftSameKey": {"statuses": [201, 201]},
                    "validationSameKey": {"statuses": [200, 200]},
                },
                "postingFeatureEnabled": False,
                "postingMethodProbes": {"forbiddenRouteStatus": 404, "actionPostInvocations": 0},
                "failureInjection": {
                    "mode": "tenant-audit-create-failure", "status": 503, "partialMutations": 0,
                },
            },
        }
        with tempfile.TemporaryDirectory(prefix="af-story-three-capture-") as directory:
            root = Path(directory)
            journey = root / "journey.json"
            story_output = root / "story-3-state.json"
            ledger_output = root / "no-ledger-effect.json"
            journey.write_text(json.dumps(story), encoding="utf-8")
            result = subprocess.run(
                ["python3", "-c", code, str(journey), str(story_output), str(ledger_output), "kemfai_af_tenant_a", "kemfai_af_tenant_b"],
                cwd=ROOT, text=True, capture_output=True,
            )
            self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
            captured = json.loads(ledger_output.read_text(encoding="utf-8"))
            self.assertEqual(
                [
                    (item["name"], item["actualDatabase"], item["persistedQueryId"])
                    for item in captured["databases"]
                ],
                [
                    ("tenant_a_db", "kemfai_af_tenant_a", "odoo:kemfai_af_tenant_a:ledger-count-hash"),
                    ("tenant_b_db", "kemfai_af_tenant_b", "odoo:kemfai_af_tenant_b:ledger-count-hash"),
                ],
            )

    def test_runner_has_valid_bash_syntax(self) -> None:
        self.require_runner()
        subprocess.run(["bash", "-n", str(RUNNER)], cwd=ROOT, check=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
