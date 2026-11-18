#!/usr/bin/env bash
# T071 genuine acceptance harness. A private runtime copy of the accepted T056 launcher
# supplies its exact-label ownership, secret redaction, PID/start-time checks and cleanup.
set -euo pipefail
repo_dir="${KEMFAI_T071_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
template="$repo_dir/scripts/test_t056_live_browser.sh"
[ -f "$template" ] || { echo 'FAIL: T056 owned-stack template missing' >&2; exit 1; }
private="$(mktemp -d)"; chmod 700 "$private"
trap 'status=$?; rm -rf -- "$private"; exit $status' EXIT
stage="$private/t071-owned-live.sh"
sed -e 's/T056/T071/g' -e 's/t056/t071/g' "$template" > "$stage"

python3 - "$stage" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); s=p.read_text()
def one(old,new):
    global s
    if s.count(old)!=1: raise SystemExit(f'FAIL: reusable T056 contract drifted: {old[:80]!r} count={s.count(old)}')
    s=s.replace(old,new)

early_env=r'''command -v node >/dev/null 2>&1 || { echo 'FAIL: node is required for Playwright browser preflight' >&2; exit 1; }
playwright_browsers_path="$(cd "$frontend_dir" && node "$repo_dir/scripts/fixtures/t071_resolve_playwright_browser.mjs")" || exit 1
sanitize_host_environment() {
  local name
  while IFS= read -r name; do
    case "$name" in PATH) ;;
      *) unset "$name";;
    esac
  done < <(compgen -e)
  export HOME="${private_dir:-/nonexistent}"
  export PLAYWRIGHT_BROWSERS_PATH="$playwright_browsers_path"
}
assert_no_dotenv_files() {
  local found
  found="$(find "$api_dir" "$frontend_dir" -maxdepth 1 -type f \( -name '.env' -o -name '.env.local' -o -name '.env.production' -o -name '.env.production.local' \) -print -quit)"
  [ -z "$found" ] || { echo 'FAIL: refusing to load checkout-local .env configuration in isolated T071 harness' >&2; exit 1; }
}
sanitize_host_environment
assert_no_dotenv_files

'''
one('command -v docker >/dev/null', early_env+'command -v docker >/dev/null')
one('docker info >/dev/null 2>&1 || { echo "FAIL: docker daemon is not reachable" >&2; exit 1; }', '''docker info >/dev/null 2>&1 || { echo "FAIL: docker daemon is not reachable" >&2; exit 1; }
required_images=(postgres:16 redis:7-alpine quay.io/keycloak/keycloak:26.0 odoo:18 quay.io/minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e)
for image in "${required_images[@]}"; do
  docker image inspect "$image" >/dev/null 2>&1 || { echo "FAIL: required local image is unavailable: ${image}" >&2; exit 1; }
done''')
one('artifacts_dir="${KEMFAI_ARTIFACTS_DIR:-$(dirname "$repo_dir")/t071-live-evidence-${run_id}}"', 'artifacts_dir="$repo_dir/.artifacts/t071-live-evidence-${run_id}"')

s=s.replace('"directAccessGrantsEnabled": false', '"directAccessGrantsEnabled": true', 1)

# Containers stay on a Docker-internal network. Docker suppresses published bindings on
# that network, so generated T071 code reaches exact-owned container IPs only through
# separately owned host relays bound to ephemeral 127.0.0.1 ports.
one('docker network create --label "$label" "$network" >/dev/null',
    'docker network create --internal --label "$label" "$network" >/dev/null')
one('redis_container="${run_id}_redis"', 'redis_container="${run_id}_redis"\nminio_container="${run_id}_minio"')
one('control_db="${run_id}_ctrl"', '''control_db="${run_id}_ctrl"
pg_volume="${run_id}_pgdata"
minio_volume="${run_id}_miniodata"
odoo_volume="${run_id}_odoodata"''')
one('kemfai_docker_cleanup_init "kemfai.t071.run" "$run_id"', '''kemfai_docker_cleanup_init "kemfai.t071.run" "$run_id"
declare -a owned_volumes=()
declare -a relay_pids=()
declare -A owned_pid_starttime=()
declare -A owned_pid_session=()''')
one('  -p 127.0.0.1::6379 redis:7-alpine >/dev/null', '''  -p 127.0.0.1::6379 redis:7-alpine >/dev/null

minio_access="t071$(openssl rand -hex 8)"; minio_secret="$(openssl rand -hex 24)"
printf '%s\\0%s\\0' "$minio_access" "$minio_secret" >> "$redaction_secrets_file"
minio_env="$private_dir/minio.env"
printf 'MINIO_ROOT_USER=%s\\nMINIO_ROOT_PASSWORD=%s\\n' "$minio_access" "$minio_secret" > "$minio_env"; chmod 600 "$minio_env"
kemfai_register_container_intent "$minio_container"
docker run -d --label "$label" --name "$minio_container" --network "$network" --env-file "$minio_env" \
  -p 127.0.0.1::9000 minio/minio:RELEASE.2025-04-22T22-12-26Z server /data >/dev/null''')

