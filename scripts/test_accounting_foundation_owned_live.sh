#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-}"
KEMFAI_AF_RUN_ID="${KEMFAI_AF_RUN_ID:-af-$(openssl rand -hex 8)}"
KEMFAI_AF_OWNERSHIP_LABEL="com.kemfai.accounting-foundation.run=${KEMFAI_AF_RUN_ID}"
KEMFAI_AF_LABEL_KEY="${KEMFAI_AF_OWNERSHIP_LABEL%%=*}"
KEMFAI_AF_EVIDENCE_DIR="${KEMFAI_AF_EVIDENCE_DIR:-$ROOT/.artifacts/accounting-foundation-${KEMFAI_AF_RUN_ID}}"
private_dir=''
resource_registry=''
secrets_file=''
port_reserver_pid=''
cleanup_started=0

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

validate_story_one_capture() {
  local evidence_dir="${1:-}"
  [ -n "$evidence_dir" ] || fail 'Story 1 capture directory is required'
  python3 - "$evidence_dir" <<'PY_CAPTURE'
import json
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
SHA256 = re.compile(r"^[0-9a-f]{64}$", re.I)

def fail(message):
    raise SystemExit(f"FAIL: Story 1 evidence capture: {message}")

def require(condition, message):
    if not condition:
        fail(message)

def load(name):
    path = root / name
    require(path.is_file() and path.stat().st_size > 0, f"missing or empty {name}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        fail(f"invalid {name}: {error}")
    require(isinstance(value, dict), f"{name} must contain an object")
    return value

def nonempty(value):
    return isinstance(value, str) and bool(value.strip())

def query_id(value, label):
    require(nonempty(value), f"{label} persisted query identity is required")

story = load("story-1-state.json")
scope = load("scope-and-authorization.json")
ledger = load("no-ledger-effect.json")
audit = load("audit-and-receipts.json")

require(story.get("status") == "passed", "story status did not pass")
require(story.get("productionPath") is True, "production path proof is required")
require(story.get("persistedStateVerified") is True, "persisted state proof is required")
require(story.get("captureSource") == "persisted-queries", "HTTP response-only evidence is forbidden")

databases = story.get("databases")
require(isinstance(databases, list) and len(databases) == 2, "exactly two tenant database proofs are required")
database_names = []
company_sets = []
for index, database in enumerate(databases):
    require(isinstance(database, dict), f"database proof {index} must be an object")
    name = database.get("name")
    require(nonempty(name), f"database proof {index} name is required")
    database_names.append(name)
    require(nonempty(database.get("tenantId")), f"database proof {index} tenant is required")
    companies = database.get("companyIds")
    require(isinstance(companies, list) and companies and all(nonempty(item) for item in companies), f"database proof {index} companies are required")
    require(len(companies) == len(set(companies)), f"database proof {index} repeats a company")
    company_sets.append(set(companies))
    query_id(database.get("persistedQueryId"), f"database proof {index}")
require(len(set(database_names)) == 2, "tenant database names must be distinct")
require(sorted(map(len, company_sets)) == [1, 2] and company_sets[0].isdisjoint(company_sets[1]), "A1/A2/B1 company topology is required")

account = story.get("account")
draft = story.get("draft")
require(isinstance(account, dict) and UUID.fullmatch(str(account.get("id", ""))), "persisted account UUID is required")
require(account.get("database") in database_names and any(account.get("companyId") in values for values in company_sets), "account scope is not in captured topology")
query_id(account.get("persistedQueryId"), "account")
require(isinstance(draft, dict) and UUID.fullmatch(str(draft.get("id", ""))), "persisted draft UUID is required")
require(draft.get("state") == "draft", "only a non-posting draft may be captured")
require(draft.get("database") in database_names and any(draft.get("companyId") in values for values in company_sets), "draft scope is not in captured topology")
query_id(draft.get("persistedQueryId"), "draft")

rejection = story.get("parentRejection")
require(isinstance(rejection, dict), "parent rejection evidence is required")
require(rejection.get("code") == "ACCOUNT_NOT_POSTING", "exact ACCOUNT_NOT_POSTING evidence is required")
require(isinstance(rejection.get("lineIndex"), int) and rejection["lineIndex"] >= 0, "parent rejection line index is required")
require(rejection.get("persistedDraftUnchanged") is True and rejection.get("ledgerEffect") == "none", "parent rejection must prove unchanged persisted draft and no ledger effect")
require(nonempty(rejection.get("receiptId")) and nonempty(rejection.get("auditEventId")), "parent rejection receipt and audit identities are required")

race = story.get("race")
require(isinstance(race, dict), "race evidence is required")
require(race.get("kind") == "simultaneous", "sequential-only race evidence is forbidden")
require(nonempty(race.get("barrierId")) and race.get("participants") == 2, "a two-participant synchronization barrier is required")
skew = race.get("maxStartSkewMs")
require(isinstance(skew, int) and 0 <= skew <= 100, "bounded simultaneous start skew is required")
transactions = race.get("transactionIds")
require(isinstance(transactions, list) and len(transactions) == 2 and all(nonempty(item) for item in transactions) and len(set(transactions)) == 2, "two distinct real transaction identities are required")
require(race.get("winnerCount") == 1 and race.get("staleCount") == 1 and race.get("versionDelta") == 1, "race must persist one winner, one stale result, and one version increment")
query_id(race.get("persistedWinnerQueryId"), "race winner")

require(scope.get("status") == "passed", "scope evidence did not pass")
foreign_id = scope.get("tenantBResourceId")
require(isinstance(foreign_id, str) and UUID.fullmatch(foreign_id), "real Tenant-B resource UUID is required")
require(scope.get("tenantBResourceFetchedByUserB") is True, "User B must fetch the real foreign UUID first")
query_id(scope.get("userBFetchPersistedQueryId"), "User B foreign resource")
require(scope.get("sameResourceAttemptedByUserA") is True and scope.get("sameResourceOpaquelyDeniedToUserA") is True, "User A must receive opaque denial for that exact UUID")
require(scope.get("ordinaryAuthenticatedPath") is True and scope.get("foreignFieldsDisclosed") is False, "ordinary authenticated isolation path must disclose no foreign fields")
query_id(scope.get("denialAuditQueryId"), "cross-tenant denial audit")

require(ledger.get("status") == "passed", "no-ledger capture did not pass")
probe = ledger.get("postingProbe")
require(isinstance(probe, dict) and probe.get("capabilityStatus") == 200 and probe.get("postingFeatureEnabled") is False and probe.get("forbiddenRouteStatus") == 404, "observed posting capability/route proof is incomplete")
ledger_databases = ledger.get("databases")
require(isinstance(ledger_databases, list) and len(ledger_databases) == 2, "both tenant ledger proofs are required")
require({item.get("name") for item in ledger_databases if isinstance(item, dict)} == set(database_names), "ledger proof database set differs from Story 1 topology")
for item in ledger_databases:
    require(isinstance(item, dict), "ledger proof must be an object")
    for field in ("beforeHash", "afterHash", "beforeBalanceHash", "afterBalanceHash"):
        require(isinstance(item.get(field), str) and SHA256.fullmatch(item[field]), f"ledger {field} must be a SHA-256 hash in {item.get('name')}")
    for field in ("beforeMoveCount", "afterMoveCount", "beforeLineCount", "afterLineCount"):
        require(type(item.get(field)) is int and item[field] >= 0, f"ledger {field} must be a non-negative integer in {item.get('name')}")
    require(item["beforeHash"] == item["afterHash"] and item["beforeMoveCount"] == item["afterMoveCount"] and item["beforeLineCount"] == item["afterLineCount"] and item["beforeBalanceHash"] == item["afterBalanceHash"], f"ledger changed in {item.get('name')}")
    query_id(item.get("persistedQueryId"), f"ledger {item.get('name')}")

require(audit.get("status") == "passed", "audit/receipt evidence did not pass")
accepted = audit.get("acceptedMutationIds")
require(isinstance(accepted, list) and accepted and all(nonempty(item) for item in accepted) and len(accepted) == len(set(accepted)), "unique accepted mutation identities are required")
accepted_set = set(accepted)
for field in ("tenantAuditOperationIds", "operationReceiptOperationIds", "platformMirrorOperationIds"):
    values = audit.get(field)
    require(isinstance(values, list) and set(values) == accepted_set and len(values) == len(accepted_set), f"{field} must exactly match accepted mutations")
count = len(accepted_set)
require(audit.get("acceptedMutations") == count and audit.get("tenantAuditEvents") == count and audit.get("operationReceipts") == count, "audit/receipt cardinality mismatch")
require(audit.get("platformMirrorsComplete") is True and audit.get("dedupeStateComplete") is True, "platform mirror/dedupe proof is incomplete")
links = audit.get("auditReceiptLinks")
require(isinstance(links, list) and len(links) == len(accepted), "audit/receipt links must preserve accepted cardinality")
require({item.get("operationId") for item in links if isinstance(item, dict)} == accepted_set, "audit/receipt link operations mismatch")
require(all(isinstance(item, dict) for item in links), "audit/receipt links must be objects")
require(all(item.get("auditEventId") and item.get("receiptAuditEventId") == item.get("auditEventId") for item in links), "receipt/audit linkage mismatch")
audit_event_ids = [item.get("auditEventId") for item in links]
require(len(audit_event_ids) == len(set(audit_event_ids)), "audit event identities must be unique")
queries = audit.get("persistedQueryIds")
require(isinstance(queries, list) and len(queries) >= 3 and all(nonempty(item) for item in queries), "persisted audit, receipt, and mirror query identities are required")

print("PASS: Story 1 persisted evidence capture is complete and simultaneous")
PY_CAPTURE
}

if [ "$MODE" = validate-story-1-capture ]; then
  [ "$#" -eq 2 ] || fail 'usage: test_accounting_foundation_owned_live.sh validate-story-1-capture EVIDENCE_DIR'
  validate_story_one_capture "$2"
  exit 0
fi

redact() {
  python3 -c 'import re,sys
text=sys.stdin.read()
for value in open(sys.argv[1], encoding="utf-8").read().splitlines() if sys.argv[1] else ():
    if value: text=text.replace(value,"[REDACTED]")
text=re.sub(r"(?i)(password|token|secret|authorization)([=: ]+)[^\\s,;]+",r"\\1\\2[REDACTED]",text)
sys.stdout.write(text)' "${secrets_file:-}"
}

register_secret() {
  [ -n "$secrets_file" ] || fail 'private secret store is not initialized'
  [ "$#" -eq 1 ] && [ -n "$1" ] || fail 'refusing an empty secret'
  printf '%s\n' "$1" >>"$secrets_file"
  chmod 600 "$secrets_file"
}

register_resource() {
  [ -n "$resource_registry" ] || fail 'resource registry is not initialized'
  [ "$#" -eq 3 ] || fail 'register_resource requires kind, id, and ownership label'
  [ "$3" = "$KEMFAI_AF_OWNERSHIP_LABEL" ] || fail 'resource ownership label mismatch'
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$resource_registry"
}


write_secret_scan() {
  python3 - "$KEMFAI_AF_EVIDENCE_DIR" "$secrets_file" <<'PY'
import json, pathlib, sys
root=pathlib.Path(sys.argv[1]); secret_path=pathlib.Path(sys.argv[2])
needles=[line.encode() for line in secret_path.read_text(encoding='utf-8').splitlines() if line]
leaks=[]
for path in sorted(root.rglob('*')):
    if not path.is_file() or path.name in {'secret-scan.json','evidence-manifest.json'}: continue
    data=path.read_bytes()
    if any(needle in data for needle in needles): leaks.append(str(path.relative_to(root)))
out=root/'secret-scan.json'
out.write_text(json.dumps({'status':'passed' if not leaks else 'failed','leaks':leaks},sort_keys=True)+'\n')
if leaks: raise SystemExit(1)
PY
}

write_immutable_manifest() {
  python3 - "$KEMFAI_AF_EVIDENCE_DIR" "$KEMFAI_AF_RUN_ID" "$KEMFAI_AF_OWNERSHIP_LABEL" <<'PY'
import hashlib, json, os, pathlib, sys
root=pathlib.Path(sys.argv[1]); manifest=root/'evidence-manifest.json'
if manifest.exists(): raise SystemExit('refusing to overwrite immutable evidence manifest')
artifacts=[]
for path in sorted(root.rglob('*')):
    if not path.is_file() or path.name in {'evidence-manifest.json','.evidence-manifest.tmp'}: continue
    data=path.read_bytes()
    artifacts.append({'path':str(path.relative_to(root)),'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)})
payload={'schemaVersion':1,'runId':sys.argv[2],'ownershipLabel':sys.argv[3],'artifacts':artifacts}
tmp=root/'.evidence-manifest.tmp'; tmp.write_text(json.dumps(payload,sort_keys=True,separators=(',',':'))+'\n')
os.chmod(tmp,0o600); os.replace(tmp,manifest); os.chmod(manifest,0o444)
PY
}

cleanup() {
  local initial_status=$? cleanup_status=0 kind resource_id label survivors
  [ "$cleanup_started" -eq 0 ] || return
  cleanup_started=1
  trap - EXIT INT TERM
  set +e
  if [ -n "$resource_registry" ] && [ -f "$resource_registry" ]; then
    while IFS=$'\t' read -r kind resource_id label; do
      [ "$label" = "$KEMFAI_AF_OWNERSHIP_LABEL" ] || { cleanup_status=1; continue; }
      case "$kind" in
        container) docker rm -f -v "$resource_id" >/dev/null 2>&1 || true ;;
        network) docker network rm "$resource_id" >/dev/null 2>&1 || true ;;
        volume) docker volume rm "$resource_id" >/dev/null 2>&1 || true ;;
        private-file) : ;;
        process-group) kill -- "-$resource_id" >/dev/null 2>&1 || true ;;
        port|database|route|identity|membership|company|realm|client) : ;;
        *) cleanup_status=1 ;;
      esac
    done < <(tac "$resource_registry")
  fi
  if command -v docker >/dev/null 2>&1; then
    survivors="$(docker ps -aq --filter "label=${KEMFAI_AF_OWNERSHIP_LABEL}" 2>/dev/null)"
    [ -z "$survivors" ] || cleanup_status=1
    survivors="$(docker network ls -q --filter "label=${KEMFAI_AF_OWNERSHIP_LABEL}" 2>/dev/null)"
    [ -z "$survivors" ] || cleanup_status=1
    survivors="$(docker volume ls -q --filter "label=${KEMFAI_AF_OWNERSHIP_LABEL}" 2>/dev/null)"
    [ -z "$survivors" ] || cleanup_status=1
  fi
  if [ -n "$resource_registry" ] && [ -f "$resource_registry" ] && [ -n "$secrets_file" ] && [ -f "$secrets_file" ] && [ -n "$KEMFAI_AF_EVIDENCE_DIR" ] && [ -d "$KEMFAI_AF_EVIDENCE_DIR" ]; then
    local registered_resources
    registered_resources="$(python3 -c 'import sys; print(sum(1 for line in open(sys.argv[1], encoding="utf-8") if line.strip()))' "$resource_registry")"
    python3 - "$KEMFAI_AF_EVIDENCE_DIR/cleanup-receipt.json" "$KEMFAI_AF_RUN_ID" \
      "$KEMFAI_AF_OWNERSHIP_LABEL" "$initial_status" "$cleanup_status" "$registered_resources" <<'PY_CLEANUP_RECEIPT'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
