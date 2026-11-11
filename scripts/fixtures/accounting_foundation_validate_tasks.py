#!/usr/bin/env python3
"""Deterministic task-DAG, safe-scope, and traceability validator."""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

TASK_RE = re.compile(
    r"^- \[(?P<done>[ x])\] (?P<id>T\d{3})(?P<parallel> \[P\])?(?: \[(?P<story>US\d)\])? "
    r"(?P<description>.+?) — Deps: (?P<deps>.+?); AC: (?P<ac>.+)$"
)
TRACE_RE = re.compile(
    r"^\| (?P<clause>(?:FR|SC)-\d{3}) \| \*\*(?P<status>SAFE-PROVEN|PARTIAL-SAFE-ONLY|BLOCKED-POLICY)\*\* "
    r"\| (?P<evidence>.+?) \| (?P<limitation>.+?) \|$"
)
RANGE_RE = re.compile(r"^(T\d{3})[–-](T\d{3})$")
ALLOWED_PARALLEL = {"T003", "T004", "T005", "T065", "T066", "T100", "T101"}
STATUS_COUNTS = {"SAFE-PROVEN": 22, "PARTIAL-SAFE-ONLY": 20, "BLOCKED-POLICY": 23}
POLICY_BLOCKED = {
    *(f"FR-{number:03d}" for number in [15, 21, 22, 23, 24, 25, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 40, 43, 44]),
    *(f"SC-{number:03d}" for number in [2, 3, 5, 6]),
}


class ValidationError(RuntimeError):
    pass


@dataclass(frozen=True)
class Task:
    id: str
    number: int
    parallel: bool
    story: str | None
    description: str
    dependency_text: str
    dependencies: frozenset[str]
    acceptance: str


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationError(message)


def expand_dependencies(text: str) -> frozenset[str]:
    if text == "none" or text.startswith("external "):
        return frozenset()
    expanded: set[str] = set()
    for raw in (part.strip() for part in text.split(",")):
        match = RANGE_RE.fullmatch(raw)
        if match:
            start, end = (int(value[1:]) for value in match.groups())
            require(start <= end, f"reversed dependency range: {raw}")
            expanded.update(f"T{number:03d}" for number in range(start, end + 1))
        else:
            require(re.fullmatch(r"T\d{3}", raw) is not None, f"malformed dependency: {raw}")
            expanded.add(raw)
    return frozenset(expanded)


def parse_tasks(text: str) -> dict[str, Task]:
    tasks: dict[str, Task] = {}
    for line in text.splitlines():
        if not line.startswith("- [") or not re.match(r"^- \[[ x]\] T\d{3}", line):
            continue
        match = TASK_RE.fullmatch(line)
        require(match is not None, f"malformed task syntax: {line[:100]}")
        groups = match.groupdict()
        task_id = groups["id"]
        require(task_id not in tasks, f"duplicate task id: {task_id}")
        tasks[task_id] = Task(
            id=task_id,
            number=int(task_id[1:]),
            parallel=groups["parallel"] is not None,
            story=groups["story"],
            description=groups["description"],
            dependency_text=groups["deps"],
            dependencies=expand_dependencies(groups["deps"]),
            acceptance=groups["ac"],
        )
    expected = [f"T{number:03d}" for number in range(1, 159)]
    require(list(tasks) == expected, "task IDs must be exact, unique, and sequential T001-T158")
    return tasks


def validate_dependencies(tasks: dict[str, Task]) -> None:
    for task in tasks.values():
        for dependency in task.dependencies:
            require(dependency in tasks, f"{task.id} has missing dependency {dependency}")
            require(tasks[dependency].number < task.number, f"{task.id} has nonpreceding dependency {dependency}")
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(task_id: str) -> None:
        require(task_id not in visiting, f"dependency cycle detected at {task_id}")
        if task_id in visited:
            return
        visiting.add(task_id)
        for dependency in tasks[task_id].dependencies:
            visit(dependency)
        visiting.remove(task_id)
        visited.add(task_id)

    for task_id in tasks:
        visit(task_id)


def ancestors(tasks: dict[str, Task], task_id: str) -> set[str]:
    result: set[str] = set()
    pending = list(tasks[task_id].dependencies)
    while pending:
        dependency = pending.pop()
        if dependency in result:
            continue
        result.add(dependency)
        pending.extend(tasks[dependency].dependencies)
    return result


