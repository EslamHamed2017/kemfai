#!/usr/bin/env bash
# T016 acceptance test: a fresh `docker compose up` of the keycloak service auto-imports
# both KEMFAI realms (kemfai-customers with the WorkspaceOwner role and VERIFY_EMAIL +
# CONFIGURE_TOTP required actions enabled; kemfai-internal with the six internal roles),
# and no role or client scope lets a kemfai-customers user obtain a kemfai-internal role
# (FR-004 - the two realms are separate trust domains with disjoint role name sets and no
# identity brokering between them).
#
# Only the keycloak service is (re)created/stopped; all other running services are left alone.
#
# Usage: ./infra/keycloak/test-realms.sh
set -euo pipefail

KEYCLOAK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$KEYCLOAK_DIR/../docker/docker-compose.yml"
KC_BASE="http://127.0.0.1:8080"
KC_ADMIN_USER="${KEYCLOAK_ADMIN:-admin}"
KC_ADMIN_PASSWORD="${KEYCLOAK_ADMIN_PASSWORD:-kemfai_dev_admin}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

FAIL=0
fail() { echo "FAIL: $*"; FAIL=1; }

echo "--- part 1: static validation of the realm export files ---"
python3 - "$KEYCLOAK_DIR" <<'PY' || fail "static validation reported problems"
import json, sys, os

d = sys.argv[1]
customers = json.load(open(os.path.join(d, "kemfai-customers-realm.json")))
internal = json.load(open(os.path.join(d, "kemfai-internal-realm.json")))

problems = []

def realm_roles(realm):
    return [r["name"] for r in realm.get("roles", {}).get("realm", [])]

c_roles = realm_roles(customers)
i_roles = realm_roles(internal)

# Task line: customers realm = WorkspaceOwner role; internal realm = the six roles.
expected_customer_roles = ["WorkspaceOwner", "accounting.coa.create", "accounting.coa.edit", "accounting.coa.view", "accounting.drafts.edit", "accounting.drafts.view"]
if sorted(c_roles) != sorted(expected_customer_roles):
    problems.append(f"customers realm roles {sorted(c_roles)} != {sorted(expected_customer_roles)}")
expected_internal = ["BillingAdmin", "Support", "SuperAdmin", "CustomerSuccess", "TechnicalAdmin", "ReadOnlyManagement"]
if sorted(i_roles) != sorted(expected_internal):
    problems.append(f"internal realm roles {sorted(i_roles)} != {sorted(expected_internal)}")

# Role name sets are disjoint -> no realm role in one file names a role of the other trust domain.
overlap = sorted(set(c_roles) & set(i_roles))
if overlap:
    problems.append(f"role name overlap between realms: {overlap}")

# Neither file mentions the other realm's role names anywhere (deep scan), and neither
# configures identity brokering or composite roles that could bridge trust domains.
for label, realm, other_roles in (
    ("customers", customers, set(expected_internal)),
    ("internal", internal, {"WorkspaceOwner"}),
):
    text = json.dumps(realm)
    for name in other_roles:
        if f'"{name}"' in text:
            problems.append(f"{label} realm file references foreign role '{name}'")
    if realm.get("identityProviders"):
        problems.append(f"{label} realm configures identityProviders (identity brokering)")
    if realm.get("identityProviderMappers"):
        problems.append(f"{label} realm configures identityProviderMappers")
    for role in realm.get("roles", {}).get("realm", []):
        if not role.get("composite"):
            continue
        allowed = label == "customers" and role.get("name") == "WorkspaceOwner"
        composed = sorted(role.get("composites", {}).get("realm", []))
        expected_permissions = sorted(expected_customer_roles[1:])
        if not allowed or composed != expected_permissions:
            problems.append(
                f"{label} realm role '{role['name']}' has unexpected composites {composed}"
            )