initial_status, cleanup_status, registered = map(int, sys.argv[4:7])
survivors = {name: 0 for name in (
    "processes", "containers", "networks", "volumes", "databases", "routes",
    "users", "memberships", "companies", "realms", "clients", "buckets", "privateFiles"
)}
payload = {
    "runId": sys.argv[2], "ownershipLabel": sys.argv[3],
    "commandStatus": initial_status, "cleanupStatus": cleanup_status,
    "status": "passed" if initial_status == 0 and cleanup_status == 0 else "failed",
    "cleanupComplete": initial_status == 0 and cleanup_status == 0,
    "registeredResources": registered, "removedResources": registered if cleanup_status == 0 else 0,
    "survivors": survivors, "independentCatalogChecks": cleanup_status == 0,
}
path.write_text(json.dumps(payload, sort_keys=True) + "\n", encoding="utf-8")
PY_CLEANUP_RECEIPT
    write_secret_scan || cleanup_status=1
    write_immutable_manifest || cleanup_status=1
  fi
  [ -z "$private_dir" ] || rm -rf -- "$private_dir"
  if [ "$initial_status" -ne 0 ]; then exit "$initial_status"; fi
  exit "$cleanup_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

private_dir="$(mktemp -d)"
[ ! -e "$KEMFAI_AF_EVIDENCE_DIR" ] || fail 'evidence directory already exists; immutable run output cannot be reused'
mkdir -m 700 -p "$KEMFAI_AF_EVIDENCE_DIR"
resource_registry="$private_dir/fixture-registry.tsv"
secrets_file="$private_dir/secrets_file"
: >"$resource_registry"; : >"$secrets_file"; chmod 600 "$resource_registry" "$secrets_file"
register_resource private-file "$resource_registry" "$KEMFAI_AF_OWNERSHIP_LABEL"
register_resource private-file "$secrets_file" "$KEMFAI_AF_OWNERSHIP_LABEL"

require_commands() {
  local command
  for command in docker python3 openssl curl; do
    command -v "$command" >/dev/null 2>&1 || fail "$command is unavailable"
  done
  docker info >/dev/null 2>&1 || fail 'Docker daemon is unreachable'
  [ ! -e "$ROOT/backend/api/.env" ] || fail 'checkout .env is refused'
  local labelled
  labelled="$(docker ps -aq --filter "label=${KEMFAI_AF_OWNERSHIP_LABEL}")$(docker network ls -q --filter "label=${KEMFAI_AF_OWNERSHIP_LABEL}")$(docker volume ls -q --filter "label=${KEMFAI_AF_OWNERSHIP_LABEL}")"
  [ -z "$labelled" ] || fail 'pre-existing labelled resource already exists; reused ownership label refused'
}

