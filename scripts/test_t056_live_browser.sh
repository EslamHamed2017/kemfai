#!/usr/bin/env bash
# T056 round-5 item 6: a real, OWNED-scratch, authenticated BROWSER -> Next.js BFF ->
# NestJS API -> real Odoo end-to-end proof, covering:
#   - Alpha logs in through the REAL Keycloak hosted login page (not a stub), fills and
#     saves a setup-wizard step, which persists through the real BFF/API into Alpha's
#     own real Odoo database.
#   - A stale/foreign setup scope is rejected (412) before any Odoo mutation.
#   - Alpha clicks the real shared SignOutButton; the real logout BFF route expires the
#     session cookie; the browser hard-navigates to the login page.
#   - Beta (a second, independent real Keycloak user/tenant/Odoo database) logs in fresh
#     and mounts the wizard: Alpha's data is never present.
#
# Every resource here is newly created by THIS run and labelled with this run's id
# (kemfai.t056.run=<run_id>) — the shared dev stack (kemfai-db/kemfai-odoo/kemfai-keycloak/
# kemfai-api/kemfai-frontend) is never read, written, started, stopped, or mutated.
# Mirrors the ownership/cleanup/secrets discipline already established in
# scripts/test_t054_live.sh (same conventions, extended here to also cover a real Keycloak
# realm/client/users and real running API + frontend server processes, since T054's
# harness only reaches the API layer via supertest, never a real browser).
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
addons_dir="$repo_dir/backend/addons"
api_dir="$repo_dir/backend/api"
frontend_dir="$repo_dir/frontend"
# shellcheck source=scripts/lib_docker_test_cleanup.sh
. "$repo_dir/scripts/lib_docker_test_cleanup.sh"

command -v docker >/dev/null 2>&1 || { echo "FAIL: docker CLI is not available" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "FAIL: docker daemon is not reachable" >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "FAIL: openssl is required to generate scratch credentials" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "FAIL: curl is required" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "FAIL: python3 is required to parse JSON responses" >&2; exit 1; }

run_id="t056r$(openssl rand -hex 5)"
label="kemfai.t056.run=${run_id}"
network="${run_id}_net"
pg_container="${run_id}_pg"
redis_container="${run_id}_redis"
kc_container="${run_id}_kc"
http_container="${run_id}_http"
alpha_db="${run_id}_alpha"
beta_db="${run_id}_beta"
control_db="${run_id}_ctrl"

pg_password="$(openssl rand -hex 20)"
odoo_master_password="$(openssl rand -hex 20)"
odoo_admin_login="t056admin${RANDOM}@example.com"
odoo_admin_password="$(openssl rand -hex 20)"
kc_admin_user="t056kcadmin"
kc_admin_password="$(openssl rand -hex 20)"
alpha_password="$(openssl rand -hex 24)"
beta_password="$(openssl rand -hex 24)"
if [ -z "$alpha_password" ] || [ -z "$beta_password" ] || [ "$alpha_password" = "$beta_password" ]; then
  echo "FAIL: runtime-generated browser credentials must be nonempty and distinct" >&2
  exit 1
fi

# Preflight: ask the OS for two currently-free loopback ports instead of hardcoding
# fixed ones, so this run never collides with (or has to choose around) some other
# process already bound to a fixed port on this host.
free_port() {
  python3 -c 'import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()'
}
api_port="$(free_port)"
frontend_port="$(free_port)"

umask 077
artifacts_dir="${KEMFAI_ARTIFACTS_DIR:-$(dirname "$repo_dir")/t056-live-evidence-${run_id}}"
mkdir -p "$artifacts_dir"
chmod 700 "$artifacts_dir"
evidence_file="$artifacts_dir/evidence.txt"

private_dir="$(mktemp -d)"
chmod 700 "$private_dir"
early_private_cleanup() {
  local early_status=$?
  set +e
  if ! rm -rf -- "$private_dir"; then
    early_status=1
  fi
  trap - EXIT
  exit "$early_status"
}
trap early_private_cleanup EXIT

# Keep every value used for log/artifact redaction in one owner-only file.  The
# redactor receives only this path in argv; secret bytes are never command-line
# arguments.  NUL delimiters make replacement literal-safe for arbitrary generated
# values without regex or shell escaping.
redaction_secrets_file="$private_dir/redaction-secrets.bin"
printf '%s\0' "$pg_password" "$odoo_master_password" "$odoo_admin_password" \
  "$kc_admin_password" "$alpha_password" "$beta_password" > "$redaction_secrets_file"
chmod 600 "$redaction_secrets_file"

redactor_program="$private_dir/redact.py"
cat > "$redactor_program" <<'PYEOF'
import os
import stat
import sys


def load_secrets(path):
    metadata = os.lstat(path)
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != os.geteuid()
        or stat.S_IMODE(metadata.st_mode) != 0o600
    ):
        raise RuntimeError("unsafe secret store")
    with open(path, "rb") as source:
        values = [value for value in source.read().split(b"\0") if value]
    if not values:
        raise RuntimeError("empty secret store")
    return sorted(set(values), key=len, reverse=True)