# Permanent containers use explicitly named, exactly-labelled volumes. This avoids
# anonymous data-volume leaks and makes ownership/survivor verification possible.
one('kemfai_register_network_intent "$network"\ndocker network create --internal --label "$label" "$network" >/dev/null', '''kemfai_register_network_intent "$network"
docker network create --internal --label "$label" "$network" >/dev/null
for volume in "$pg_volume" "$minio_volume" "$odoo_volume"; do
  owned_volumes+=("$volume")
  docker volume create --label "$label" "$volume" >/dev/null
done''')
one('--env-file "$pg_env_file" -p 127.0.0.1::5432 postgres:16', '--env-file "$pg_env_file" -v "${pg_volume}:/var/lib/postgresql/data" -p 127.0.0.1::5432 postgres:16')
one('-p 127.0.0.1::9000 minio/minio:RELEASE.2025-04-22T22-12-26Z server /data', '-v "${minio_volume}:/data" -p 127.0.0.1::9000 quay.io/minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e server /data')
one('-v "${conf_file}:/etc/odoo/odoo.conf:ro" -p 127.0.0.1::8069 odoo:18', '-v "${conf_file}:/etc/odoo/odoo.conf:ro" -v "${odoo_volume}:/var/lib/odoo" -p 127.0.0.1::8069 odoo:18')
for port in (5432, 6379, 9000, 8080, 8069):
    one(f' -p 127.0.0.1::{port}', '')
one('pg_host_port="$(docker port "$pg_container" 5432/tcp | head -1 | cut -d: -f2)"\nredis_host_port="$(docker port "$redis_container" 6379/tcp | head -1 | cut -d: -f2)"', 'start_owned_relay "$pg_container" 5432 pg_host_port\nstart_owned_relay "$redis_container" 6379 redis_host_port')
postgres_ready='[ "$ready" -eq 1 ] || fail "private PostgreSQL container \'${pg_container}\' never became ready"'
one(postgres_ready, postgres_ready+'''\nready=0
for _ in $(seq 1 60); do
  [ "$(docker exec "$redis_container" redis-cli ping 2>/dev/null)" = PONG ] && { ready=1; break; }
  sleep 0.5
done
[ "$ready" -eq 1 ] || fail "private Redis container '${redis_container}' never became ready"''')
one('kemfai_register_container_intent "$kc_container"', '''start_owned_relay "$minio_container" 9000 minio_host_port
ready=0
for _ in $(seq 1 60); do
  if curl --fail --silent "http://127.0.0.1:${minio_host_port}/minio/health/ready" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.5
done
[ "$ready" -eq 1 ] || fail 'private MinIO container never became ready'
kemfai_register_container_intent "$kc_container"''')
one('kc_host_port="$(docker port "$kc_container" 8080/tcp | head -1 | cut -d: -f2)"', 'start_owned_relay "$kc_container" 8080 kc_host_port')
one('odoo_host_port="$(docker port "$http_container" 8069/tcp | head -1 | cut -d: -f2)"', 'start_owned_relay "$http_container" 8069 odoo_host_port')

# Replace the inherited cmdline-only PID check with immutable start-time + session
# registration and post-signal session-survivor proof.
pid_start=s.index('pid_owned_by_this_run() {')
pid_end=s.index('\ncleanup() {', pid_start)
pid_code='source "$repo_dir/scripts/fixtures/t071_process_lifecycle.sh"\n'
s=s[:pid_start]+pid_code+s[pid_end:]