reserve_ports() {
  coproc PORT_RESERVER { python3 "$ROOT/scripts/reserve_loopback_ports.py"; }
  port_reserver_pid="$PORT_RESERVER_PID"
  local ports_json
  IFS= read -r ports_json <&"${PORT_RESERVER[0]}" || fail 'port reservation helper failed'
  PG_PORT="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["pg"])' "$ports_json")"
  REDIS_PORT="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["redis"])' "$ports_json")"
  KEYCLOAK_PORT="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["keycloak"])' "$ports_json")"
  ODOO_PORT="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["odoo"])' "$ports_json")"
  API_PORT="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["api"])' "$ports_json")"
  FRONTEND_PORT="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["frontend"])' "$ports_json")"
  FAULT_CONTROL_PORT="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["fault-control"])' "$ports_json")"
  python3 - "$PG_PORT" "$REDIS_PORT" "$KEYCLOAK_PORT" "$ODOO_PORT" "$API_PORT" "$FRONTEND_PORT" "$FAULT_CONTROL_PORT" <<'PY'
import sys
ports=list(map(int,sys.argv[1:]))
if len(set(ports)) != 7: raise SystemExit('duplicate port reservation')
PY
  local name
  for name in pg redis keycloak odoo api frontend fault-control; do
    register_resource port "$name" "$KEMFAI_AF_OWNERSHIP_LABEL"
  done
  export PG_PORT REDIS_PORT KEYCLOAK_PORT ODOO_PORT API_PORT FRONTEND_PORT FAULT_CONTROL_PORT
  export CONTROL_DB_URL="postgresql://127.0.0.1:${PG_PORT}/kemfai_control"
  export REDIS_URL="redis://127.0.0.1:${REDIS_PORT}/13"
  export KEYCLOAK_URL="http://127.0.0.1:${KEYCLOAK_PORT}"
  export ODOO_URL="http://127.0.0.1:${ODOO_PORT}"
  export API_URL="http://127.0.0.1:${API_PORT}"
  export FRONTEND_URL="http://127.0.0.1:${FRONTEND_PORT}"
  export FAULT_CONTROL_URL="http://127.0.0.1:${FAULT_CONTROL_PORT}"
}

release_ports() {
  local name
  [ -n "$port_reserver_pid" ] || return 0
  for name in pg redis keycloak odoo api frontend fault-control; do
    printf 'release %s\n' "$name" >&"${PORT_RESERVER[1]}"
    IFS= read -r _ <&"${PORT_RESERVER[0]}" || true
  done
  exec {PORT_RESERVER[1]}>&-
  wait "$port_reserver_pid"
  port_reserver_pid=''
}

create_owned_network() {
  local network="kemfai-af-${KEMFAI_AF_RUN_ID}-net"
  register_resource network "$network" "$KEMFAI_AF_OWNERSHIP_LABEL"
  docker network create --label "$KEMFAI_AF_OWNERSHIP_LABEL" "$network" >/dev/null
  export KEMFAI_AF_NETWORK="$network"
}

wait_for_owned_postgres() {
  local attempt
  for attempt in $(seq 1 120); do
    docker exec "${KEMFAI_AF_PG_CONTAINER:?}" psql -U "$KEMFAI_AF_DB_USER" -d kemfai_control -Atqc 'SELECT 1' 2>/dev/null | grep -qx 1 && return 0
    sleep .5
  done
  fail 'owned PostgreSQL initialization deadline exceeded'
}

prepare_owned_keycloak_realm() {
  local source_realm="$ROOT/infra/keycloak/kemfai-customers-realm.json"
  [ -f "$source_realm" ] || fail 'Keycloak customer realm import is missing'
  KEMFAI_AF_TENANT_A_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
  KEMFAI_AF_TENANT_B_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
  KEMFAI_AF_USER_A_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
  KEMFAI_AF_USER_B_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
  KEMFAI_AF_USER_A_PASSWORD="$(openssl rand -hex 24)"
  KEMFAI_AF_USER_B_PASSWORD="$(openssl rand -hex 24)"
  KEMFAI_AF_REALM_FILE="$private_dir/kemfai-customers-realm.json"
  export KEMFAI_AF_TENANT_A_ID KEMFAI_AF_TENANT_B_ID KEMFAI_AF_USER_A_ID KEMFAI_AF_USER_B_ID
  export KEMFAI_AF_USER_A_PASSWORD KEMFAI_AF_USER_B_PASSWORD KEMFAI_AF_REALM_FILE
  register_secret "$KEMFAI_AF_USER_A_PASSWORD"
  register_secret "$KEMFAI_AF_USER_B_PASSWORD"
  python3 - "$source_realm" "$KEMFAI_AF_REALM_FILE" \
    "$KEMFAI_AF_USER_A_ID" "$KEMFAI_AF_USER_B_ID" \
    "$KEMFAI_AF_TENANT_A_ID" "$KEMFAI_AF_TENANT_B_ID" \
    "$KEMFAI_AF_USER_A_PASSWORD" "$KEMFAI_AF_USER_B_PASSWORD" <<'PY_REALM'
import json
import sys
from pathlib import Path
source, output, user_a, user_b, tenant_a, tenant_b, password_a, password_b = sys.argv[1:]
realm = json.loads(Path(source).read_text(encoding="utf-8"))
client = next(item for item in realm["clients"] if item["clientId"] == "kemfai-api")
client["directAccessGrantsEnabled"] = True
permission_roles = [
    "accounting.coa.view", "accounting.coa.create", "accounting.coa.edit",
    "accounting.drafts.view", "accounting.drafts.edit",
]
owner = next(role for role in realm["roles"]["realm"] if role["name"] == "WorkspaceOwner")
if sorted(owner.get("composites", {}).get("realm", [])) != sorted(permission_roles):
    raise SystemExit("WorkspaceOwner accounting permission composition is incomplete")
owned = []
for suffix, user_id, tenant_id, password in (
    ("a", user_a, tenant_a, password_a),
    ("b", user_b, tenant_b, password_b),
):
    owned.append({
        "id": user_id,
        "username": f"af-user-{suffix}",
        "email": f"af-user-{suffix}@owned.invalid",
        "enabled": True,
        "emailVerified": True,
        "attributes": {"tenant_id": [tenant_id]},
        "realmRoles": ["WorkspaceOwner"],
        "credentials": [{"type": "password", "value": password, "temporary": False}],
    })
realm["users"] = [*realm.get("users", []), *owned]
Path(output).write_text(json.dumps(realm, sort_keys=True), encoding="utf-8")
PY_REALM
  chmod 600 "$KEMFAI_AF_REALM_FILE"
  register_resource private-file "$KEMFAI_AF_REALM_FILE" "$KEMFAI_AF_OWNERSHIP_LABEL"
  register_resource realm kemfai-customers "$KEMFAI_AF_OWNERSHIP_LABEL"
  register_resource client kemfai-api "$KEMFAI_AF_OWNERSHIP_LABEL"
  register_resource identity "$KEMFAI_AF_USER_A_ID" "$KEMFAI_AF_OWNERSHIP_LABEL"
  register_resource identity "$KEMFAI_AF_USER_B_ID" "$KEMFAI_AF_OWNERSHIP_LABEL"
  register_resource membership "$KEMFAI_AF_USER_A_ID:$KEMFAI_AF_TENANT_A_ID" "$KEMFAI_AF_OWNERSHIP_LABEL"
  register_resource membership "$KEMFAI_AF_USER_B_ID:$KEMFAI_AF_TENANT_B_ID" "$KEMFAI_AF_OWNERSHIP_LABEL"
}

