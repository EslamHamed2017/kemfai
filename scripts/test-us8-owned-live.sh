#!/usr/bin/env bash
set -euo pipefail
umask 077

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
api_dir="$repo_dir/backend/api"; frontend_dir="$repo_dir/frontend"
operation="${US8_OPERATION_ID:-t084-t091-native-20261018T192039Z}"
[ "$operation" = 't084-t091-native-20261018T192039Z' ] || { echo 'unexpected US8_OPERATION_ID' >&2; exit 2; }
evidence="${US8_EVIDENCE_DIR:-/opt/hermes/kemfai-codex-supervisor/t084-t091-native-20261018T192039Z/evidence/owned-live}"
mkdir -p "$evidence"; chmod 700 "$evidence"
prefix="kemfai-us8-${operation,,}"; label="kemfai.us8.operation=$operation"
pg="${prefix}-pg"; redis="${prefix}-redis"; pg_volume="${prefix}-pgdata"
private_dir="$(mktemp -d)"; chmod 700 "$private_dir"
api_pid=''; frontend_pid=''; identity_pid=''; cleanup_failed=0

redact() { python3 -c 'import pathlib,sys; d=sys.stdin.buffer.read(); [globals().__setitem__("d",d.replace(v,b"[REDACTED]")) for v in pathlib.Path(sys.argv[1]).read_bytes().split(b"\0") if v]; sys.stdout.buffer.write(d)' "$private_dir/secrets"; }
stop_owned() { local pid="$1" marker="$2"; [ -z "$pid" ] && return 0; if kill -0 "$pid" 2>/dev/null; then tr '\0' ' ' <"/proc/$pid/cmdline" | grep -Fq "$marker" || return 1; kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true; for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || return 0; sleep .1; done; kill -KILL -- "-$pid" 2>/dev/null || true; fi; }
cleanup() {
  local status=$? survivors
  trap - EXIT INT TERM; set +e
  stop_owned "$frontend_pid" 'next' || cleanup_failed=1; stop_owned "$api_pid" 'dist/main.js' || cleanup_failed=1; stop_owned "$identity_pid" 'us8-live-identity.ts' || cleanup_failed=1
  mapfile -t owned < <(docker ps -aq --filter "label=$label" 2>/dev/null); [ "${#owned[@]}" -eq 0 ] || docker rm -fv "${owned[@]}" >/dev/null 2>&1 || cleanup_failed=1
  mapfile -t volumes < <(docker volume ls -q --filter "label=$label" 2>/dev/null); [ "${#volumes[@]}" -eq 0 ] || docker volume rm "${volumes[@]}" >/dev/null 2>&1 || cleanup_failed=1
  survivors="$(docker ps -aq --filter "label=$label"; docker volume ls -q --filter "label=$label")"
  printf 'operation=%s\nsurvivors=%s\nprocess_cleanup=%s\n' "$operation" "${survivors:-none}" "$cleanup_failed" >"$evidence/cleanup-receipt.txt"
  rm -rf -- "$private_dir"; [ -z "$survivors" ] || status=1; [ "$cleanup_failed" -eq 0 ] || status=1; exit "$status"
}
trap cleanup EXIT INT TERM
for command in docker node npm python3 curl openssl; do command -v "$command" >/dev/null || { echo "$command missing" >&2; exit 1; }; done
docker info >/dev/null 2>&1; [ ! -e "$api_dir/.env" ] && [ ! -e "$frontend_dir/.env" ] || { echo 'checkout-local env refused' >&2; exit 1; }
[ -z "$(docker ps -aq --filter "label=$label")$(docker volume ls -q --filter "label=$label")" ] || { echo 'owned operation resources already exist' >&2; exit 1; }
free_port() { python3 - <<'PY'
import random,socket
for port in random.sample(range(20000,60000),40000):
 s=socket.socket()
 try: s.bind(('127.0.0.1',port)); print(port); break
 except OSError: pass
 finally: s.close()
PY
}
pg_port="$(free_port)"; redis_port="$(free_port)"; api_port="$(free_port)"; frontend_port="$(free_port)"
pg_user="us8_$(openssl rand -hex 5)"; pg_password="$(openssl rand -hex 24)"; control_db='kemfai_control'
printf '%s\0' "$pg_password" >"$private_dir/secrets"; chmod 600 "$private_dir/secrets"
printf 'operation=%s\nlabel=%s\npostgres=%s:%s\nredis=%s:%s\napi=127.0.0.1:%s\nfrontend=127.0.0.1:%s\n' "$operation" "$label" "$pg" "$pg_port" "$redis" "$redis_port" "$api_port" "$frontend_port" >"$evidence/fixture-registry.txt"
chmod 600 "$evidence/fixture-registry.txt"

