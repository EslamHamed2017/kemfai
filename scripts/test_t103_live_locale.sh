#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="$repo_dir/infra/docker/docker-compose.yml"

# Same prerequisites as T039's live-auth runner: DB + Redis + Keycloak + API up.
docker compose -f "$compose_file" up -d kemfai-db redis keycloak api
until docker exec kemfai-db pg_isready -U odoo >/dev/null 2>&1; do sleep 1; done

# The development seed keeps module.accounts fail-closed. Enable it only for this
# live auth probe, then restore the exact prior state even when the probe fails.
prior_accounts_flag="$(docker exec kemfai-db psql -U odoo -d kemfai_control -At -c   "SELECT CASE WHEN enabled THEN 'true' ELSE 'false' END FROM feature_flag WHERE feature_key='module.accounts'")"
restore_accounts_flag() {
  local status=$? restore_status=0
  trap - EXIT
  set +e
  if [ -z "$prior_accounts_flag" ]; then
    docker exec kemfai-db psql -U odoo -d kemfai_control -v ON_ERROR_STOP=1 -c       "DELETE FROM feature_flag WHERE feature_key='module.accounts'" >/dev/null || restore_status=$?
  else
    docker exec kemfai-db psql -U odoo -d kemfai_control -v ON_ERROR_STOP=1 -c       "UPDATE feature_flag SET enabled=$prior_accounts_flag WHERE feature_key='module.accounts'" >/dev/null || restore_status=$?
  fi
  [ "$status" -ne 0 ] || status=$restore_status
  exit "$status"
}
trap restore_accounts_flag EXIT
docker exec kemfai-db psql -U odoo -d kemfai_control -v ON_ERROR_STOP=1 -c   "INSERT INTO feature_flag(feature_key, enabled, notes) VALUES ('module.accounts', true, 'temporary T039/T103 live-auth gate') ON CONFLICT (feature_key) DO UPDATE SET enabled=true" >/dev/null
for url in http://localhost:8080/realms/kemfai-customers/.well-known/openid-configuration http://localhost:4000/; do
  for _ in $(seq 1 90); do
    if curl --fail --silent "$url" >/dev/null; then break; fi
    sleep 1
  done
  curl --fail --silent "$url" >/dev/null
done

cd "$repo_dir/frontend"
LIVE_DOCKER_AUTH=1 npm run test:integration:auth -- tests/integration/live-locale.integration.spec.ts
