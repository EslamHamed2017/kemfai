#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="$repo_dir/infra/docker/docker-compose.yml"

docker compose -f "$compose_file" up -d kemfai-db redis keycloak
until docker exec kemfai-db pg_isready -U odoo >/dev/null 2>&1; do sleep 1; done
# Keep reused development volumes aligned with the Compose application credential.
docker exec kemfai-db psql -U odoo -d postgres -v ON_ERROR_STOP=1 -c \
  "ALTER ROLE kemfai_api WITH PASSWORD '${CONTROL_DB_APP_PASSWORD:-kemfai_api_dev}'" >/dev/null
docker compose -f "$compose_file" up -d api
for url in http://localhost:8080/realms/kemfai-customers/.well-known/openid-configuration http://localhost:4000/; do
  for _ in $(seq 1 90); do
    if curl --fail --silent "$url" >/dev/null; then break; fi
    sleep 1
  done
  curl --fail --silent "$url" >/dev/null
done

cd "$repo_dir/frontend"
LIVE_DOCKER_AUTH=1 npm run test:integration:auth