relay_code=r'''
start_owned_relay() {
  local container_name="$1" target_port="$2" output_name="$3"
  local container_id network_id ownership_status target_ip subnet config ready relay_pid relay_port ready_pid
  container_id="$(kemfai_exact_owned_container_id "$container_name")"; ownership_status=$?
  [ "$ownership_status" -eq 0 ] || fail "cannot establish exact ownership for relay target ${container_name}"
  network_id="$(kemfai_exact_owned_network_id "$network")"; ownership_status=$?
  [ "$ownership_status" -eq 0 ] && [ -n "$network_id" ] || fail "cannot establish exact ownership for relay network"
  target_ip="$(docker inspect -f "{{with index .NetworkSettings.Networks \"${network}\"}}{{.IPAddress}}{{end}}" "$container_id" 2>/dev/null)" || fail "cannot inspect relay target ${container_name}"
  subnet="$(docker network inspect -f '{{(index .IPAM.Config 0).Subnet}}' "$network" 2>/dev/null)" || fail "cannot inspect owned relay subnet"
  [ -n "$target_ip" ] && [ -n "$subnet" ] || fail "relay target is not attached to the owned internal network"
  config="$private_dir/relay-${container_name}.json"; ready="$private_dir/relay-${container_name}.ready"
  printf '{"targetIp":"%s","subnet":"%s","targetPort":%s,"readyFile":"%s"}\n' "$target_ip" "$subnet" "$target_port" "$ready" >"$config"; chmod 600 "$config"
  ( export T071_RELAY_CONFIG="$config"; exec python3 -I "$repo_dir/scripts/fixtures/t071_owned_session_exec.py" --hold-for-cleanup --keep-env T071_RELAY_CONFIG python3 "$repo_dir/scripts/fixtures/t071_loopback_relay.py" ) >"$artifacts_dir/relay-${container_name}.log" 2>&1 &
  relay_pid=$!; relay_pids+=("$relay_pid")
  register_owned_process "$relay_pid" "t071_loopback_relay.py"
  for _ in $(seq 1 100); do [ -s "$ready" ] && break; kill -0 "$relay_pid" 2>/dev/null || break; sleep 0.05; done
  [ -s "$ready" ] || { redact_secrets <"$artifacts_dir/relay-${container_name}.log"; fail "loopback relay failed for ${container_name}"; }
  read -r ready_pid relay_port < <(python3 - "$ready" <<'PRELAY'
import json, os, stat, sys
p=sys.argv[1]; m=os.stat(p, follow_symlinks=False)
if not stat.S_ISREG(m.st_mode) or m.st_uid != os.geteuid() or stat.S_IMODE(m.st_mode) != 0o600: raise SystemExit(1)
d=json.load(open(p)); print(d['pid'], d['port'])
PRELAY
  ) || fail "invalid loopback relay readiness file"
  [ "$ready_pid" = "$relay_pid" ] || fail "loopback relay pid mismatch"
  case "$relay_port" in ''|*[!0-9]*) fail "invalid loopback relay port";; esac
  [ "$relay_port" -ge 1024 ] && [ "$relay_port" -le 65535 ] || fail "loopback relay port is out of range"
  printf -v "$output_name" '%s' "$relay_port"
}
'''
one('source "$repo_dir/scripts/fixtures/t071_process_lifecycle.sh"', 'source "$repo_dir/scripts/fixtures/t071_process_lifecycle.sh"'+relay_code)

# Exact labelled volume ownership mirrors the container/network checks.
volume_code=r'''
exact_owned_volume_id() {
  local name="$1" resource_id actual
  resource_id="$(docker volume ls -q --filter "name=^${name}$" 2>/dev/null)" || return 3
  [ -n "$resource_id" ] || return 1
  case "$resource_id" in *$'\n'*) return 3;; esac
  actual="$(docker volume inspect -f '{{ index .Labels "kemfai.t071.run" }}' "$resource_id" 2>/dev/null)" || return 3
  [ "$actual" = "$run_id" ] || return 2
  printf '%s\n' "$resource_id"
}
'''
cleanup_start=s.index('\ncleanup() {')
s=s[:cleanup_start]+volume_code+s[cleanup_start:]

# Process terminators must affect cleanup status, then owned named volumes are removed
# and exact-label survivors fail closed.
one('terminate_owned_process_group "$frontend_pid" "next"', 'terminate_owned_process_group "$frontend_pid" "next" || cleanup_verification_failed=1')
one('terminate_owned_process_group "$api_pid" "dist/main.js"', 'terminate_owned_process_group "$api_pid" "dist/main.js" || cleanup_verification_failed=1')
one('  kemfai_cleanup_owned_containers || cleanup_verification_failed=1', '''  for relay_pid in "${relay_pids[@]}"; do
    terminate_owned_process_group "$relay_pid" "t071_loopback_relay.py" || cleanup_verification_failed=1
  done
  kemfai_cleanup_owned_containers || cleanup_verification_failed=1''')
volume_cleanup=r'''
  for name in "${owned_volumes[@]}"; do
    resource_id="$(exact_owned_volume_id "$name")"; ownership_status=$?
    case "$ownership_status" in
      0) docker volume rm "$resource_id" >/dev/null 2>&1 || { echo "FAIL cleanup: could not remove verified T071 volume '$name'" >&2; cleanup_verification_failed=1; };;
      1) ;;
      2) echo "FAIL cleanup: tracked volume '$name' has a nonmatching run label — not touching it" >&2; cleanup_verification_failed=1;;
      *) echo "FAIL cleanup: unable to verify tracked volume '$name' — not touching it" >&2; cleanup_verification_failed=1;;
    esac
  done
  volume_survivors="$(docker volume ls -q --filter "label=kemfai.t071.run=${run_id}" 2>/dev/null)" || cleanup_verification_failed=1
  if [ -n "$volume_survivors" ]; then echo "FAIL cleanup: exact-label T071 volume survivor(s) detected for run ${run_id}" >&2; cleanup_verification_failed=1; fi
'''
container_survivor_anchor='  kemfai_cleanup_owned_networks || cleanup_verification_failed=1'
idx=s.index(container_survivor_anchor, s.index('cleanup() {'))
s=s[:idx]+volume_cleanup+s[idx:]