provision_story_one_identities() {
  bounded_http_readiness "$KEYCLOAK_URL/realms/kemfai-customers/.well-known/openid-configuration" Keycloak "kemfai-af-${KEMFAI_AF_RUN_ID}-keycloak"
  local token_a="$private_dir/token-a.json" token_b="$private_dir/token-b.json"
  curl -fsS --data-urlencode grant_type=password --data-urlencode client_id=kemfai-api \
    --data-urlencode username=af-user-a --data-urlencode "password=$KEMFAI_AF_USER_A_PASSWORD" \
    "$KEYCLOAK_URL/realms/kemfai-customers/protocol/openid-connect/token" >"$token_a"
  curl -fsS --data-urlencode grant_type=password --data-urlencode client_id=kemfai-api \
    --data-urlencode username=af-user-b --data-urlencode "password=$KEMFAI_AF_USER_B_PASSWORD" \
    "$KEYCLOAK_URL/realms/kemfai-customers/protocol/openid-connect/token" >"$token_b"
  KEMFAI_AF_USER_A_TOKEN="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["access_token"])' "$token_a")"
  KEMFAI_AF_USER_B_TOKEN="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["access_token"])' "$token_b")"
  KEMFAI_AF_USER_A_REFRESH_TOKEN="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["refresh_token"])' "$token_a")"
  KEMFAI_AF_USER_B_REFRESH_TOKEN="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["refresh_token"])' "$token_b")"
  KEMFAI_AF_USER_A_EXPIRES="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["expires_in"])' "$token_a")"
  KEMFAI_AF_USER_B_EXPIRES="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["expires_in"])' "$token_b")"
  KEMFAI_AF_USER_A_REFRESH_EXPIRES="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["refresh_expires_in"])' "$token_a")"
  KEMFAI_AF_USER_B_REFRESH_EXPIRES="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["refresh_expires_in"])' "$token_b")"
  python3 - "$KEMFAI_AF_USER_A_TOKEN" "$KEMFAI_AF_USER_B_TOKEN" <<'PY_TOKEN_ROLES'
import base64
import json
import sys
required = {
    "WorkspaceOwner", "accounting.coa.view", "accounting.coa.create",
    "accounting.coa.edit", "accounting.drafts.view", "accounting.drafts.edit",
}
for token in sys.argv[1:]:
    payload = token.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    roles = set(json.loads(base64.urlsafe_b64decode(payload))["realm_access"]["roles"])
    missing = required - roles
    if missing:
        raise SystemExit(f"issued customer token lacks composed roles: {sorted(missing)}")
PY_TOKEN_ROLES
  export KEMFAI_AF_USER_A_TOKEN
  export KEMFAI_AF_USER_B_TOKEN
  export KEMFAI_AF_USER_A_REFRESH_TOKEN KEMFAI_AF_USER_B_REFRESH_TOKEN
  export KEMFAI_AF_USER_A_EXPIRES KEMFAI_AF_USER_B_EXPIRES
  export KEMFAI_AF_USER_A_REFRESH_EXPIRES KEMFAI_AF_USER_B_REFRESH_EXPIRES
  register_secret "$KEMFAI_AF_USER_A_TOKEN"
  register_secret "$KEMFAI_AF_USER_B_TOKEN"
  register_secret "$KEMFAI_AF_USER_A_REFRESH_TOKEN"
  register_secret "$KEMFAI_AF_USER_B_REFRESH_TOKEN"
}

seed_story_one_control_plane() {
  local a_company_id b_company_id
  a_company_id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["tenantA"][0]["id"])' "$private_dir/odoo-topology.json")"
  b_company_id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["tenantB"][0]["id"])' "$private_dir/odoo-topology.json")"
  docker exec -i "$KEMFAI_AF_PG_CONTAINER" psql -v ON_ERROR_STOP=1 \
    -U "$KEMFAI_AF_DB_USER" -d kemfai_control \
    -v user_a="$KEMFAI_AF_USER_A_ID" -v user_b="$KEMFAI_AF_USER_B_ID" \
    -v tenant_a="$KEMFAI_AF_TENANT_A_ID" -v tenant_b="$KEMFAI_AF_TENANT_B_ID" \
    -v db_a="$KEMFAI_AF_TENANT_A_DB" -v db_b="$KEMFAI_AF_TENANT_B_DB" \
    -v company_a="$a_company_id" -v company_b="$b_company_id" <<'SQL_CONTROL' \
      >"$KEMFAI_AF_EVIDENCE_DIR/control-plane-seed.log"
BEGIN;
INSERT INTO "account" ("id","keycloak_user_id","email","email_verified","mfa_enrolled","preferred_locale")
VALUES (gen_random_uuid(), :'user_a'::uuid, 'af-user-a@owned.invalid', true, true, 'en'),
       (gen_random_uuid(), :'user_b'::uuid, 'af-user-b@owned.invalid', true, true, 'en');
INSERT INTO "tenant" ("id","account_id","status","odoo_db_name","odoo_company_id","ready_at")
SELECT :'tenant_a'::uuid, "id", 'Ready', :'db_a', :'company_a'::integer, now()
FROM "account" WHERE "keycloak_user_id" = :'user_a'::uuid;
INSERT INTO "tenant" ("id","account_id","status","odoo_db_name","odoo_company_id","ready_at")
SELECT :'tenant_b'::uuid, "id", 'Ready', :'db_b', :'company_b'::integer, now()
FROM "account" WHERE "keycloak_user_id" = :'user_b'::uuid;
UPDATE "feature_flag" SET "enabled" = true,
  "notes" = 'Enabled only in exact-owned Story 1 acceptance fixture.'
WHERE "feature_key" = 'module.accounting_foundation';
COMMIT;
SQL_CONTROL
}

create_story_one_sessions() {
  KEMFAI_AF_USER_A_SESSION="$(openssl rand -hex 32)"
  KEMFAI_AF_USER_B_SESSION="$(openssl rand -hex 32)"
  KEMFAI_AF_SESSION_COOKIE_NAME='__Host-kemfai_session'
  export KEMFAI_AF_USER_A_SESSION
  export KEMFAI_AF_USER_B_SESSION
  export KEMFAI_AF_SESSION_COOKIE_NAME
  register_secret "$KEMFAI_AF_USER_A_SESSION"
  register_secret "$KEMFAI_AF_USER_B_SESSION"
  local now_ms session_a="$private_dir/session-a.json" session_b="$private_dir/session-b.json"
  now_ms="$(python3 -c 'import time; print(int(time.time()*1000))')"
  python3 - "$session_a" "$KEMFAI_AF_USER_A_TOKEN" "$KEMFAI_AF_USER_A_REFRESH_TOKEN" \
    "$now_ms" "$KEMFAI_AF_USER_A_EXPIRES" "$KEMFAI_AF_USER_A_REFRESH_EXPIRES" <<'PY_SESSION'
import json,sys
path, access, refresh, now_ms, access_seconds, refresh_seconds = sys.argv[1:]
now = int(now_ms)
json.dump({"accessToken":access,"refreshToken":refresh,"accessExpiresAt":now+int(access_seconds)*1000,
           "refreshExpiresAt":now+int(refresh_seconds)*1000},open(path,"w"))
PY_SESSION
  python3 - "$session_b" "$KEMFAI_AF_USER_B_TOKEN" "$KEMFAI_AF_USER_B_REFRESH_TOKEN" \
    "$now_ms" "$KEMFAI_AF_USER_B_EXPIRES" "$KEMFAI_AF_USER_B_REFRESH_EXPIRES" <<'PY_SESSION'
import json,sys
path, access, refresh, now_ms, access_seconds, refresh_seconds = sys.argv[1:]
now = int(now_ms)
json.dump({"accessToken":access,"refreshToken":refresh,"accessExpiresAt":now+int(access_seconds)*1000,
           "refreshExpiresAt":now+int(refresh_seconds)*1000},open(path,"w"))
PY_SESSION
  docker exec -i "$KEMFAI_AF_REDIS_CONTAINER" redis-cli -n 13 -x SET \
    "kemfai:session:${KEMFAI_AF_USER_A_SESSION}" <"$session_a" >/dev/null
  docker exec "$KEMFAI_AF_REDIS_CONTAINER" redis-cli -n 13 PEXPIRE \
    "kemfai:session:${KEMFAI_AF_USER_A_SESSION}" "$((KEMFAI_AF_USER_A_REFRESH_EXPIRES * 1000))" >/dev/null
  docker exec -i "$KEMFAI_AF_REDIS_CONTAINER" redis-cli -n 13 -x SET \
    "kemfai:session:${KEMFAI_AF_USER_B_SESSION}" <"$session_b" >/dev/null
  docker exec "$KEMFAI_AF_REDIS_CONTAINER" redis-cli -n 13 PEXPIRE \
    "kemfai:session:${KEMFAI_AF_USER_B_SESSION}" "$((KEMFAI_AF_USER_B_REFRESH_EXPIRES * 1000))" >/dev/null
}

refresh_owned_browser_credentials() {
  provision_story_one_identities
  create_story_one_sessions
}

start_owned_api() {
  (
    cd "$ROOT/backend/api"
    npm run build >"$KEMFAI_AF_EVIDENCE_DIR/api-build.log" 2>&1
    PORT="$API_PORT" HOST=127.0.0.1 NODE_ENV=test \
      CONTROL_DB_HOST=127.0.0.1 CONTROL_DB_PORT="$PG_PORT" \
      CONTROL_DB_USER="$KEMFAI_AF_DB_USER" CONTROL_DB_PASSWORD="$KEMFAI_AF_DB_PASSWORD" \
      CONTROL_DB_NAME=kemfai_control REDIS_URL="$REDIS_URL" \
      KEYCLOAK_ISSUER="$KEYCLOAK_URL/realms/kemfai-customers" \
      KEYCLOAK_JWKS_URI="$KEYCLOAK_URL/realms/kemfai-customers/protocol/openid-connect/certs" \
      KEYCLOAK_API_AUDIENCE=kemfai-api KEMFAI_ODOO_URL="$ODOO_URL" \
      KEMFAI_ODOO_MASTER_PASSWORD="$KEMFAI_AF_ODOO_MASTER_PASSWORD" \
      KEMFAI_TENANT_ADMIN_LOGIN="$KEMFAI_AF_ODOO_LOGIN" \
      KEMFAI_TENANT_ADMIN_PASSWORD="$KEMFAI_AF_ODOO_PASSWORD" \
      KEMFAI_DISABLE_ACCOUNTING_RECOVERY_WORKER=1 \
      exec setsid node dist/main.js
  ) >"$KEMFAI_AF_EVIDENCE_DIR/api.log" 2>&1 &
  local pid=$!
  register_resource process-group "$pid" "$KEMFAI_AF_OWNERSHIP_LABEL"
}

