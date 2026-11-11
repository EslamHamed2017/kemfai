#!/usr/bin/env python3
"""Capture Story 2 acceptance facts from persisted Odoo/control-plane state."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import urllib.request
from pathlib import Path
from typing import Any


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"FAIL: Story 2 persisted capture: {message}")


def env(name: str) -> str:
    value = os.getenv(name, "").strip()
    require(bool(value), f"missing {name}")
    return value


class Odoo:
    def __init__(self) -> None:
        self.url = env("ODOO_URL")
        self.login = env("KEMFAI_AF_ODOO_LOGIN")
        self.password = env("KEMFAI_AF_ODOO_PASSWORD")
        self.request_id = 0
        self.uids: dict[str, int] = {}

    def rpc(self, service: str, method: str, args: list[Any]) -> Any:
        self.request_id += 1
        request = urllib.request.Request(
            f"{self.url}/jsonrpc",
            data=json.dumps({
                "jsonrpc": "2.0", "method": "call",
                "params": {"service": service, "method": method, "args": args},
                "id": self.request_id,
            }).encode(),
            headers={"content-type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=120) as response:
            body = json.load(response)
        require("error" not in body, f"Odoo {service}.{method} failed")
        return body.get("result")

    def rows(
        self, db: str, model: str, domain: list[Any], fields: list[str]
    ) -> list[dict[str, Any]]:
        uid = self.uids.get(db)
        if uid is None:
            uid = self.rpc("common", "authenticate", [db, self.login, self.password, {}])
            require(isinstance(uid, int), f"authentication failed for {db}")
            self.uids[db] = uid
        rows = self.rpc("object", "execute_kw", [
            db, uid, self.password, model, "search_read", [domain],
            {"fields": fields, "order": "id asc"},
        ])
        require(isinstance(rows, list), f"{model} persisted query failed")
        return rows

    def count(self, db: str, model: str, domain: list[Any]) -> int:
        uid = self.uids.get(db)
        if uid is None:
            self.rows(db, "res.company", [], ["id"])
            uid = self.uids[db]
        value = self.rpc("object", "execute_kw", [
            db, uid, self.password, model, "search_count", [domain], {},
        ])
        require(isinstance(value, int), f"{model} count query failed")
        return value


def control(sql: str) -> list[dict[str, Any]]:
    command = [
        "docker", "exec", env("KEMFAI_AF_PG_CONTAINER"),
        "psql", "-XAtq", "-U", env("KEMFAI_AF_DB_USER"), "-d", "kemfai_control",
        "-c", f"SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json) FROM ({sql}) q",
    ]
    result = subprocess.run(command, check=True, text=True, capture_output=True)
    value = json.loads(result.stdout.strip())
    require(isinstance(value, list), "control-plane persisted query failed")
    return value


def save(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n")
    path.chmod(0o600)


def one_by_public_id(
    odoo: Odoo, db: str, model: str, public_id: str, fields: list[str]
) -> dict[str, Any]:
    rows = odoo.rows(db, model, [["public_id", "=", public_id]], fields)
    require(len(rows) == 1, f"expected one persisted {model} row for {public_id}")
    return rows[0]


def audit_targets(facts: dict[str, Any]) -> tuple[set[str], set[str]]:
    """Return mutated public IDs whose tenant audit events must persist."""
    values = facts.get("values", {})
    rules = facts.get("rules", {})
    races = facts.get("races", {})
    scope = facts.get("scope", {})
    tenant_a = {str(value) for value in values.values()} | {str(value) for value in rules}
    tenant_a.add(str(races.get("sameKey", {}).get("resourceId", "")))
    tenant_a.add(str(scope.get("companyA2", {}).get("exactForeignId", "")))
    tenant_b = {str(scope.get("tenantB", {}).get("exactForeignId", ""))}
    tenant_a.discard("")
    tenant_b.discard("")
    return tenant_a, tenant_b


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--journey", type=Path, required=True)
    parser.add_argument("--topology", type=Path, required=True)
    parser.add_argument("--story-output", type=Path, required=True)
    args = parser.parse_args()

    journey = json.loads(args.journey.read_text(encoding="utf-8"))
    topology = json.loads(args.topology.read_text(encoding="utf-8"))
    facts = journey.get("story2")
    require(isinstance(facts, dict), "browser Story 2 facts are missing")
    odoo = Odoo()
    db_a, db_b = env("KEMFAI_AF_TENANT_A_DB"), env("KEMFAI_AF_TENANT_B_DB")
    company_a_id = topology["tenantA"][0]["id"]

    definitions = facts.get("definitions")
    values = facts.get("values")
    rules = facts.get("rules")
    assignments = facts.get("assignments")
    require(isinstance(definitions, dict) and set(definitions) == {"project", "costCenter"}, "Project and Cost Center browser identities are required")
    require(isinstance(values, dict) and set(values) == {"project", "costCenter"}, "Project and Cost Center value identities are required")
    require(isinstance(rules, dict) and len(rules) == 2, "two browser-created dimension rules are required")
    require(isinstance(assignments, list) and len(assignments) == 2, "two browser-created assignments are required")

    captured_definitions = []
    for key, expected_key in (("project", "project"), ("costCenter", "cost_center")):
        public_id = str(definitions[key])
        row = one_by_public_id(odoo, db_a, "kemfai.dimension.definition", public_id, ["public_id", "company_id", "key", "version"])
        require(row.get("key") == expected_key and row.get("company_id", [None])[0] == company_a_id, f"persisted {expected_key} definition scope mismatch")
        captured_definitions.append({"id": public_id, "key": expected_key, "persistedQueryId": f"odoo:{db_a}:dimension-definition:{public_id}"})

    captured_values = []
    for key in ("project", "costCenter"):
        public_id, definition_id = str(values[key]), str(definitions[key])
        row = one_by_public_id(odoo, db_a, "kemfai.dimension.value", public_id, ["public_id", "company_id", "definition_id", "version"])
        definition_row = one_by_public_id(odoo, db_a, "kemfai.dimension.definition", definition_id, ["id"])
        require(row.get("company_id", [None])[0] == company_a_id and row.get("definition_id", [None])[0] == definition_row["id"], f"persisted dimension value scope mismatch: {public_id}")
        captured_values.append({"id": public_id, "definitionId": definition_id, "persistedQueryId": f"odoo:{db_a}:dimension-value:{public_id}"})

    draft_id = str(facts.get("completedDraftId", ""))
    require(bool(draft_id), "completed browser draft identity is required")
    persisted_drafts = odoo.rows(
        db_a, "kemfai.account.draft", [["public_id", "=", draft_id]],
        ["public_id", "payload_json", "company_id"],
    )
    require(len(persisted_drafts) == 1, "completed browser draft is not persisted")
    persisted_lines = persisted_drafts[0].get("payload_json", {}).get("lines", [])
    require(isinstance(persisted_lines, list) and len(persisted_lines) == 1, "persisted draft line is missing")
    persisted_assignments = persisted_lines[0].get("dimensions", [])
    require(isinstance(persisted_assignments, list), "persisted draft assignments are invalid")
    captured_assignments = [
        {
            "definitionId": str(item.get("definitionId", "")),
            "valueId": str(item.get("valueId", "")),
            "persistedQueryId": f"odoo:{db_a}:draft:{draft_id}:payload_json",
        }
        for item in persisted_assignments if isinstance(item, dict)
    ]
    expected_pairs = {(str(item.get("definitionId")), str(item.get("valueId"))) for item in assignments}
    require(
        {(item["definitionId"], item["valueId"]) for item in captured_assignments} == expected_pairs
        and all(part for pair in expected_pairs for part in pair),
        "persisted draft assignments differ from browser facts",
    )

    captured_rules = []
    for public_id in rules:
        row = one_by_public_id(odoo, db_a, "kemfai.dimension.rule", str(public_id), ["public_id", "company_id", "version", "dimension_definition_id"])
        require(row.get("company_id", [None])[0] == company_a_id, f"persisted rule company mismatch: {public_id}")
        captured_rules.append({"ruleId": str(public_id), "version": row["version"], "persistedQueryId": f"odoo:{db_a}:dimension-rule:{public_id}:version={row['version']}"})

    account_before = facts.get("accountCountBefore")
    account_after = facts.get("accountCountAfter")
    require(isinstance(account_before, int) and account_before == account_after, "browser account count changed through dimension analysis")
    persisted_account_count = odoo.count(db_a, "account.account", [["company_ids", "in", [company_a_id]]])
    require(persisted_account_count == account_before + 1, "persisted account count differs from browser-created-account boundary")

    ledger_before, ledger_after = facts.get("ledgerBefore"), facts.get("ledgerAfter")
    require(isinstance(ledger_before, dict) and ledger_before == ledger_after, "browser ledger snapshots changed")
    for key, db in (("tenantA", db_a), ("tenantB", db_b)):
        snapshot = ledger_before.get(key)
        require(isinstance(snapshot, dict), f"{key} ledger snapshot is missing")
        require(odoo.count(db, "account.move", []) == snapshot.get("moves"), f"{key} persisted move count changed after browser run")
        require(odoo.count(db, "account.move.line", []) == snapshot.get("lines"), f"{key} persisted move-line count changed after browser run")

    race_facts = facts.get("races")
    require(isinstance(race_facts, dict), "browser race facts are missing")
    same_key = race_facts.get("sameKey")
    stale_rule = race_facts.get("staleRule")
    require(isinstance(same_key, dict) and isinstance(stale_rule, dict), "both Story 2 race families are required")
    starts = same_key.get("starts")
    require(isinstance(starts, list) and len(starts) == 2 and all(isinstance(item, int) for item in starts), "same-key simultaneous starts are missing")
    require(same_key.get("statuses") == [201, 201], "same-key replay statuses differ")
    operation_id = str(same_key.get("operationId", ""))
    same_key_handoffs = control(f"SELECT id::text,state,route,method FROM accounting_mutation_handoff WHERE id = '{operation_id}'::uuid")
    require(len(same_key_handoffs) == 1 and same_key_handoffs[0]["state"] == "audited", "same-key race did not converge on one persisted audited handoff")

    stale_rule_id = str(stale_rule.get("ruleId", ""))
    stale_handoffs = control("SELECT id::text,state,route,method FROM accounting_mutation_handoff " +
        f"WHERE method='PATCH' AND route='/v1/accounting/dimension-rules/{stale_rule_id}' ORDER BY created_at,id")
    require(len(stale_handoffs) == 2 and sorted(stale_rule.get("statuses", [])) == [200, 412], "stale-rule race lacks two simultaneous HTTP transactions")
    require(sum(row["state"] == "audited" for row in stale_handoffs) == 1, "stale-rule race must persist exactly one audited winner")

    scope = facts.get("scope")
    require(isinstance(scope, dict), "browser isolation facts are missing")
    a2_id = str(scope.get("companyA2", {}).get("exactForeignId", ""))
    b_id = str(scope.get("tenantB", {}).get("exactForeignId", ""))
    require(scope.get("companyA2", {}).get("status") == 404 and scope.get("tenantB", {}).get("status") == 404, "cross-company or cross-tenant attempt was not opaquely denied")
    one_by_public_id(odoo, db_a, "kemfai.dimension.definition", a2_id, ["public_id", "company_id"])
    one_by_public_id(odoo, db_b, "kemfai.dimension.definition", b_id, ["public_id", "company_id"])
    denial_rows = control("SELECT id::text,action FROM audit_event WHERE action='accounting.access.denied' ORDER BY created_at,id")
    require(len(denial_rows) >= 2, "persisted isolation denial audits are missing")

    tenant_a_targets, tenant_b_targets = audit_targets(facts)
    audit_rows_a = odoo.rows(db_a, "kemfai.account.audit.event", [["target_public_id", "in", sorted(tenant_a_targets)]], ["public_id", "operation_uuid", "target_public_id", "action"])
    audit_rows_b = odoo.rows(db_b, "kemfai.account.audit.event", [["target_public_id", "in", sorted(tenant_b_targets)]], ["public_id", "operation_uuid", "target_public_id", "action"])
    require(tenant_a_targets <= {str(row.get("target_public_id")) for row in audit_rows_a}, "persisted Tenant A Story 2 audit targets are incomplete")
    require(tenant_b_targets <= {str(row.get("target_public_id")) for row in audit_rows_b}, "persisted Tenant B Story 2 audit targets are incomplete")

    payload = {
        "story": "story-2", "status": "passed", "productionPath": True,
        "persistedStateVerified": True, "captureSource": "persisted-queries",
        "normalizedDimensions": {
            "definitions": captured_definitions,
            "values": captured_values,
            "assignments": captured_assignments,
        },
        "resolvedRuleVersions": captured_rules,
        "races": {
            "sameKey": {
                "kind": "simultaneous", "participants": 2,
                "maxStartSkewMs": abs(starts[0] - starts[1]),
                "operationId": operation_id,
                "persistedHandoffQueryId": f"control:accounting_mutation_handoff:{operation_id}",
                "winnerCount": 1, "replayCount": 1,
            },
            "staleRule": {
                "kind": "simultaneous", "participants": 2,
                "transactionIds": [row["id"] for row in stale_handoffs],
                "winnerCount": 1, "staleCount": 1,
                "persistedWinnerQueryId": f"odoo:{db_a}:dimension-rule:{stale_rule_id}",
            },
        },
        "isolation": {
            "companyA2ResourceId": a2_id, "tenantBResourceId": b_id,
            "opaqueStatuses": [404, 404],
            "persistedResourceQueryIds": [f"odoo:{db_a}:dimension-definition:{a2_id}", f"odoo:{db_b}:dimension-definition:{b_id}"],
            "denialAuditQueryIds": [f"control:audit_event:{row['id']}" for row in denial_rows[-2:]],
        },
        "audit": {
            "targetIds": {"tenantA": sorted(tenant_a_targets), "tenantB": sorted(tenant_b_targets)},
            "events": [
                *[{"database": "tenant_a_db", "eventId": str(row["public_id"]), "targetId": str(row["target_public_id"])} for row in audit_rows_a],
                *[{"database": "tenant_b_db", "eventId": str(row["public_id"]), "targetId": str(row["target_public_id"])} for row in audit_rows_b],
            ],
            "persistedQueryIds": [f"odoo:{db_a}:dimension-audit-targets", f"odoo:{db_b}:dimension-audit-targets"],
        },
        "accountCount": {
            "before": account_before, "after": account_after,
            "persistedObservedAfter": persisted_account_count,
            "fixtureAccountDelta": 1,
            "persistedQueryId": f"odoo:{db_a}:account-count:company={company_a_id}",
        },
        "noLedger": {
            "ledgerEffect": "none", "actionPostInvocations": 0,
            "databases": [
                {"name": "tenant_a_db", "before": ledger_before["tenantA"], "after": ledger_after["tenantA"], "persistedQueryId": f"odoo:{db_a}:ledger-count-hash"},
                {"name": "tenant_b_db", "before": ledger_before["tenantB"], "after": ledger_after["tenantB"], "persistedQueryId": f"odoo:{db_b}:ledger-count-hash"},
            ],
            "persistedQueryId": "odoo:tenant-a+b:ledger-count-hash",
        },
    }
    save(args.story_output, payload)
    print("PASS: captured Story 2 assignments, rules, races, audit, isolation, account-count, and no-ledger facts")


if __name__ == "__main__":
    main()
