#!/usr/bin/env bash
# Runs every deterministic KEMFAI governance test. No real model calls, no
# network, and the real repo/.state/history are never touched (integration
# tests run in isolated scratch git repos under mktemp).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

FAIL=0

echo "########## test_t108_ci_wiring.py ##########"
python3 "$HERE/test_t108_ci_wiring.py"
[ $? -eq 0 ] || FAIL=1

echo ""

echo "########## test_t096_ci_wiring.py ##########"
python3 "$HERE/test_t096_ci_wiring.py"
[ $? -eq 0 ] || FAIL=1

echo ""

echo "########## test_t097_quickstart.py ##########"
python3 "$HERE/test_t097_quickstart.py"
[ $? -eq 0 ] || FAIL=1

echo ""
echo "########## test_t112_process_ownership.py ##########"
python3 "$HERE/test_t112_process_ownership.py"
[ $? -eq 0 ] || FAIL=1

echo ""

echo "########## test_t108_integration_runner.js ##########"
node "$HERE/test_t108_integration_runner.js"
[ $? -eq 0 ] || FAIL=1

echo ""

echo "########## test_t108_odoo_cleanup.sh ##########"
bash "$HERE/test_t108_odoo_cleanup.sh"
[ $? -eq 0 ] || FAIL=1

echo ""

echo "########## repository Docker cleanup static gate ##########"
(
  cd "$REPO"
  python3 scripts/check_docker_test_cleanup.py
)
[ $? -eq 0 ] || FAIL=1

echo ""

echo "########## test_docker_test_cleanup.sh ##########"
bash "$HERE/test_docker_test_cleanup.sh"
[ $? -eq 0 ] || FAIL=1

echo ""

echo "########## test_lib_governance.sh ##########"
bash "$HERE/test_lib_governance.sh"
[ $? -eq 0 ] || FAIL=1

echo ""
echo "########## test_extract_final_response.sh ##########"
bash "$HERE/test_extract_final_response.sh"
[ $? -eq 0 ] || FAIL=1

echo ""
echo "########## test_run_loop_integration.sh ##########"
bash "$HERE/test_run_loop_integration.sh"
[ $? -eq 0 ] || FAIL=1

echo ""

run_accounting_foundation_suite() {
  local module="$1" output status
  echo "########## ${module}.py ##########"
  output="$(cd "$REPO" && python3 -m unittest -v "scripts.tests.${module}" 2>&1)"
  status=$?
  printf '%s\n' "$output"
  if [ "$status" -ne 0 ]; then
    FAIL=1
  fi
  if [[ ! "$output" =~ Ran[[:space:]]+[1-9][0-9]*[[:space:]]+tests? ]]; then
    echo "FAIL: ${module}.py discovered zero or unreported tests"
    FAIL=1
  fi
  echo ""
}

run_accounting_foundation_suite test_infra_compose
run_accounting_foundation_suite test_accounting_foundation_owned_live
run_accounting_foundation_suite test_accounting_foundation_evidence
run_accounting_foundation_suite test_accounting_foundation_ci
run_accounting_foundation_suite test_accounting_foundation_tasks

if [ "$FAIL" -eq 0 ]; then
  echo "ALL KEMFAI GOVERNANCE TESTS PASSED"
else
  echo "KEMFAI GOVERNANCE TESTS FAILED"
fi
exit $FAIL
