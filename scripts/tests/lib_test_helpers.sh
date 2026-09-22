#!/usr/bin/env bash
# Minimal deterministic assertion helpers for KEMFAI governance tests.
# No network, no real model calls. Sourced by each test file.
set -uo pipefail

TESTS_RUN=0
TESTS_FAILED=0

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  TESTS_RUN=$((TESTS_RUN+1))
  if [ "$expected" = "$actual" ]; then
    echo "  ok - $desc"
  else
    TESTS_FAILED=$((TESTS_FAILED+1))
    echo "  FAIL - $desc"
    echo "         expected: [$expected]"
    echo "         actual:   [$actual]"
  fi
}

assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  TESTS_RUN=$((TESTS_RUN+1))
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    echo "  ok - $desc"
  else
    TESTS_FAILED=$((TESTS_FAILED+1))
    echo "  FAIL - $desc"
    echo "         expected to contain: [$needle]"
  fi
}

assert_not_contains() {
  local desc="$1" haystack="$2" needle="$3"
  TESTS_RUN=$((TESTS_RUN+1))
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    TESTS_FAILED=$((TESTS_FAILED+1))
    echo "  FAIL - $desc"
    echo "         expected NOT to contain: [$needle]"
  else
    echo "  ok - $desc"
  fi
}

assert_file_exists() {
  local desc="$1" file="$2"
  TESTS_RUN=$((TESTS_RUN+1))
  if [ -f "$file" ]; then
    echo "  ok - $desc"
  else
    TESTS_FAILED=$((TESTS_FAILED+1))
    echo "  FAIL - $desc (missing: $file)"
  fi
}

assert_file_absent() {
  local desc="$1" file="$2"
  TESTS_RUN=$((TESTS_RUN+1))
  if [ ! -f "$file" ]; then
    echo "  ok - $desc"
  else
    TESTS_FAILED=$((TESTS_FAILED+1))
    echo "  FAIL - $desc (should be absent: $file)"
  fi
}

print_summary() {
  echo ""
  echo "$(basename "$0"): $TESTS_RUN checks, $TESTS_FAILED failed"
  [ "$TESTS_FAILED" -eq 0 ]
}