# The customer realm remains for hostile-realm replay. Add a distinct internal realm,
# audience and three synthetic users: BillingAdmin, wrong-role, and a second admin used
# for the genuine concurrent decision race.
anchor='echo "PASS: scratch Keycloak realm ${realm_name} + Alpha(${alpha_kc_id})/Beta(${beta_kc_id}) users ready on ${kc_base}." | tee -a "$evidence_file"'
internal=r'''
internal_realm="kemfai-internal-${run_id}"
internal_redirect_uri="http://127.0.0.1:${frontend_port}/internal-auth/callback"
internal_payload="$private_dir/internal-realm.json"
cat > "$internal_payload" <<JSON
{"realm":"${internal_realm}","enabled":true,"registrationAllowed":false,"accessTokenLifespan":15,
 "roles":{"realm":[{"name":"BillingAdmin"},{"name":"SupportAgent"}]},
 "clients":[{"clientId":"kemfai-internal-ui","enabled":true,"publicClient":true,"standardFlowEnabled":true,"directAccessGrantsEnabled":true,"redirectUris":["${internal_redirect_uri}"],"webOrigins":["http://127.0.0.1:${frontend_port}"],"attributes":{"pkce.code.challenge.method":"S256"},"protocolMappers":[{"name":"api audience","protocol":"openid-connect","protocolMapper":"oidc-audience-mapper","config":{"included.client.audience":"kemfai-api","access.token.claim":"true"}}]},{"clientId":"t071-wrong-audience","enabled":true,"publicClient":true,"standardFlowEnabled":false,"directAccessGrantsEnabled":true}]}
JSON
curl -sf -K "$token_header_file" -X POST "${kc_base}/admin/realms" -H 'Content-Type: application/json' --data @"$internal_payload" >/dev/null || fail 'internal realm creation failed'
internal_create_user() {
 local email="$1" password="$2" role="$3" body="$private_dir/internal-user.json" headers="$private_dir/internal-user.headers"
 printf '{"username":"%s","email":"%s","enabled":true,"emailVerified":true,"firstName":"T071","lastName":"Fixture","credentials":[{"type":"password","value":"%s","temporary":false}]}' "$email" "$email" "$password" > "$body"; chmod 600 "$body"
 curl -sf -K "$token_header_file" -D "$headers" -o /dev/null -X POST "${kc_base}/admin/realms/${internal_realm}/users" -H 'Content-Type: application/json' --data @"$body"
 local id; id="$(grep -i '^location:' "$headers"|tr -d '\r'|sed 's#.*/users/##')"
 local role_file="$private_dir/internal-role.json"; curl -sf -K "$token_header_file" "${kc_base}/admin/realms/${internal_realm}/roles/${role}" > "$role_file"
 curl -sf -K "$token_header_file" -X POST "${kc_base}/admin/realms/${internal_realm}/users/${id}/role-mappings/realm" -H 'Content-Type: application/json' --data "[$(cat "$role_file")]" >/dev/null
 printf '%s' "$id"
}
admin_email="t071-admin-${run_id}@example.invalid"; admin_password="$(openssl rand -hex 18)"
race_email="t071-race-${run_id}@example.invalid"; race_password="$(openssl rand -hex 18)"
wrong_email="t071-support-${run_id}@example.invalid"; wrong_password="$(openssl rand -hex 18)"
printf '%s\0%s\0%s\0' "$admin_password" "$race_password" "$wrong_password" >> "$redaction_secrets_file"
admin_kc_id="$(internal_create_user "$admin_email" "$admin_password" BillingAdmin)"
race_kc_id="$(internal_create_user "$race_email" "$race_password" BillingAdmin)"
wrong_kc_id="$(internal_create_user "$wrong_email" "$wrong_password" SupportAgent)"
'''
one(anchor, anchor+internal)

# The master admin token is deliberately short-lived. Odoo bootstrap and migrations
# can outlast it, so replace the private curl header immediately before the late
# tenant bindings. Register the replacement for log redaction before installing it.
late_bind_anchor='bind_owner "$alpha_kc_id" "$alpha_tenant_id"'
late_admin_renewal=r'''echo "== T071: renewing scratch Keycloak admin token before late bindings =="
TOKEN="$(admin_token)"
[ -n "$TOKEN" ] || fail "could not renew scratch Keycloak admin token before tenant bindings"
printf '%s\0' "$TOKEN" >> "$redaction_secrets_file"
write_token_header
'''
one(late_bind_anchor, late_admin_renewal+late_bind_anchor)

