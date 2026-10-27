#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
manifest="$repo_dir/scripts/t093-suite-manifest.json"
checker="$repo_dir/scripts/t093_manifest.mjs"
integration_dir="$repo_dir/backend/api/test/integration"
unclassified="$integration_dir/t093-arbitrary-non-audit.integration-spec.ts"
near_verifier="$integration_dir/audit-source-linkage-copy.integration-spec.ts"
checker_output="$(mktemp)"
trap 'rm -f -- "$unclassified" "$near_verifier" "$checker_output"' EXIT

node "$checker" check
selected="$(node "$checker" list)"
grep -qF $'test/integration/audit-event-migration.integration-spec.ts\t' <<<"$selected"
grep -qF $'test/integration/company-mutation-handoff.integration-spec.ts\tKEMFAI_LIVE_T055_HANDOFF=1' <<<"$selected"
! grep -qF 'tenant-provisioning-live.integration-spec.ts' <<<"$selected"
node -e '
  const manifest = require(process.argv[1]);
  const excluded = manifest.suites.filter((suite) => !suite.run);
  if (!excluded.length || excluded.some((suite) => !suite.rationale)) process.exit(1);
' "$manifest"

# Classification is based on the complete integration-suite inventory, not source text.
printf '%s\n' "describe('non-audit suite', () => {});" >"$unclassified"
if node "$checker" check >"$checker_output" 2>&1; then
  printf 'FAIL T093 manifest accepted an arbitrary unclassified suite\n' >&2
  exit 1
fi
grep -qF 'integration suite is unclassified: test/integration/t093-arbitrary-non-audit.integration-spec.ts' "$checker_output"
rm -f -- "$unclassified"

# Only the verifier's exact filename is exempt; lookalikes still fail closed.
printf '%s\n' "describe('verifier lookalike', () => {});" >"$near_verifier"
if node "$checker" check >"$checker_output" 2>&1; then
  printf 'FAIL T093 manifest accepted a verifier lookalike\n' >&2
  exit 1
fi
grep -qF 'integration suite is unclassified: test/integration/audit-source-linkage-copy.integration-spec.ts' "$checker_output"
rm -f -- "$near_verifier"

node -e '
  const fs = require("fs");
  const manifest = require(process.argv[1]);
  const classified = manifest.suites.map((suite) => suite.path).sort();
  const current = fs.readdirSync(process.argv[2])
    .filter((name) => name.endsWith(".integration-spec.ts"))
    .map((name) => `test/integration/${name}`)
    .filter((path) => path !== "test/integration/audit-source-linkage.integration-spec.ts")
    .sort();
  if (JSON.stringify(classified) !== JSON.stringify(current)) process.exit(1);
' "$manifest" "$integration_dir"

printf 'PASS T093 manifest coverage\n'
