#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture_dir="$(mktemp -d)"
trap 'rm -rf -- "$fixture_dir"' EXIT
mkdir "$fixture_dir/results"
printf '%s\n' '{"numTotalTestSuites":1,"numPassedTestSuites":1,"numFailedTestSuites":0,"numPendingTestSuites":0,"numTotalTests":2,"numPassedTests":2,"numFailedTests":0,"numPendingTests":0}' >"$fixture_dir/results/one.json"
printf '%s\n' '{"numTotalTestSuites":1,"numPassedTestSuites":0,"numFailedTestSuites":0,"numPendingTestSuites":1,"numTotalTests":1,"numPassedTests":0,"numFailedTests":0,"numPendingTests":1}' >"$fixture_dir/results/two.json"
node "$repo_dir/scripts/t093_aggregate.mjs" "$fixture_dir/results" "$fixture_dir/aggregate.json"
node -e '
  const result = require(process.argv[1]);
  if (!result.success || result.numTotalTestSuites !== 2 || result.numPassedTests !== 2 || result.numPendingTests !== 1) process.exit(1);
' "$fixture_dir/aggregate.json"
printf 'PASS T093 isolated-suite aggregation\n'
