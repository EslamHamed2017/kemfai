#!/usr/bin/env bash
# T003 acceptance test: bring up all seven infra/docker services and prove each is
# genuinely reachable (not just "container exists"), then tear everything down.
#
# Usage: ./infra/docker/test-compose.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

COMPOSE="docker compose"
FAIL=0

cleanup() {
  echo "--- tearing down ---"
  $COMPOSE down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "--- building and starting all services ---"
$COMPOSE up -d --build

wait_for_healthy() {
  local service="$1"
  local timeout="${2:-90}"
  local waited=0
  echo "waiting for '$service' to report healthy (timeout ${timeout}s)..."
  while true; do
    local cid status
    cid=$($COMPOSE ps -q "$service")
    if [ -z "$cid" ]; then
      echo "FAIL: no container found for service '$service'"
      return 1
    fi
    status=$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo "none")
    if [ "$status" = "healthy" ]; then
      echo "OK: '$service' is healthy"
      return 0
    fi
    if [ "$status" = "unhealthy" ]; then
      echo "FAIL: '$service' reported unhealthy"
      docker logs "$cid" --tail 50 || true
      return 1
    fi
    if [ "$waited" -ge "$timeout" ]; then
      echo "FAIL: '$service' did not become healthy within ${timeout}s (last status: $status)"
      docker logs "$cid" --tail 50 || true
      return 1
    fi
    sleep 3
    waited=$((waited + 3))
  done
}

for svc in kemfai-db redis minio; do
  wait_for_healthy "$svc" 60 || FAIL=1
done
wait_for_healthy keycloak 120 || FAIL=1
wait_for_healthy api 90 || FAIL=1
wait_for_healthy frontend 90 || FAIL=1

echo "--- functional reachability checks ---"

check_http() {
  local name="$1" url="$2" expect_substr="$3"
  local body
  if ! body=$(curl -fsS --max-time 10 "$url"); then
    echo "FAIL: $name ($url) did not respond"
    FAIL=1
    return
  fi
  if [ -n "$expect_substr" ] && [[ "$body" != *"$expect_substr"* ]]; then
    echo "FAIL: $name ($url) responded but body did not contain expected content"
    FAIL=1
    return
  fi
  echo "OK: $name reachable at $url"
}

# Keycloak admin port: the master realm's OIDC discovery doc is always served once ready.
check_http "Keycloak admin port" "http://127.0.0.1:8080/realms/master/.well-known/openid-configuration" "issuer"

# MinIO console (not just the S3 API port).
check_http "MinIO console" "http://127.0.0.1:9001/" ""

# KEMFAI API/BFF.
check_http "KEMFAI API" "http://127.0.0.1:4000/" "kemfai-api"

# KEMFAI frontend.
check_http "KEMFAI frontend" "http://127.0.0.1:3010/" "KEMFAI"

echo "--- Redis reachable from backend/api's configured REDIS_URL ---"
if $COMPOSE exec -T api node -e "
const net = require('net');
const url = new URL(process.env.REDIS_URL);
const sock = net.createConnection(Number(url.port), url.hostname);
sock.setTimeout(5000);
sock.on('connect', () => { console.log('connected'); sock.end(); process.exit(0); });
sock.on('timeout', () => { console.error('timeout'); process.exit(1); });
sock.on('error', (e) => { console.error(e.message); process.exit(1); });
"; then
  echo "OK: api container can reach Redis at its configured REDIS_URL"
else
  echo "FAIL: api container could not reach Redis at its configured REDIS_URL"
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  echo "=== T003 acceptance test: FAILED ==="
  exit 1
fi

echo "=== T003 acceptance test: PASSED (all seven services healthy and reachable) ==="