def redact(data, secrets):
    for secret in secrets:
        data = data.replace(secret, b"[REDACTED]")
    return data


def scrub_tree(root, secrets):
    root_metadata = os.lstat(root)
    if not stat.S_ISDIR(root_metadata.st_mode) or stat.S_ISLNK(root_metadata.st_mode):
        raise RuntimeError("unsafe artifact directory")
    os.chmod(root, 0o700)
    for current_root, directories, filenames in os.walk(root, topdown=True, followlinks=False):
        for directory in directories:
            directory_path = os.path.join(current_root, directory)
            metadata = os.lstat(directory_path)
            if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
                raise RuntimeError("unsafe artifact entry")
            os.chmod(directory_path, 0o700)
        for filename in filenames:
            artifact_path = os.path.join(current_root, filename)
            metadata = os.lstat(artifact_path)
            if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
                raise RuntimeError("unsafe artifact entry")
            with open(artifact_path, "r+b", buffering=0) as artifact:
                content = redact(artifact.read(), secrets)
                artifact.seek(0)
                artifact.write(content)
                artifact.truncate()
                os.fchmod(artifact.fileno(), 0o600)
                os.fsync(artifact.fileno())


try:
    operation, secret_path = sys.argv[1:3]
    known_secrets = load_secrets(secret_path)
    if operation == "stream" and len(sys.argv) == 3:
        sys.stdout.buffer.write(redact(sys.stdin.buffer.read(), known_secrets))
    elif operation == "tree" and len(sys.argv) == 4:
        scrub_tree(sys.argv[3], known_secrets)
    else:
        raise RuntimeError("invalid redaction operation")
except Exception:
    print("FAIL: private credential redaction failed", file=sys.stderr)
    sys.exit(1)
PYEOF
chmod 600 "$redactor_program"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# Retained artifacts (and anything echoed to this script's own stdout/stderr) must
# never carry a generated secret. Pipe any log content that might quote a failed
# command's connection string/credentials through this before printing or persisting
# it. The admin bearer token is appended to the private store as soon as it exists.
redact_secrets() {
  python3 "$redactor_program" stream "$redaction_secrets_file"
}

scrub_retained_artifacts() {
  python3 "$redactor_program" tree "$redaction_secrets_file" "$artifacts_dir"
}

api_pid=""
frontend_pid=""
kemfai_docker_cleanup_init "kemfai.t056.run" "$run_id"

# Each of api_pid/frontend_pid is started below via `setsid`, which puts it in a brand
# new session/process group equal to its own pid — so `kill -- -$pid` (negative: the
# whole group) also reaches any child the launcher spawns (e.g. `npx next start`'s real
# `next-server` worker, which is NOT the pid npx itself prints), never just the single
# launcher pid. Before signalling anything, verify the pid still looks like a process
# THIS run started (its /proc cmdline still contains the expected marker) — a plain
# `kill $pid` after this run's own process already exited and the pid got recycled by
# the OS for an unrelated process would otherwise kill a stranger's process by fixed pid.
pid_owned_by_this_run() {
  local pid="$1" expected_substr="$2"
  [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ] || return 1
  tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qF -- "$expected_substr"
}
terminate_owned_process_group() {
  local pid="$1" expected_substr="$2"
  [ -n "$pid" ] || return 0
  if ! pid_owned_by_this_run "$pid" "$expected_substr"; then
    echo "SKIP cleanup: pid ${pid} no longer matches this run's '${expected_substr}' process — not touching it" >&2
    return 0
  fi
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
  for _ in $(seq 1 20); do
    [ -d "/proc/$pid" ] || return 0
    sleep 0.2
  done
  kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
}

cleanup() {
  local cleanup_status=$?
  local cleanup_verification_failed=0
  local container_survivors=""
  local network_survivors=""
  local resource_id=""
  local ownership_status=0
  set +e
  echo "== Cleanup: removing only resources labelled ${label} =="
  terminate_owned_process_group "$frontend_pid" "next"
  terminate_owned_process_group "$api_pid" "dist/main.js"
  kemfai_cleanup_owned_containers || cleanup_verification_failed=1
  kemfai_cleanup_owned_networks || cleanup_verification_failed=1
  if ! container_survivors="$(
    docker ps -aq --filter "label=kemfai.t056.run=${run_id}" 2>/dev/null
  )"; then
    echo "FAIL cleanup: unable to verify exact-label T056 container cleanup for run ${run_id}" >&2
    cleanup_verification_failed=1
  elif [ -n "$container_survivors" ]; then
    echo "FAIL cleanup: exact-label T056 container survivor(s) detected for run ${run_id}" >&2
    cleanup_verification_failed=1
  fi
  if ! network_survivors="$(
    docker network ls -q --filter "label=kemfai.t056.run=${run_id}" 2>/dev/null
  )"; then
    echo "FAIL cleanup: unable to verify exact-label T056 network cleanup for run ${run_id}" >&2
    cleanup_verification_failed=1
  elif [ -n "$network_survivors" ]; then
    echo "FAIL cleanup: exact-label T056 network survivor(s) detected for run ${run_id}" >&2
    cleanup_verification_failed=1
  fi
  # Retained artifacts must never carry a generated secret: scrub every known secret
  # value out of every file this run wrote, in place, regardless of how the run ended.
  if [ -d "$artifacts_dir" ]; then
    if ! scrub_retained_artifacts; then
      echo "FAIL cleanup: retained artifacts could not be securely scrubbed" >&2
      cleanup_verification_failed=1
    fi
  fi
  if ! rm -rf -- "$private_dir"; then
    echo "FAIL cleanup: private credential files could not be removed" >&2
    cleanup_verification_failed=1
  fi
  if [ "$cleanup_verification_failed" -ne 0 ] && [ "$cleanup_status" -eq 0 ]; then
    cleanup_status=1
  fi
  trap - EXIT
  exit "$cleanup_status"
}
trap cleanup EXIT
kemfai_install_cleanup_signal_traps