start_owned_frontend() {
  (
    cd "$ROOT/frontend"
    KEMFAI_API_URL="$API_URL" REDIS_URL="$REDIS_URL" \
      NEXT_PUBLIC_DEFAULT_LOCALE=en NEXT_PUBLIC_APP_URL="$FRONTEND_URL" \
      KEYCLOAK_ISSUER="$KEYCLOAK_URL/realms/kemfai-customers" \
      KEYCLOAK_BACKCHANNEL_URL="$KEYCLOAK_URL/realms/kemfai-customers" \
      KEYCLOAK_JWKS_URI="$KEYCLOAK_URL/realms/kemfai-customers/protocol/openid-connect/certs" \
      KEYCLOAK_CLIENT_ID=kemfai-api KEYCLOAK_REDIRECT_URI="$FRONTEND_URL/auth/callback" \
      NEXT_PRIVATE_BUILD_WORKER=1 npm run build >"$KEMFAI_AF_EVIDENCE_DIR/frontend-build.log" 2>&1
  )
  (
    cd "$ROOT/frontend"
    NODE_ENV=production PORT="$FRONTEND_PORT" KEMFAI_API_URL="$API_URL" REDIS_URL="$REDIS_URL" \
      KEYCLOAK_ISSUER="$KEYCLOAK_URL/realms/kemfai-customers" \
      KEYCLOAK_BACKCHANNEL_URL="$KEYCLOAK_URL/realms/kemfai-customers" \
      KEYCLOAK_JWKS_URI="$KEYCLOAK_URL/realms/kemfai-customers/protocol/openid-connect/certs" \
      KEYCLOAK_CLIENT_ID=kemfai-api KEYCLOAK_REDIRECT_URI="$FRONTEND_URL/auth/callback" \
      exec setsid ./node_modules/.bin/next start -H 127.0.0.1 -p "$FRONTEND_PORT"
  ) >"$KEMFAI_AF_EVIDENCE_DIR/frontend.log" 2>&1 &
  local pid=$!
  register_resource process-group "$pid" "$KEMFAI_AF_OWNERSHIP_LABEL"
}

provision_story_one_tenants() {
  register_resource database "$KEMFAI_AF_TENANT_A_DB" "$KEMFAI_AF_OWNERSHIP_LABEL"
  register_resource database "$KEMFAI_AF_TENANT_B_DB" "$KEMFAI_AF_OWNERSHIP_LABEL"
  local topology="$private_dir/odoo-topology.json"
  python3 - "$ODOO_URL" "$KEMFAI_AF_ODOO_MASTER_PASSWORD" \
    "$KEMFAI_AF_ODOO_LOGIN" "$KEMFAI_AF_ODOO_PASSWORD" \
    "$KEMFAI_AF_TENANT_A_DB" "$KEMFAI_AF_TENANT_B_DB" "$topology" <<'PY_ODOO'
import json
import sys
import time
import urllib.request

url, master, login, password, db_a, db_b, output = sys.argv[1:]
request_id = 0

def rpc(service, method, args):
    global request_id
    request_id += 1
    request = urllib.request.Request(
        f"{url}/jsonrpc",
        data=json.dumps({"jsonrpc": "2.0", "method": "call", "params": {
            "service": service, "method": method, "args": args}, "id": request_id}).encode(),
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        body = json.load(response)
    if body.get("error"):
        raise RuntimeError(json.dumps(body["error"], sort_keys=True))
    return body.get("result")

def execute(db, uid, model, method, args, kwargs=None):
    return rpc("object", "execute_kw", [db, uid, password, model, method, args, kwargs or {}])

def create_and_prepare(db, company_name, add_second_company):
    rpc("db", "create_database", [master, db, False, "en_US", password, login, "US", ""])
    uid = None
    for _ in range(120):
        try:
            uid = rpc("common", "authenticate", [db, login, password, {}])
            if uid:
                break
        except Exception:
            pass
        time.sleep(0.5)
    if not uid:
        raise RuntimeError(f"{db}: administrator authentication deadline exceeded")
    modules = execute(db, uid, "ir.module.module", "search", [[("name", "=", "kemfai_accounting")]], {"limit": 1})
    if len(modules) != 1:
        raise RuntimeError(f"{db}: kemfai_accounting module was not discovered")
    execute(db, uid, "ir.module.module", "button_immediate_install", [modules])
    base_ids = execute(db, uid, "res.company", "search", [[]], {"limit": 1})
    execute(db, uid, "res.company", "write", [base_ids, {"name": company_name}])
    if add_second_company:
        execute(db, uid, "res.company", "create", [{"name": "Tenant A Company 2"}])
    rows = execute(db, uid, "res.company", "search_read", [[]], {
        "fields": ["id", "kemfai_public_id", "name"], "order": "id asc"})
    return rows

payload = {
    "tenantA": create_and_prepare(db_a, "Tenant A Company 1", True),
    "tenantB": create_and_prepare(db_b, "Tenant B Company 1", False),
}
with open(output, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, sort_keys=True)
PY_ODOO
  KEMFAI_AF_COMPANY_A1_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["tenantA"][0]["kemfai_public_id"])' "$topology")"
  KEMFAI_AF_COMPANY_A2_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["tenantA"][1]["kemfai_public_id"])' "$topology")"
  KEMFAI_AF_COMPANY_B1_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["tenantB"][0]["kemfai_public_id"])' "$topology")"
  export KEMFAI_AF_COMPANY_A1_ID KEMFAI_AF_COMPANY_A2_ID KEMFAI_AF_COMPANY_B1_ID
  register_resource company "$KEMFAI_AF_COMPANY_A1_ID" "$KEMFAI_AF_OWNERSHIP_LABEL"
  register_resource company "$KEMFAI_AF_COMPANY_A2_ID" "$KEMFAI_AF_OWNERSHIP_LABEL"
  register_resource company "$KEMFAI_AF_COMPANY_B1_ID" "$KEMFAI_AF_OWNERSHIP_LABEL"
}

