#!/usr/bin/env python3
from __future__ import annotations

import shlex
import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]
COMPOSE_PATH = ROOT / "infra/docker/docker-compose.yml"


class InfraComposeTests(unittest.TestCase):
    def test_postgres_healthcheck_targets_existing_database(self) -> None:
        compose = yaml.safe_load(COMPOSE_PATH.read_text(encoding="utf-8"))
        database = compose["services"]["kemfai-db"]
        healthcheck = database["healthcheck"]["test"]
        self.assertEqual(healthcheck[0], "CMD-SHELL")
        command = shlex.split(healthcheck[1])

        self.assertEqual(command[0], "pg_isready")
        self.assertIn("-h", command)
        self.assertEqual(command[command.index("-h") + 1], "127.0.0.1")
        self.assertIn("-d", command)
        selected_database = command[command.index("-d") + 1]
        self.assertEqual(selected_database, database["environment"]["POSTGRES_DB"])


if __name__ == "__main__":
    unittest.main()