# Seed five distinct periods using current schema, put a genuine PDF into the tenant
# bucket, and retain all IDs only inside the owner-only runtime directory.
seed_anchor='echo "PASS: control-plane seeded — Alpha tenant=${alpha_tenant_id}, Beta tenant=${beta_tenant_id}; both bound WorkspaceOwner in scratch Keycloak." | tee -a "$evidence_file"'
seed=r'''
subscription_id="$(psql_q "SELECT id FROM subscription WHERE tenant_id='${alpha_tenant_id}';")"
seed_submission() { local tag="$1" month="$2"; psql_q "WITH fixture AS (SELECT gen_random_uuid() id, clock_timestamp() changed_at) INSERT INTO payment_submission (id,tenant_id,subscription_id,billing_period_start,billing_period_end,amount,currency,bank_reference,proof_object_key,status,status_history) SELECT id,'${alpha_tenant_id}','${subscription_id}','2027-${month}-01','2027-${month}-28','1250.50','AED','T071-${tag}-${run_id}','payment-submissions/'||id||'/proof.pdf','PendingReview',jsonb_build_array(jsonb_build_object('status','PendingReview','changedAt',to_char(changed_at at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),'changedBy',NULL,'notes',NULL,'bankReference','T071-${tag}-${run_id}','proofObjectKey','payment-submissions/'||id||'/proof.pdf')) FROM fixture RETURNING id;"; }
approve_id="$(seed_submission APPROVE 01)"; reject_id="$(seed_submission REJECT 02)"; info_id="$(seed_submission INFO 03)"; race_id="$(seed_submission RACE 04)"; fault_id="$(seed_submission FAULT 05)"
proof="$private_dir/proof.pdf"; printf '%%PDF-1.7\nT071 inert synthetic proof\n%%%%EOF\n' > "$proof"
minio_fixture_config="$private_dir/minio-fixture.json"
cat > "$minio_fixture_config" <<JSON
{"endpoint":"http://127.0.0.1:${minio_host_port}","accessKey":"${minio_access}","secretKey":"${minio_secret}","tenantId":"${alpha_tenant_id}","submissionIds":["${approve_id}","${reject_id}","${info_id}","${race_id}","${fault_id}"],"proofPath":"${proof}"}
JSON
chmod 600 "$minio_fixture_config"
( cd "$api_dir"; T071_MINIO_FIXTURE_CONFIG="$minio_fixture_config" node "$repo_dir/scripts/fixtures/t071_minio_fixture.mjs" ) >"$artifacts_dir/minio-fixture.log" 2>&1 || { redact_secrets <"$artifacts_dir/minio-fixture.log"; fail 'MinIO SDK fixture failed'; }
owned_proof_bucket="kemfai-tenant-${alpha_tenant_id}"
psql_q "UPDATE tenant SET minio_bucket='${owned_proof_bucket}' WHERE id='${alpha_tenant_id}';" >/dev/null
[ "$(psql_q "SELECT minio_bucket FROM tenant WHERE id='${alpha_tenant_id}';")" = "$owned_proof_bucket" ] || fail 'owned tenant was not linked to its owned proof bucket'
'''
one(seed_anchor, seed_anchor+seed)

