#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="$repo_dir/infra/docker/docker-compose.yml"

# Same prerequisites as T039's live-auth runner: DB + Redis + Keycloak + API up.
docker compose -f "$compose_file" up -d kemfai-db redis keycloak api
for url in http://localhost:8080/realms/kemfai-customers/.well-known/openid-configuration http://localhost:4000/; do
  for _ in $(seq 1 90); do
    if curl --fail --silent "$url" >/dev/null; then break; fi
    sleep 1
  done
  curl --fail --silent "$url" >/dev/null
done

cd "$repo_dir/frontend"
LIVE_DOCKER_AUTH=1 npm run test:integration:auth -- tests/integration/live-locale.integration.spec.ts