# Required actions in the customers realm (task acceptance: both enabled).
ra = {a["alias"]: a for a in customers.get("requiredActions", [])}
for alias in ("VERIFY_EMAIL", "CONFIGURE_TOTP"):
    action = ra.get(alias)
    if not action or action.get("enabled") is not True:
        problems.append(f"customers realm required action {alias} missing or not enabled")

# Realm identity: two distinct realms.
if customers["realm"] != "kemfai-customers" or internal["realm"] != "kemfai-internal":
    problems.append("realm names are not kemfai-customers / kemfai-internal")

if problems:
    print("\n".join(f"  - {p}" for p in problems))
    sys.exit(1)
print("  OK: role sets exact and disjoint, owned accounting composites exact, no brokering, required actions enabled")
PY

echo "--- part 2: fresh keycloak boot auto-imports both realms ---"
# --force-recreate gives a fresh container filesystem (the keycloak service defines no data
# volume), so every run genuinely exercises the "fresh docker compose up" import path.
docker compose -f "$COMPOSE_FILE" up -d --force-recreate keycloak

echo "waiting for both realms to appear in the admin API (timeout 180s)..."
TOKEN=""
for i in $(seq 1 60); do
  if TOKEN=$(curl -fsS --max-time 5 -X POST \
      -d "grant_type=password&client_id=admin-cli&username=$KC_ADMIN_USER&password=$KC_ADMIN_PASSWORD" \
      "$KC_BASE/realms/master/protocol/openid-connect/token" 2>/dev/null); then
    if curl -fsS --max-time 5 -H "Authorization: Bearer $(echo "$TOKEN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')" \
        "$KC_BASE/admin/realms" -o "$TMP_DIR/realms.json" 2>/dev/null; then
      if python3 -c '
import json, sys
names = {r["realm"] for r in json.load(open(sys.argv[1]))}
sys.exit(0 if {"kemfai-customers", "kemfai-internal"} <= names else 1)' "$TMP_DIR/realms.json" 2>/dev/null; then
        echo "  OK: both realms imported (after ~$((i * 3))s)"
        break
      fi
    fi
  fi
  sleep 3
  if [ "$i" = "60" ]; then
    fail "realms did not appear within 180s; last Keycloak logs:"
    docker logs kemfai-keycloak --tail 40 || true
  fi
done