{
  echo "T056 round-5 live browser gate evidence (no secrets) — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "run id:           ${run_id}"
  echo "artifacts dir:    ${artifacts_dir}"
  echo "network:          ${network}"
  echo "postgres:         ${pg_container}"
  echo "redis:            ${redis_container}"
  echo "keycloak:         ${kc_container}"
  echo "odoo (2 dbs):     ${http_container} -> ${alpha_db}, ${beta_db}"
  echo "control db:       ${control_db}"
  echo "api port:         ${api_port}"
  echo "frontend port:    ${frontend_port}"
} | tee "$evidence_file"

echo
echo "== Phase 1: network + scratch PostgreSQL + Redis =="
kemfai_register_network_intent "$network"
docker network create --label "$label" "$network" >/dev/null

pg_env_file="$private_dir/pg.env"
printf 'POSTGRES_USER=odoo\nPOSTGRES_PASSWORD=%s\n' "$pg_password" > "$pg_env_file"
chmod 600 "$pg_env_file"
kemfai_register_container_intent "$pg_container"
docker run -d --label "$label" --name "$pg_container" --network "$network" \
  --env-file "$pg_env_file" -p 127.0.0.1::5432 postgres:16 >/dev/null

kemfai_register_container_intent "$redis_container"
docker run -d --label "$label" --name "$redis_container" --network "$network" \
  -p 127.0.0.1::6379 redis:7-alpine >/dev/null

ready=0
for _ in $(seq 1 60); do
  if docker exec "$pg_container" pg_isready -h 127.0.0.1 -U odoo >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.5
done
[ "$ready" -eq 1 ] || fail "private PostgreSQL container '${pg_container}' never became ready"
pg_host_port="$(docker port "$pg_container" 5432/tcp | head -1 | cut -d: -f2)"
redis_host_port="$(docker port "$redis_container" 6379/tcp | head -1 | cut -d: -f2)"
docker exec "$pg_container" psql -U odoo -d postgres -c "CREATE DATABASE ${control_db} OWNER odoo;" >/dev/null \
  || fail "failed to create scratch control DB ${control_db}"
echo "PASS: private PostgreSQL (${pg_container}) and Redis (${redis_container}) ready." | tee -a "$evidence_file"

echo
echo "== Phase 2: scratch Keycloak realm + client + Alpha/Beta users =="
# Secrets passed via --env-file (private, 0600), never -e: a -e KEY=value argument is
# visible to any local user via `ps aux`/`/proc/<pid>/cmdline` on the host `docker`
# client process for as long as it runs, whereas an --env-file's contents are not
# argv-visible at all.
kc_env_file="$private_dir/kc.env"
printf 'KEYCLOAK_ADMIN=%s\nKEYCLOAK_ADMIN_PASSWORD=%s\nKC_HTTP_ENABLED=true\n' \
  "$kc_admin_user" "$kc_admin_password" > "$kc_env_file"
chmod 600 "$kc_env_file"
kemfai_register_container_intent "$kc_container"
docker run -d --label "$label" --name "$kc_container" --network "$network" \
  --env-file "$kc_env_file" \
  -p 127.0.0.1::8080 quay.io/keycloak/keycloak:26.0 start-dev >/dev/null
kc_host_port="$(docker port "$kc_container" 8080/tcp | head -1 | cut -d: -f2)"
kc_base="http://127.0.0.1:${kc_host_port}"
ready=0
for _ in $(seq 1 90); do
  if curl --fail --silent "${kc_base}/realms/master/.well-known/openid-configuration" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" -eq 1 ] || fail "scratch Keycloak container never became ready on ${kc_base}"

