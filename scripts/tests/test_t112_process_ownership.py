#!/usr/bin/env python3
"""Regression contract for deterministic T112 process-session ownership."""

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / "scripts/test_t112_owned_fixture.sh"


class T112ProcessOwnershipTests(unittest.TestCase):
    def test_port_keeper_is_ready_before_session_registration(self) -> None:
        source = RUNNER.read_text(encoding="utf-8")
        coproc = source.index("coproc T112_PORT_KEEPER")
        readiness = source.index('read -r port_json <&"$port_read_fd"', coproc)
        registration = source.index(
            'register_owned_process "$port_keeper_pid" reserve_loopback_ports.py',
            coproc,
        )
        self.assertLess(
            readiness,
            registration,
            "the first child output must prove setsid/exec readiness before ownership is inspected",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