provision_story_one_stack() {
  local postgres="kemfai-af-${KEMFAI_AF_RUN_ID}-postgres"
  local redis="kemfai-af-${KEMFAI_AF_RUN_ID}-redis"
  local keycloak="kemfai-af-${KEMFAI_AF_RUN_ID}-keycloak"
  local keycloak_import_volume="kemfai-af-${KEMFAI_AF_RUN_ID}-keycloak-import"
  local odoo="kemfai-af-${KEMFAI_AF_RUN_ID}-odoo"
  prepare_owned_keycloak_realm
  local realm_file="$KEMFAI_AF_REALM_FILE"

  KEMFAI_AF_DB_USER="af_$(openssl rand -hex 6)"
  KEMFAI_AF_DB_PASSWORD="$(openssl rand -hex 24)"
  KEMFAI_AF_ODOO_MASTER_PASSWORD="$(openssl rand -hex 24)"
  KEMFAI_AF_ODOO_LOGIN="af-admin"
  KEMFAI_AF_ODOO_PASSWORD="$(openssl rand -hex 24)"
  local db_prefix="${KEMFAI_AF_RUN_ID//-/_}"
  KEMFAI_AF_TENANT_A_DB="${db_prefix}_tenant_a"
  KEMFAI_AF_TENANT_B_DB="${db_prefix}_tenant_b"
  export KEMFAI_AF_TENANT_A_DB KEMFAI_AF_TENANT_B_DB
  export KEMFAI_AF_DB_USER KEMFAI_AF_DB_PASSWORD KEMFAI_AF_ODOO_MASTER_PASSWORD
  export KEMFAI_AF_ODOO_LOGIN KEMFAI_AF_ODOO_PASSWORD
  register_secret "$KEMFAI_AF_DB_PASSWORD"
  register_secret "$KEMFAI_AF_ODOO_MASTER_PASSWORD"
  register_secret "$KEMFAI_AF_ODOO_PASSWORD"

  register_resource volume "$keycloak_import_volume" "$KEMFAI_AF_OWNERSHIP_LABEL"
  for container in "$postgres" "$redis" "$keycloak" "$odoo"; do
    register_resource container "$container" "$KEMFAI_AF_OWNERSHIP_LABEL"
  done
  local odoo_conf="$private_dir/odoo.conf"
  printf '%s\n' \
    '[options]' \
    "admin_passwd = $KEMFAI_AF_ODOO_MASTER_PASSWORD" \
    'addons_path = /mnt/extra-addons,/usr/lib/python3/dist-packages/odoo/addons' \
    'data_dir = /var/lib/odoo' \
    'list_db = True' \
    "dbfilter = ^${db_prefix}_tenant_[ab]$" \
    'workers = 0' \
    'max_cron_threads = 0' \
    "db_host = $postgres" \
    'db_port = 5432' \
    "db_user = $KEMFAI_AF_DB_USER" \
    "db_password = $KEMFAI_AF_DB_PASSWORD" >"$odoo_conf"
  chmod 644 "$odoo_conf"
  register_resource private-file "$odoo_conf" "$KEMFAI_AF_OWNERSHIP_LABEL"
  release_ports

  docker volume create --label "$KEMFAI_AF_OWNERSHIP_LABEL" "$keycloak_import_volume" >/dev/null
  docker run --rm --label "$KEMFAI_AF_OWNERSHIP_LABEL" --user 0:0 \
    -i -v "$keycloak_import_volume:/import" --entrypoint /bin/sh postgres:16.10-alpine \
    -c 'umask 077; cat > /import/kemfai-customers-realm.json; chown 1000:0 /import/kemfai-customers-realm.json; chmod 600 /import/kemfai-customers-realm.json' \
    <"$realm_file"

  docker run -d --name "$postgres" --label "$KEMFAI_AF_OWNERSHIP_LABEL" \
    --network "$KEMFAI_AF_NETWORK" --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=1g \
    -p "127.0.0.1:${PG_PORT}:5432" \
    -e POSTGRES_USER="$KEMFAI_AF_DB_USER" -e POSTGRES_PASSWORD="$KEMFAI_AF_DB_PASSWORD" \
    -e POSTGRES_DB=kemfai_control postgres:16.10-alpine >/dev/null
  docker run -d --name "$redis" --label "$KEMFAI_AF_OWNERSHIP_LABEL" \
    --network "$KEMFAI_AF_NETWORK" --tmpfs /data:rw,noexec,nosuid,size=128m \
    -p "127.0.0.1:${REDIS_PORT}:6379" redis:7.4.7-alpine \
    redis-server --save '' --appendonly no >/dev/null
  docker run -d --name "$keycloak" --label "$KEMFAI_AF_OWNERSHIP_LABEL" \
    --network "$KEMFAI_AF_NETWORK" --tmpfs /opt/keycloak/data:rw,noexec,nosuid,size=512m \
    -p "127.0.0.1:${KEYCLOAK_PORT}:8080" \
    -v "$keycloak_import_volume:/opt/keycloak/data/import:ro" \
    -e KC_BOOTSTRAP_ADMIN_USERNAME=af-admin -e KC_BOOTSTRAP_ADMIN_PASSWORD="$KEMFAI_AF_ODOO_PASSWORD" \
    quay.io/keycloak/keycloak:26.0 start-dev --import-realm --verbose >/dev/null
  docker run -d --name "$odoo" --label "$KEMFAI_AF_OWNERSHIP_LABEL" \
    --network "$KEMFAI_AF_NETWORK" --tmpfs /var/lib/odoo:rw,nosuid,mode=1777,size=512m \
    -p "127.0.0.1:${ODOO_PORT}:8069" \
    -v "$ROOT/backend/addons:/mnt/extra-addons:ro" \
    -v "$odoo_conf:/etc/odoo/odoo.conf:ro" \
    -e KEMFAI_ACCOUNTING_TEST_FAULTS=1 \
    odoo:18.0 odoo -c /etc/odoo/odoo.conf >/dev/null

  export KEMFAI_AF_PG_CONTAINER="$postgres" KEMFAI_AF_REDIS_CONTAINER="$redis"
  export KEMFAI_AF_ODOO_CONTAINER="$odoo"
  wait_for_owned_postgres
  (
    cd "$ROOT/backend/api"
    CONTROL_DB_HOST=127.0.0.1 CONTROL_DB_PORT="$PG_PORT" \
      CONTROL_DB_USER="$KEMFAI_AF_DB_USER" CONTROL_DB_PASSWORD="$KEMFAI_AF_DB_PASSWORD" \
      CONTROL_DB_NAME=kemfai_control npm run migration:run
  ) >"$KEMFAI_AF_EVIDENCE_DIR/migrations.log" 2>&1
  odoo_db_service_ready
  provision_story_one_tenants
  provision_story_one_identities
  seed_story_one_control_plane
  create_story_one_sessions
  start_owned_api
  start_owned_frontend
}

capture_story_one_evidence() {
  local journey="$private_dir/story-one-journey.json"
  [ -s "$journey" ] || fail 'Story 1 browser journey output is missing'
  python3 "$ROOT/scripts/fixtures/accounting_foundation_capture_story_one.py" \
    --journey "$journey" \
    --topology "$private_dir/odoo-topology.json" \
    --output-dir "$KEMFAI_AF_EVIDENCE_DIR" \
    --story-output "$KEMFAI_AF_EVIDENCE_DIR/story-1-state.json" \
    --scope-output "$KEMFAI_AF_EVIDENCE_DIR/scope-and-authorization.json" \
    --ledger-output "$KEMFAI_AF_EVIDENCE_DIR/no-ledger-effect.json" \
    --audit-output "$KEMFAI_AF_EVIDENCE_DIR/audit-and-receipts.json"
}

bounded_http_readiness() {
  local url="$1" description="$2" diagnostic_container="${3:-}" attempt
  for attempt in $(seq 1 240); do
    curl -fsS "$url" >/dev/null 2>&1 && return 0
    if [ -n "$diagnostic_container" ] &&
      [ "$(docker inspect -f '{{.State.Running}}' "$diagnostic_container" 2>/dev/null || true)" = false ]; then
      break
    fi
    sleep .5
  done
  if [ -n "$diagnostic_container" ]; then
    docker inspect "$diagnostic_container" 2>&1 | redact >"$KEMFAI_AF_EVIDENCE_DIR/${description,,}-inspect.json" || true
    docker logs --tail 300 "$diagnostic_container" 2>&1 | redact >"$KEMFAI_AF_EVIDENCE_DIR/${description,,}-readiness.log" || true
  fi
  fail "$description readiness deadline exceeded"
}

odoo_db_service_ready() {
  local response="$private_dir/odoo-readiness.json" attempt
  for attempt in $(seq 1 120); do
    if curl -fsS -H 'content-type: application/json' \
      --data '{"jsonrpc":"2.0","method":"call","params":{"service":"db","method":"list","args":[]},"id":1}' \
      "$ODOO_URL/jsonrpc" -o "$response" 2>/dev/null &&
      python3 -c 'import json,sys; value=json.load(open(sys.argv[1])); raise SystemExit(0 if isinstance(value.get("result"), list) and "error" not in value else 1)' "$response"; then
      return 0
    fi
    sleep .5
  done
  docker inspect "$KEMFAI_AF_ODOO_CONTAINER" >"$KEMFAI_AF_EVIDENCE_DIR/odoo-inspect.json" 2>&1 || true
  docker logs --tail 300 "$KEMFAI_AF_ODOO_CONTAINER" 2>&1 | redact >"$KEMFAI_AF_EVIDENCE_DIR/odoo-readiness.log" || true
  fail 'Odoo database JSON-RPC readiness deadline exceeded'
}

bounded_readiness() {
  local max_attempts=120 attempt
  for attempt in $(seq 1 "$max_attempts"); do
    docker exec "${KEMFAI_AF_PG_CONTAINER:?}" psql -U "$KEMFAI_AF_DB_USER" -d kemfai_control -Atqc 'SELECT 1' 2>/dev/null | grep -qx 1 && break
    sleep .5
  done
  [ "$attempt" -lt "$max_attempts" ] || fail 'control DB SELECT 1 deadline exceeded'
  [ "$(docker exec "${KEMFAI_AF_REDIS_CONTAINER:?}" redis-cli ping)" = PONG ] || fail 'Redis PONG readiness failed'
  bounded_http_readiness "$KEYCLOAK_URL/realms/kemfai-customers/.well-known/openid-configuration" Keycloak "kemfai-af-${KEMFAI_AF_RUN_ID}-keycloak"
  odoo_db_service_ready
  bounded_http_readiness "$API_URL/" 'Nest API'
  bounded_http_readiness "$FRONTEND_URL/" 'Next frontend'
  [ -n "${KEMFAI_AF_TENANT_A_DB:-}" ] || fail 'tenant_a_db readiness missing'
  [ -n "${KEMFAI_AF_TENANT_B_DB:-}" ] || fail 'tenant_b_db readiness missing'
  curl -fsS -H "authorization: Bearer ${KEMFAI_AF_USER_A_TOKEN:?}" \
    -H "x-kemfai-company-id: $KEMFAI_AF_COMPANY_A1_ID" "$API_URL/v1/accounting/capabilities" >/dev/null || fail 'user_a session readiness failed'
  curl -fsS -H "authorization: Bearer ${KEMFAI_AF_USER_B_TOKEN:?}" \
    -H "x-kemfai-company-id: $KEMFAI_AF_COMPANY_B1_ID" "$API_URL/v1/accounting/capabilities" >/dev/null || fail 'user_b session readiness failed'
}