def validate_barriers_and_install_order(tasks: dict[str, Task]) -> None:
    barriers = {
        "T031": {f"T{number:03d}" for number in range(18, 31)},
        "T080": {f"T{number:03d}" for number in range(72, 80)},
        "T115": {f"T{number:03d}" for number in range(106, 115)},
    }
    for task_id, required in barriers.items():
        require(required <= tasks[task_id].dependencies, f"{task_id} starts implementation before every story test")

    direct_requirements = {
        "T045": {"T037", "T044"},
        "T046": {"T044", "T045"},
        "T088": {"T045", "T087"},
        "T089": {"T046", "T087", "T088"},
        "T120": {"T088", "T119"},
        "T121": {"T089", "T119", "T120"},
    }
    for task_id, required in direct_requirements.items():
        require(required <= tasks[task_id].dependencies, f"{task_id} installs or calls models before complete imports/access")

    acceptance_requirements = {
        "T071": {"T044", "T045", "T046"},
        "T105": {"T086", "T087", "T088", "T089"},
        "T142": {"T119", "T120", "T121"},
    }
    for task_id, required in acceptance_requirements.items():
        missing = required - ancestors(tasks, task_id)
        require(not missing, f"{task_id} acceptance lacks final addon install/upgrade ancestry: {sorted(missing)}")

    import_completion = {
        "T031": "imports no future model module",
        "T044": "every imported target and every manifest data target exists",
        "T080": "imports target only files existing by T080",
        "T086": "every Python/data target exists",
        "T119": "every imported/data target exists",
    }
    for task_id, required_text in import_completion.items():
        body = f"{tasks[task_id].description} {tasks[task_id].acceptance}"
        require(required_text.lower() in body.lower(), f"{task_id} does not prove import/data targets exist before use")
    require("imports future" not in "\n".join(task.description + task.acceptance for task in tasks.values()).lower(), "future import/data target referenced before creation")


def validate_scope_and_paths(tasks: dict[str, Task]) -> None:
    parallel = {task.id for task in tasks.values() if task.parallel}
    require(parallel == ALLOWED_PARALLEL, f"unsafe [P] set: {sorted(parallel)}")
    for number in range(151, 159):
        task = tasks[f"T{number:03d}"]
        require(task.story in {"US4", "US5", "US6", "US7"}, f"{task.id} blocked story marker missing")
        require("BLOCKED GATE" in task.description, f"{task.id} is executable while policy is pending")
        require(re.search(r"\bImplement\b", task.description, re.I) is None, f"{task.id} contains forbidden implementation")
    for number in range(143, 151):
        task = tasks[f"T{number:03d}"]
        require(task.description.startswith("Run "), f"post-acceptance task {task.id} introduces implementation")
    all_body = "\n".join(task.description for task in tasks.values())
    require(re.search(r"\bImplement (?:posting|reversal|opening|period)\b", all_body, re.I) is None, "forbidden posting-family implementation exists")
    for task in tasks.values():
        for token in re.findall(r"`([^`]+)`", f"{task.description} {task.acceptance}"):
            require(not token.startswith(("/tmp/", "/home/", "/opt/", "/root/")), f"{task.id} contains an absolute implementation path")
            require("../" not in token and "\\" not in token, f"{task.id} contains malformed path syntax")


def parse_traceability(text: str) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for line in text.splitlines():
        match = TRACE_RE.fullmatch(line)
        if match:
            rows.append(match.groupdict())
    expected = [*(f"FR-{number:03d}" for number in range(1, 51)), *(f"SC-{number:03d}" for number in range(1, 16))]
    clauses = [row["clause"] for row in rows]
    require(clauses == expected, "traceability must contain every FR-001..050 and SC-001..015 exactly once in order")
    counts = {status: sum(row["status"] == status for row in rows) for status in STATUS_COUNTS}
    require(counts == STATUS_COUNTS, f"traceability status counts are dishonest: {counts}")
    by_clause = {row["clause"]: row for row in rows}
    stale_policy_claims = (
        "matrix is pending Finance Owner approval",
        "No Owner-approved applicable matrix exists",
        "All seven locked category values remain an external owner gate",
        "because both are pending",
    )
    for claim in stale_policy_claims:
        require(claim not in text, f"traceability retains stale approved-policy claim: {claim}")
    for clause in POLICY_BLOCKED:
        require(by_clause[clause]["status"] == "BLOCKED-POLICY", f"{clause} cannot be green before policy-dependent runtime acceptance")
    for row in rows:
        require(row["evidence"].strip() and row["limitation"].strip(), f"{row['clause']} lacks evidence/limitation")
        if row["status"] != "SAFE-PROVEN":
            require("fully accepted" not in row["limitation"].lower(), f"{row['clause']} falsely upgrades a non-green status")
    return rows


def validate(text: str) -> tuple[dict[str, Task], list[dict[str, str]]]:
    tasks = parse_tasks(text)
    validate_dependencies(tasks)
    validate_barriers_and_install_order(tasks)
    validate_scope_and_paths(tasks)
    rows = parse_traceability(text)
    return tasks, rows


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("tasks")
    parser.add_argument("--traceability-report")
    args = parser.parse_args(argv)
    try:
        text = Path(args.tasks).read_text(encoding="utf-8")
        tasks, rows = validate(text)
        if args.traceability_report:
            target = Path(args.traceability_report)
            target.parent.mkdir(parents=True, exist_ok=True)
            payload = {
                "schemaVersion": 1,
                "taskCount": len(tasks),
                "clauses": rows,
                "counts": STATUS_COUNTS,
            }
            target.write_text(json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
    except (OSError, ValidationError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1
    print(f"PASS: task graph={len(tasks)} traceability={len(rows)} safe-scope and addon ancestry verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
