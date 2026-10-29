#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REALM="$ROOT/infra/keycloak/kemfai-customers-realm.json"
IMAGE="${KEMFAI_T096_KEYCLOAK_IMAGE:-quay.io/keycloak/keycloak:26.0}"
OWNER="t096-$(date +%s)-$$-$(openssl rand -hex 6)"
NAME="kemfai-t096-keycloak-${OWNER}"
ADMIN_PASSWORD="$(openssl rand -hex 24)"
CLIENT_SECRET="$(openssl rand -hex 24)"
HEADERS="$(mktemp)"
CREATED=0
STAGE=init

cleanup() {
  rm -f "$HEADERS"
  if [[ "$CREATED" == 1 ]] && docker inspect "$NAME" >/dev/null 2>&1; then
    local actual_owner
    actual_owner="$(docker inspect --format '{{ index .Config.Labels "kemfai.fixture.owner" }}' "$NAME")"
    if [[ "$actual_owner" != "$OWNER" ]]; then
      printf 'REFUSING CLEANUP: owner mismatch for %s\n' "$NAME" >&2
      return 1
    fi
    docker rm -fv -- "$NAME" >/dev/null
  fi
}

on_error() {
  local code=$?
  printf 'T096 runtime failed at stage=%s exit=%s\n' "$STAGE" "$code" >&2
  if [[ "$CREATED" == 1 ]]; then docker logs "$NAME" 2>&1 | tail -n 80 >&2 || true; fi
  exit "$code"
}
trap cleanup EXIT
trap on_error ERR

docker info >/dev/null
[[ -f "$REALM" ]]

STAGE=container-start
docker run -d \
  --name "$NAME" \
  --label kemfai.fixture=T096 \
  --label "kemfai.fixture.owner=$OWNER" \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=t096-admin \
  -e KC_BOOTSTRAP_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  -e KEYCLOAK_USERS_CLIENT_SECRET="$CLIENT_SECRET" \
  -v "$REALM:/opt/keycloak/data/import/kemfai-customers-realm.json:ro" \
  -p 127.0.0.1::8080 \
  "$IMAGE" start-dev --import-realm >/dev/null
CREATED=1
PORT="$(docker port "$NAME" 8080/tcp | python3 -c 'import sys; print(sys.stdin.read().strip().rsplit(":", 1)[-1])')"
[[ "$PORT" =~ ^[0-9]+$ ]]

STAGE=readiness
READY=0
for _ in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:${PORT}/realms/kemfai-customers/.well-known/openid-configuration" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done
[[ "$READY" == 1 ]]

STAGE=scoped-token
TOKEN_JSON="$(curl -fsS -X POST \
  "http://127.0.0.1:${PORT}/realms/kemfai-customers/protocol/openid-connect/token" \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode grant_type=client_credentials \
  --data-urlencode client_id=kemfai-users \
  --data-urlencode client_secret="$CLIENT_SECRET")"
TOKEN="$(TOKEN_JSON="$TOKEN_JSON" python3 -c 'import json, os; print(json.loads(os.environ["TOKEN_JSON"])["access_token"])')"
ROLES="$(TOKEN="$TOKEN" python3 -c 'import base64, json, os; p=os.environ["TOKEN"].split(".")[1]; p += "=" * (-len(p) % 4); print(",".join(sorted(json.loads(base64.urlsafe_b64decode(p)).get("resource_access", {}).get("realm-management", {}).get("roles", []))))')"
[[ "$ROLES" == 'manage-users,view-realm' ]]
BASE="http://127.0.0.1:${PORT}/admin/realms/kemfai-customers"

STAGE=role-read
[[ "$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/roles/WorkspaceOwner")" == 200 ]]

STAGE=user-create
EMAIL="t096-$(date +%s)-$$@example.invalid"
[[ "$(curl -sS -D "$HEADERS" -o /dev/null -w '%{http_code}' -X POST "$BASE/users" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  --data "{\"username\":\"$EMAIL\",\"email\":\"$EMAIL\",\"enabled\":true}")" == 201 ]]
LOCATION="$(python3 - "$HEADERS" <<'PY'
import sys
for line in open(sys.argv[1]):
    if line.lower().startswith('location:'):
        print(line.split(':', 1)[1].strip())
        break
PY
)"
[[ -n "$LOCATION" ]]

STAGE=user-delete
[[ "$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE -H "Authorization: Bearer $TOKEN" "$LOCATION")" == 204 ]]

STAGE=broader-admin-denial
DENIED="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/clients" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  --data '{"clientId":"t096-must-be-forbidden"}')"
[[ "$DENIED" == 403 ]]

STAGE=cleanup
cleanup
CREATED=0
trap - EXIT
[[ -z "$(docker ps -aq --filter "label=kemfai.fixture.owner=$OWNER")" ]]
printf 'PASS: Keycloak 26 realm imported with exact manage-users,view-realm token roles\n'
printf 'PASS: role read and user create/delete allowed; broader client administration denied 403\n'
printf 'PASS: owned fixture cleanup verified\n'
