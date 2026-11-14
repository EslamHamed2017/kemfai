#!/usr/bin/env python3
"""Read-only verifier for the required Accounting Foundation merge check."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from typing import Any
from urllib.parse import quote

REQUIRED_CHECK = "accounting-foundation-owned-live"
READ_EVENTS = {"pull_request", "pull_request_target", "merge_group"}


def fail(message: str) -> int:
    print(f"FAIL: {message}", file=sys.stderr)
    return 1


def required_contexts(payload: Any) -> set[str]:
    if not isinstance(payload, dict):
        return set()
    contexts = {value for value in payload.get("contexts", []) if isinstance(value, str)}
    for check in payload.get("checks", []):
        if isinstance(check, dict) and isinstance(check.get("context"), str):
            contexts.add(check["context"])
    return contexts


def main() -> int:
    event = os.environ.get("GITHUB_EVENT_NAME", "")
    if event not in READ_EVENTS:
        print(f"PASS: branch-protection lookup is not required for event {event or 'local'}")
        return 0
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    branch = os.environ.get("GITHUB_BASE_REF") or os.environ.get("KEMFAI_BRANCH_PROTECTION_BRANCH", "")
    if re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository) is None:
        return fail("GITHUB_REPOSITORY is absent or malformed")
    if re.fullmatch(r"[A-Za-z0-9._/-]+", branch) is None or ".." in branch:
        return fail("target branch is absent or malformed")
    endpoint = f"https://api.github.com/repos/{repository}/branches/{quote(branch, safe='')}"
    result = subprocess.run(
        [
            "curl",
            "--disable",
            "--fail",
            "--silent",
            "--show-error",
            "--proto",
            "=https",
            "--tlsv1.2",
            "-H",
            "Accept: application/vnd.github+json",
            "-H",
            "User-Agent: kemfai-branch-protection-verifier",
            endpoint,
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        return fail("required-status lookup failed or branch protection is absent")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError:
        return fail("required-status lookup returned invalid JSON")
    if not isinstance(payload, dict):
        return fail("required-status lookup returned malformed branch metadata")
    protection = payload.get("protection")
    if (
        payload.get("protected") is not True
        or not isinstance(protection, dict)
        or protection.get("enabled") is not True
    ):
        return fail("target branch is not protected")
    contexts = required_contexts(protection.get("required_status_checks"))
    if REQUIRED_CHECK not in contexts:
        return fail(f"{REQUIRED_CHECK} is not configured as a required status check")
    print(f"PASS: {REQUIRED_CHECK} is required on {repository}:{branch} (read-only)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
