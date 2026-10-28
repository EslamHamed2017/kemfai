#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/addons/kemfai_sample/tests" "$tmp/state"
printf '%s\n' 'def test_discovery(): pass' >"$tmp/addons/test_discovery.py"
printf '%s\n' '    def test_real(self):' '        pass' >"$tmp/addons/kemfai_sample/tests/test_sample.py"
cat >"$tmp/bin/docker" <<'FAKE'
#!/usr/bin/env bash
set -u
state=${MOCK_STATE:?}
args=("$@")
for ((i=0;i<${#args[@]};i++)); do
  if [ "${args[$i]}" = --database ]; then
    db="${args[$((i+1))]}"; printf '%s' "${KEMFAI_CI_DB_USER:-odoo_ci}" >"$state/$db"
    printf '0 failed, 0 error(s) of 1 tests when loading database\n'
    exit "${MOCK_ODOO_STATUS:-0}"
  fi
done
db=''
for ((i=0;i<${#args[@]};i++)); do
  case "${args[$i]}" in
    database=*) db="${args[$i]#database=}" ;;
  esac
done
if [[ " $* " == *" psql "* ]] && [ -z "$db" ]; then
  for state_file in "$state"/*; do
    [ -e "$state_file" ] || continue
    db="${state_file##*/}"
  done
fi
if [[ " $* " == *" psql "* ]]; then
  if [ -n "$db" ] && [ -e "$state/$db" ]; then
    if [[ "$*" == *"pg_get_userbyid"* ]]; then cat "$state/$db"; else printf '1\n'; fi
  fi
  exit 0
fi
if [[ " $* " == *" dropdb "* ]]; then
  db="${args[${#args[@]}-1]}"
  [ "${MOCK_DROP_FAIL:-0}" = 0 ] || exit 23
  [ "${MOCK_SURVIVOR:-0}" = 1 ] || rm -f -- "$state/$db"
  exit 0
fi
printf 'unexpected fake docker call: %q ' "$@" >&2; exit 90
FAKE
chmod +x "$tmp/bin/docker"
run_case() {
  local expected="$1" odoo="$2" drop="$3" survivor="$4" status
  rm -f "$tmp/state"/*
  set +e
  PATH="$tmp/bin:$PATH" MOCK_STATE="$tmp/state" MOCK_ODOO_STATUS="$odoo" \
    MOCK_DROP_FAIL="$drop" MOCK_SURVIVOR="$survivor" \
    KEMFAI_CI_ADDONS_DIR="$tmp/addons" GITHUB_RUN_ID=cleanup-regression GITHUB_RUN_ATTEMPT=1 \
    bash "$repo/scripts/ci/test_odoo_addons.sh" >"$tmp/output" 2>&1
  status=$?
  set -e
  [ "$status" -eq "$expected" ] || { cat "$tmp/output"; echo "expected $expected got $status" >&2; exit 1; }
}
run_case 0 0 0 0
[ -z "$(find "$tmp/state" -mindepth 1 -print -quit)" ] || { echo 'success leaked DB' >&2; exit 1; }
run_case 42 42 0 0
[ -z "$(find "$tmp/state" -mindepth 1 -print -quit)" ] || { echo 'failure leaked DB' >&2; exit 1; }
run_case 1 0 1 0
run_case 1 0 0 1
echo 'PASS: Odoo addon database cleanup is exact-owned, verified, status-preserving, and fail-closed.'