phase5='echo "== Phase 5: starting the REAL NestJS API process =="'
build=r'''sanitize_host_environment
export HOME="$private_dir/host-home"; mkdir -p "$HOME"; chmod 700 "$HOME"
proxy_port="$(free_port)"
echo '== T071 build: current API and frontend against owned endpoints =='
( cd "$api_dir"; sanitize_host_environment; npm run build ) >"$artifacts_dir/api-build.log" 2>&1 || { redact_secrets <"$artifacts_dir/api-build.log"; fail 'API build failed'; }
( cd "$frontend_dir"; sanitize_host_environment; export NEXT_PUBLIC_DEFAULT_LOCALE=en NEXT_PUBLIC_API_URL="http://127.0.0.1:${api_port}" NEXT_PUBLIC_PAYMENT_PROOF_ORIGINS="http://127.0.0.1:${minio_host_port}" KEMFAI_API_URL="http://127.0.0.1:${proxy_port}" REDIS_URL="redis://127.0.0.1:${redis_host_port}" SUPPORT_EMAIL='support@example.invalid'; export INTERNAL_KEYCLOAK_ISSUER="${kc_base}/realms/${internal_realm}" INTERNAL_KEYCLOAK_BACKCHANNEL_URL="${kc_base}/realms/${internal_realm}" INTERNAL_KEYCLOAK_JWKS_URI="${kc_base}/realms/${internal_realm}/protocol/openid-connect/certs" INTERNAL_KEYCLOAK_CLIENT_ID=kemfai-internal-ui INTERNAL_KEYCLOAK_REDIRECT_URI="$internal_redirect_uri"; npm run build ) >"$artifacts_dir/frontend-build.log" 2>&1 || { redact_secrets <"$artifacts_dir/frontend-build.log"; fail 'frontend build failed'; }
echo "== Phase 5: starting the REAL NestJS API process =="'''
one(phase5, build)
one('exec setsid node dist/main.js', 'exec python3 -I "$repo_dir/scripts/fixtures/t071_owned_session_exec.py" --hold-for-cleanup --keep-env PORT,HOST,NODE_ENV,CONTROL_DB_HOST,CONTROL_DB_PORT,CONTROL_DB_USER,CONTROL_DB_PASSWORD,CONTROL_DB_NAME,REDIS_URL,KEMFAI_ODOO_URL,KEMFAI_ODOO_MASTER_PASSWORD,KEMFAI_TENANT_ADMIN_LOGIN,KEMFAI_TENANT_ADMIN_PASSWORD,KEYCLOAK_URL,KEYCLOAK_CUSTOMERS_REALM,KEYCLOAK_ISSUER,KEYCLOAK_JWKS_URI,KEYCLOAK_API_AUDIENCE,KEYCLOAK_ADMIN,KEYCLOAK_ADMIN_PASSWORD,OPENAPI_CONTRACT_PATH,STORAGE_ENDPOINT,STORAGE_ACCESS_KEY,STORAGE_SECRET_KEY,KEYCLOAK_INTERNAL_REALM,KEYCLOAK_INTERNAL_ISSUER,KEYCLOAK_INTERNAL_JWKS_URI,KEYCLOAK_INTERNAL_API_AUDIENCE,RESEND_API_KEY,RESEND_FROM,RESEND_BASE_URL,RESEND_ALLOW_LOOPBACK_FIXTURE node dist/main.js')
one('  cd "$frontend_dir"\n  export NODE_ENV=production PORT=', '  cd "$frontend_dir"\n  export NEXT_PUBLIC_PAYMENT_PROOF_ORIGINS="http://127.0.0.1:${minio_host_port}"\n  export NODE_ENV=production PORT=')
one('exec setsid npx next start -p "$frontend_port"', 'exec python3 -I "$repo_dir/scripts/fixtures/t071_owned_session_exec.py" --hold-for-cleanup --keep-env NEXT_PUBLIC_PAYMENT_PROOF_ORIGINS,NODE_ENV,PORT,NEXT_PUBLIC_API_URL,NEXT_PUBLIC_DEFAULT_LOCALE,KEYCLOAK_ISSUER,KEYCLOAK_BACKCHANNEL_URL,KEYCLOAK_JWKS_URI,KEYCLOAK_CLIENT_ID,KEYCLOAK_REDIRECT_URI,KEMFAI_API_URL,INTERNAL_KEYCLOAK_ISSUER,INTERNAL_KEYCLOAK_BACKCHANNEL_URL,INTERNAL_KEYCLOAK_JWKS_URI,INTERNAL_KEYCLOAK_CLIENT_ID,INTERNAL_KEYCLOAK_REDIRECT_URI,REDIS_URL,SUPPORT_EMAIL npx next start -H 127.0.0.1 -p "$frontend_port"')
one('api_pid=$!', 'api_pid=$!\nregister_owned_process "$api_pid" "dist/main.js"')
one('frontend_pid=$!', 'frontend_pid=$!\nregister_owned_process "$frontend_pid" "next"')

# Configure exact internal auth and real storage endpoints. The controlled proxy forwards
# every request to Nest; it corrupts one already-committed 2xx response exactly once.
one('export STORAGE_ENDPOINT="http://127.0.0.1:1" STORAGE_ACCESS_KEY=unused STORAGE_SECRET_KEY=unused', '''export STORAGE_ENDPOINT="http://127.0.0.1:${minio_host_port}" STORAGE_ACCESS_KEY="$minio_access" STORAGE_SECRET_KEY="$minio_secret"
  export KEYCLOAK_INTERNAL_REALM="$internal_realm" KEYCLOAK_INTERNAL_ISSUER="${kc_base}/realms/${internal_realm}"
  export KEYCLOAK_INTERNAL_JWKS_URI="${kc_base}/realms/${internal_realm}/protocol/openid-connect/certs" KEYCLOAK_INTERNAL_API_AUDIENCE=kemfai-api
  export RESEND_API_KEY="$minio_secret" RESEND_FROM='KEMFAI Billing <billing@example.invalid>' RESEND_BASE_URL="http://127.0.0.1:${proxy_port}" RESEND_ALLOW_LOOPBACK_FIXTURE=1''')