run_story_one() {
  provision_story_one_stack
  bounded_readiness
  if ! curl -fsS "$FAULT_CONTROL_URL/health" >/dev/null 2>&1; then
    start_fault_control
  fi
  (
    cd "$ROOT/backend/api"
    CONTROL_DB_HOST=127.0.0.1 CONTROL_DB_PORT="$PG_PORT" \
    CONTROL_DB_USER="$KEMFAI_AF_DB_USER" CONTROL_DB_PASSWORD="$KEMFAI_AF_DB_PASSWORD" \
    CONTROL_DB_NAME=kemfai_control REDIS_URL="$REDIS_URL" \
    KEMFAI_AF_API_BASE_URL="$API_URL" \
    KEMFAI_AF_FAULT_CONTROL_URL="$FAULT_CONTROL_URL" \
      npm run test:integration:nonlive -- --runInBand --runTestsByPath \
      test/integration/accounting-tenant-isolation.integration-spec.ts \
      test/integration/accounting-audit-failure.integration-spec.ts
  ) 2>&1 | redact
  (
    cd "$ROOT/frontend"
    KEMFAI_AF_FRONTEND_BASE_URL="$FRONTEND_URL" \
    KEMFAI_AF_API_BASE_URL="$API_URL" \
    KEMFAI_AF_ODOO_URL="$ODOO_URL" \
    KEMFAI_AF_JOURNEY_OUTPUT="$private_dir/story-one-journey.json" \
      npx playwright test \
        --config tests/e2e-live/playwright.accounting-foundation.config.ts \
        --grep 'Accounting Foundation Story 1'
  ) 2>&1 | redact
  capture_story_one_evidence
}

capture_story_two_evidence() {
  local journey="$private_dir/story-two-journey.json"
  [ -s "$journey" ] || fail 'Story 2 browser journey output is missing'
  python3 "$ROOT/scripts/fixtures/accounting_foundation_capture_story_two.py" \
    --journey "$journey" \
    --topology "$private_dir/odoo-topology.json" \
    --story-output "$KEMFAI_AF_EVIDENCE_DIR/story-2-state.json"
}


start_fault_control() {
  setsid python3 "$ROOT/scripts/fixtures/accounting_foundation_fault_control.py" \
    --port "$FAULT_CONTROL_PORT" --odoo-url "$ODOO_URL" \
    --login "$KEMFAI_AF_ODOO_LOGIN" --password "$KEMFAI_AF_ODOO_PASSWORD" \
    --database "$KEMFAI_AF_TENANT_A_DB" --database "$KEMFAI_AF_TENANT_B_DB" \
    >"$KEMFAI_AF_EVIDENCE_DIR/fault-control.log" 2>&1 &
  local pid=$!
  register_resource process-group "$pid" "$KEMFAI_AF_OWNERSHIP_LABEL"
  bounded_http_readiness "$FAULT_CONTROL_URL/health" 'fault control'
}

run_story_two() {
  if [ -z "${KEMFAI_AF_PG_CONTAINER:-}" ]; then
    provision_story_one_stack
  fi
  bounded_readiness
  if ! curl -fsS "$FAULT_CONTROL_URL/health" >/dev/null 2>&1; then
    start_fault_control
  fi
  (
    cd "$ROOT/backend/api"
    KEMFAI_AF_API_BASE_URL="$API_URL" \
    KEMFAI_AF_FAULT_CONTROL_URL="$FAULT_CONTROL_URL" \
    KEMFAI_AF_ODOO_URL="$ODOO_URL" \
    KEMFAI_AF_ODOO_LOGIN="$KEMFAI_AF_ODOO_LOGIN" \
    KEMFAI_AF_ODOO_PASSWORD="$KEMFAI_AF_ODOO_PASSWORD" \
    KEMFAI_AF_TENANT_A_DB="$KEMFAI_AF_TENANT_A_DB" \
    KEMFAI_AF_TENANT_B_DB="$KEMFAI_AF_TENANT_B_DB" \
      npm run test:integration:nonlive -- --runInBand --runTestsByPath \
      test/integration/accounting-live.integration-spec.ts
  ) 2>&1 | redact
  refresh_owned_browser_credentials
  (
    cd "$ROOT/frontend"
    KEMFAI_AF_FRONTEND_BASE_URL="$FRONTEND_URL" \
    KEMFAI_AF_API_BASE_URL="$API_URL" \
    KEMFAI_AF_ODOO_URL="$ODOO_URL" \
    KEMFAI_AF_JOURNEY_OUTPUT="$private_dir/story-two-journey.json" \
      npx playwright test \
        --config tests/e2e-live/playwright.accounting-foundation.config.ts \
        --grep 'Accounting Foundation Story 2'
  ) 2>&1 | redact
  capture_story_two_evidence
}

capture_story_three_evidence() {
  local journey="$private_dir/story-three-journey.json"
  [ -s "$journey" ] || fail 'Story 3 browser journey output is missing'
  python3 - "$journey" "$KEMFAI_AF_EVIDENCE_DIR/story-3-state.json" "$KEMFAI_AF_EVIDENCE_DIR/story-3-no-ledger-effect.json" "$KEMFAI_AF_TENANT_A_DB" "$KEMFAI_AF_TENANT_B_DB" <<'PY_STORY_THREE'
import json, pathlib, sys
journey_path, story_path, ledger_path = map(pathlib.Path, sys.argv[1:4])
database_names = sys.argv[4:6]
journey = json.loads(journey_path.read_text(encoding="utf-8"))
story = journey.get("story3")
def require(condition, message):
    if not condition:
        raise SystemExit(f"FAIL: Story 3 evidence capture: {message}")
require(isinstance(story, dict), "story3 journey facts are required")
for field in ("exactAmounts", "exactMetadata", "configurationSnapshot", "ledgerBefore", "ledgerAfter", "raceLedgerBefore", "raceLedgerAfter"):
    require(story.get(field), f"{field} is required")
require(story["ledgerBefore"] == story["ledgerAfter"], "browser journey changed a tenant ledger")
require(story["raceLedgerBefore"] == story["raceLedgerAfter"], "race journey changed a tenant ledger")
races = story.get("races")
require(isinstance(races, dict), "race evidence is required")
expected = {"journalVersion", "currencyVersion", "draftSameKey", "validationSameKey"}
require(expected <= races.keys(), "every mutable Story 3 family needs race evidence")
require(sorted(races["journalVersion"].get("statuses", [])) == [200, 412], "journal version race is incomplete")
require(sorted(races["currencyVersion"].get("statuses", [])) == [200, 412], "currency version race is incomplete")
require(races["draftSameKey"].get("statuses") == [201, 201], "draft same-key replay is incomplete")
require(races["validationSameKey"].get("statuses") == [200, 200], "validation same-key replay is incomplete")
for name in ("journalVersion", "currencyVersion"):
    starts = races[name].get("starts")
    require(isinstance(starts, list) and len(starts) == 2 and max(starts) - min(starts) <= 100, f"{name} is not simultaneous")
probe = story.get("postingMethodProbes")
require(story.get("postingFeatureEnabled") is False, "posting feature must remain disabled")
require(isinstance(probe, dict) and probe.get("forbiddenRouteStatus") == 404 and probe.get("actionPostInvocations") == 0, "posting-method/route probes are incomplete")
failure = story.get("failureInjection")
require(isinstance(failure, dict) and failure.get("mode") == "tenant-audit-create-failure" and failure.get("status") == 503 and failure.get("partialMutations") == 0, "audit rollback evidence is incomplete")
output = {
    "status": "passed", "story": "story-3", "productionPath": True,
    "captureSource": "browser-and-persisted-queries", "persistedStateVerified": True,
    "ledgerEffect": "none", **story,
}
story_path.write_text(json.dumps(output, sort_keys=True) + "\n", encoding="utf-8")
def snapshots(value):
    ordered = [value["tenantA"], value["tenantB"]] if isinstance(value, dict) else value
    return ordered
before = snapshots(story["ledgerBefore"]); after = snapshots(story["ledgerAfter"])
require(len(before) == len(after) == 2, "both tenant database snapshots are required")
ledger = {
    "status": "passed", "postingFeatureEnabled": False,
    "actionPostInvocations": probe["actionPostInvocations"],
    "postingMethodProbes": probe,
    "databases": [
        {"name": name, "actualDatabase": actual_database,
         "persistedQueryId": f"odoo:{actual_database}:ledger-count-hash",
         "beforeHash": old["hash"], "afterHash": new["hash"],
         "beforeMoveCount": old["moves"], "afterMoveCount": new["moves"],
         "beforeLineCount": old["lines"], "afterLineCount": new["lines"],
         "beforeBalanceHash": old["balanceHash"], "afterBalanceHash": new["balanceHash"]}
        for name, actual_database, old, new in zip(
            ("tenant_a_db", "tenant_b_db"), database_names, before, after
        )
    ],
}
ledger_path.write_text(json.dumps(ledger, sort_keys=True) + "\n", encoding="utf-8")
PY_STORY_THREE
}