if [ -s "$TMP_DIR/realms.json" ]; then
  echo "--- part 3: live verification via the Keycloak Admin REST API ---"
  ACCESS_TOKEN=$(echo "$TOKEN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')
  AUTH="Authorization: Bearer $ACCESS_TOKEN"

  curl -fsS --max-time 10 -H "$AUTH" "$KC_BASE/admin/realms/kemfai-customers" -o "$TMP_DIR/customers.json" || fail "cannot fetch kemfai-customers realm"
  curl -fsS --max-time 10 -H "$AUTH" "$KC_BASE/admin/realms/kemfai-internal" -o "$TMP_DIR/internal.json" || fail "cannot fetch kemfai-internal realm"
  curl -fsS --max-time 10 -H "$AUTH" "$KC_BASE/admin/realms/kemfai-customers/roles" -o "$TMP_DIR/c-roles.json" || fail "cannot fetch customers realm roles"
  curl -fsS --max-time 10 -H "$AUTH" "$KC_BASE/admin/realms/kemfai-internal/roles" -o "$TMP_DIR/i-roles.json" || fail "cannot fetch internal realm roles"
  curl -fsS --max-time 10 -H "$AUTH" "$KC_BASE/admin/realms/kemfai-customers/authentication/required-actions" -o "$TMP_DIR/c-actions.json" || fail "cannot fetch customers required actions"
  curl -fsS --max-time 10 -H "$AUTH" "$KC_BASE/admin/realms/kemfai-customers/clients?clientId=kemfai-api" -o "$TMP_DIR/c-client.json" || fail "cannot fetch kemfai-api client"
  curl -fsS --max-time 10 -H "$AUTH" "$KC_BASE/admin/realms/kemfai-customers/client-scopes" -o "$TMP_DIR/c-scopes.json" || fail "cannot fetch customers client scopes"

  python3 - "$TMP_DIR" <<'PY' || fail "live verification reported problems"
import json, sys, os

d = sys.argv[1]
problems = []

def load(name):
    with open(os.path.join(d, name)) as f:
        return json.load(f)

customers = load("customers.json")
internal = load("internal.json")
c_roles = {r["name"] for r in load("c-roles.json")}
i_roles = {r["name"] for r in load("i-roles.json")}
actions = {a["alias"]: a for a in load("c-actions.json")}
client = load("c-client.json")
scopes = load("c-scopes.json")

# Both realms exist and are enabled.
for label, realm in (("kemfai-customers", customers), ("kemfai-internal", internal)):
    if not realm.get("enabled"):
        problems.append(f"realm {label} is not enabled")

# Customers realm: WorkspaceOwner present, none of the six internal roles present.
if "WorkspaceOwner" not in c_roles:
    problems.append("WorkspaceOwner role missing from live kemfai-customers realm")
for permission in expected_customer_roles[1:]:
    if permission not in c_roles:
        problems.append(f"customer accounting permission role missing: {permission}")
internal_roles = {"BillingAdmin", "Support", "SuperAdmin", "CustomerSuccess", "TechnicalAdmin", "ReadOnlyManagement"}
leaked = sorted(c_roles & internal_roles)
if leaked:
    problems.append(f"kemfai-customers realm exposes internal roles {leaked} (FR-004)")

# Internal realm: all six roles present, no WorkspaceOwner.
missing = sorted(internal_roles - i_roles)
if missing:
    problems.append(f"kemfai-internal realm is missing roles {missing}")
if "WorkspaceOwner" in i_roles:
    problems.append("kemfai-internal realm exposes WorkspaceOwner")

# Required actions enabled in the live customers realm.
for alias in ("VERIFY_EMAIL", "CONFIGURE_TOTP"):
    a = actions.get(alias)
    if not a or a.get("enabled") is not True:
        problems.append(f"live required action {alias} missing or disabled")

# No identity brokering in the live customers realm.
if customers.get("identityProviders"):
    problems.append("live kemfai-customers realm has identityProviders configured")

# No client scope in the customers realm mentions an internal role (FR-004: no client
# scope may let a customers user obtain a kemfai-internal role).
scopes_text = json.dumps(scopes)
for name in sorted(internal_roles):
    if f'"{name}"' in scopes_text:
        problems.append(f"customers realm client scopes reference internal role '{name}'")

# The kemfai-api client exists, is public, uses the standard flow with PKCE, and maps the
# audience BearerAuthGuard validates.
if not client:
    problems.append("kemfai-api client missing from live kemfai-customers realm")
else:
    c = client[0]
    if not c.get("publicClient"):
        problems.append("kemfai-api client is not public")
    if not c.get("standardFlowEnabled"):
        problems.append("kemfai-api client does not enable the standard flow")
    mappers = c.get("protocolMappers", [])
    aud = [m for m in mappers if m.get("protocolMapper") == "oidc-audience-mapper"
           and m.get("config", {}).get("included.client.audience") == "kemfai-api"]
    if not aud:
        problems.append("kemfai-api client lacks the oidc-audience-mapper for 'kemfai-api'")

if problems:
    print("\n".join(f"  - {p}" for p in problems))
    sys.exit(1)
print("  OK: live realms, roles, required actions, client, and separation all verified")
PY
fi

echo "--- restoring prior state (keycloak was not running before this test) ---"
docker compose -f "$COMPOSE_FILE" stop keycloak >/dev/null 2>&1 || true

if [ "$FAIL" -ne 0 ]; then
  echo "=== T016 acceptance test: FAILED ==="
  exit 1
fi

echo "=== T016 acceptance test: PASSED (fresh boot auto-imports both realms; FR-004 separation holds) ==="