one('echo "== Phase 6: starting the REAL Next.js frontend process =="', '''proxy_log="$artifacts_dir/fault-proxy.log"; fault_count="$private_dir/fault-count"; email_sink="$private_dir/email-sink"
( export T071_PROXY_UPSTREAM="http://127.0.0.1:${api_port}" T071_PROXY_PORT="$proxy_port" T071_FAULT_SUBMISSION_ID="$fault_id" T071_FAULT_COUNT_FILE="$fault_count" T071_EMAIL_SINK_FILE="$email_sink"; exec python3 -I "$repo_dir/scripts/fixtures/t071_owned_session_exec.py" --hold-for-cleanup --keep-env T071_PROXY_UPSTREAM,T071_PROXY_PORT,T071_FAULT_SUBMISSION_ID,T071_FAULT_COUNT_FILE,T071_EMAIL_SINK_FILE node "$repo_dir/scripts/fixtures/t071_fault_proxy.mjs" ) >"$proxy_log" 2>&1 &
proxy_pid=$!
register_owned_process "$proxy_pid" "t071_fault_proxy.mjs"
echo "== Phase 6: starting the REAL Next.js frontend process =="''')
one('terminate_owned_process_group "$api_pid" "dist/main.js" || cleanup_verification_failed=1', 'terminate_owned_process_group "$proxy_pid" "t071_fault_proxy.mjs" || cleanup_verification_failed=1\n  terminate_owned_process_group "$api_pid" "dist/main.js" || cleanup_verification_failed=1')
one('api_pid=""\nfrontend_pid=""', 'api_pid=""\nfrontend_pid=""\nproxy_pid=""')
one('export KEMFAI_API_URL="http://127.0.0.1:${api_port}"\n  export REDIS_URL=', '''export KEMFAI_API_URL="http://127.0.0.1:${proxy_port}"
  export INTERNAL_KEYCLOAK_ISSUER="${kc_base}/realms/${internal_realm}"
  export INTERNAL_KEYCLOAK_BACKCHANNEL_URL="${kc_base}/realms/${internal_realm}"
  export INTERNAL_KEYCLOAK_JWKS_URI="${kc_base}/realms/${internal_realm}/protocol/openid-connect/certs"
  export INTERNAL_KEYCLOAK_CLIENT_ID=kemfai-internal-ui INTERNAL_KEYCLOAK_REDIRECT_URI="$internal_redirect_uri"
  export REDIS_URL=''')

one('npx playwright test --config tests/e2e-live/playwright.live.config.ts', 'npx playwright test --config tests/e2e-live/playwright.t071-live.config.ts')
one('npx playwright test --config tests/e2e-live/playwright.t071-live.config.ts tests/e2e-live/t071-real-browser.live.spec.ts',
    'npx playwright test --config tests/e2e-live/playwright.t071-live.config.ts tests/e2e-live/t071-billing-admin.live.spec.ts')
one('real browser harness (tests/e2e-live/t071-real-browser.live.spec.ts) failed',
    'real browser harness (tests/e2e-live/t071-billing-admin.live.spec.ts) failed')
export_anchor='export T071_BETA_TENANT_ID="$beta_tenant_id"'
exports=r'''
export T071_API_URL="http://127.0.0.1:${api_port}" T071_BILLING_ADMIN_EMAIL="$admin_email" T071_BILLING_ADMIN_PASSWORD="$admin_password"
node "$repo_dir/scripts/fixtures/t071_validate_local_url.mjs" "$T071_BASE_URL" >/dev/null || fail 'generated frontend URL is not exact loopback origin'
node "$repo_dir/scripts/fixtures/t071_validate_local_url.mjs" "$T071_API_URL" >/dev/null || fail 'generated API URL is not exact loopback origin'
export T071_APPROVE_CUSTOMER_EMAIL="$alpha_email" T071_APPROVE_ID="$approve_id" T071_REJECT_ID="$reject_id" T071_MORE_INFO_ID="$info_id" T071_RACE_ID="$race_id" T071_FAULT_ID="$fault_id"
export T071_APPROVE_REF="T071-APPROVE-${run_id}" T071_REJECT_REF="T071-REJECT-${run_id}" T071_INFO_REF="T071-INFO-${run_id}" T071_FAULT_REF="T071-FAULT-${run_id}"
export T071_INTERNAL_ISSUER="${kc_base}/realms/${internal_realm}" T071_INTERNAL_TOKEN_URL="${kc_base}/realms/${internal_realm}/protocol/openid-connect/token" T071_CUSTOMER_TOKEN_URL="${kc_base}/realms/${realm_name}/protocol/openid-connect/token"
export T071_RACE_EMAIL="$race_email" T071_RACE_PASSWORD="$race_password" T071_WRONG_EMAIL="$wrong_email" T071_WRONG_PASSWORD="$wrong_password" T071_CUSTOMER_EMAIL="$alpha_email" T071_CUSTOMER_PASSWORD="$alpha_password"
export T071_CLIENT_ID=kemfai-internal-ui T071_CUSTOMER_CLIENT_ID=kemfai-api T071_SC008_EVIDENCE="$artifacts_dir/sc008.json" T071_FAULT_COUNT_FILE="$fault_count"
export T071_WRONG_AUDIENCE_CLIENT_ID=t071-wrong-audience
export T071_PLAYWRIGHT_OUTPUT_DIR="$private_dir/playwright-output"
'''
one(export_anchor, export_anchor+exports)

