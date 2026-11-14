#!/usr/bin/env python3
"""Regression checks for the isolated US8 runner's startup and port safety."""

import json
import socket
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / "scripts/test-us8-owned-live.sh"
RESERVER = ROOT / "scripts/reserve_loopback_ports.py"


def require_source_contract() -> None:
    source = RUNNER.read_text()
    required = (
        'wait_for_container_service "$pg" postgres',
        'wait_for_container_service "$redis" redis',
        'startup-diagnostics.sanitized.log',
        '${service}-readiness.sanitized.log',
        'release_port pg',
        'release_port redis',
        'release_port api',
        'release_port frontend',
        'docker network ls -q --filter "label=$label"',
    )
    missing = [token for token in required if token not in source]
    if missing:
        raise AssertionError(f"runner readiness contract missing: {missing}")
    if 'service="$2" readiness="$evidence/${service}' in source:
        raise AssertionError("set -u unsafe dependent local initialization")


def assert_bind_fails(port: int) -> None:
    sock = socket.socket()
    try:
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            return
        raise AssertionError(f"reserved port {port} was bindable")
    finally:
        sock.close()


def main() -> None:
    require_source_contract()
    process = subprocess.Popen(
        [sys.executable, str(RESERVER)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        assert process.stdout and process.stdin
        ports = json.loads(process.stdout.readline())
        expected_names = {"pg", "redis", "keycloak", "odoo", "api", "frontend", "fault-control"}
        assert set(ports) == expected_names
        assert len(set(ports.values())) == len(expected_names)
        assert all(20000 <= value < 60000 for value in ports.values())
        for port in ports.values():
            assert_bind_fails(port)
        process.stdin.write("release pg\n")
        process.stdin.flush()
        assert process.stdout.readline().strip() == "released pg"
        probe = socket.socket()
        try:
            probe.bind(("127.0.0.1", ports["pg"]))
        finally:
            probe.close()
        for name in expected_names - {"pg"}:
            assert_bind_fails(ports[name])
    finally:
        process.terminate()
        process.wait(timeout=5)
    print("PASS US8 owned readiness regression")


if __name__ == "__main__":
    main()
