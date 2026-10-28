#!/usr/bin/env python3
"""Fail closed unless T109's machine-readable test evidence has no weak outcomes."""

import json
import pathlib
import sys


def fail(message: str) -> None:
    raise SystemExit(f"FAIL: {message}")


if len(sys.argv) != 3 or sys.argv[1] not in {"backend", "browser"}:
    fail("usage: t109_validate_evidence.py backend|browser FILE")

kind = sys.argv[1]
path = pathlib.Path(sys.argv[2])
try:
    payload = json.loads(path.read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError) as error:
    fail(f"cannot read {kind} evidence: {error}")

if kind == "backend":
    for field in ("numFailedTestSuites", "numFailedTests", "numPendingTests", "numRuntimeErrorTestSuites"):
        if payload.get(field) != 0:
            fail(f"backend evidence {field}={payload.get(field)!r}, expected 0")
    if not payload.get("success") or payload.get("numPassedTests", 0) < 112:
        fail("backend evidence is incomplete or unsuccessful")
else:
    if payload.get("fixtureLabel") != (
        "kemfai.phase12.operation=t109-parent-gates-continuation-20261025T153344Z"
    ):
        fail("browser evidence has the wrong fixture label")
    counts = payload.get("counts")
    if not isinstance(counts, dict):
        fail("browser evidence has no counts object")
    for field in ("skipped", "flaky", "unexpected", "errors"):
        if counts.get(field) != 0:
            fail(f"browser evidence {field}={counts.get(field)!r}, expected 0")
    if payload.get("status") != "passed" or counts.get("total", 0) < 163:
        fail("browser evidence is incomplete or unsuccessful")

    observations = payload.get("observations")
    controls = payload.get("controls")
    if not isinstance(observations, list) or not isinstance(controls, list):
        fail("browser evidence omitted actual observations or scanner controls")
    if counts.get("observations") != len(observations) or len(observations) < 100:
        fail("browser observation count is inconsistent or incomplete")
    if counts.get("controls") != len(controls) or len(controls) < 22:
        fail("browser scanner-control evidence is inconsistent or incomplete")
    if any(not isinstance(item, dict) or item.get("detected") is not True for item in controls):
        fail("a browser scanner control did not prove leak detection")

    surfaces = {
        "plans",
        "signup",
        "verify-email",
        "mfa",
        "provisioning",
        "company-wizard",
        "company-settings",
        "billing",
        "modules",
        "checklist",
        "support-access",
        "billing-admin",
    }
    observed_surfaces = {
        item.get("surface") for item in observations if isinstance(item, dict)
    }
    if not surfaces.issubset(observed_surfaces):
        fail(f"browser evidence is missing surfaces: {sorted(surfaces - observed_surfaces)}")

    def saw(*, surface=None, locale=None, branch=None, endpoint=None):
        return any(
            isinstance(item, dict)
            and (surface is None or item.get("surface") == surface)
            and (locale is None or item.get("locale") == locale)
            and (branch is None or item.get("branch") == branch)
            and (endpoint is None or item.get("endpoint") == endpoint)
            and item.get("headersScanned") is True
            and item.get("bodyScanned") is True
            for item in observations
        )

    for surface in surfaces:
        for locale in ("en", "ar"):
            for branch in ("ui-clean", "ui-branch"):
                if not saw(surface=surface, locale=locale, branch=branch):
                    fail(f"missing {locale} {branch} response evidence for {surface}")

    public_endpoints = {
        "GET /public/plans",
        "POST /accounts/signup",
        "POST /accounts/verify-email",
        "POST /accounts/resend-verification",
    }
    bff_endpoints = {
        "POST /api/accounts/mfa/enroll",
        "POST /api/accounts/mfa/confirm",
        "GET /api/tenants/me",
        "POST /api/tenants/me/provisioning-retry",
        "GET /api/companies/current/setup",
        "PUT /api/companies/current/setup",
        "POST /api/companies/current/setup/complete",
        "GET /api/companies/current/settings",
        "PUT /api/companies/current/settings",
        "GET /api/billing/subscription",
        "GET /api/billing/payment-submissions",
        "POST /api/billing/payment-submissions",
        "GET /api/modules",
        "PUT /api/modules/selection",
        "GET /api/onboarding/checklist",
        "GET /api/support-access/grants",
        "POST /api/support-access/grants",
        "POST /api/support-access/grants/:grantId/revoke",
        "GET /api/internal/billing/review-queue",
        "POST /api/internal/billing/payment-submissions/:submissionId/approve",
        "POST /api/internal/billing/payment-submissions/:submissionId/reject",
        "POST /api/internal/billing/payment-submissions/:submissionId/request-more-info",
    }
    for endpoint in public_endpoints:
        if not saw(branch="nest-public-success", endpoint=endpoint):
            fail(f"missing public endpoint evidence: {endpoint}")
    for endpoint in bff_endpoints:
        if not saw(branch="bff-success", endpoint=endpoint):
            fail(f"missing BFF success evidence: {endpoint}")
        if not saw(branch="bff-anonymous-denial", endpoint=endpoint):
            fail(f"missing BFF anonymous-denial evidence: {endpoint}")

    mutating_bff_endpoints = {
        endpoint for endpoint in bff_endpoints if endpoint.startswith(("POST ", "PUT "))
    }
    for endpoint in mutating_bff_endpoints:
        if not saw(branch="bff-csrf-denial", endpoint=endpoint):
            fail(f"missing BFF CSRF-denial evidence: {endpoint}")

    internal_endpoints = {
        endpoint for endpoint in bff_endpoints if "/api/internal/billing/" in endpoint
    }
    for endpoint in internal_endpoints:
        if not saw(branch="bff-role-denial", endpoint=endpoint):
            fail(f"missing Billing Admin role-denial evidence: {endpoint}")

    odoo_seam_endpoints = {
        "GET /api/companies/current/setup",
        "PUT /api/companies/current/setup",
        "POST /api/companies/current/setup/complete",
        "GET /api/companies/current/settings",
        "PUT /api/companies/current/settings",
        "GET /api/modules",
        "PUT /api/modules/selection",
        "GET /api/onboarding/checklist",
    }
    for endpoint in odoo_seam_endpoints:
        for branch in ("bff-raw-success", "bff-raw-error"):
            if not saw(branch=branch, endpoint=endpoint):
                fail(f"missing {branch} evidence: {endpoint}")

    for endpoint in {
        "POST /accounts/signup",
        "POST /accounts/verify-email",
        "POST /accounts/resend-verification",
    }:
        if not saw(branch="nest-public-denial", endpoint=endpoint):
            fail(f"missing public denial/error evidence: {endpoint}")

print(f"T109 {kind} evidence validated: {path}")