admin_token() {
  # Secrets go into a private 0600 request-body file, never a `-d`/`--data` literal:
  # curl's own argv is visible via `ps aux` to any local user for as long as the curl
  # process runs, a request file's contents are not.
  local body_file="$private_dir/admin_token_body"
  printf 'grant_type=password&client_id=admin-cli&username=%s&password=%s' \
    "$kc_admin_user" "$kc_admin_password" > "$body_file"
  chmod 600 "$body_file"
  curl -s "${kc_base}/realms/master/protocol/openid-connect/token" --data @"$body_file" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])"
  rm -f "$body_file"
}
TOKEN="$(admin_token)"
[ -n "$TOKEN" ] || fail "could not obtain a scratch Keycloak admin token"
# The shell builtin writes the token directly to the private redaction store; no
# external process receives the value in argv.
printf '%s\0' "$TOKEN" >> "$redaction_secrets_file"
# The admin bearer token itself is also a generated secret; every subsequent
# authenticated admin call below uses this private curl config file (`-K`) for the
# Authorization header instead of a `-H "Authorization: Bearer ..."` argv literal.
token_header_file="$private_dir/kc_admin_token_header"
write_token_header() {
  printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" > "$token_header_file"
  chmod 600 "$token_header_file"
}
write_token_header

realm_name="kemfai-t056"
redirect_uri="http://127.0.0.1:${frontend_port}/auth/callback"
web_origin="http://127.0.0.1:${frontend_port}"
realm_payload_file="$private_dir/realm.json"
cat > "$realm_payload_file" <<JSON
{
  "realm": "${realm_name}",
  "enabled": true,
  "registrationAllowed": false,
  "roles": {"realm": [{"name": "WorkspaceOwner", "description": "scratch WorkspaceOwner role"}]},
  "clients": [
    {
      "clientId": "kemfai-api",
      "enabled": true,
      "publicClient": true,
      "standardFlowEnabled": true,
      "directAccessGrantsEnabled": false,
      "protocol": "openid-connect",
      "redirectUris": ["${redirect_uri}"],
      "webOrigins": ["${web_origin}"],
      "attributes": {"pkce.code.challenge.method": "S256"},
      "protocolMappers": [
        {
          "name": "kemfai-api audience",
          "protocol": "openid-connect",
          "protocolMapper": "oidc-audience-mapper",
          "config": {"included.client.audience": "kemfai-api", "id.token.claim": "false", "access.token.claim": "true"}
        },
        {
          "name": "tenant_id",
          "protocol": "openid-connect",
          "protocolMapper": "oidc-usermodel-attribute-mapper",
          "config": {"user.attribute": "tenant_id", "claim.name": "tenant_id", "jsonType.label": "String", "access.token.claim": "true", "id.token.claim": "false", "userinfo.token.claim": "false", "multivalued": "false"}
        }
      ]
    }
  ]
}
JSON
curl -sf -K "$token_header_file" -X POST "${kc_base}/admin/realms" \
  -H "Content-Type: application/json" \
  --data @"$realm_payload_file" >/dev/null || fail "failed to create scratch Keycloak realm ${realm_name}"

owner_role_id="$(curl -sf -K "$token_header_file" "${kc_base}/admin/realms/${realm_name}/roles/WorkspaceOwner" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")"
[ -n "$owner_role_id" ] || fail "WorkspaceOwner role not found in scratch realm"

# A freshly-created realm's User Profile component does NOT treat `tenant_id` as a
# managed attribute (Keycloak 26's default `unmanagedAttributePolicy` silently drops any
# attribute the profile doesn't declare) — mirrors the real kemfai-customers realm, which
# explicitly declares `tenant_id` in its User Profile config. Without this, bind_owner's
# PUT below would appear to succeed (204) while Keycloak quietly discards the attribute,
# so the tenant_id protocol mapper would emit no claim and every company-setup request
# would fail WorkspaceOwner access with a tenant-scope 403 — not a role problem, a
# storage one. Fetch the current profile and APPEND tenant_id, never replace it (the
# built-in username/email/firstName/lastName declarations must survive).
profile_file="$private_dir/users_profile.json"
curl -sf -K "$token_header_file" "${kc_base}/admin/realms/${realm_name}/users/profile" \
  > "$profile_file" || fail "failed to read scratch realm's User Profile config"
python3 -c "
import json
with open('$profile_file') as f:
    profile = json.load(f)
profile['attributes'].append({
    'name': 'tenant_id',
    'displayName': 'Tenant ID',
    'permissions': {'view': ['admin'], 'edit': ['admin']},
    'multivalued': False,
})
with open('$profile_file', 'w') as f:
    json.dump(profile, f)
"
curl -sf -K "$token_header_file" -X PUT "${kc_base}/admin/realms/${realm_name}/users/profile" \
  -H "Content-Type: application/json" --data @"$profile_file" >/dev/null \
  || fail "failed to declare tenant_id as a managed User Profile attribute"
rm -f "$profile_file"
echo "PASS: scratch realm's User Profile declares tenant_id as a managed attribute (it would otherwise be silently dropped)." | tee -a "$evidence_file"

