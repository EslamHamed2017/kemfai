#!/usr/bin/env python3
from __future__ import annotations

import copy
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
VALIDATOR = ROOT / "scripts/fixtures/accounting_foundation_validate_evidence.py"
REQUIRED_FAILURES = [
    "role_scope_denial",
    "stale_if_match",
    "idempotency_conflict",
    "lost_rpc_response",
    "platform_audit_unavailable",
    "tenant_audit_write_failure",
    "browser_double_submit",
    "policy_pending",
]


def _baseline_artifacts() -> dict[str, dict]:
    passed_story = {
        "status": "passed",
        "productionPath": True,
        "persistedStateVerified": True,
        "emptyLoadingErrorCovered": True,
        "locales": ["en-LTR", "ar-RTL"],
    }
    routes = [
        {"method": "POST", "path": "/v1/accounting/drafts/{id}/post", "status": 404},
        {
            "method": "POST",
            "path": "/v1/accounting/entries/{id}/reverse",
            "status": 404,
        },
        {
            "method": "POST",
            "path": "/v1/accounting/opening-batches/{id}/post",
            "status": 404,
        },
        {
            "method": "POST",
            "path": "/v1/accounting/periods/{id}/transitions",
            "status": 404,
        },
    ]
    return {
        "fixture-registry.json": {
            "runId": "af-test-run",
            "ownershipLabel": "kemfai.accounting-foundation.run=af-test-run",
            "tenants": [
                {
                    "tenantId": "tenant-a",
                    "database": "tenant_a_db",
                    "route": "route-a",
                    "companies": ["company-a1", "company-a2"],
                },
                {
                    "tenantId": "tenant-b",
                    "database": "tenant_b_db",
                    "route": "route-b",
                    "companies": ["company-b1"],
                },
            ],
            "users": [
                {"subject": "user-a", "tenants": ["tenant-a"]},
                {"subject": "user-b", "tenants": ["tenant-b"]},
            ],
        },
        "readiness.json": {
            "status": "passed",
            "databases": [
                {
                    "name": "tenant_a_db",
                    "route": "route-a",
                    "addonsInstalled": True,
                    "addons": [
                        {
                            "name": "kemfai_dimensions",
                            "state": "installed",
                            "version": "18.0.1.0.0",
                        },
                        {
                            "name": "kemfai_accounting",
                            "state": "installed",
                            "version": "18.0.1.0.0",
                        },
                    ],
                },
                {
                    "name": "tenant_b_db",
                    "route": "route-b",
                    "addonsInstalled": True,
                    "addons": [
                        {
                            "name": "kemfai_dimensions",
                            "state": "installed",
                            "version": "18.0.1.0.0",
                        },
                        {
                            "name": "kemfai_accounting",
                            "state": "installed",
                            "version": "18.0.1.0.0",
                        },
                    ],
                },
            ],
        },
        "playwright.json": {
            "stats": {"expected": 3, "skipped": 0, "unexpected": 0, "flaky": 0},
            "errors": [],
        },
        "playwright-summary.json": {
            "status": "passed",
            "counts": {
                "expected": 3,
                "skipped": 0,
                "unexpected": 0,
                "flaky": 0,
                "errors": 0,
            },
            "stories": [
                {"name": "story-1", "status": "passed"},
                {"name": "story-2", "status": "passed"},
                {"name": "story-3", "status": "passed"},
            ],
        },
        "api-contract-summary.json": {"status": "passed", "forbiddenRoutes": routes},
        "story-1-state.json": {
            **passed_story,
            "story": "story-1",
            "captureSource": "persisted-queries",
            "databases": [
                {
                    "name": "tenant_a_db",
                    "tenantId": "tenant-a",
                    "companyIds": ["company-a1", "company-a2"],
                    "persistedQueryId": "query-db-a",
                },
                {
                    "name": "tenant_b_db",
                    "tenantId": "tenant-b",
                    "companyIds": ["company-b1"],
                    "persistedQueryId": "query-db-b",
                },
            ],
            "account": {
                "id": "11111111-1111-4111-8111-111111111111",
                "database": "tenant_a_db",
                "companyId": "company-a1",
                "persistedQueryId": "query-account",
            },
            "draft": {
                "id": "22222222-2222-4222-8222-222222222222",
                "state": "draft",
                "database": "tenant_a_db",
                "companyId": "company-a1",
                "persistedQueryId": "query-draft",
            },
            "parentRejection": {
                "code": "ACCOUNT_NOT_POSTING",
                "lineIndex": 0,
                "persistedDraftUnchanged": True,
                "ledgerEffect": "none",
                "receiptId": "receipt-parent",
                "auditEventId": "audit-parent",
            },
            "race": {
                "kind": "simultaneous",
                "barrierId": "barrier-1",
                "participants": 2,
                "maxStartSkewMs": 4,
                "transactionIds": ["tx-left", "tx-right"],
                "winnerCount": 1,
                "staleCount": 1,
                "versionDelta": 1,
                "persistedWinnerQueryId": "query-race-winner",
            },
        },
        "story-2-state.json": {
            **passed_story,
            "story": "story-2",
            "captureSource": "persisted-queries",
            "normalizedDimensions": {
                "definitions": [
                    {
                        "id": "44444444-4444-4444-8444-444444444444",
                        "key": "project",
                        "persistedQueryId": "query-project-definition",
                    },
                    {
                        "id": "55555555-5555-4555-8555-555555555555",
                        "key": "cost_center",
                        "persistedQueryId": "query-cost-center-definition",
                    },
                ],
                "values": [
                    {
                        "id": "66666666-6666-4666-8666-666666666666",
                        "definitionId": "44444444-4444-4444-8444-444444444444",
                        "persistedQueryId": "query-project-value",
                    },
                    {
                        "id": "77777777-7777-4777-8777-777777777777",
                        "definitionId": "55555555-5555-4555-8555-555555555555",
                        "persistedQueryId": "query-cost-center-value",
                    },
                ],
                "assignments": [
                    {
                        "definitionId": "44444444-4444-4444-8444-444444444444",
                        "valueId": "66666666-6666-4666-8666-666666666666",
                        "persistedQueryId": "query-project-assignment",
                    },
                    {
                        "definitionId": "55555555-5555-4555-8555-555555555555",
                        "valueId": "77777777-7777-4777-8777-777777777777",
                        "persistedQueryId": "query-cost-center-assignment",
                    },
                ],
            },
            "resolvedRuleVersions": [
                {
                    "ruleId": "88888888-8888-4888-8888-888888888888",
                    "version": 2,
                    "persistedQueryId": "query-resolved-rule",
                }
            ],
            "races": {
                "sameKey": {
                    "kind": "simultaneous",
                    "participants": 2,
                    "maxStartSkewMs": 3,
                    "operationId": "99999999-9999-4999-8999-999999999999",
                    "persistedHandoffQueryId": "query-same-key-handoff",
                    "winnerCount": 1,
                    "replayCount": 1,
                },
                "staleRule": {
                    "kind": "simultaneous",
                    "participants": 2,
                    "transactionIds": ["tx-rule-left", "tx-rule-right"],
                    "winnerCount": 1,
                    "staleCount": 1,
                    "persistedWinnerQueryId": "query-stale-rule-winner",
                },
            },
            "isolation": {
                "companyA2ResourceId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "tenantBResourceId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                "opaqueStatuses": [404, 404],
                "persistedResourceQueryIds": ["query-company-a2", "query-tenant-b"],
                "denialAuditQueryIds": ["query-denial-a2", "query-denial-b"],
            },
            "audit": {
                "targetIds": {
                    "tenantA": ["66666666-6666-4666-8666-666666666666"],
                    "tenantB": ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
                },
                "events": [
                    {
                        "database": "tenant_a_db",
                        "eventId": "aaaaaaaa-1111-4111-8111-111111111111",
                        "targetId": "66666666-6666-4666-8666-666666666666",
                    },
                    {
                        "database": "tenant_b_db",
                        "eventId": "bbbbbbbb-1111-4111-8111-111111111111",
                        "targetId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                    },
                ],
                "persistedQueryIds": ["query-audit-a", "query-audit-b"],
            },
            "accountCount": {
                "before": 3,
                "after": 3,
                "persistedQueryId": "query-account-count",
            },
            "noLedger": {
                "ledgerEffect": "none",
                "actionPostInvocations": 0,
                "persistedQueryId": "query-story-2-ledger",
            },
        },
        "story-3-state.json": {
            **passed_story,
            "story": "story-3",
            "captureSource": "browser-and-persisted-queries",
            "ledgerEffect": "none",
            "draftId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            "elapsedMilliseconds": 120000,
            "exactAmounts": [
                {"transactionDebit": amount, "transactionCredit": "100.00000" if index == 4 else "0.00000",
                 "baseDebit": amount, "baseCredit": "100.00000" if index == 4 else "0.00000"}
                for index, amount in enumerate(("10.00001", "20.20000", "30.00300", "39.79699", "0.00000"))
            ],
            "exactMetadata": [
                {
                    "transactionCurrencyCode": "EUR" if index == 0 else "USD",
                    "transactionPrecision": 2,
                    "transactionCurrencyMetadataVersion": "native-eur-v1" if index == 0 else "native-usd-v1",
                    "companyBaseCurrencyCode": "USD", "basePrecision": 2,
                    "baseCurrencyMetadataVersion": "native-usd-v1", "currencyConfigurationVersion": 1,
                    "transactionDebit": amount, "transactionCredit": "100.00000" if index == 4 else "0.00000",
                    "baseDebit": amount, "baseCredit": "100.00000" if index == 4 else "0.00000",
                    "rateReference": "owned-manual-rate" if index == 0 else None,
                    "rateEffectiveDate": "2026-11-07" if index == 0 else None,
                }
                for index, amount in enumerate(("10.00001", "20.20000", "30.00300", "39.79699", "0.00000"))
            ],
            "configurationSnapshot": {
                "accounts": {"dddddddd-dddd-4ddd-8ddd-dddddddddddd": 1},
                "dimensionRules": {},
                "journal": {"id": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "version": 1},
                "currencies": {
                    "USD": {"currencyCode": "USD", "configurationVersion": 1,
                            "nativeMetadataVersion": "native-usd-v1", "nativeDecimalPlaces": 2},
                    "EUR": {"currencyCode": "EUR", "configurationVersion": 1,
                            "nativeMetadataVersion": "native-eur-v1", "nativeDecimalPlaces": 2},
                },
            },
            "races": {
                "journalVersion": {"starts": [1000, 1002], "statuses": [200, 412]},
                "currencyVersion": {"starts": [2000, 2003], "statuses": [412, 200]},
                "draftSameKey": {"statuses": [201, 201], "resourceId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                                 "operationId": "11111111-2222-4333-8444-555555555555",
                                 "auditEventId": "22222222-3333-4444-8555-666666666666"},
                "validationSameKey": {"statuses": [200, 200],
                                      "operationId": "33333333-4444-4555-8666-777777777777",
                                      "auditEventId": "44444444-5555-4666-8777-888888888888"},
            },
            "postingFeatureEnabled": False,
            "postingMethodProbes": {"forbiddenRouteStatus": 404, "actionPostInvocations": 0},
            "failureInjection": {"mode": "tenant-audit-create-failure", "status": 503, "partialMutations": 0},
        },
        "no-ledger-effect.json": {
            "status": "passed",
            "actionPostInvocations": 0,
            "postingFeatureEnabled": False,
            "databases": [
                {
                    "name": "tenant_a_db",
                    "beforeHash": "a" * 64,
                    "afterHash": "a" * 64,
                    "beforeMoveCount": 0, "afterMoveCount": 0,
                    "beforeLineCount": 0, "afterLineCount": 0,
                    "beforeBalanceHash": "c" * 64, "afterBalanceHash": "c" * 64,
                },
                {
                    "name": "tenant_b_db",
                    "beforeHash": "b" * 64,
                    "afterHash": "b" * 64,
                    "beforeMoveCount": 0, "afterMoveCount": 0,
                    "beforeLineCount": 0, "afterLineCount": 0,
                    "beforeBalanceHash": "d" * 64, "afterBalanceHash": "d" * 64,
                },
            ],
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
        "audit-and-receipts.json": {
            "status": "passed",
            "acceptedMutations": 3,
            "tenantAuditEvents": 3,
            "operationReceipts": 3,
            "platformMirrorsComplete": True,
            "dedupeStateComplete": True,
            "acceptedMutationIds": ["op-create", "op-draft", "op-validate"],
            "tenantAuditOperationIds": ["op-create", "op-draft", "op-validate"],
            "operationReceiptOperationIds": ["op-create", "op-draft", "op-validate"],
            "platformMirrorOperationIds": ["op-create", "op-draft", "op-validate"],
            "persistedQueryIds": ["query-audit", "query-receipt", "query-mirror"],
        },
        "failure-injection.json": {
            "status": "passed",
            "cases": [
                {
                    "name": name,
                    "status": "passed",
                    "partialMutations": 0,
                    "duplicateResults": 0,
                    **(
                        {
                            "recovery": {
                                "bounded": True,
                                "finalState": "audited",
                                "auditedOutcomes": 1,
                                "operationReceipts": 1,
                            }
                        }
                        if name in {"lost_rpc_response", "platform_audit_unavailable"}
                        else {}
                    ),
                    **(
                        {"domainMutationRolledBack": True}
                        if name == "tenant_audit_write_failure"
                        else {}
                    ),
                }
                for name in REQUIRED_FAILURES
            ],
        },
        "odoo-exposure-scan.json": {
            "status": "passed", "rawOdooExposures": 0,
            "scanTargets": ["browser-responses", "browser-links", "api-responses", "publishable-logs"],
            "nativeUrls": 0, "nativeModels": 0, "internalIds": 0,
            "databaseNames": 0, "rpcDetails": 0,
        },
        "secret-scan.json": {"status": "passed", "secretsFound": 0},
        "cleanup-receipt.json": {
            "status": "passed",
            "cleanupComplete": True,
            "registeredResources": 17,
            "removedResources": 17,
            "survivors": {
                "processes": 0,
                "containers": 0,
                "networks": 0,
                "volumes": 0,
                "databases": 0,
                "routes": 0,
                "users": 0,
                "memberships": 0,
                "companies": 0,
                "realms": 0,
                "clients": 0,
                "buckets": 0,
                "privateFiles": 0,
            },
            "independentCatalogChecks": True,
        },
    }


class AccountingFoundationEvidenceTests(unittest.TestCase):
    maxDiff = None

    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory(prefix="af-evidence-test-")
        self.addCleanup(self._temp.cleanup)
        self.evidence = Path(self._temp.name)
        self.artifacts = _baseline_artifacts()
        self._write_all()

    def _write_all(self) -> None:
        for name, payload in self.artifacts.items():
            (self.evidence / name).write_text(
                json.dumps(payload, sort_keys=True) + "\n", encoding="utf-8"
            )
        self._write_manifest()

    def _write_manifest(self) -> None:
        artifacts = {}
        for name in sorted(self.artifacts):
            path = self.evidence / name
            if not path.is_file():
                continue
            raw = path.read_bytes()
            artifacts[name] = {
                "bytes": len(raw),
                "sha256": hashlib.sha256(raw).hexdigest(),
            }
        payload = {"schemaVersion": 1, "runId": "af-test-run", "artifacts": artifacts}
        (self.evidence / "evidence-manifest.json").write_text(
            json.dumps(payload, sort_keys=True) + "\n", encoding="utf-8"
        )

    def _rewrite_payload(self, name: str, payload: dict) -> None:
        self.artifacts[name] = payload
        (self.evidence / name).write_text(
            json.dumps(payload, sort_keys=True) + "\n", encoding="utf-8"
        )
        self._write_manifest()

    def _run(self, *options: str) -> subprocess.CompletedProcess[str]:
        self.assertTrue(VALIDATOR.is_file(), f"missing intended validator: {VALIDATOR}")
        return subprocess.run(
            [sys.executable, str(VALIDATOR), *options, str(self.evidence)],
            cwd=ROOT,
            text=True,
            capture_output=True,
        )

    def _assert_invalid(self) -> None:
        result = self._run()
        self.assertNotEqual(result.returncode, 0, msg=result.stdout + result.stderr)
        self.assertIn("FAIL", (result.stdout + result.stderr).upper())

    def test_complete_manifest_is_accepted(self) -> None:
        result = self._run()
        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)

    def test_story_one_mode_accepts_owned_live_manifest(self) -> None:
        tenant_a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        tenant_b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        company_a1 = "a1111111-1111-4111-8111-111111111111"
        company_a2 = "a2222222-2222-4222-8222-222222222222"
        company_b1 = "b1111111-1111-4111-8111-111111111111"
        story = copy.deepcopy(self.artifacts["story-1-state.json"])
        story["databases"][0]["tenantId"] = tenant_a
        story["databases"][0]["companyIds"] = [company_a1, company_a2]
        story["databases"][1]["tenantId"] = tenant_b
        story["databases"][1]["companyIds"] = [company_b1]
        story["account"]["companyId"] = company_a1
        story["draft"]["companyId"] = company_a1
        self.artifacts = {
            "story-1-state.json": story,
            "scope-and-authorization.json": self.artifacts["scope-and-authorization.json"],
            "no-ledger-effect.json": self.artifacts["no-ledger-effect.json"],
            "audit-and-receipts.json": self.artifacts["audit-and-receipts.json"],
            "secret-scan.json": {"status": "passed", "leaks": []},
            "cleanup-receipt.json": {
                **copy.deepcopy(self.artifacts["cleanup-receipt.json"]),
                "runId": "af-test-run",
                "ownershipLabel": "com.kemfai.accounting-foundation.run=af-test-run",
                "commandStatus": 0,
                "cleanupStatus": 0,
            },
        }
        for path in self.evidence.iterdir():
            path.unlink()
        self._write_all()

        result = self._run("--story-1")

        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
        self.assertIn("Story 1 evidence", result.stdout)

    def test_story_two_mode_accepts_current_cleanup_receipt_schema(self) -> None:
        cleanup = copy.deepcopy(self.artifacts["cleanup-receipt.json"])
        cleanup.update({
            "runId": "af-test-run",
            "ownershipLabel": "com.kemfai.accounting-foundation.run=af-test-run",
            "commandStatus": 0,
            "cleanupStatus": 0,
        })
        self.artifacts = {
            "story-2-state.json": self.artifacts["story-2-state.json"],
            "secret-scan.json": {"status": "passed", "leaks": []},
            "cleanup-receipt.json": cleanup,
        }
        for path in self.evidence.iterdir():
            path.unlink()
        self._write_all()

        result = self._run("--story-2")

        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
        self.assertIn("Story 2 evidence", result.stdout)

    def test_story_three_mode_accepts_owned_live_manifest_and_fails_on_ledger_change(self) -> None:
        self.artifacts = {
            "story-3-state.json": self.artifacts["story-3-state.json"],
            "no-ledger-effect.json": self.artifacts["no-ledger-effect.json"],
            "secret-scan.json": {"status": "passed", "leaks": []},
            "cleanup-receipt.json": {
                **copy.deepcopy(self.artifacts["cleanup-receipt.json"]),
                "runId": "af-test-run",
                "ownershipLabel": "com.kemfai.accounting-foundation.run=af-test-run",
                "commandStatus": 0,
                "cleanupStatus": 0,
            },
        }
        for path in self.evidence.iterdir():
            path.unlink()
        self._write_all()

        result = self._run("--story-3")
        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
        self.assertIn("Story 3 evidence", result.stdout)

        ledger = copy.deepcopy(self.artifacts["no-ledger-effect.json"])
        ledger["databases"][0]["afterHash"] = "changed"
        self._rewrite_payload("no-ledger-effect.json", ledger)
        result = self._run("--story-3")
        self.assertNotEqual(result.returncode, 0, msg=result.stdout + result.stderr)

    def test_missing_or_empty_manifest_fails_closed(self) -> None:
        manifest = self.evidence / "evidence-manifest.json"
        for mode in ("missing", "empty"):
            with self.subTest(mode=mode):
                self.artifacts = _baseline_artifacts()
                self._write_all()
                if mode == "missing":
                    manifest.unlink()
                else:
                    manifest.write_bytes(b"")
                self._assert_invalid()

    def test_missing_required_evidence_fails_closed(self) -> None:
        for name in (
            "story-1-state.json",
            "audit-and-receipts.json",
            "api-contract-summary.json",
            "readiness.json",
            "no-ledger-effect.json",
            "failure-injection.json",
            "cleanup-receipt.json",
        ):
            with self.subTest(name=name):
                self.artifacts = _baseline_artifacts()
                self._write_all()
                (self.evidence / name).unlink()
                self.artifacts.pop(name)
                self._write_manifest()
                self._assert_invalid()

    def test_empty_required_evidence_fails_closed(self) -> None:
        for name in (
            "story-2-state.json",
            "audit-and-receipts.json",
            "api-contract-summary.json",
            "readiness.json",
            "no-ledger-effect.json",
            "failure-injection.json",
            "cleanup-receipt.json",
        ):
            with self.subTest(name=name):
                self.artifacts = _baseline_artifacts()
                self._write_all()
                (self.evidence / name).write_bytes(b"")
                self._write_manifest()
                self._assert_invalid()

    def test_skipped_or_flaky_story_evidence_fails(self) -> None:
        for field in ("skipped", "flaky"):
            with self.subTest(field=field):
                self.artifacts = _baseline_artifacts()
                self._write_all()
                payload = copy.deepcopy(self.artifacts["playwright-summary.json"])
                payload["counts"][field] = 1
                self._rewrite_payload("playwright-summary.json", payload)
                self._assert_invalid()

    def test_nonpassed_story_state_fails(self) -> None:
        for status in ("skipped", "flaky"):
            with self.subTest(status=status):
                self.artifacts = _baseline_artifacts()
                self._write_all()
                payload = copy.deepcopy(self.artifacts["story-3-state.json"])
                payload["status"] = status
                self._rewrite_payload("story-3-state.json", payload)
                self._assert_invalid()

    def test_incomplete_audit_evidence_fails(self) -> None:
        payload = copy.deepcopy(self.artifacts["audit-and-receipts.json"])
        payload["tenantAuditEvents"] -= 1
        self._rewrite_payload("audit-and-receipts.json", payload)
        self._assert_invalid()

    def test_story_two_rejects_response_only_capture(self) -> None:
        payload = copy.deepcopy(self.artifacts["story-2-state.json"])
        payload["captureSource"] = "http-responses"
        self._rewrite_payload("story-2-state.json", payload)
        self._assert_invalid()

    def test_story_two_rejects_sequential_only_races(self) -> None:
        for race_name in ("sameKey", "staleRule"):
            with self.subTest(race_name=race_name):
                self.artifacts = _baseline_artifacts()
                self._write_all()
                payload = copy.deepcopy(self.artifacts["story-2-state.json"])
                payload["races"][race_name]["kind"] = "sequential"
                self._rewrite_payload("story-2-state.json", payload)
                self._assert_invalid()

    def test_story_two_requires_both_addons_in_each_tenant_database(self) -> None:
        for database_index in range(2):
            for missing_addon in ("kemfai_dimensions", "kemfai_accounting"):
                with self.subTest(
                    database_index=database_index, missing_addon=missing_addon
                ):
                    self.artifacts = _baseline_artifacts()
                    self._write_all()
                    payload = copy.deepcopy(self.artifacts["readiness.json"])
                    database = payload["databases"][database_index]
                    database["addons"] = [
                        addon
                        for addon in database["addons"]
                        if addon["name"] != missing_addon
                    ]
                    self._rewrite_payload("readiness.json", payload)
                    self._assert_invalid()

    def test_story_two_requires_normalized_definition_value_and_assignment_ids(self) -> None:
        required_ids = (
            ("definitions", "id"),
            ("values", "id"),
            ("assignments", "valueId"),
        )
        for section, field in required_ids:
            with self.subTest(section=section, field=field):
                self.artifacts = _baseline_artifacts()
                self._write_all()
                payload = copy.deepcopy(self.artifacts["story-2-state.json"])
                payload["normalizedDimensions"][section][0].pop(field)
                self._rewrite_payload("story-2-state.json", payload)
                self._assert_invalid()

    def test_story_two_requires_resolved_rule_versions(self) -> None:
        payload = copy.deepcopy(self.artifacts["story-2-state.json"])
        payload["resolvedRuleVersions"] = []
        self._rewrite_payload("story-2-state.json", payload)
        self._assert_invalid()

    def test_story_two_requires_unchanged_account_count(self) -> None:
        payload = copy.deepcopy(self.artifacts["story-2-state.json"])
        payload["accountCount"]["after"] += 1
        self._rewrite_payload("story-2-state.json", payload)
        self._assert_invalid()

    def test_story_two_requires_persisted_no_ledger_facts(self) -> None:
        invalid_facts = (
            ("ledgerEffect", "posted"),
            ("actionPostInvocations", 1),
            ("persistedQueryId", ""),
        )
        for field, value in invalid_facts:
            with self.subTest(field=field):
                self.artifacts = _baseline_artifacts()
                self._write_all()
                payload = copy.deepcopy(self.artifacts["story-2-state.json"])
                payload["noLedger"][field] = value
                self._rewrite_payload("story-2-state.json", payload)
                self._assert_invalid()

    def test_no_ledger_rejects_invalid_count_facts(self) -> None:
        for prefix, value in (
            ("MoveCount", None),
            ("MoveCount", True),
            ("LineCount", -1),
            ("LineCount", "0"),
        ):
            with self.subTest(prefix=prefix, value=value):
                self.artifacts = _baseline_artifacts()
                self._write_all()
                payload = copy.deepcopy(self.artifacts["no-ledger-effect.json"])
                item = payload["databases"][0]
                item[f"before{prefix}"] = value
                item[f"after{prefix}"] = value
                self._rewrite_payload("no-ledger-effect.json", payload)
                self._assert_invalid()

    def test_no_ledger_rejects_invalid_hash_facts(self) -> None:
        for prefix, value in (
            ("Hash", None),
            ("Hash", ""),
            ("BalanceHash", "not-a-sha256"),
            ("BalanceHash", "z" * 64),
        ):
            with self.subTest(prefix=prefix, value=value):
                self.artifacts = _baseline_artifacts()
                self._write_all()
                payload = copy.deepcopy(self.artifacts["no-ledger-effect.json"])
                item = payload["databases"][0]
                item[f"before{prefix}"] = value
                item[f"after{prefix}"] = value
                self._rewrite_payload("no-ledger-effect.json", payload)
                self._assert_invalid()

    def test_no_ledger_rejects_each_changed_pair(self) -> None:
        for field, value in (
            ("afterHash", "e" * 64),
            ("afterMoveCount", 1),
            ("afterLineCount", 1),
            ("afterBalanceHash", "e" * 64),
        ):
            with self.subTest(field=field):
                self.artifacts = _baseline_artifacts()
                self._write_all()
                payload = copy.deepcopy(self.artifacts["no-ledger-effect.json"])
                payload["databases"][0][field] = value
                self._rewrite_payload("no-ledger-effect.json", payload)
                self._assert_invalid()

    def test_story_one_response_only_capture_fails(self) -> None:
        payload = copy.deepcopy(self.artifacts["story-1-state.json"])
        payload["captureSource"] = "http-responses"
        self._rewrite_payload("story-1-state.json", payload)
        self._assert_invalid()

    def test_story_one_requires_both_persisted_tenant_databases(self) -> None:
        payload = copy.deepcopy(self.artifacts["story-1-state.json"])
        payload["databases"] = payload["databases"][:1]
        self._rewrite_payload("story-1-state.json", payload)
        self._assert_invalid()

    def test_story_one_requires_en_ltr_and_ar_rtl(self) -> None:
        payload = copy.deepcopy(self.artifacts["story-1-state.json"])
        payload["locales"] = ["en-LTR"]
        self._rewrite_payload("story-1-state.json", payload)
        self._assert_invalid()

    def test_story_one_parent_rejection_must_be_exact_and_persisted(self) -> None:
        payload = copy.deepcopy(self.artifacts["story-1-state.json"])
        payload["parentRejection"]["code"] = "ACCOUNT_INVALID"
        self._rewrite_payload("story-1-state.json", payload)
        self._assert_invalid()

    def test_story_one_sequential_race_or_extra_winner_fails(self) -> None:
        for field, value in (("kind", "sequential"), ("winnerCount", 2)):
            with self.subTest(field=field):
                self.artifacts = _baseline_artifacts()
                self._write_all()
                payload = copy.deepcopy(self.artifacts["story-1-state.json"])
                payload["race"][field] = value
                self._rewrite_payload("story-1-state.json", payload)
                self._assert_invalid()

    def test_story_one_foreign_uuid_denial_must_use_persisted_resource(self) -> None:
        payload = copy.deepcopy(self.artifacts["scope-and-authorization.json"])
        payload["tenantBResourceId"] = "not-a-real-uuid"
        self._rewrite_payload("scope-and-authorization.json", payload)
        self._assert_invalid()

    def test_story_one_receipt_and_event_sets_must_match_mutations(self) -> None:
        payload = copy.deepcopy(self.artifacts["audit-and-receipts.json"])
        payload["operationReceiptOperationIds"][-1] = "op-duplicate"
        self._rewrite_payload("audit-and-receipts.json", payload)
        self._assert_invalid()

    def test_story_one_recovery_must_be_bounded_and_exactly_once(self) -> None:
        payload = copy.deepcopy(self.artifacts["failure-injection.json"])
        lost = next(case for case in payload["cases"] if case["name"] == "lost_rpc_response")
        lost["recovery"]["auditedOutcomes"] = 2
        self._rewrite_payload("failure-injection.json", payload)
        self._assert_invalid()

    def test_story_three_rejects_transformed_or_missing_exact_money(self) -> None:
        for mutation in ("transformed", "missing"):
            with self.subTest(mutation=mutation):
                self.artifacts = _baseline_artifacts()
                self._write_all()
                payload = copy.deepcopy(self.artifacts["story-3-state.json"])
                if mutation == "transformed":
                    payload["exactMetadata"][0]["transactionDebit"] = "10.00"
                else:
                    payload["exactMetadata"][0].pop("baseCurrencyMetadataVersion")
                self._rewrite_payload("story-3-state.json", payload)
                self._assert_invalid()

    def test_story_three_requires_conditional_fx_pair_or_null(self) -> None:
        for line_index, field, value in ((0, "rateReference", None), (1, "rateEffectiveDate", "2026-11-07")):
            with self.subTest(line_index=line_index, field=field):
                self.artifacts = _baseline_artifacts()
                self._write_all()
                payload = copy.deepcopy(self.artifacts["story-3-state.json"])
                payload["exactMetadata"][line_index][field] = value
                self._rewrite_payload("story-3-state.json", payload)
                self._assert_invalid()

    def test_story_three_requires_complete_configuration_snapshots(self) -> None:
        for section in ("accounts", "journal", "currencies"):
            with self.subTest(section=section):
                self.artifacts = _baseline_artifacts()
                self._write_all()
                payload = copy.deepcopy(self.artifacts["story-3-state.json"])
                payload["configurationSnapshot"][section] = {} if section != "journal" else {"id": "", "version": 0}
                self._rewrite_payload("story-3-state.json", payload)
                self._assert_invalid()

    def test_story_three_rejects_sequential_or_incomplete_races(self) -> None:
        mutations = (("journalVersion", "starts", [1, 500]),
                     ("currencyVersion", "statuses", [200, 200]),
                     ("draftSameKey", "operationId", ""),
                     ("validationSameKey", "statuses", [200, 409]))
        for race, field, value in mutations:
            with self.subTest(race=race, field=field):
                self.artifacts = _baseline_artifacts()
                self._write_all()
                payload = copy.deepcopy(self.artifacts["story-3-state.json"])
                payload["races"][race][field] = value
                self._rewrite_payload("story-3-state.json", payload)
                self._assert_invalid()

    def test_story_three_requires_audit_rollback_and_posting_absence(self) -> None:
        for path, value in (("failureInjection.partialMutations", 1),
                            ("postingMethodProbes.forbiddenRouteStatus", 403),
                            ("postingFeatureEnabled", True)):
            with self.subTest(path=path):
                self.artifacts = _baseline_artifacts()
                self._write_all()
                payload = copy.deepcopy(self.artifacts["story-3-state.json"])
                target = payload
                parts = path.split(".")
                for part in parts[:-1]: target = target[part]
                target[parts[-1]] = value
                self._rewrite_payload("story-3-state.json", payload)
                self._assert_invalid()

    def test_native_engine_exposure_categories_fail_closed(self) -> None:
        for field in ("nativeUrls", "nativeModels", "internalIds", "databaseNames", "rpcDetails"):
            with self.subTest(field=field):
                self.artifacts = _baseline_artifacts()
                self._write_all()
                payload = copy.deepcopy(self.artifacts["odoo-exposure-scan.json"])
                payload[field] = 1
                self._rewrite_payload("odoo-exposure-scan.json", payload)
                self._assert_invalid()

    def test_mounted_forbidden_route_fails(self) -> None:
        payload = copy.deepcopy(self.artifacts["api-contract-summary.json"])
        payload["forbiddenRoutes"][0]["status"] = 403
        self._rewrite_payload("api-contract-summary.json", payload)
        self._assert_invalid()

    def test_missing_second_tenant_database_proof_fails(self) -> None:
        payload = copy.deepcopy(self.artifacts["readiness.json"])
        payload["databases"] = payload["databases"][:1]
        self._rewrite_payload("readiness.json", payload)
        self._assert_invalid()

    def test_ledger_change_fails(self) -> None:
        payload = copy.deepcopy(self.artifacts["no-ledger-effect.json"])
        payload["databases"][0]["afterHash"] = "changed"
        self._rewrite_payload("no-ledger-effect.json", payload)
        self._assert_invalid()

    def test_missing_failure_injection_case_fails(self) -> None:
        payload = copy.deepcopy(self.artifacts["failure-injection.json"])
        payload["cases"] = payload["cases"][:-1]
        self._rewrite_payload("failure-injection.json", payload)
        self._assert_invalid()

    def test_cleanup_survivor_fails(self) -> None:
        payload = copy.deepcopy(self.artifacts["cleanup-receipt.json"])
        payload["survivors"]["databases"] = 1
        self._rewrite_payload("cleanup-receipt.json", payload)
        self._assert_invalid()


if __name__ == "__main__":
    unittest.main()