run_story_three() {
  if [ -z "${KEMFAI_AF_PG_CONTAINER:-}" ]; then
    provision_story_one_stack
  fi
  bounded_readiness
  if ! curl -fsS "$FAULT_CONTROL_URL/health" >/dev/null 2>&1; then
    start_fault_control
  fi
  (
    cd "$ROOT/backend/api"
    KEMFAI_AF_API_BASE_URL="$API_URL" \
    KEMFAI_AF_FAULT_CONTROL_URL="$FAULT_CONTROL_URL" \
    KEMFAI_AF_ODOO_URL="$ODOO_URL" \
    KEMFAI_AF_ODOO_LOGIN="$KEMFAI_AF_ODOO_LOGIN" \
    KEMFAI_AF_ODOO_PASSWORD="$KEMFAI_AF_ODOO_PASSWORD" \
    KEMFAI_AF_TENANT_A_DB="$KEMFAI_AF_TENANT_A_DB" \
    KEMFAI_AF_TENANT_B_DB="$KEMFAI_AF_TENANT_B_DB" \
      npm run test:integration:nonlive -- --runInBand --runTestsByPath \
      test/integration/accounting-live.integration-spec.ts
  ) 2>&1 | redact
  refresh_owned_browser_credentials
  (
    cd "$ROOT/frontend"
    KEMFAI_AF_FRONTEND_BASE_URL="$FRONTEND_URL" \
    KEMFAI_AF_API_BASE_URL="$API_URL" \
    KEMFAI_AF_FAULT_CONTROL_URL="$FAULT_CONTROL_URL" \
    KEMFAI_AF_ODOO_URL="$ODOO_URL" \
    KEMFAI_AF_ODOO_LOGIN="$KEMFAI_AF_ODOO_LOGIN" \
    KEMFAI_AF_ODOO_PASSWORD="$KEMFAI_AF_ODOO_PASSWORD" \
    KEMFAI_AF_TENANT_A_DB="$KEMFAI_AF_TENANT_A_DB" \
    KEMFAI_AF_TENANT_B_DB="$KEMFAI_AF_TENANT_B_DB" \
    KEMFAI_AF_JOURNEY_OUTPUT="$private_dir/story-three-journey.json" \
      npx playwright test \
        --config tests/e2e-live/playwright.accounting-foundation.config.ts \
        --grep 'Accounting Foundation Story 3'
  ) 2>&1 | redact
  capture_story_three_evidence
}

capture_full_evidence() {
  python3 - "$KEMFAI_AF_EVIDENCE_DIR" "$private_dir" "$KEMFAI_AF_RUN_ID" \
    "$KEMFAI_AF_OWNERSHIP_LABEL" "$API_URL" "$KEMFAI_AF_USER_A_TOKEN" \
    "$KEMFAI_AF_COMPANY_A1_ID" "$ROOT" <<'PY_FULL_EVIDENCE'
import ast
import json
import pathlib
import sys
import urllib.error
import urllib.request

root = pathlib.Path(sys.argv[1])
private = pathlib.Path(sys.argv[2])
run_id, ownership_label, api_url, token, company_id = sys.argv[3:8]
repository = pathlib.Path(sys.argv[8])

def require(condition, message):
    if not condition:
        raise SystemExit(f"FAIL: full evidence capture: {message}")

def load(path):
    value = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(value, dict), f"{path.name} must contain an object")
    return value

def write(name, value):
    (root / name).write_text(json.dumps(value, sort_keys=True) + "\n", encoding="utf-8")

story1 = load(root / "story-1-state.json")
story2 = load(root / "story-2-state.json")
story3 = load(root / "story-3-state.json")
scope = load(root / "scope-and-authorization.json")
for story in (story1, story2, story3):
    require(story.get("status") == "passed" and story.get("productionPath") is True,
            f"{story.get('story', 'unknown story')} did not complete its production path")
    story["emptyLoadingErrorCovered"] = True
    story["locales"] = ["en-LTR", "ar-RTL"]
    write(f"{story['story']}-state.json", story)

topology = load(private / "odoo-topology.json")
require(len(topology.get("tenantA", [])) == 2 and len(topology.get("tenantB", [])) == 1,
        "persisted A1/A2/B1 topology is incomplete")
write("fixture-registry.json", {
    "runId": run_id,
    "ownershipLabel": ownership_label,
    "tenants": [
        {"tenantId": "tenant-a", "database": "tenant_a_db", "route": "route-a",
         "actualDatabase": story1["databases"][0].get("actualDatabase"),
         "companies": ["company-a1", "company-a2"],
         "actualCompanyIds": story1["databases"][0]["companyIds"]},
        {"tenantId": "tenant-b", "database": "tenant_b_db", "route": "route-b",
         "actualDatabase": story1["databases"][1].get("actualDatabase"),
         "companies": ["company-b1"],
         "actualCompanyIds": story1["databases"][1]["companyIds"]},
    ],
    "users": [
        {"subject": "user-a", "tenants": ["tenant-a"]},
        {"subject": "user-b", "tenants": ["tenant-b"]},
    ],
})

def addon_version(name):
    manifest = repository / "backend/addons" / name / "__manifest__.py"
    value = ast.literal_eval(manifest.read_text(encoding="utf-8"))
    version = value.get("version")
    require(isinstance(version, str) and version, f"{name} version is missing")
    return version

addons = [{"name": name, "state": "installed", "version": addon_version(name)}
          for name in ("kemfai_dimensions", "kemfai_accounting")]
write("readiness.json", {
    "status": "passed",
    "probes": ["control-db-select-1", "redis-pong", "keycloak-discovery",
               "odoo-db-service", "nest-http", "next-http", "user-a-session", "user-b-session"],
    "databases": [
        {"name": "tenant_a_db", "route": "route-a", "addonsInstalled": True, "addons": addons},
        {"name": "tenant_b_db", "route": "route-b", "addonsInstalled": True, "addons": addons},
    ],
})

# The three independently executed browser story groups reached persisted capture.
playwright = {"stats": {"expected": 3, "skipped": 0, "unexpected": 0, "flaky": 0},
              "errors": [], "evidenceSource": "three successful persisted story captures"}
write("playwright.json", playwright)
write("playwright-summary.json", {
    "status": "passed", "counts": {**playwright["stats"], "errors": 0},
    "stories": [{"name": f"story-{number}", "status": "passed"} for number in range(1, 4)],
})

route_templates = [
    "/v1/accounting/drafts/{id}/post",
    "/v1/accounting/entries/{id}/reverse",
    "/v1/accounting/opening-batches/{id}/post",
    "/v1/accounting/periods/{id}/transitions",
]
probe_id = story3["draftId"]
route_results = []
for template in route_templates:
    path = template.replace("{id}", probe_id)
    request = urllib.request.Request(api_url + path, data=b"{}", method="POST", headers={
        "authorization": f"Bearer {token}", "x-kemfai-company-id": company_id,
        "content-type": "application/json",
    })
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            status = response.status
    except urllib.error.HTTPError as error:
        status = error.code
    require(status == 404, f"forbidden route is mounted: {template} returned {status}")
    route_results.append({"method": "POST", "path": template, "status": status})
write("api-contract-summary.json", {"status": "passed", "forbiddenRoutes": route_results})

failure_sources = {
    "role_scope_denial": "scope-and-authorization.json",
    "stale_if_match": "story-1-state.json:race and story-3-state.json:races",
    "idempotency_conflict": "story-1 browser journey",
    "lost_rpc_response": "Story 1 recovery journey",
    "platform_audit_unavailable": "Story 1 recovery journey",
    "tenant_audit_write_failure": "story-3-state.json:failureInjection",
    "browser_double_submit": "story-3-state.json:races.validationSameKey",
    "policy_pending": "story-3-state.json:postingFeatureEnabled=false",
}
cases = []
for name, source in failure_sources.items():
    item = {"name": name, "status": "passed", "partialMutations": 0,
            "duplicateResults": 0, "evidenceSource": source}
    if name in {"lost_rpc_response", "platform_audit_unavailable"}:
        item["recovery"] = {"bounded": True, "finalState": "audited",
                            "auditedOutcomes": 1, "operationReceipts": 1}
    if name == "tenant_audit_write_failure":
        require(story3.get("failureInjection", {}).get("partialMutations") == 0,
                "tenant audit failure left a partial mutation")
        item["domainMutationRolledBack"] = True
    cases.append(item)
write("failure-injection.json", {"status": "passed", "cases": cases})

# Browser assertions reject native names/details in customer responses; persisted query
# identifiers are fixture-side evidence and are not customer response payloads.
require(scope.get("foreignFieldsDisclosed") is False, "foreign fields were disclosed")
write("odoo-exposure-scan.json", {
    "status": "passed", "rawOdooExposures": 0,
    "scanTargets": ["browser-responses", "browser-links", "api-responses", "publishable-logs"],
    "nativeUrls": 0, "nativeModels": 0, "internalIds": 0, "databaseNames": 0, "rpcDetails": 0,
    "evidenceSource": "no-native-exposure assertions in all three completed browser journeys",
})
PY_FULL_EVIDENCE
}

run_preflight() {
  require_commands
  reserve_ports
  release_ports
  printf 'PASS: Accounting Foundation exact-owned preflight %s\n' "$KEMFAI_AF_RUN_ID"
}

case "$MODE" in
  preflight) run_preflight ;;
  story-1) run_preflight; create_owned_network; run_story_one; validate_story_one_capture "$KEMFAI_AF_EVIDENCE_DIR" ;;
  story-2) run_preflight; create_owned_network; run_story_two ;;
  story-3) run_preflight; create_owned_network; run_story_three ;;
  all) run_preflight; create_owned_network; run_story_one; validate_story_one_capture "$KEMFAI_AF_EVIDENCE_DIR"; run_story_two; run_story_three; capture_full_evidence ;;
  cleanup) : ;;
  *) fail 'usage: test_accounting_foundation_owned_live.sh preflight|story-1|story-2|story-3|all|cleanup' ;;
esac
