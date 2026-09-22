#!/usr/bin/env bash
# Runs every deterministic KEMFAI governance test. No real model calls, no
# network, and the real repo/.state/history are never touched (integration
# tests run in isolated scratch git repos under mktemp).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

FAIL=0

echo "########## test_lib_governance.sh ##########"
bash "$HERE/test_lib_governance.sh"
[ $? -eq 0 ] || FAIL=1

echo ""
echo "########## test_run_loop_integration.sh ##########"
bash "$HERE/test_run_loop_integration.sh"
[ $? -eq 0 ] || FAIL=1

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "ALL KEMFAI GOVERNANCE TESTS PASSED"
else
  echo "KEMFAI GOVERNANCE TESTS FAILED"
fi
exit $FAIL