create_user() {
  local email="$1" password="$2"
  local loc="$private_dir/created_user_headers"
  # Secrets go into a private 0600 request-body file, never a `--data` literal (see
  # admin_token's comment above for why).
  local body_file="$private_dir/create_user_body.json"
  # firstName/lastName are required: Keycloak's default User Profile config marks them
  # mandatory, so a user created without them is presented an "Update Account
  # Information" required-action form at login instead of completing authentication —
  # which previously stalled the browser harness forever waiting for a post-login
  # redirect that could never happen.
  printf '{"username":"%s","email":"%s","enabled":true,"emailVerified":true,"firstName":"T056","lastName":"Scratch","requiredActions":[],"credentials":[{"type":"password","value":"%s","temporary":false}]}' \
    "$email" "$email" "$password" > "$body_file"
  chmod 600 "$body_file"
  curl -sf -K "$token_header_file" -D "$loc" -o /dev/null -X POST "${kc_base}/admin/realms/${realm_name}/users" \
    -H "Content-Type: application/json" \
    --data @"$body_file" \
    || { rm -f "$body_file"; fail "failed to create Keycloak user ${email}"; }
  rm -f "$body_file"
  grep -i '^location:' "$loc" | tr -d '\r' | sed 's#.*/users/##'
}

alpha_email="t056-alpha-${run_id}@example.test"
beta_email="t056-beta-${run_id}@example.test"
alpha_kc_id="$(create_user "$alpha_email" "$alpha_password")"
beta_kc_id="$(create_user "$beta_email" "$beta_password")"
[ -n "$alpha_kc_id" ] && [ -n "$beta_kc_id" ] || fail "Keycloak user creation did not return an id"
echo "PASS: scratch Keycloak realm ${realm_name} + Alpha(${alpha_kc_id})/Beta(${beta_kc_id}) users ready on ${kc_base}." | tee -a "$evidence_file"

echo
echo "== Phase 3: offline bootstrap of Alpha/Beta Odoo databases, then isolated locked-down HTTP container =="
odoo_env_file="$private_dir/odoo.env"
printf 'HOST=%s\nUSER=odoo\nPASSWORD=%s\n' "$pg_container" "$pg_password" > "$odoo_env_file"
chmod 600 "$odoo_env_file"

bootstrap_db() {
  local db="$1"
  local init_name="${run_id}_${db##*_}init"
  local admin_name="${run_id}_${db##*_}admin"
  kemfai_register_container_intent "$init_name"
  timeout --kill-after=30 900 \
    docker run --rm --name "$init_name" --label "$label" --network "$network" \
    --env-file "$odoo_env_file" -v "${addons_dir}:/mnt/extra-addons:ro" \
    odoo:18 odoo -d "$db" \
    --addons-path=/mnt/extra-addons,/usr/lib/python3/dist-packages/odoo/addons \
    -i kemfai_tenant_core,kemfai_company_setup --stop-after-init --without-demo=all \
    > "$artifacts_dir/bootstrap-${db}.log" 2>&1 \
    || { redact_secrets < "$artifacts_dir/bootstrap-${db}.log"; fail "offline bootstrap of ${db} failed"; }

  printf 'ADMIN_LOGIN=%s\nADMIN_PASSWORD=%s\n' "$odoo_admin_login" "$odoo_admin_password" >> "$odoo_env_file"
  local shell_script="$private_dir/bootstrap_admin_${db}.py"
  cat > "$shell_script" <<'PYEOF'
import os
user = env['res.users'].browse(2)
user.write({'login': os.environ['ADMIN_LOGIN'], 'password': os.environ['ADMIN_PASSWORD']})
env.cr.commit()
PYEOF
  kemfai_register_container_intent "$admin_name"
  timeout --kill-after=15 180 \
    docker run --rm -i --name "$admin_name" --label "$label" --network "$network" \
    --env-file "$odoo_env_file" -v "${addons_dir}:/mnt/extra-addons:ro" \
    odoo:18 odoo shell -d "$db" \
    --addons-path=/mnt/extra-addons,/usr/lib/python3/dist-packages/odoo/addons --no-http \
    < "$shell_script" > "$artifacts_dir/bootstrap-admin-${db}.log" 2>&1 \
    || { redact_secrets < "$artifacts_dir/bootstrap-admin-${db}.log"; fail "offline admin bootstrap of ${db} failed"; }
}
bootstrap_db "$alpha_db"
bootstrap_db "$beta_db"
echo "PASS: Alpha (${alpha_db}) and Beta (${beta_db}) Odoo databases bootstrapped offline with admin credentials." | tee -a "$evidence_file"

conf_file="$private_dir/odoo.conf"
cat > "$conf_file" <<EOF
[options]
addons_path = /mnt/extra-addons,/usr/lib/python3/dist-packages/odoo/addons
data_dir = /var/lib/odoo
admin_passwd = ${odoo_master_password}
dbfilter = ^${run_id}_.*\$
list_db = False
EOF
chmod 644 "$conf_file"
kemfai_register_container_intent "$http_container"
docker run -d --label "$label" --name "$http_container" --network "$network" \
  --env-file "$odoo_env_file" -v "${addons_dir}:/mnt/extra-addons:ro" \
  -v "${conf_file}:/etc/odoo/odoo.conf:ro" -p 127.0.0.1::8069 odoo:18 >/dev/null
