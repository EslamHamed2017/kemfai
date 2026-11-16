#!/usr/bin/env bash
# Offline regression for the T072 launcher. It must not invoke Docker or open listeners.
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
launcher="$repo_dir/scripts/test_t072_live.sh"
bash -n "$launcher"
python3 - "$launcher" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text()
required = (
    'docker volume create --label "$label" "$odoo_volume"',
    "odoo_config_path='/var/lib/odoo/.kemfai-t072.conf'",
    "printf '%s\\n' \"$odoo_config\" | docker run --rm -i --label \"$label\"",
    "umask 077; cat > /var/lib/odoo/.kemfai-t072.conf",
    "stat -c %a /var/lib/odoo/.kemfai-t072.conf",
    '-v "$odoo_volume:/var/lib/odoo"',
    'docker run --rm --entrypoint odoo --label "$label" --network "$network"',
    'docker run --rm -i --entrypoint odoo --label "$label" --network "$network"',
    'docker run -d --entrypoint odoo --label "$label" --name "$odoo"',
    'capture_failure_diagnostics "$status"',
    "docker inspect --format '{{json .State}}'",
    'running={{.State.Running}} exit_code={{.State.ExitCode}} oom_killed={{.State.OOMKilled}}',
    'docker logs "$resource_id" 2>&1 | redact_stream',
    'chmod 600 "$state_file" "$log_file"',
    'pg_isready -h /var/run/postgresql -p 5432',
    "pg_readiness=\"$artifacts_dir/pg-readiness.log\"",
    't071_owned_session_exec.py" --hold-for-cleanup --keep-env T071_RELAY_CONFIG',
)
for marker in required:
    if marker not in text:
        raise SystemExit(f'FAIL: missing secure Odoo config marker: {marker}')
if text.index('docker volume create --label "$label" "$odoo_volume"') > text.index(
    "printf '%s\\n' \"$odoo_config\" | docker run --rm -i --label \"$label\""
):
    raise SystemExit('FAIL: Odoo config is written before its exact-labelled volume exists')
if text.count('--entrypoint odoo') != 3:
    raise SystemExit('FAIL: every bootstrap/shell/server Odoo command must bypass the image wrapper')
for forbidden in (
    '--user root', '--user 0', '/etc/odoo/odoo.conf:ro', 'chmod 644',
    'odoo:18 odoo -c', 'odoo:18 odoo shell', '.Config.Env',
    'exec setsid python3 "$repo_dir/scripts/fixtures/t071_loopback_relay.py"',
):
    if forbidden in text:
        raise SystemExit(f'FAIL: insecure Odoo config transport reintroduced: {forbidden}')
cleanup = text[text.index('cleanup() {'):text.index('trap cleanup EXIT INT TERM')]
capture_at = cleanup.index('capture_failure_diagnostics')
for destructive in ('docker rm -fv', 'docker network ls', 'docker volume ls'):
    if capture_at > cleanup.index(destructive):
        raise SystemExit(f'FAIL: diagnostics occur after destructive cleanup: {destructive}')
for inspect_line in (line for line in text.splitlines() if 'docker inspect' in line):
    if '--format' not in inspect_line and ' -f ' not in inspect_line:
        raise SystemExit(f'FAIL: unrestricted docker inspect is forbidden: {inspect_line}')
if '2>&1 | redact_stream >"$log_file"' not in text:
    raise SystemExit('FAIL: retained container logs do not pass through secret redaction')
print('PASS: T072 launcher preserves redacted pre-cleanup diagnostics and secure Odoo startup')
PY