docker volume create --label "$label" "$pg_volume" >/dev/null
docker run -d --name "$pg" --label "$label" --memory=512m --cpus=1 -e POSTGRES_USER="$pg_user" -e POSTGRES_PASSWORD="$pg_password" -e POSTGRES_DB="$control_db" -v "$pg_volume:/var/lib/postgresql/data" -p "127.0.0.1:$pg_port:5432" postgres:16-alpine >/dev/null
docker run -d --name "$redis" --label "$label" --memory=256m --cpus=.5 -p "127.0.0.1:$redis_port:6379" redis:7-alpine redis-server --save '' --appendonly no >/dev/null
for _ in $(seq 1 60); do docker exec "$pg" pg_isready -U "$pg_user" -d "$control_db" >/dev/null 2>&1 && break; sleep .5; done
docker exec "$pg" pg_isready -U "$pg_user" -d "$control_db" >/dev/null; [ "$(docker exec "$redis" redis-cli ping)" = PONG ]
export CONTROL_DB_HOST=127.0.0.1 CONTROL_DB_PORT="$pg_port" CONTROL_DB_USER="$pg_user" CONTROL_DB_PASSWORD="$pg_password" CONTROL_DB_NAME="$control_db" REDIS_URL="redis://127.0.0.1:$redis_port/14"
(cd "$api_dir" && npm run migration:run) >"$evidence/migration-up.log" 2>&1
(cd "$api_dir" && npm run migration:revert && npm run migration:run) >"$evidence/migration-roundtrip.log" 2>&1
(cd "$api_dir" && npm run test:contract -- --runInBand) >"$evidence/api-contract-full.log" 2>&1
(cd "$api_dir" && npm run test:integration -- --runInBand test/integration/support-access-denial.integration-spec.ts test/integration/support-access-sweep-idempotency.integration-spec.ts test/integration/support-access-migration.integration-spec.ts) >"$evidence/api-live-integration.log" 2>&1

psql() { docker exec -e PGPASSWORD="$pg_password" "$pg" psql -U "$pg_user" -d "$control_db" -X -q -t -A -c "$1"; }
plan_id="$(psql "INSERT INTO plan(name,name_en,name_ar,published,monthly_price,annual_price,currency) VALUES('US8','US8','الدعم',true,10,100,'USD') RETURNING id")"
sub_a=08400000-0000-4000-8000-000000000001; sub_b=08400000-0000-4000-8000-000000000002
acct_a="$(psql "INSERT INTO account(keycloak_user_id,email,email_verified,selected_plan_id,selected_billing_cycle) VALUES('$sub_a','owner-a@example.invalid',true,'$plan_id','monthly') RETURNING id")"
acct_b="$(psql "INSERT INTO account(keycloak_user_id,email,email_verified,selected_plan_id,selected_billing_cycle) VALUES('$sub_b','owner-b@example.invalid',true,'$plan_id','monthly') RETURNING id")"
tenant_a="$(psql "INSERT INTO tenant(account_id,status,ready_at) VALUES('$acct_a','Ready',now()-interval '30 days') RETURNING id")"; tenant_b="$(psql "INSERT INTO tenant(account_id,status,ready_at) VALUES('$acct_b','Ready',now()) RETURNING id")"
psql "INSERT INTO subscription(tenant_id,plan_id,billing_cycle,status,current_period_start,current_period_end) VALUES('$tenant_a','$plan_id','monthly','PendingActivation',current_date-30,current_date-1),('$tenant_b','$plan_id','monthly','Active',current_date,current_date+30); UPDATE feature_flag SET enabled=true WHERE feature_key='module.support_access';" >/dev/null

identity_json="$private_dir/identity.json"
(cd "$api_dir"; export US8_IDENTITY_OUTPUT="$identity_json" US8_TENANT_A_ID="$tenant_a" US8_TENANT_B_ID="$tenant_b"; exec setsid ./node_modules/.bin/ts-node test/support/us8-live-identity.ts) >"$evidence/identity.log" 2>&1 & identity_pid=$!
for _ in $(seq 1 100); do [ -s "$identity_json" ] && break; sleep .1; done; [ -s "$identity_json" ]
readarray -t ident < <(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); [print(d[k]) for k in ("customerIssuer","internalIssuer","audience","jwksUri","ownerA","ownerB","support","customerSupportSpoof")]' "$identity_json")
customer_issuer="${ident[0]}"; internal_issuer="${ident[1]}"; audience="${ident[2]}"; jwks="${ident[3]}"; token_a="${ident[4]}"; token_b="${ident[5]}"; token_support="${ident[6]}"; token_spoof="${ident[7]}"
printf '%s\0%s\0%s\0%s\0' "$token_a" "$token_b" "$token_support" "$token_spoof" >>"$private_dir/secrets"
session_a="$(openssl rand -hex 24)"; now_ms="$(date +%s000)"; exp_ms="$((now_ms+1800000))"
docker exec "$redis" redis-cli -n 14 SET "kemfai:session:$session_a" "{\"accessToken\":\"$token_a\",\"refreshToken\":\"synthetic\",\"accessExpiresAt\":$exp_ms,\"refreshExpiresAt\":$exp_ms}" PX 1800000 >/dev/null