odoo_host_port="$(docker port "$http_container" 8069/tcp | head -1 | cut -d: -f2)"
ready=0
for _ in $(seq 1 90); do
  if curl --fail --silent "http://127.0.0.1:${odoo_host_port}/web/login" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" -eq 1 ] || fail "isolated Odoo HTTP container never became ready"
echo "PASS: isolated Odoo HTTP container ready on 127.0.0.1:${odoo_host_port}, dbfilter anchored to ${run_id}_, list_db off." | tee -a "$evidence_file"

odoo_rpc() {
  local service="$1" method="$2" args_json="$3"
  # args_json carries the Odoo admin password for `common.login` calls — write the
  # whole JSON-RPC body to a private 0600 file so it is never a `-d`/`--data` argv
  # literal (see admin_token's comment above).
  local body_file="$private_dir/odoo_rpc_body.json"
  printf '{"jsonrpc":"2.0","method":"call","params":{"service":"%s","method":"%s","args":%s},"id":1}' \
    "$service" "$method" "$args_json" > "$body_file"
  chmod 600 "$body_file"
  curl -sf "http://127.0.0.1:${odoo_host_port}/jsonrpc" -H 'Content-Type: application/json' \
    --data @"$body_file"
  rm -f "$body_file"
}
odoo_uid() {
  local db="$1"
  odoo_rpc common login "[\"${db}\",\"${odoo_admin_login}\",\"${odoo_admin_password}\"]" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['result'])"
}
odoo_company_id() {
  local db="$1" uid="$2"
  odoo_rpc object execute_kw "[\"${db}\",${uid},\"${odoo_admin_password}\",\"res.company\",\"search\",[[]],{\"limit\":1}]" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['result'][0])"
}
alpha_uid="$(odoo_uid "$alpha_db")"
beta_uid="$(odoo_uid "$beta_db")"
alpha_company_id="$(odoo_company_id "$alpha_db" "$alpha_uid")"
beta_company_id="$(odoo_company_id "$beta_db" "$beta_uid")"
[ -n "$alpha_company_id" ] && [ -n "$beta_company_id" ] || fail "could not resolve Alpha/Beta Odoo company ids"
echo "PASS: Alpha company id=${alpha_company_id}, Beta company id=${beta_company_id}." | tee -a "$evidence_file"

echo
echo "== Phase 4: control-plane migrations + Alpha/Beta seed rows =="
cd "$api_dir"
export CONTROL_DB_HOST=127.0.0.1
export CONTROL_DB_PORT="$pg_host_port"
export CONTROL_DB_USER=odoo
export CONTROL_DB_PASSWORD="$pg_password"
export CONTROL_DB_NAME="$control_db"
export REDIS_URL="redis://127.0.0.1:${redis_host_port}"
npm run migration:run > "$artifacts_dir/migrations.log" 2>&1 \
  || { redact_secrets < "$artifacts_dir/migrations.log"; fail "migrations failed against scratch control DB"; }

# Secrets via --env-file (private, 0600), never `docker exec -e KEY=value` (argv-visible
# to any local user via `ps aux` for as long as the `docker` client process runs).
psql_env_file="$private_dir/psql.env"
printf 'PGPASSWORD=%s\n' "$pg_password" > "$psql_env_file"
chmod 600 "$psql_env_file"
# -X (ignore any ~/.psqlrc) + -q (quiet: suppress command-tag/row-count status lines
# like "INSERT 0 1") alongside -t -A, so a single RETURNING-id INSERT yields exactly the
# UUID on stdout — never the UUID with a trailing status line glued on, which previously
# corrupted downstream interpolation into the next INSERT's VALUES(...).
psql_q() {
  docker exec --env-file "$psql_env_file" "$pg_container" \
    psql -h 127.0.0.1 -U odoo -d "$control_db" -X -q -t -A -c "$1"
}

plan_id="$(psql_q "INSERT INTO plan (name, published, monthly_price, annual_price, currency) VALUES ('t056-plan-${run_id}', true, '10.00', '100.00', 'USD') RETURNING id;")"
alpha_account_id="$(psql_q "INSERT INTO account (keycloak_user_id, email, email_verified, selected_plan_id, selected_billing_cycle) VALUES ('${alpha_kc_id}', '${alpha_email}', true, '${plan_id}', 'monthly') RETURNING id;")"
beta_account_id="$(psql_q "INSERT INTO account (keycloak_user_id, email, email_verified, selected_plan_id, selected_billing_cycle) VALUES ('${beta_kc_id}', '${beta_email}', true, '${plan_id}', 'monthly') RETURNING id;")"
alpha_tenant_id="$(psql_q "INSERT INTO tenant (account_id, status, odoo_db_name, odoo_company_id, ready_at) VALUES ('${alpha_account_id}', 'Ready'::tenant_status_enum, '${alpha_db}', ${alpha_company_id}, now()) RETURNING id;")"
beta_tenant_id="$(psql_q "INSERT INTO tenant (account_id, status, odoo_db_name, odoo_company_id, ready_at) VALUES ('${beta_account_id}', 'Ready'::tenant_status_enum, '${beta_db}', ${beta_company_id}, now()) RETURNING id;")"
psql_q "INSERT INTO subscription (tenant_id, plan_id, billing_cycle, status, current_period_start, current_period_end) VALUES ('${alpha_tenant_id}', '${plan_id}', 'monthly', 'Active', '2026-01-01', '2027-01-01');" >/dev/null
psql_q "INSERT INTO subscription (tenant_id, plan_id, billing_cycle, status, current_period_start, current_period_end) VALUES ('${beta_tenant_id}', '${plan_id}', 'monthly', 'Active', '2026-01-01', '2027-01-01');" >/dev/null
psql_q "UPDATE feature_flag SET enabled = true WHERE feature_key = 'module.company_setup';" >/dev/null

