#!/usr/bin/env python3
from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
CI = ROOT / '.github/workflows/ci.yml'
RUNNER = ROOT / 'scripts/test_t096_security_hardening.sh'


def job_block(text: str, job: str) -> str:
    match = re.search(rf'^  {re.escape(job)}:\n(?P<body>.*?)(?=^  [a-zA-Z0-9_-]+:\n|\Z)', text, re.M | re.S)
    if not match:
        raise AssertionError(f'missing job {job}')
    return match.group(0)


class T096CiWiringTests(unittest.TestCase):
    def test_owned_keycloak_gate_is_blocking_and_ordered_after_image_pull(self) -> None:
        block = job_block(CI.read_text(), 'owned-backend-live')
        name = '- name: T096 security hardening owned Keycloak'
        self.assertEqual(block.count(name), 1)
        self.assertIn('run: bash scripts/test_t096_security_hardening.sh', block)
        self.assertLess(block.index('docker pull quay.io/keycloak/keycloak:26.0'), block.index(name))
        self.assertLess(block.index(name), block.index('- name: T050 company validation owned stack'))
        step = block[block.index(name):block.index('- name: T050 company validation owned stack')]
        self.assertNotIn('continue-on-error', step)
        self.assertNotIn('|| true', step)

    def test_owned_runner_has_loopback_binding_exact_scope_and_owner_checked_cleanup(self) -> None:
        runner = RUNNER.read_text()
        for required in [
            'set -Eeuo pipefail',
            '--label "kemfai.fixture.owner=$OWNER"',
            '-p 127.0.0.1::8080',
            "[[ \"$ROLES\" == 'manage-users,view-realm' ]]",
            '[[ "$DENIED" == 403 ]]',
            'if [[ "$actual_owner" != "$OWNER" ]]',
            'docker rm -fv -- "$NAME"',
        ]:
            self.assertIn(required, runner)
        self.assertNotIn('docker rm -f $(docker ps', runner)
        subprocess.run(['bash', '-n', str(RUNNER)], check=True, cwd=ROOT)


if __name__ == '__main__':
    unittest.main()