(cd "$api_dir" && npm run build) >"$evidence/api-build-live.log" 2>&1
(cd "$frontend_dir"; export KEMFAI_API_URL="http://127.0.0.1:$api_port" REDIS_URL="redis://127.0.0.1:$redis_port/14" NEXT_PUBLIC_DEFAULT_LOCALE=en KEYCLOAK_ISSUER="$customer_issuer" KEYCLOAK_BACKCHANNEL_URL="$customer_issuer" KEYCLOAK_JWKS_URI="$jwks" KEYCLOAK_CLIENT_ID=kemfai-api KEYCLOAK_REDIRECT_URI="http://127.0.0.1:$frontend_port/auth/callback"; NEXT_PRIVATE_BUILD_WORKER=1 npm run build) >"$evidence/frontend-build-live.log" 2>&1
(cd "$api_dir"; export PORT="$api_port" HOST=127.0.0.1 NODE_ENV=test KEYCLOAK_ISSUER="$customer_issuer" KEYCLOAK_JWKS_URI="$jwks" KEYCLOAK_API_AUDIENCE="$audience" KEYCLOAK_INTERNAL_ISSUER="$internal_issuer" KEYCLOAK_INTERNAL_JWKS_URI="$jwks" KEYCLOAK_INTERNAL_API_AUDIENCE="$audience" OPENAPI_CONTRACT_PATH="$repo_dir/specs/001-saas-onboarding-shell/contracts/openapi.yaml" KEMFAI_ODOO_MASTER_PASSWORD=owned-live-unused KEMFAI_TENANT_ADMIN_LOGIN=owned-live-unused KEMFAI_TENANT_ADMIN_PASSWORD=owned-live-unused; exec setsid node dist/main.js) >"$evidence/api.log" 2>&1 & api_pid=$!
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$api_port/" >/dev/null && break; sleep .5; done; curl -sf "http://127.0.0.1:$api_port/" >/dev/null
(cd "$frontend_dir"; export NODE_ENV=production PORT="$frontend_port" KEMFAI_API_URL="http://127.0.0.1:$api_port" REDIS_URL="redis://127.0.0.1:$redis_port/14" NEXT_PUBLIC_DEFAULT_LOCALE=en KEYCLOAK_ISSUER="$customer_issuer" KEYCLOAK_BACKCHANNEL_URL="$customer_issuer" KEYCLOAK_JWKS_URI="$jwks" KEYCLOAK_CLIENT_ID=kemfai-api KEYCLOAK_REDIRECT_URI="http://127.0.0.1:$frontend_port/auth/callback"; exec setsid npx next start -H 127.0.0.1 -p "$frontend_port") >"$evidence/frontend.log" 2>&1 & frontend_pid=$!
for _ in $(seq 1 90); do curl -sf "http://127.0.0.1:$frontend_port/" >/dev/null && break; sleep .5; done; curl -sf "http://127.0.0.1:$frontend_port/" >/dev/null

export US8_BASE_URL="http://127.0.0.1:$frontend_port" US8_API_URL="http://127.0.0.1:$api_port" US8_SESSION_A="$session_a" US8_OWNER_A_TOKEN="$token_a" US8_SUPPORT_TOKEN="$token_support" US8_CUSTOMER_SUPPORT_SPOOF_TOKEN="$token_spoof" US8_OWNER_ACCOUNT_ID="$acct_a" US8_TENANT_A_ID="$tenant_a" US8_TENANT_B_ID="$tenant_b" US8_PG_CONTAINER="$pg" US8_PG_USER="$pg_user" US8_CONTROL_DB="$control_db" US8_PLAYWRIGHT_OUTPUT_DIR="$evidence/playwright"
(cd "$frontend_dir" && PLAYWRIGHT_BROWSERS_PATH="$(node ../scripts/fixtures/t071_resolve_playwright_browser.mjs)" npx playwright test --config tests/e2e-live/playwright.us8-live.config.ts) >"$evidence/browser.log" 2>&1
cp "$evidence"/playwright/*/*.png "$evidence"/ 2>/dev/null || true
psql "SELECT json_build_object('grants',count(DISTINCT g.id),'usages',count(DISTINCT u.id),'audits',count(DISTINCT a.id)) FROM support_access_grant g LEFT JOIN support_access_usage u ON u.grant_id=g.id LEFT JOIN audit_event a ON a.subject_id=g.id" >"$evidence/db-audit-counts.json"
redact <"$evidence/api.log" >"$evidence/api.sanitized.log"; redact <"$evidence/frontend.log" >"$evidence/frontend.sanitized.log"; rm -f "$evidence/api.log" "$evidence/frontend.log"
printf 'PASS US8 owned live\noperation=%s\n' "$operation" | tee "$evidence/result.txt"