# Keycloak-side WorkspaceOwner role + tenant_id attribute (mirrors
# AdminRestKeycloakUserProvisioner.assignWorkspaceOwner). Keycloak 26's User Profile
# component treats a PUT body as authoritative: a body carrying only `attributes` clears
# email/firstName/lastName. So this fetches the user's CURRENT representation first and
# merges tenant_id into its existing attributes — it never synthesizes or overwrites
# email/firstName/lastName with placeholder values.
bind_owner() {
  local kc_id="$1" tenant_id="$2"
  local current_file="$private_dir/bind_owner_current_${kc_id}.json"
  local merged_file="$private_dir/bind_owner_merged_${kc_id}.json"
  curl -sf -K "$token_header_file" "${kc_base}/admin/realms/${realm_name}/users/${kc_id}" \
    > "$current_file"
  python3 -c "
import json, sys
with open('$current_file') as f:
    user = json.load(f)
attributes = dict(user.get('attributes') or {})
attributes['tenant_id'] = ['$tenant_id']
merged = {
    'username': user.get('username'),
    'email': user.get('email'),
    'firstName': user.get('firstName'),
    'lastName': user.get('lastName'),
    'enabled': user.get('enabled'),
    'emailVerified': user.get('emailVerified'),
    'requiredActions': user.get('requiredActions'),
    'attributes': attributes,
}
merged = {k: v for k, v in merged.items() if v is not None}
with open('$merged_file', 'w') as f:
    json.dump(merged, f)
"
  rm -f "$current_file"
  chmod 600 "$merged_file"
  curl -sf -K "$token_header_file" -X PUT "${kc_base}/admin/realms/${realm_name}/users/${kc_id}" \
    -H "Content-Type: application/json" \
    --data @"$merged_file" >/dev/null
  rm -f "$merged_file"
  curl -sf -K "$token_header_file" -X POST "${kc_base}/admin/realms/${realm_name}/users/${kc_id}/role-mappings/realm" \
    -H "Content-Type: application/json" \
    --data "[{\"id\":\"${owner_role_id}\",\"name\":\"WorkspaceOwner\"}]" >/dev/null
}
# Odoo/bootstrap work can exceed Keycloak's short admin-token lifetime. Refresh
# immediately before the two admin bindings rather than reusing the phase-2 token.
TOKEN="$(admin_token)"
[ -n "$TOKEN" ] || fail "could not refresh scratch Keycloak admin token"
printf '%s\0' "$TOKEN" >> "$redaction_secrets_file"
write_token_header
bind_owner "$alpha_kc_id" "$alpha_tenant_id"
bind_owner "$beta_kc_id" "$beta_tenant_id"
echo "PASS: control-plane seeded — Alpha tenant=${alpha_tenant_id}, Beta tenant=${beta_tenant_id}; both bound WorkspaceOwner in scratch Keycloak." | tee -a "$evidence_file"

echo
echo "== Phase 5: starting the REAL NestJS API process =="
api_log="$artifacts_dir/api.log"
# `export` is a shell builtin: it sets these in THIS subshell's own environment before
# `exec`-ing into node, so none of them are ever a separate argv token any process's
# `ps aux`/`/proc/<pid>/cmdline` output could show (unlike the earlier `env KEY=value
# cmd` form, where KEY=value IS an argv token of the external `env` binary). `setsid`
# gives the final node process its own session/process-group (pgid == its own pid), so
# cleanup can terminate the whole group, not just this one pid.
(
  cd "$api_dir"
  export PORT="$api_port" HOST=127.0.0.1 NODE_ENV=development
  export CONTROL_DB_HOST=127.0.0.1 CONTROL_DB_PORT="$pg_host_port" CONTROL_DB_USER=odoo
  export CONTROL_DB_PASSWORD="$pg_password" CONTROL_DB_NAME="$control_db"
  export REDIS_URL="redis://127.0.0.1:${redis_host_port}"
  export KEMFAI_ODOO_URL="http://127.0.0.1:${odoo_host_port}"
  export KEMFAI_ODOO_MASTER_PASSWORD="$odoo_master_password"
  export KEMFAI_TENANT_ADMIN_LOGIN="$odoo_admin_login"
  export KEMFAI_TENANT_ADMIN_PASSWORD="$odoo_admin_password"
  export KEYCLOAK_URL="$kc_base"
  export KEYCLOAK_CUSTOMERS_REALM="$realm_name"
  export KEYCLOAK_ISSUER="${kc_base}/realms/${realm_name}"
  export KEYCLOAK_JWKS_URI="${kc_base}/realms/${realm_name}/protocol/openid-connect/certs"
  export KEYCLOAK_API_AUDIENCE="kemfai-api"
  export KEYCLOAK_ADMIN="$kc_admin_user" KEYCLOAK_ADMIN_PASSWORD="$kc_admin_password"
  export OPENAPI_CONTRACT_PATH="$repo_dir/specs/001-saas-onboarding-shell/contracts/openapi.yaml"
  export STORAGE_ENDPOINT="http://127.0.0.1:1" STORAGE_ACCESS_KEY=unused STORAGE_SECRET_KEY=unused
  exec setsid node dist/main.js
) > "$api_log" 2>&1 &
api_pid=$!
ready=0
for _ in $(seq 1 60); do
  if curl --fail --silent "http://127.0.0.1:${api_port}/" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" -eq 1 ] || { redact_secrets < "$api_log"; fail "scratch API process never became ready on ${api_port}"; }
