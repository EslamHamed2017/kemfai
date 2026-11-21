#!/usr/bin/env python3
"""Fail-closed independent validator for Accounting Foundation live evidence."""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

REQUIRED_FAILURES = {
    "role_scope_denial",
    "stale_if_match",
    "idempotency_conflict",
    "lost_rpc_response",
    "platform_audit_unavailable",
    "tenant_audit_write_failure",
    "browser_double_submit",
    "policy_pending",
}
STORY_TWO_REQUIRED_FILES = {
    "story-2-state.json",
    "secret-scan.json",
    "cleanup-receipt.json",
}
STORY_THREE_REQUIRED_FILES = {
    "story-3-state.json",
    "no-ledger-effect.json",
    "secret-scan.json",
    "cleanup-receipt.json",
}
STORY_ONE_REQUIRED_FILES = {
    "story-1-state.json",
    "no-ledger-effect.json",
    "scope-and-authorization.json",
    "audit-and-receipts.json",
    "secret-scan.json",
    "cleanup-receipt.json",
}
REQUIRED_FILES = {
    "fixture-registry.json",
    "readiness.json",
    "playwright.json",
    "playwright-summary.json",
    "api-contract-summary.json",
    "story-1-state.json",
    "story-2-state.json",
    "story-3-state.json",
    "no-ledger-effect.json",
    "scope-and-authorization.json",
    "audit-and-receipts.json",
    "failure-injection.json",
    "odoo-exposure-scan.json",
    "secret-scan.json",
    "cleanup-receipt.json",
}
UUID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.IGNORECASE)
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$", re.IGNORECASE)
FORBIDDEN_PATHS = {
    "/v1/accounting/drafts/{id}/post",
    "/v1/accounting/entries/{id}/reverse",
    "/v1/accounting/opening-batches/{id}/post",
    "/v1/accounting/periods/{id}/transitions",
}


class EvidenceError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise EvidenceError(message)


def load_json(path: Path) -> Any:
    require(path.is_file(), f"missing required evidence: {path.name}")
    require(path.stat().st_size > 0, f"empty required evidence: {path.name}")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise EvidenceError(f"invalid JSON evidence {path.name}: {error}") from error