pass_anchor='echo "PASS: real browser Alpha persistence, stale-scope rejection, logout, and Beta isolation all verified end to end." | tee -a "$evidence_file"'
post=r'''
[ "$(cat "$fault_count")" = 1 ] || fail 'controlled ambiguous response was not injected exactly once'
for pair in "$approve_id:Approved" "$reject_id:Rejected" "$info_id:MoreInfoRequested" "$race_id:Approved" "$fault_id:Rejected"; do id="${pair%%:*}"; expected="${pair##*:}"; [ "$(psql_q "SELECT status FROM payment_submission WHERE id='${id}';")" = "$expected" ] || fail "persisted status mismatch for $id"; done
[ "$(psql_q "SELECT count(*) FROM payment_submission WHERE id IN ('${approve_id}','${reject_id}','${info_id}','${race_id}','${fault_id}') AND jsonb_array_length(status_history)=2;")" = 5 ] || fail 'append-only status history was not persisted for every decision'
[ "$(psql_q "SELECT count(*) FROM payment_submission WHERE (id='${reject_id}' AND decision_notes='Synthetic rejection reason') OR (id='${info_id}' AND decision_notes='Upload a clearer proof') OR (id='${fault_id}' AND decision_notes='Controlled ambiguous response');")" = 3 ] || fail 'exact required reject/more-info notes were not persisted'
[ "$(psql_q "SELECT count(*) FROM subscription WHERE id='${subscription_id}' AND status='Active' AND current_period_start='2027-04-01' AND current_period_end='2027-04-28' AND activated_at IS NOT NULL;")" = 1 ] || fail 'approval/race activation effects were not persisted'
[ "$(psql_q "SELECT count(*) FROM audit_event WHERE action='billing.payment_submission.decided' AND subject_id IN ('${approve_id}','${reject_id}','${info_id}','${race_id}','${fault_id}');")" = 5 ] || fail 'decision audit count mismatch'
[ "$(psql_q "SELECT count(*) FROM billing_decision_notification_outbox WHERE submission_id IN ('${approve_id}','${reject_id}','${info_id}','${race_id}','${fault_id}');")" = 5 ] || fail 'notification outbox count mismatch'
delivered=0
for _ in $(seq 1 50); do delivered="$(psql_q "SELECT count(*) FROM billing_decision_notification_outbox WHERE delivered_at IS NOT NULL AND submission_id IN ('${approve_id}','${reject_id}','${info_id}','${race_id}','${fault_id}');")"; [ "$delivered" = 5 ] && break; sleep 0.2; done
[ "$delivered" = 5 ] || fail 'local-only notification sink did not durably acknowledge five outbox rows'
[ "$(wc -l < "$email_sink")" = 5 ] || fail 'local-only notification sink count mismatch'
python3 - "$artifacts_dir/sc008.json" <<'P'
import json,sys
d=json.load(open(sys.argv[1])); assert 0 < d['milliseconds'] < 300000
P
echo 'PASS: persisted statuses/history, activation effects, five audits/outbox rows, one fault, and measured SC-008 verified.' | tee -a "$evidence_file"
'''
one(pass_anchor, post)

s=s.replace('repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"', 'repo_dir="${KEMFAI_T071_REPO_DIR:?KEMFAI_T071_REPO_DIR is required}"',1)
p.write_text(s)
PY
chmod 700 "$stage"
if [ "${KEMFAI_T071_VALIDATE_STAGE_ONLY:-0}" = 1 ]; then
  bash -n "$stage"
  [ -z "${KEMFAI_T071_STAGE_OUTPUT:-}" ] || { cp "$stage" "$KEMFAI_T071_STAGE_OUTPUT"; chmod 600 "$KEMFAI_T071_STAGE_OUTPUT"; }
  echo 'PASS: staged T071 owned-stack harness is syntactically valid.'
  exit 0
fi
export KEMFAI_T071_REPO_DIR="$repo_dir"
staged_pid=""
forward_stage_signal() {
  local signal_status=143
  trap - INT TERM
  if [ -n "$staged_pid" ]; then
    kill -TERM "$staged_pid" 2>/dev/null || true
    wait "$staged_pid" || signal_status=$?
  fi
  exit "$signal_status"
}
trap forward_stage_signal INT TERM
set +e
"$stage" &
staged_pid=$!
wait "$staged_pid"
status=$?
set -e
trap - INT TERM
exit "$status"