echo "PASS: real NestJS API running on http://127.0.0.1:${api_port} (pid ${api_pid})." | tee -a "$evidence_file"

echo
echo "== Phase 6: starting the REAL Next.js frontend process =="
frontend_log="$artifacts_dir/frontend.log"
(
  cd "$frontend_dir"
  export NODE_ENV=production PORT="$frontend_port"
  export NEXT_PUBLIC_API_URL="http://127.0.0.1:${api_port}" NEXT_PUBLIC_DEFAULT_LOCALE=en
  export KEYCLOAK_ISSUER="${kc_base}/realms/${realm_name}"
  export KEYCLOAK_BACKCHANNEL_URL="${kc_base}/realms/${realm_name}"
  export KEYCLOAK_JWKS_URI="${kc_base}/realms/${realm_name}/protocol/openid-connect/certs"
  export KEYCLOAK_CLIENT_ID="kemfai-api"
  export KEYCLOAK_REDIRECT_URI="${redirect_uri}"
  export KEMFAI_API_URL="http://127.0.0.1:${api_port}"
  export REDIS_URL="redis://127.0.0.1:${redis_host_port}"
  export SUPPORT_EMAIL="support@example.test"
  # `next start`'s real worker is spawned by `npx`/`next`'s CLI wrapper as a CHILD
  # process — `setsid` here, not inside npx, is what puts BOTH the wrapper and that
  # child in one killable process group (they share its pgid; npx never calls setsid
  # itself, so it doesn't start a group of its own).
  exec setsid npx next start -p "$frontend_port"
) > "$frontend_log" 2>&1 &
frontend_pid=$!
ready=0
for _ in $(seq 1 60); do
  if curl --fail --silent "http://127.0.0.1:${frontend_port}/" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" -eq 1 ] || { redact_secrets < "$frontend_log"; fail "scratch frontend process never became ready on ${frontend_port}"; }
echo "PASS: real Next.js frontend running on http://127.0.0.1:${frontend_port} (pid ${frontend_pid})." | tee -a "$evidence_file"

echo
echo "== Phase 7: real browser (Playwright) Alpha persistence + stale-scope + logout + Beta isolation proof =="
cd "$frontend_dir"
export T056_BASE_URL="http://127.0.0.1:${frontend_port}"
export T056_ALPHA_EMAIL="$alpha_email"
export T056_ALPHA_PASSWORD="$alpha_password"
export T056_BETA_EMAIL="$beta_email"
export T056_BETA_PASSWORD="$beta_password"
export T056_KC_BASE="$kc_base"
export T056_ODOO_BASE="http://127.0.0.1:${odoo_host_port}"
export T056_ALPHA_DB="$alpha_db"
export T056_ALPHA_COMPANY_ID="$alpha_company_id"
export T056_BETA_DB="$beta_db"
export T056_BETA_COMPANY_ID="$beta_company_id"
export T056_ODOO_ADMIN_LOGIN="$odoo_admin_login"
export T056_ODOO_ADMIN_PASSWORD="$odoo_admin_password"
export T056_REDIS_URL="redis://127.0.0.1:${redis_host_port}"
export T056_ALPHA_TENANT_ID="$alpha_tenant_id"
export T056_BETA_TENANT_ID="$beta_tenant_id"

set +e
npx playwright test --config tests/e2e-live/playwright.live.config.ts tests/e2e-live/t056-real-browser.live.spec.ts > "$artifacts_dir/browser-harness.log" 2>&1
status=$?
set -e
redact_secrets < "$artifacts_dir/browser-harness.log"
[ $status -eq 0 ] || fail "real browser harness (tests/e2e-live/t056-real-browser.live.spec.ts) failed"
echo "PASS: real browser Alpha persistence, stale-scope rejection, logout, and Beta isolation all verified end to end." | tee -a "$evidence_file"

echo
echo "== T056 round-5 live browser gate: ALL PHASES PASSED =="
cat "$evidence_file"
