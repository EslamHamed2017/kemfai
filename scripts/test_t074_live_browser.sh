#!/usr/bin/env bash
# T074/T077 and T080/T083 exact-owned Chromium -> Next BFF -> normal Nest AppModule -> PG/Redis/Odoo proof.
set -euo pipefail
umask 077
repo_dir="${KEMFAI_T074_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
api_dir="$repo_dir/backend/api"; frontend_dir="$repo_dir/frontend"; addons_dir="$repo_dir/backend/addons"
run_id="t074_$(date -u +%Y%m%dT%H%M%SZ)_$$_${RANDOM}"; label="kemfai.t074.run=$run_id"
live_mode="${KEMFAI_LIVE_MODE:-t074}"
network="${run_id}_net"; pg="${run_id}_pg"; redis="${run_id}_redis"; odoo="${run_id}_odoo"
pg_volume="${run_id}_pgdata"; odoo_volume="${run_id}_odoodata"; control_db="${run_id}_control"
tenant_a_db="${run_id}_tenant_a"; tenant_b_db="${run_id}_tenant_b"
private_dir="$(mktemp -d)"; chmod 700 "$private_dir"
artifacts_dir="${KEMFAI_ARTIFACTS_DIR:-$repo_dir/.artifacts/$run_id}"; mkdir -p "$artifacts_dir"; chmod 700 "$artifacts_dir"
source "$repo_dir/scripts/fixtures/t071_process_lifecycle.sh"
declare -a relay_pids=(); declare -A owned_pid_starttime=(); declare -A owned_pid_session=()
api_pid=""; frontend_pid=""; identity_pid=""; cleanup_failed=0
fail(){ echo "FAIL T074 live: $*" >&2; exit 1; }
cleanup(){
  local status=$? pid survivors
  trap - EXIT INT TERM; set +e
  terminate_owned_process_group "$frontend_pid" next || cleanup_failed=1
  terminate_owned_process_group "$api_pid" dist/main.js || cleanup_failed=1
  terminate_owned_process_group "$identity_pid" t074-live-identity.ts || cleanup_failed=1
  for pid in "${relay_pids[@]}"; do terminate_owned_process_group "$pid" t071_loopback_relay.py || cleanup_failed=1; done
  mapfile -t owned < <(docker ps -aq --filter "label=$label" 2>/dev/null)
  [ "${#owned[@]}" -eq 0 ] || docker rm -fv "${owned[@]}" >/dev/null 2>&1 || cleanup_failed=1
  docker network ls -q --filter "label=$label" | xargs -r docker network rm >/dev/null 2>&1 || cleanup_failed=1
  docker volume ls -q --filter "label=$label" | xargs -r docker volume rm >/dev/null 2>&1 || cleanup_failed=1
  survivors="$(docker ps -aq --filter "label=$label"; docker network ls -q --filter "label=$label"; docker volume ls -q --filter "label=$label")"
  printf 'label=%s\ncontainer_network_volume_survivors=%s\n' "$label" "${survivors:-none}" >"$artifacts_dir/cleanup.txt"
  [ -z "$survivors" ] || cleanup_failed=1
  rm -rf -- "$private_dir"
  [ "$cleanup_failed" -eq 0 ] || status=1
  exit "$status"
}
trap cleanup EXIT INT TERM
for c in docker node npm python3 curl openssl; do command -v "$c" >/dev/null || fail "$c missing"; done
docker info >/dev/null 2>&1 || fail 'Docker unavailable'
[ ! -e "$api_dir/.env" ] && [ ! -e "$frontend_dir/.env" ] || fail 'checkout-local env refused'
for image in postgres:16 redis:7-alpine odoo:18; do docker image inspect "$image" >/dev/null || fail "offline image missing: $image"; done
free_port(){ python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'; }
api_port="$(free_port)"; frontend_port="$(free_port)"
pg_user="t074_$(openssl rand -hex 5)"; pg_password="$(openssl rand -hex 24)"; odoo_password="$(openssl rand -hex 24)"; odoo_master="$(openssl rand -hex 24)"
secrets="$private_dir/secrets"; printf '%s\0%s\0%s\0' "$pg_password" "$odoo_password" "$odoo_master" >"$secrets"
redact(){ python3 -c 'import pathlib,sys;d=sys.stdin.buffer.read();[(globals().__setitem__("d",d.replace(v,b"[REDACTED]"))) for v in pathlib.Path(sys.argv[1]).read_bytes().split(b"\0") if v];sys.stdout.buffer.write(d)' "$secrets"; }
pg_env="$private_dir/pg.env"; printf 'POSTGRES_USER=%s\nPOSTGRES_PASSWORD=%s\nPOSTGRES_DB=%s\n' "$pg_user" "$pg_password" "$control_db" >"$pg_env"
docker network create --internal --label "$label" "$network" >/dev/null
docker volume create --label "$label" "$pg_volume" >/dev/null; docker volume create --label "$label" "$odoo_volume" >/dev/null
docker run -d --label "$label" --name "$pg" --network "$network" --env-file "$pg_env" -v "$pg_volume:/var/lib/postgresql/data" postgres:16 >/dev/null
docker run -d --label "$label" --name "$redis" --network "$network" redis:7-alpine redis-server --save '' --appendonly no >/dev/null
for _ in $(seq 1 60); do docker exec "$pg" psql -U "$pg_user" -d "$control_db" -tAc 'select 1' 2>/dev/null | grep -qx 1 && break; sleep .5; done
docker exec "$pg" psql -U "$pg_user" -d "$control_db" -tAc 'select 1' 2>/dev/null | grep -qx 1 || { docker logs "$pg" 2>&1 | redact >"$artifacts_dir/postgres-failure.log"; fail 'PostgreSQL not ready'; }
[ "$(docker exec "$redis" redis-cli ping)" = PONG ] || fail 'Redis not ready'
odoo_conf="$private_dir/odoo.conf"; cat >"$odoo_conf" <<EOF
[options]
admin_passwd=$odoo_master
db_host=$pg
db_port=5432
db_user=$pg_user
db_password=$pg_password
dbfilter=^${run_id}_tenant_[ab]$
list_db=False
workers=0
without_demo=all
addons_path=/mnt/extra-addons,/usr/lib/python3/dist-packages/odoo/addons
EOF
chmod 644 "$odoo_conf"
for db in "$tenant_a_db" "$tenant_b_db"; do
  addons="base,kemfai_tenant_core,kemfai_module_selection"
  [ "$live_mode" != t080 ] || addons="$addons,kemfai_onboarding_checklist"
  docker run --rm --label "$label" --network "$network" -v "$addons_dir:/mnt/extra-addons:ro" -v "$odoo_conf:/etc/odoo/odoo.conf:ro" odoo:18 odoo -c /etc/odoo/odoo.conf -d "$db" -i "$addons" --stop-after-init --without-demo=all >"$artifacts_dir/bootstrap-$db.log" 2>&1 || fail "Odoo bootstrap $db"
  printf "env['res.users'].browse(2).write({'login':'admin','password':'%s'})\nenv.cr.commit()\n" "$odoo_password" | docker run --rm -i --label "$label" --network "$network" -v "$addons_dir:/mnt/extra-addons:ro" -v "$odoo_conf:/etc/odoo/odoo.conf:ro" odoo:18 odoo shell -c /etc/odoo/odoo.conf -d "$db" --no-http >>"$artifacts_dir/bootstrap-$db.log" 2>&1 || fail "Odoo admin $db"
  if [ "$live_mode" = t080 ]; then
    printf "r=env['kemfai.module.selection'].kemfai_replace_selection(['module.sales','module.accounting','module.inventory'],'08000000-0000-4000-8000-000000000004','08000000-0000-4000-8000-000000000001','08000000-0000-4000-8000-000000000002','08000000-0000-4000-8000-000000000003','2026-10-17T08:00:00.000Z')\nenv['kemfai.module.selection'].kemfai_ack_selection_event(r['operationUuid'],'08000000-0000-4000-8000-000000000001','08000000-0000-4000-8000-000000000002','08000000-0000-4000-8000-000000000003')\nenv.cr.commit()\n" | docker run --rm -i --label "$label" --network "$network" -v "$addons_dir:/mnt/extra-addons:ro" -v "$odoo_conf:/etc/odoo/odoo.conf:ro" odoo:18 odoo shell -c /etc/odoo/odoo.conf -d "$db" --no-http >>"$artifacts_dir/bootstrap-$db.log" 2>&1 || fail "Odoo checklist module destinations $db"
    printf '%s\n' \
      'company = env.company' \
      'journals = env["account.journal"].search([("active", "=", True), ("type", "=", "bank"), ("company_id", "=", company.id)])' \
      'banks = env["res.partner.bank"].search([("active", "=", True), ("partner_id", "=", company.partner_id.id)])' \
      'print("KEMFAI_EMPTY_BANK_BASELINE database=%s journals=%s banks=%s" % (env.cr.dbname, len(journals), len(banks)))' \
      'journals.write({"active": False})' \
      'banks.write({"active": False})' \
      'env.cr.commit()' | docker run --rm -i --label "$label" --network "$network" -v "$addons_dir:/mnt/extra-addons:ro" -v "$odoo_conf:/etc/odoo/odoo.conf:ro" odoo:18 odoo shell -c /etc/odoo/odoo.conf -d "$db" --no-http >>"$artifacts_dir/bootstrap-$db.log" 2>&1 || fail "Odoo empty bank baseline $db"
  fi
done
if [ "$live_mode" = t080 ]; then
  docker run --rm --label "$label" --network "$network" -v "$addons_dir:/mnt/extra-addons:ro" -v "$odoo_conf:/etc/odoo/odoo.conf:ro" odoo:18 odoo -c /etc/odoo/odoo.conf -d "$tenant_a_db" -u kemfai_onboarding_checklist --test-enable --test-tags /kemfai_onboarding_checklist --stop-after-init --without-demo=all >"$artifacts_dir/odoo-checklist-regression.log" 2>&1 || fail "Odoo checklist regression"
fi
docker run -d --label "$label" --name "$odoo" --network "$network" -v "$addons_dir:/mnt/extra-addons:ro" -v "$odoo_conf:/etc/odoo/odoo.conf:ro" -v "$odoo_volume:/var/lib/odoo" odoo:18 odoo -c /etc/odoo/odoo.conf >/dev/null
start_relay(){
  local container="$1" port="$2" out="$3" ip subnet cfg ready pid rpid rport
  ip="$(docker inspect -f "{{with index .NetworkSettings.Networks \"$network\"}}{{.IPAddress}}{{end}}" "$container")"; subnet="$(docker network inspect -f '{{(index .IPAM.Config 0).Subnet}}' "$network")"
  cfg="$private_dir/relay-$container.json"; ready="$private_dir/relay-$container.ready"; printf '{"targetIp":"%s","subnet":"%s","targetPort":%s,"readyFile":"%s"}\n' "$ip" "$subnet" "$port" "$ready" >"$cfg"
  (export T071_RELAY_CONFIG="$cfg"; exec python3 -I "$repo_dir/scripts/fixtures/t071_owned_session_exec.py" --hold-for-cleanup --keep-env T071_RELAY_CONFIG python3 "$repo_dir/scripts/fixtures/t071_loopback_relay.py") >"$artifacts_dir/relay-$container.log" 2>&1 & pid=$!; relay_pids+=("$pid"); register_owned_process "$pid" t071_loopback_relay.py
  for _ in $(seq 1 100); do [ -s "$ready" ] && break; sleep .05; done; [ -s "$ready" ] || fail "relay $container"
  read -r rpid rport < <(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d["pid"],d["port"])' "$ready"); [ "$rpid" = "$pid" ] || fail 'relay pid mismatch'; printf -v "$out" '%s' "$rport"
}
start_relay "$pg" 5432 pg_port; start_relay "$redis" 6379 redis_port; start_relay "$odoo" 8069 odoo_port
for _ in $(seq 1 120); do curl -sf "http://127.0.0.1:$odoo_port/web/health" >/dev/null && break; sleep .5; done
curl -sf "http://127.0.0.1:$odoo_port/web/health" >/dev/null || fail 'Odoo not ready'
export CONTROL_DB_HOST=127.0.0.1 CONTROL_DB_PORT="$pg_port" CONTROL_DB_USER="$pg_user" CONTROL_DB_PASSWORD="$pg_password" CONTROL_DB_NAME="$control_db" REDIS_URL="redis://127.0.0.1:$redis_port/14"
(cd "$api_dir" && npm run migration:run) >"$artifacts_dir/migrations.log" 2>&1 || fail 'migrations'
if [ "$live_mode" = t080 ]; then
  (cd "$api_dir"; export OPENAPI_CONTRACT_PATH="$repo_dir/specs/001-saas-onboarding-shell/contracts/openapi.yaml" KEMFAI_ODOO_URL="http://127.0.0.1:$odoo_port" KEMFAI_ODOO_MASTER_PASSWORD="$odoo_master" KEMFAI_TENANT_ADMIN_LOGIN=admin KEMFAI_TENANT_ADMIN_PASSWORD="$odoo_password"; timeout 600 npm run test:contract -- --runInBand) >"$artifacts_dir/api-contract-full.log" 2>&1 || { redact <"$artifacts_dir/api-contract-full.log"; fail 'full API contract gate'; }
  (cd "$api_dir"; export OPENAPI_CONTRACT_PATH="$repo_dir/specs/001-saas-onboarding-shell/contracts/openapi.yaml" KEMFAI_ODOO_URL="http://127.0.0.1:$odoo_port" KEMFAI_ODOO_MASTER_PASSWORD="$odoo_master" KEMFAI_TENANT_ADMIN_LOGIN=admin KEMFAI_TENANT_ADMIN_PASSWORD="$odoo_password"; timeout 1200 npm run test:integration -- --runInBand) >"$artifacts_dir/api-integration-nonlive.log" 2>&1 || { redact <"$artifacts_dir/api-integration-nonlive.log"; fail 'aggregate non-live API integration gate'; }
fi
psql_env="$private_dir/psql.env"; printf 'PGPASSWORD=%s\n' "$pg_password" >"$psql_env"
psql_q(){ docker exec --env-file "$psql_env" "$pg" psql -U "$pg_user" -d "$control_db" -X -q -t -A -c "$1"; }
plan_a="$(psql_q "INSERT INTO plan(name,name_en,name_ar,published,monthly_price,annual_price,currency) VALUES('Current','Current','الحالية',true,10,100,'USD') RETURNING id")"; plan_b="$(psql_q "INSERT INTO plan(name,name_en,name_ar,published,monthly_price,annual_price,currency) VALUES('Growth','Growth','النمو',true,20,200,'USD') RETURNING id")"
psql_q "INSERT INTO feature(id,key,display_name,display_name_en,display_name_ar,kind) VALUES(gen_random_uuid(),'module.sales','Sales','Sales','المبيعات','module'),(gen_random_uuid(),'module.accounting','Accounting','Accounting','المحاسبة','module'),(gen_random_uuid(),'module.inventory','Inventory','Inventory','المخزون','module') ON CONFLICT(key) DO UPDATE SET display_name_en=excluded.display_name_en,display_name_ar=excluded.display_name_ar; INSERT INTO plan_feature_entitlement(plan_id,feature_key,enabled) VALUES('$plan_a','module.sales',true),('$plan_a','module.accounting',true),('$plan_a','module.inventory',true),('$plan_b','module.sales',true),('$plan_b','module.accounting',true),('$plan_b','module.inventory',true); INSERT INTO plan_setting(plan_id,trial_window_days,auto_restrict_unpaid) VALUES('$plan_a',14,true),('$plan_b',14,true); UPDATE feature_flag SET enabled=true WHERE feature_key='module.module_selection';" >/dev/null
[ "$live_mode" != t080 ] || psql_q "INSERT INTO feature(id,key,display_name,display_name_en,display_name_ar,kind) VALUES(gen_random_uuid(),'module.onboarding_checklist','Onboarding checklist (US7)','Onboarding checklist (US7)','قائمة بدء الاستخدام','module') ON CONFLICT(key) DO NOTHING; INSERT INTO feature_flag(feature_key,enabled,notes) VALUES('module.onboarding_checklist',true,'Owned T080 live fixture') ON CONFLICT(feature_key) DO UPDATE SET enabled=excluded.enabled,notes=excluded.notes;" >/dev/null
sub_a=07400000-0000-4000-8000-000000000001; sub_b=07400000-0000-4000-8000-000000000002
acct_a="$(psql_q "INSERT INTO account(keycloak_user_id,email,email_verified,selected_plan_id,selected_billing_cycle) VALUES('$sub_a','a@example.invalid',true,'$plan_a','monthly') RETURNING id")"; acct_b="$(psql_q "INSERT INTO account(keycloak_user_id,email,email_verified,selected_plan_id,selected_billing_cycle) VALUES('$sub_b','b@example.invalid',true,'$plan_b','monthly') RETURNING id")"
tenant_a="$(psql_q "INSERT INTO tenant(account_id,status,odoo_db_name,ready_at) VALUES('$acct_a','Ready','$tenant_a_db',now()) RETURNING id")"; tenant_b="$(psql_q "INSERT INTO tenant(account_id,status,odoo_db_name,ready_at) VALUES('$acct_b','Ready','$tenant_b_db',now()) RETURNING id")"
psql_q "INSERT INTO subscription(tenant_id,plan_id,billing_cycle,status,current_period_start,current_period_end) VALUES('$tenant_a','$plan_a','monthly','Active',current_date,current_date+30),('$tenant_b','$plan_b','monthly','Active',current_date,current_date+30);" >/dev/null
[ "$live_mode" != t080 ] || psql_q "UPDATE subscription SET status='PendingActivation' WHERE tenant_id='$tenant_a';" >/dev/null
identity_json="$private_dir/identity.json"
(cd "$api_dir"; export T074_IDENTITY_OUTPUT="$identity_json" T074_TENANT_A_ID="$tenant_a" T074_TENANT_B_ID="$tenant_b"; exec python3 -I "$repo_dir/scripts/fixtures/t071_owned_session_exec.py" --hold-for-cleanup --keep-env T074_IDENTITY_OUTPUT,T074_TENANT_A_ID,T074_TENANT_B_ID ./node_modules/.bin/ts-node test/support/t074-live-identity.ts) >"$artifacts_dir/identity.log" 2>&1 & identity_pid=$!; register_owned_process "$identity_pid" t074-live-identity.ts
for _ in $(seq 1 100); do [ -s "$identity_json" ] && break; sleep .1; done; [ -s "$identity_json" ] || fail 'identity fixture'
readarray -t ident < <(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d["issuer"]);print(d["audience"]);print(d["jwksUri"]);print(d["tokenA"]);print(d["tokenB"]);print(d["tokenNonOwner"])' "$identity_json")
issuer="${ident[0]}"; audience="${ident[1]}"; jwks="${ident[2]}"; token_a="${ident[3]}"; token_b="${ident[4]}"; token_non_owner="${ident[5]}"; printf '%s\0%s\0%s\0' "$token_a" "$token_b" "$token_non_owner" >>"$secrets"
session_a="$(openssl rand -hex 24)"; session_b="$(openssl rand -hex 24)"; now_ms="$(date +%s000)"; exp_ms="$((now_ms+1800000))"
docker exec "$redis" redis-cli -n 14 SET "kemfai:session:$session_a" "{\"accessToken\":\"$token_a\",\"refreshToken\":\"synthetic-a\",\"accessExpiresAt\":$exp_ms,\"refreshExpiresAt\":$exp_ms}" PX 1800000 >/dev/null
docker exec "$redis" redis-cli -n 14 SET "kemfai:session:$session_b" "{\"accessToken\":\"$token_b\",\"refreshToken\":\"synthetic-b\",\"accessExpiresAt\":$exp_ms,\"refreshExpiresAt\":$exp_ms}" PX 1800000 >/dev/null
(cd "$api_dir" && npm run build) >"$artifacts_dir/api-build.log" 2>&1 || fail 'API build'
(cd "$frontend_dir" && NEXT_PUBLIC_DEFAULT_LOCALE=en KEMFAI_API_URL="http://127.0.0.1:$api_port" REDIS_URL="redis://127.0.0.1:$redis_port/14" npm run build) >"$artifacts_dir/frontend-build.log" 2>&1 || fail 'frontend build'
(cd "$api_dir"; export PORT="$api_port" HOST=127.0.0.1 NODE_ENV=test KEYCLOAK_ISSUER="$issuer" KEYCLOAK_API_AUDIENCE="$audience" KEYCLOAK_JWKS_URI="$jwks" KEMFAI_ODOO_URL="http://127.0.0.1:$odoo_port" KEMFAI_ODOO_MASTER_PASSWORD="$odoo_master" KEMFAI_TENANT_ADMIN_LOGIN=admin KEMFAI_TENANT_ADMIN_PASSWORD="$odoo_password" KEMFAI_DISABLE_MODULE_SELECTION_RECOVERY_WORKER=1 OPENAPI_CONTRACT_PATH="$repo_dir/specs/001-saas-onboarding-shell/contracts/openapi.yaml"; exec python3 -I "$repo_dir/scripts/fixtures/t071_owned_session_exec.py" --hold-for-cleanup --keep-env PORT,HOST,NODE_ENV,KEYCLOAK_ISSUER,KEYCLOAK_API_AUDIENCE,KEYCLOAK_JWKS_URI,KEMFAI_ODOO_URL,KEMFAI_ODOO_MASTER_PASSWORD,KEMFAI_TENANT_ADMIN_LOGIN,KEMFAI_TENANT_ADMIN_PASSWORD,KEMFAI_DISABLE_MODULE_SELECTION_RECOVERY_WORKER,OPENAPI_CONTRACT_PATH,CONTROL_DB_HOST,CONTROL_DB_PORT,CONTROL_DB_USER,CONTROL_DB_PASSWORD,CONTROL_DB_NAME,REDIS_URL node dist/main.js) >"$artifacts_dir/api.log" 2>&1 & api_pid=$!; register_owned_process "$api_pid" dist/main.js
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$api_port/" >/dev/null && break; sleep 1; done; curl -sf "http://127.0.0.1:$api_port/" >/dev/null || fail 'API not ready'
if [ "$live_mode" = t080 ]; then
  (cd "$api_dir"; export KEMFAI_LIVE_T079=1 T079_API_URL="http://127.0.0.1:$api_port" T079_ODOO_URL="http://127.0.0.1:$odoo_port" T079_ODOO_DB_A="$tenant_a_db" T079_ODOO_DB_B="$tenant_b_db" T079_ODOO_PASSWORD="$odoo_password" T079_TOKEN_A="$token_a" T079_TOKEN_B="$token_b"; ./node_modules/.bin/jest --config test/jest-owned-integration.json --runInBand --runTestsByPath test/integration/checklist-liveness.integration-spec.ts) >"$artifacts_dir/t079-live.log" 2>&1 || { redact <"$artifacts_dir/t079-live.log"; fail 'T079 Odoo liveness'; }
fi
(cd "$frontend_dir"; export NODE_ENV=production PORT="$frontend_port" KEMFAI_API_URL="http://127.0.0.1:$api_port" REDIS_URL="redis://127.0.0.1:$redis_port/14" NEXT_PUBLIC_DEFAULT_LOCALE=en KEYCLOAK_ISSUER="$issuer" KEYCLOAK_BACKCHANNEL_URL="$issuer" KEYCLOAK_JWKS_URI="$jwks" KEYCLOAK_CLIENT_ID=kemfai-api KEYCLOAK_REDIRECT_URI="http://127.0.0.1:$frontend_port/auth/callback"; exec python3 -I "$repo_dir/scripts/fixtures/t071_owned_session_exec.py" --hold-for-cleanup --keep-env NODE_ENV,PORT,KEMFAI_API_URL,REDIS_URL,NEXT_PUBLIC_DEFAULT_LOCALE,KEYCLOAK_ISSUER,KEYCLOAK_BACKCHANNEL_URL,KEYCLOAK_JWKS_URI,KEYCLOAK_CLIENT_ID,KEYCLOAK_REDIRECT_URI npx next start -H 127.0.0.1 -p "$frontend_port") >"$artifacts_dir/frontend.log" 2>&1 & frontend_pid=$!; register_owned_process "$frontend_pid" next
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$frontend_port/" >/dev/null && break; sleep 1; done; curl -sf "http://127.0.0.1:$frontend_port/" >/dev/null || fail 'frontend not ready'
export T074_BASE_URL="http://127.0.0.1:$frontend_port" T074_SESSION_A="$session_a" T074_SESSION_B="$session_b" T074_PG_CONTAINER="$pg" T074_PG_USER="$pg_user" T074_CONTROL_DB="$control_db" T074_TENANT_A_ID="$tenant_a" T074_PLAN_A_ID="$plan_a" T074_UPGRADE_PLAN=Growth T074_PLAYWRIGHT_OUTPUT_DIR="$artifacts_dir/playwright"
if [ "$live_mode" = t080 ]; then
  export T080_BASE_URL="$T074_BASE_URL" T080_SESSION_A="$session_a" T080_SESSION_B="$session_b" T080_PG_CONTAINER="$pg" T080_PG_USER="$pg_user" T080_CONTROL_DB="$control_db" T080_TENANT_A_ID="$tenant_a" T080_TENANT_B_ID="$tenant_b" T080_TOKEN_A="$token_a" T080_TOKEN_NON_OWNER="$token_non_owner" T080_ODOO_URL="http://127.0.0.1:$odoo_port" T080_ODOO_DB_A="$tenant_a_db" T080_ODOO_DB_B="$tenant_b_db" T080_ODOO_LOGIN=admin T080_ODOO_PASSWORD="$odoo_password" T080_API_URL="http://127.0.0.1:$api_port" T080_PLAYWRIGHT_OUTPUT_DIR="$artifacts_dir/playwright"
  (cd "$frontend_dir" && npx playwright test --config tests/e2e-live/playwright.t080-live.config.ts) >"$artifacts_dir/browser.log" 2>&1 || { redact <"$artifacts_dir/browser.log"; fail 'browser journey'; }
else
  (cd "$frontend_dir" && npx playwright test --config tests/e2e-live/playwright.t074-live.config.ts) >"$artifacts_dir/browser.log" 2>&1 || { redact <"$artifacts_dir/browser.log"; fail 'browser journey'; }
fi
if [ "$live_mode" != t080 ]; then
  rpc_body="$private_dir/odoo-check.json"; printf '{"jsonrpc":"2.0","method":"call","params":{"service":"common","method":"login","args":["%s","admin","%s"]},"id":1}' "$tenant_a_db" "$odoo_password" >"$rpc_body"
  uid="$(curl -sf "http://127.0.0.1:$odoo_port/jsonrpc" -H 'content-type: application/json' --data @"$rpc_body" | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"])')"
  printf '{"jsonrpc":"2.0","method":"call","params":{"service":"object","method":"execute_kw","args":["%s",%s,"%s","kemfai.module.selection","kemfai_get_selection",[]]},"id":2}' "$tenant_a_db" "$uid" "$odoo_password" >"$rpc_body"
  selection="$(curl -sf "http://127.0.0.1:$odoo_port/jsonrpc" -H 'content-type: application/json' --data @"$rpc_body" | python3 -c 'import json,sys;print(json.dumps(json.load(sys.stdin)["result"],separators=(",",":")))')"
  [ "$selection" = '["module.accounting"]' ] || fail 'authoritative Odoo selection mismatch'
  printf 'odoo_selection=%s\n' "$selection" >"$artifacts_dir/odoo-persistence.txt"
fi
cp "$artifacts_dir/playwright"/*/*.png "$artifacts_dir/" 2>/dev/null || true
printf 'PASS %s owned browser journey\nrun_id=%s\ntenant_a=%s\ntenant_b=%s\n' "$live_mode" "$run_id" "$tenant_a" "$tenant_b" | tee "$artifacts_dir/result.txt"