def normalize_manifest_entries(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    entries = manifest.get("artifacts")
    if isinstance(entries, dict):
        return entries
    if isinstance(entries, list):
        normalized: dict[str, dict[str, Any]] = {}
        for entry in entries:
            require(isinstance(entry, dict) and isinstance(entry.get("path"), str), "invalid manifest entry")
            normalized[entry["path"]] = entry
        return normalized
    raise EvidenceError("manifest artifacts must be an object or list")


def validate_manifest(
    root: Path, required_files: set[str] = REQUIRED_FILES
) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    manifest = load_json(root / "evidence-manifest.json")
    require(isinstance(manifest, dict), "manifest must be an object")
    require(manifest.get("schemaVersion") == 1, "unsupported evidence manifest schema")
    require(isinstance(manifest.get("runId"), str) and manifest["runId"], "manifest runId is required")
    entries = normalize_manifest_entries(manifest)
    require(entries, "manifest cannot be empty")
    require(required_files <= set(entries), "manifest omits required evidence")
    for name, metadata in entries.items():
        require(name not in {"evidence-manifest.json", ".evidence-manifest.tmp"}, "manifest cannot hash itself")
        relative = Path(name)
        require(not relative.is_absolute() and ".." not in relative.parts, f"unsafe manifest path: {name}")
        path = root / relative
        require(path.is_file() and path.stat().st_size > 0, f"manifested artifact missing or empty: {name}")
        raw = path.read_bytes()
        require(metadata.get("bytes") == len(raw), f"byte count mismatch: {name}")
        require(metadata.get("sha256") == hashlib.sha256(raw).hexdigest(), f"hash mismatch: {name}")
    disk_files = {
        str(path.relative_to(root))
        for path in root.rglob("*")
        if path.is_file() and path.name != "evidence-manifest.json"
    }
    require(disk_files <= set(entries), "unmanifested evidence file present")
    return manifest, entries


def validate_fixture(data: dict[str, Any], run_id: str) -> None:
    require(data.get("runId") == run_id, "fixture runId differs from manifest")
    label = data.get("ownershipLabel")
    require(isinstance(label, str) and label.endswith(f"={run_id}"), "fixture ownership label mismatch")
    tenants = data.get("tenants")
    users = data.get("users")
    require(isinstance(tenants, list) and len(tenants) == 2, "exactly two tenants are required")
    require(isinstance(users, list) and len(users) == 2, "exactly two users are required")
    require({item.get("tenantId") for item in tenants} == {"tenant-a", "tenant-b"}, "tenant identities mismatch")
    require(len({item.get("database") for item in tenants}) == 2, "tenant databases must be distinct")
    require(len({item.get("route") for item in tenants}) == 2, "tenant routes must be distinct")
    companies = {item.get("tenantId"): set(item.get("companies", [])) for item in tenants}
    require(companies == {"tenant-a": {"company-a1", "company-a2"}, "tenant-b": {"company-b1"}}, "company topology mismatch")
    memberships = {item.get("subject"): item.get("tenants") for item in users}
    require(memberships == {"user-a": ["tenant-a"], "user-b": ["tenant-b"]}, "user memberships are not disjoint")


def validate_readiness(data: dict[str, Any]) -> None:
    require(data.get("status") == "passed", "readiness did not pass")
    databases = data.get("databases")
    require(isinstance(databases, list) and len(databases) == 2, "both tenant database proofs are required")
    require({item.get("name") for item in databases} == {"tenant_a_db", "tenant_b_db"}, "readiness database set mismatch")
    require(len({item.get("route") for item in databases}) == 2, "readiness routes must be distinct")
    require(all(item.get("addonsInstalled") is True for item in databases), "addon readiness missing")
    required_addons = {"kemfai_dimensions", "kemfai_accounting"}
    for item in databases:
        addons = item.get("addons")
        require(isinstance(addons, list), f"addon details missing for {item.get('name')}")
        installed = {
            addon.get("name")
            for addon in addons
            if isinstance(addon, dict)
            and addon.get("state") == "installed"
            and nonempty(addon.get("version"))
        }
        require(required_addons <= installed, f"completed Story 2 addons missing in {item.get('name')}")


def validate_browser(root: Path) -> None:
    report = load_json(root / "playwright.json")
    stats = report.get("stats", {})
    require(stats.get("expected", 0) > 0, "zero Playwright tests discovered")
    require(all(stats.get(key) == 0 for key in ("skipped", "unexpected", "flaky")), "Playwright skipped/unexpected/flaky result")
    require(report.get("errors") == [], "Playwright errors present")
    summary = load_json(root / "playwright-summary.json")
    require(summary.get("status") == "passed", "Playwright summary did not pass")
    counts = summary.get("counts", {})
    require(counts.get("expected", 0) > 0, "zero summarized browser tests")
    require(all(counts.get(key) == 0 for key in ("skipped", "unexpected", "flaky", "errors")), "browser summary contains non-green counts")
    stories = summary.get("stories")
    require(isinstance(stories, list), "browser story summary is missing")
    require({item.get("name") for item in stories} == {"story-1", "story-2", "story-3"}, "browser story set mismatch")
    require(all(item.get("status") == "passed" for item in stories), "browser story did not pass")


def validate_stories(root: Path) -> None:
    for number in range(1, 4):
        data = load_json(root / f"story-{number}-state.json")
        require(data.get("story") == f"story-{number}" and data.get("status") == "passed", f"story-{number} state did not pass")
        require(data.get("productionPath") is True, f"story-{number} lacks production-path proof")
        require(data.get("persistedStateVerified") is True, f"story-{number} lacks persisted-state proof")
        require(data.get("emptyLoadingErrorCovered") is True, f"story-{number} state coverage incomplete")
        require(set(data.get("locales", [])) == {"en-LTR", "ar-RTL"}, f"story-{number} locale proof incomplete")
        if number == 3:
            require(data.get("ledgerEffect") == "none", "Story 3 changed the ledger")


def nonempty(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def require_query_id(value: Any, label: str) -> None:
    require(nonempty(value), f"{label} persisted query identity is required")


def validate_story_one(data: dict[str, Any]) -> None:
    require(data.get("captureSource") == "persisted-queries", "Story 1 response-only evidence is forbidden")
    databases = data.get("databases")
    require(isinstance(databases, list) and len(databases) == 2, "Story 1 requires both tenant database proofs")
    topology: dict[str, tuple[str, set[str]]] = {}
    for index, item in enumerate(databases):
        require(isinstance(item, dict), f"Story 1 database proof {index} must be an object")
        name = item.get("name")
        tenant = item.get("tenantId")
        companies = item.get("companyIds")
        require(nonempty(name) and nonempty(tenant), f"Story 1 database proof {index} scope is incomplete")
        require(
            isinstance(companies, list)
            and companies
            and all(nonempty(company) for company in companies)
            and len(companies) == len(set(companies)),
            f"Story 1 database proof {index} companies are invalid",
        )
        require(name not in topology, "Story 1 tenant database names must be distinct")
        topology[name] = (tenant, set(companies))
        require_query_id(item.get("persistedQueryId"), f"Story 1 database proof {index}")
    require(set(topology) == {"tenant_a_db", "tenant_b_db"}, "Story 1 tenant database set mismatch")
    tenant_a, companies_a = topology["tenant_a_db"]
    tenant_b, companies_b = topology["tenant_b_db"]
    require(tenant_a != tenant_b, "Story 1 tenant identities must be distinct")
    require(
        len(companies_a) == 2 and len(companies_b) == 1 and companies_a.isdisjoint(companies_b),
        "Story 1 persisted A1/A2/B1 topology mismatch",
    )

    for key, expected_state in (("account", None), ("draft", "draft")):
        item = data.get(key)
        require(isinstance(item, dict), f"Story 1 persisted {key} is required")
        require(UUID_PATTERN.fullmatch(str(item.get("id", ""))) is not None, f"Story 1 {key} UUID is invalid")
        database = item.get("database")
        company = item.get("companyId")
        require(database in topology and company in topology[database][1], f"Story 1 {key} scope is invalid")
        if expected_state is not None:
            require(item.get("state") == expected_state, "Story 1 evidence must remain draft-only")
        require_query_id(item.get("persistedQueryId"), f"Story 1 {key}")

    rejection = data.get("parentRejection")
    require(isinstance(rejection, dict), "Story 1 parent rejection evidence is required")
    require(rejection.get("code") == "ACCOUNT_NOT_POSTING", "Story 1 exact ACCOUNT_NOT_POSTING evidence is required")
    require(isinstance(rejection.get("lineIndex"), int) and rejection["lineIndex"] >= 0, "Story 1 parent rejection line is invalid")
    require(
        rejection.get("persistedDraftUnchanged") is True and rejection.get("ledgerEffect") == "none",
        "Story 1 parent rejection must preserve the persisted draft and ledger",
    )
    require(
        nonempty(rejection.get("receiptId")) and nonempty(rejection.get("auditEventId")),
        "Story 1 parent rejection receipt and audit event are required",
    )

    race = data.get("race")
    require(isinstance(race, dict), "Story 1 race evidence is required")
    require(race.get("kind") == "simultaneous", "Story 1 sequential-only race evidence is forbidden")
    require(nonempty(race.get("barrierId")) and race.get("participants") == 2, "Story 1 race requires a two-party barrier")
    skew = race.get("maxStartSkewMs")
    require(isinstance(skew, int) and 0 <= skew <= 100, "Story 1 race start skew is unbounded")
    transactions = race.get("transactionIds")
    require(
        isinstance(transactions, list)
        and len(transactions) == 2
        and all(nonempty(transaction) for transaction in transactions)
        and len(set(transactions)) == 2,
        "Story 1 race requires two distinct real transactions",
    )
    require(
        race.get("winnerCount") == 1 and race.get("staleCount") == 1 and race.get("versionDelta") == 1,
        "Story 1 race must persist one winner, one stale result, and one version increment",
    )
    require_query_id(race.get("persistedWinnerQueryId"), "Story 1 race winner")


def validate_story_two(data: dict[str, Any]) -> None:
    require(data.get("captureSource") == "persisted-queries", "Story 2 response-only evidence is forbidden")
    normalized = data.get("normalizedDimensions")
    require(isinstance(normalized, dict), "Story 2 normalized dimension evidence is required")

    definitions = normalized.get("definitions")
    require(isinstance(definitions, list) and len(definitions) == 2, "Story 2 requires Project and Cost Center definitions")
    definition_ids: set[str] = set()
    definition_keys: set[str] = set()
    for index, item in enumerate(definitions):
        require(isinstance(item, dict), f"Story 2 definition {index} must be an object")
        public_id = item.get("id")
        require(isinstance(public_id, str) and UUID_PATTERN.fullmatch(public_id) is not None, f"Story 2 definition {index} UUID is invalid")
        require(public_id not in definition_ids, "Story 2 definition UUIDs must be distinct")
        definition_ids.add(public_id)
        definition_keys.add(str(item.get("key", "")))
        require_query_id(item.get("persistedQueryId"), f"Story 2 definition {index}")
    require(definition_keys == {"project", "cost_center"}, "Story 2 definition keys were transformed")

    values = normalized.get("values")
    require(isinstance(values, list) and len(values) == 2, "Story 2 requires two normalized values")
    value_by_id: dict[str, str] = {}
    for index, item in enumerate(values):
        require(isinstance(item, dict), f"Story 2 value {index} must be an object")
        public_id, definition_id = item.get("id"), item.get("definitionId")
        require(isinstance(public_id, str) and UUID_PATTERN.fullmatch(public_id) is not None, f"Story 2 value {index} UUID is invalid")
        require(public_id not in value_by_id, "Story 2 value UUIDs must be distinct")
        require(definition_id in definition_ids, f"Story 2 value {index} definition was transformed")
        value_by_id[public_id] = definition_id
        require_query_id(item.get("persistedQueryId"), f"Story 2 value {index}")
    require(set(value_by_id.values()) == definition_ids, "Story 2 values do not cover both definitions")

    assignments = normalized.get("assignments")
    require(isinstance(assignments, list) and len(assignments) == 2, "Story 2 requires two persisted assignments")
    assignment_pairs: set[tuple[str, str]] = set()
    for index, item in enumerate(assignments):
        require(isinstance(item, dict), f"Story 2 assignment {index} must be an object")
        definition_id, value_id = item.get("definitionId"), item.get("valueId")
        require(value_by_id.get(str(value_id)) == definition_id, f"Story 2 assignment {index} identifiers were transformed")
        assignment_pairs.add((str(definition_id), str(value_id)))
        require_query_id(item.get("persistedQueryId"), f"Story 2 assignment {index}")
    require(assignment_pairs == {(definition_id, value_id) for value_id, definition_id in value_by_id.items()}, "Story 2 assignments do not exactly match persisted values")

    rules = data.get("resolvedRuleVersions")
    require(isinstance(rules, list) and rules, "Story 2 resolved rule versions are required")
    rule_ids: set[str] = set()
    for index, item in enumerate(rules):
        require(isinstance(item, dict), f"Story 2 rule {index} must be an object")
        rule_id, version = item.get("ruleId"), item.get("version")
        require(isinstance(rule_id, str) and UUID_PATTERN.fullmatch(rule_id) is not None, f"Story 2 rule {index} UUID is invalid")
        require(rule_id not in rule_ids and isinstance(version, int) and not isinstance(version, bool) and version > 0, f"Story 2 rule {index} version is invalid")
        rule_ids.add(rule_id)
        require_query_id(item.get("persistedQueryId"), f"Story 2 rule {index}")

    races = data.get("races")
    require(isinstance(races, dict), "Story 2 race evidence is required")
    same_key = races.get("sameKey")
    require(isinstance(same_key, dict) and same_key.get("kind") == "simultaneous", "Story 2 same-key sequential-only race is forbidden")
    require(same_key.get("participants") == 2 and same_key.get("winnerCount") == 1 and same_key.get("replayCount") == 1, "Story 2 same-key race cardinality is invalid")
    skew = same_key.get("maxStartSkewMs")
    require(isinstance(skew, int) and not isinstance(skew, bool) and 0 <= skew <= 100, "Story 2 same-key race start skew is invalid")
    operation_id = same_key.get("operationId")
    require(isinstance(operation_id, str) and UUID_PATTERN.fullmatch(operation_id) is not None, "Story 2 same-key operation UUID is invalid")
    require_query_id(same_key.get("persistedHandoffQueryId"), "Story 2 same-key race")

    stale = races.get("staleRule")
    require(isinstance(stale, dict) and stale.get("kind") == "simultaneous", "Story 2 stale-rule sequential-only race is forbidden")
    transactions = stale.get("transactionIds")
    require(stale.get("participants") == 2 and stale.get("winnerCount") == 1 and stale.get("staleCount") == 1, "Story 2 stale-rule race cardinality is invalid")
    require(isinstance(transactions, list) and len(transactions) == 2 and all(nonempty(item) for item in transactions) and len(set(transactions)) == 2, "Story 2 stale-rule race requires two real transactions")
    require_query_id(stale.get("persistedWinnerQueryId"), "Story 2 stale-rule race")

    isolation = data.get("isolation")
    require(isinstance(isolation, dict), "Story 2 isolation evidence is required")
    for field in ("companyA2ResourceId", "tenantBResourceId"):
        value = isolation.get(field)
        require(isinstance(value, str) and UUID_PATTERN.fullmatch(value) is not None, f"Story 2 {field} is invalid")
    require(isolation.get("opaqueStatuses") == [404, 404], "Story 2 cross-scope denials are not opaque")
    for field in ("persistedResourceQueryIds", "denialAuditQueryIds"):
        queries = isolation.get(field)
        require(isinstance(queries, list) and len(queries) == 2 and all(nonempty(item) for item in queries), f"Story 2 {field} is incomplete")

    audit = data.get("audit")
    require(isinstance(audit, dict), "Story 2 tenant audit evidence is required")
    targets = audit.get("targetIds")
    events = audit.get("events")
    require(isinstance(targets, dict) and set(targets) == {"tenantA", "tenantB"}, "Story 2 audit target scopes are invalid")
    require(isinstance(events, list) and events, "Story 2 persisted audit events are required")
    event_targets = {(item.get("database"), item.get("targetId")) for item in events if isinstance(item, dict)}
    require(all(("tenant_a_db", target) in event_targets for target in targets["tenantA"]), "Story 2 Tenant A audit targets are incomplete")
    require(all(("tenant_b_db", target) in event_targets for target in targets["tenantB"]), "Story 2 Tenant B audit targets are incomplete")
    audit_queries = audit.get("persistedQueryIds")
    require(isinstance(audit_queries, list) and len(audit_queries) == 2 and all(nonempty(item) for item in audit_queries), "Story 2 audit query identities are incomplete")

    account_count = data.get("accountCount")
    require(isinstance(account_count, dict), "Story 2 account-count evidence is required")
    before, after = account_count.get("before"), account_count.get("after")
    require(isinstance(before, int) and not isinstance(before, bool) and before == after, "Story 2 dimension analysis changed the account count")
    require_query_id(account_count.get("persistedQueryId"), "Story 2 account count")

    no_ledger = data.get("noLedger")
    require(isinstance(no_ledger, dict), "Story 2 no-ledger evidence is required")
    require(no_ledger.get("ledgerEffect") == "none" and no_ledger.get("actionPostInvocations") == 0, "Story 2 changed or invoked the ledger")
    require_query_id(no_ledger.get("persistedQueryId"), "Story 2 no-ledger proof")


def validate_story_three(data: dict[str, Any]) -> None:
    require(data.get("captureSource") == "browser-and-persisted-queries", "Story 3 response-only evidence is forbidden")
    draft_id = data.get("draftId")
    require(isinstance(draft_id, str) and UUID_PATTERN.fullmatch(draft_id) is not None, "Story 3 persisted draft UUID is required")
    elapsed = data.get("elapsedMilliseconds")
    require(isinstance(elapsed, int) and not isinstance(elapsed, bool) and 0 < elapsed <= 180_000, "Story 3 five-line flow exceeded three minutes")

    amounts = data.get("exactAmounts")
    metadata = data.get("exactMetadata")
    require(isinstance(amounts, list) and len(amounts) == 5, "Story 3 requires five exact amount tuples")
    require(isinstance(metadata, list) and len(metadata) == 5, "Story 3 requires five exact metadata snapshots")
    amount_fields = ("transactionDebit", "transactionCredit", "baseDebit", "baseCredit")
    metadata_fields = (
        "transactionCurrencyCode", "transactionPrecision", "transactionCurrencyMetadataVersion",
        "companyBaseCurrencyCode", "basePrecision", "baseCurrencyMetadataVersion",
        "currencyConfigurationVersion", "rateReference", "rateEffectiveDate",
    )
    decimal_lexeme = re.compile(r"^(?:0|[1-9][0-9]*)\.[0-9]+$")
    currency_codes: set[str] = set()
    for index, (amount, line) in enumerate(zip(amounts, metadata)):
        require(isinstance(amount, dict) and isinstance(line, dict), f"Story 3 line {index} evidence must be objects")
        for field in amount_fields:
            lexeme = amount.get(field)
            require(isinstance(lexeme, str) and decimal_lexeme.fullmatch(lexeme) is not None, f"Story 3 line {index} {field} is not an exact decimal lexeme")
            require(line.get(field) == lexeme, f"Story 3 line {index} {field} was transformed")
        require(all(field in line for field in metadata_fields), f"Story 3 line {index} metadata snapshot is incomplete")
        transaction_code = line.get("transactionCurrencyCode")
        base_code = line.get("companyBaseCurrencyCode")
        require(nonempty(transaction_code) and nonempty(base_code), f"Story 3 line {index} currency codes are incomplete")
        require(isinstance(line.get("transactionPrecision"), int) and line["transactionPrecision"] >= 0, f"Story 3 line {index} transaction precision is invalid")
        require(isinstance(line.get("basePrecision"), int) and line["basePrecision"] >= 0, f"Story 3 line {index} base precision is invalid")
        require(nonempty(str(line.get("transactionCurrencyMetadataVersion", ""))), f"Story 3 line {index} transaction metadata version is missing")
        require(nonempty(str(line.get("baseCurrencyMetadataVersion", ""))), f"Story 3 line {index} base metadata version is missing")
        require(isinstance(line.get("currencyConfigurationVersion"), int) and line["currencyConfigurationVersion"] > 0, f"Story 3 line {index} currency configuration version is invalid")
        currency_codes.add(transaction_code)
        foreign = transaction_code != base_code
        require((nonempty(line.get("rateReference")) and nonempty(line.get("rateEffectiveDate"))) if foreign else (line.get("rateReference") is None and line.get("rateEffectiveDate") is None), f"Story 3 line {index} FX provenance must be paired for foreign currency and null for base currency")
    require(any(len(amount[field].split(".", 1)[1]) > metadata[index]["transactionPrecision"] for index, amount in enumerate(amounts) for field in ("transactionDebit", "transactionCredit")), "Story 3 lacks preserved excess-scale evidence")

    snapshot = data.get("configurationSnapshot")
    require(isinstance(snapshot, dict), "Story 3 configuration snapshot is required")
    accounts = snapshot.get("accounts")
    require(isinstance(accounts, dict) and accounts and all(nonempty(key) and isinstance(version, int) and version > 0 for key, version in accounts.items()), "Story 3 account snapshots are incomplete")
    journal = snapshot.get("journal")
    require(isinstance(journal, dict) and nonempty(journal.get("id")) and isinstance(journal.get("version"), int) and journal["version"] > 0, "Story 3 journal snapshot is incomplete")
    currencies = snapshot.get("currencies")
    require(isinstance(currencies, dict) and currency_codes <= set(currencies), "Story 3 currency snapshots are incomplete")
    for code in currency_codes:
        item = currencies[code]
        require(isinstance(item, dict) and item.get("currencyCode") == code, f"Story 3 {code} snapshot code mismatch")
        require(isinstance(item.get("configurationVersion"), int) and item["configurationVersion"] > 0, f"Story 3 {code} configuration snapshot version is invalid")
        require(nonempty(str(item.get("nativeMetadataVersion", ""))), f"Story 3 {code} native metadata snapshot is missing")
        require(isinstance(item.get("nativeDecimalPlaces"), int) and item["nativeDecimalPlaces"] >= 0, f"Story 3 {code} precision snapshot is invalid")

    races = data.get("races")
    require(isinstance(races, dict), "Story 3 race evidence is required")
    for name in ("journalVersion", "currencyVersion"):
        race = races.get(name)
        require(isinstance(race, dict) and sorted(race.get("statuses", [])) == [200, 412], f"Story 3 {name} race cardinality is invalid")
        starts = race.get("starts")
        require(isinstance(starts, list) and len(starts) == 2 and all(isinstance(value, int) for value in starts) and max(starts) - min(starts) <= 100, f"Story 3 {name} sequential-only race is forbidden")
    for name, statuses in (("draftSameKey", [201, 201]), ("validationSameKey", [200, 200])):
        race = races.get(name)
        require(isinstance(race, dict) and race.get("statuses") == statuses, f"Story 3 {name} replay cardinality is invalid")
        for field in ("operationId", "auditEventId"):
            value = race.get(field)
            require(isinstance(value, str) and UUID_PATTERN.fullmatch(value) is not None, f"Story 3 {name} {field} is invalid")

    require(data.get("postingFeatureEnabled") is False, "Story 3 posting feature is enabled")
    probes = data.get("postingMethodProbes")
    require(isinstance(probes, dict) and probes.get("forbiddenRouteStatus") == 404 and probes.get("actionPostInvocations") == 0, "Story 3 posting route or method is reachable")
    failure = data.get("failureInjection")
    require(isinstance(failure, dict) and failure.get("mode") == "tenant-audit-create-failure" and failure.get("status") == 503 and failure.get("partialMutations") == 0, "Story 3 tenant-audit rollback evidence is incomplete")


def validate_native_exposure(data: dict[str, Any]) -> None:
    require(data.get("status") == "passed" and data.get("rawOdooExposures") == 0, "native Odoo exposure detected")
    require(set(data.get("scanTargets", [])) == {"browser-responses", "browser-links", "api-responses", "publishable-logs"}, "native-engine exposure scan targets are incomplete")
    for field in ("nativeUrls", "nativeModels", "internalIds", "databaseNames", "rpcDetails"):
        require(data.get(field) == 0, f"native-engine exposure detected: {field}")


def validate_scope(data: dict[str, Any]) -> None:
    require(data.get("status") == "passed", "scope evidence did not pass")
    foreign_id = data.get("tenantBResourceId")
    require(isinstance(foreign_id, str) and UUID_PATTERN.fullmatch(foreign_id) is not None, "real Tenant-B resource UUID is required")
    require(data.get("tenantBResourceFetchedByUserB") is True, "User B did not first fetch the foreign resource")
    require_query_id(data.get("userBFetchPersistedQueryId"), "User B foreign resource")
    require(
        data.get("sameResourceAttemptedByUserA") is True
        and data.get("sameResourceOpaquelyDeniedToUserA") is True,
        "the exact foreign resource was not opaquely denied to User A",
    )
    require(data.get("ordinaryAuthenticatedPath") is True, "cross-tenant denial did not use the ordinary authenticated path")
    require(data.get("foreignFieldsDisclosed") is False, "cross-tenant denial disclosed foreign fields")
    require_query_id(data.get("denialAuditQueryId"), "cross-tenant denial audit")


def validate_routes(data: dict[str, Any]) -> None:
    require(data.get("status") == "passed", "API contract summary did not pass")
    routes = data.get("forbiddenRoutes")
    require(isinstance(routes, list), "forbidden route evidence missing")
    require({item.get("path") for item in routes} == FORBIDDEN_PATHS, "forbidden route set mismatch")
    require(all(item.get("method") == "POST" and item.get("status") == 404 for item in routes), "forbidden route is mounted")


def validate_no_ledger(data: dict[str, Any]) -> None:
    require(data.get("status") == "passed", "no-ledger proof did not pass")
    require(data.get("actionPostInvocations") == 0, "posting method was invoked")
    require(data.get("postingFeatureEnabled") is False, "posting feature is enabled")
    databases = data.get("databases")
    require(isinstance(databases, list) and len(databases) == 2, "both database ledger proofs are required")
    for item in databases:
        require(isinstance(item, dict), "ledger proof must be an object")
        for field in ("beforeHash", "afterHash", "beforeBalanceHash", "afterBalanceHash"):
            require(isinstance(item.get(field), str) and SHA256_PATTERN.fullmatch(item[field]) is not None, f"ledger {field} must be a SHA-256 hash in {item.get('name')}")
        for field in ("beforeMoveCount", "afterMoveCount", "beforeLineCount", "afterLineCount"):
            require(type(item.get(field)) is int and item[field] >= 0, f"ledger {field} must be a non-negative integer in {item.get('name')}")
        require(item["beforeHash"] == item["afterHash"], f"ledger hash changed in {item.get('name')}")
        for prefix in ("MoveCount", "LineCount", "BalanceHash"):
            require(item[f"before{prefix}"] == item[f"after{prefix}"], f"ledger {prefix} changed in {item.get('name')}")


def validate_audit(data: dict[str, Any]) -> None:
    require(data.get("status") == "passed", "audit evidence did not pass")
    accepted_ids = data.get("acceptedMutationIds")
    require(
        isinstance(accepted_ids, list)
        and accepted_ids
        and all(nonempty(operation_id) for operation_id in accepted_ids)
        and len(accepted_ids) == len(set(accepted_ids)),
        "unique accepted mutation identities are required",
    )
    accepted_set = set(accepted_ids)
    for field in ("tenantAuditOperationIds", "operationReceiptOperationIds", "platformMirrorOperationIds"):
        operation_ids = data.get(field)
        require(
            isinstance(operation_ids, list)
            and len(operation_ids) == len(accepted_set)
            and set(operation_ids) == accepted_set,
            f"{field} must exactly match accepted mutations",
        )
    accepted = data.get("acceptedMutations")
    require(accepted == len(accepted_set), "accepted mutation count is invalid")
    require(data.get("tenantAuditEvents") == accepted, "tenant audit cardinality mismatch")
    require(data.get("operationReceipts") == accepted, "operation receipt cardinality mismatch")
    require(data.get("platformMirrorsComplete") is True and data.get("dedupeStateComplete") is True, "audit mirror/dedupe incomplete")
    queries = data.get("persistedQueryIds")
    require(
        isinstance(queries, list) and len(queries) >= 3 and all(nonempty(query) for query in queries),
        "persisted audit, receipt, and mirror query identities are required",
    )


def validate_failures(data: dict[str, Any]) -> None:
    require(data.get("status") == "passed", "failure injection did not pass")
    cases = data.get("cases")
    require(isinstance(cases, list), "failure injection cases missing")
    require(all(isinstance(item, dict) for item in cases), "failure injection case must be an object")
    require({item.get("name") for item in cases} == REQUIRED_FAILURES, "failure injection matrix incomplete")
    require(len(cases) == len(REQUIRED_FAILURES), "failure injection cases are duplicated")
    require(all(item.get("status") == "passed" for item in cases), "failure injection case did not pass")
    require(all(item.get("partialMutations") == 0 and item.get("duplicateResults") == 0 for item in cases), "failure injection left partial/duplicate results")
    by_name = {item["name"]: item for item in cases}
    for name in ("lost_rpc_response", "platform_audit_unavailable"):
        recovery = by_name[name].get("recovery")
        require(isinstance(recovery, dict), f"{name} recovery evidence is required")
        require(
            recovery.get("bounded") is True
            and recovery.get("finalState") == "audited"
            and recovery.get("auditedOutcomes") == 1
            and recovery.get("operationReceipts") == 1,
            f"{name} recovery must be bounded and exactly once",
        )
    require(
        by_name["tenant_audit_write_failure"].get("domainMutationRolledBack") is True,
        "tenant audit failure must roll back the domain mutation",
    )


def validate_cleanup(data: dict[str, Any]) -> None:
    require(data.get("status") == "passed" and data.get("cleanupComplete") is True, "cleanup did not pass")
    registered = data.get("registeredResources")
    require(isinstance(registered, int) and registered > 0 and data.get("removedResources") == registered, "cleanup resource cardinality mismatch")
    survivors = data.get("survivors")
    require(isinstance(survivors, dict) and survivors and all(value == 0 for value in survivors.values()), "cleanup survivors remain")
    require(data.get("independentCatalogChecks") is True, "independent cleanup catalog checks missing")


def validate_story_cleanup(data: dict[str, Any], run_id: str) -> None:
    require(data.get("runId") == run_id, "story cleanup runId differs from manifest")
    label = data.get("ownershipLabel")
    require(isinstance(label, str) and label.endswith(f"={run_id}"), "story cleanup ownership label mismatch")
    require(data.get("commandStatus") == 0, "story owned-live command did not pass")
    require(data.get("cleanupStatus") == 0, "story cleanup did not pass")
    validate_cleanup(data)


def validate_story_one_run(root: Path) -> None:
    require(root.is_dir(), "evidence path is not a directory")
    manifest, _ = validate_manifest(root, STORY_ONE_REQUIRED_FILES)
    payloads = {name: load_json(root / name) for name in STORY_ONE_REQUIRED_FILES}
    story = payloads["story-1-state.json"]
    require(story.get("story") == "story-1" and story.get("status") == "passed", "story-1 state did not pass")
    require(story.get("productionPath") is True, "story-1 lacks production-path proof")
    require(story.get("persistedStateVerified") is True, "story-1 lacks persisted-state proof")
    require(story.get("emptyLoadingErrorCovered") is True, "story-1 state coverage incomplete")
    require(set(story.get("locales", [])) == {"en-LTR", "ar-RTL"}, "story-1 locale proof incomplete")
    validate_story_one(story)
    validate_scope(payloads["scope-and-authorization.json"])
    validate_no_ledger(payloads["no-ledger-effect.json"])
    validate_audit(payloads["audit-and-receipts.json"])
    secret = payloads["secret-scan.json"]
    require(secret.get("status") == "passed", "secret scan did not pass")
    require(secret.get("secretsFound", len(secret.get("leaks", []))) == 0, "secret leak detected")
    validate_story_cleanup(payloads["cleanup-receipt.json"], manifest["runId"])


def validate_story_two_run(root: Path) -> None:
    require(root.is_dir(), "evidence path is not a directory")
    manifest, _ = validate_manifest(root, STORY_TWO_REQUIRED_FILES)
    payloads = {name: load_json(root / name) for name in STORY_TWO_REQUIRED_FILES}
    story = payloads["story-2-state.json"]
    require(story.get("story") == "story-2" and story.get("status") == "passed", "story-2 state did not pass")
    require(story.get("productionPath") is True, "story-2 lacks production-path proof")
    require(story.get("persistedStateVerified") is True, "story-2 lacks persisted-state proof")
    validate_story_two(story)
    secret = payloads["secret-scan.json"]
    require(secret.get("status") == "passed", "secret scan did not pass")
    require(secret.get("secretsFound", len(secret.get("leaks", []))) == 0, "secret leak detected")
    validate_story_cleanup(payloads["cleanup-receipt.json"], manifest["runId"])


def validate_story_three_run(root: Path) -> None:
    require(root.is_dir(), "evidence path is not a directory")
    manifest, _ = validate_manifest(root, STORY_THREE_REQUIRED_FILES)
    payloads = {name: load_json(root / name) for name in STORY_THREE_REQUIRED_FILES}
    story = payloads["story-3-state.json"]
    require(story.get("story") == "story-3" and story.get("status") == "passed", "story-3 state did not pass")
    require(story.get("productionPath") is True, "story-3 lacks production-path proof")
    require(story.get("persistedStateVerified") is True, "story-3 lacks persisted-state proof")
    validate_story_three(story)
    validate_no_ledger(payloads["no-ledger-effect.json"])
    secret = payloads["secret-scan.json"]
    require(secret.get("status") == "passed", "secret scan did not pass")
    require(secret.get("secretsFound", len(secret.get("leaks", []))) == 0, "secret leak detected")
    validate_story_cleanup(payloads["cleanup-receipt.json"], manifest["runId"])


def validate(root: Path) -> None:
    require(root.is_dir(), "evidence path is not a directory")
    manifest, _ = validate_manifest(root)
    payloads = {name: load_json(root / name) for name in REQUIRED_FILES}
    validate_fixture(payloads["fixture-registry.json"], manifest["runId"])
    validate_readiness(payloads["readiness.json"])
    validate_browser(root)
    validate_stories(root)
    validate_story_one(payloads["story-1-state.json"])
    validate_story_two(payloads["story-2-state.json"])
    validate_story_three(payloads["story-3-state.json"])
    validate_routes(payloads["api-contract-summary.json"])
    validate_no_ledger(payloads["no-ledger-effect.json"])
    validate_scope(payloads["scope-and-authorization.json"])
    validate_audit(payloads["audit-and-receipts.json"])
    validate_failures(payloads["failure-injection.json"])
    validate_native_exposure(payloads["odoo-exposure-scan.json"])
    secret = payloads["secret-scan.json"]
    require(secret.get("status") == "passed", "secret scan did not pass")
    require(secret.get("secretsFound", len(secret.get("leaks", []))) == 0, "secret leak detected")
    validate_cleanup(payloads["cleanup-receipt.json"])


def main(argv: list[str]) -> int:
    mode = argv[1] if len(argv) == 3 else None
    if len(argv) not in {2, 3} or mode not in {None, "--story-1", "--story-2", "--story-3"}:
        print(
            "FAIL: usage: accounting_foundation_validate_evidence.py [--story-1|--story-2|--story-3] EVIDENCE_DIR",
            file=sys.stderr,
        )
        return 2
    try:
        root = Path(argv[-1]).resolve()
        if mode == "--story-1":
            validate_story_one_run(root)
        elif mode == "--story-2":
            validate_story_two_run(root)
        elif mode == "--story-3":
            validate_story_three_run(root)
        else:
            validate(root)
    except (EvidenceError, OSError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1
    if mode == "--story-1":
        print("PASS: Accounting Foundation Story 1 evidence is complete, hashed, independent, and fail-closed")
    elif mode == "--story-2":
        print("PASS: Accounting Foundation Story 2 evidence is complete, hashed, independent, and fail-closed")
    elif mode == "--story-3":
        print("PASS: Accounting Foundation Story 3 evidence is complete, hashed, independent, and fail-closed")
    else:
        print("PASS: Accounting Foundation evidence is complete, hashed, independent, and fail-closed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
