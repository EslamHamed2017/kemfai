"""Regression test for Odoo addon test-package registration.

Odoo imports tests through each addon's ``tests/__init__.py``.  A test file
that is present but not imported is therefore silently absent from an Odoo
``--test-enable`` run.  Keep this check independent of Odoo so discovery
failures are caught before starting the container gate.
"""

from __future__ import annotations

import ast
import unittest
from collections import defaultdict
from pathlib import Path


ADDONS_DIR = Path(__file__).resolve().parent


def _test_methods(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    return sorted(
        node.name
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name.startswith("test_")
    )


def _registered_test_modules(initializer: Path) -> set[str]:
    if not initializer.is_file():
        return set()

    tree = ast.parse(
        initializer.read_text(encoding="utf-8"), filename=str(initializer)
    )
    modules: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.ImportFrom) or node.level != 1:
            continue
        modules.update(alias.name for alias in node.names)
    return modules


def _odoo_ineligible_methods(path: Path) -> list[str]:
    """Return test methods whose class lacks an Odoo test-case ancestor."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    odoo_bases: set[str] = set()
    classes: dict[str, ast.ClassDef] = {}

    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module == "odoo.tests.common":
            odoo_bases.update(alias.asname or alias.name for alias in node.names)
    for node in tree.body:
        if isinstance(node, ast.ClassDef):
            classes[node.name] = node

    eligible_classes = set(odoo_bases)
    changed = True
    while changed:
        changed = False
        for name, node in classes.items():
            direct_bases = {
                base.id for base in node.bases if isinstance(base, ast.Name)
            }
            if name not in eligible_classes and direct_bases & eligible_classes:
                eligible_classes.add(name)
                changed = True

    return sorted(
        child.name
        for name, node in classes.items()
        if name not in eligible_classes
        for child in node.body
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef))
        and child.name.startswith("test_")
    )


class TestOdooTestDiscovery(unittest.TestCase):
    maxDiff = None

    def test_every_kemfai_test_method_is_registered_by_its_package(self) -> None:
        undiscovered: dict[str, dict[str, list[str]]] = defaultdict(dict)

        for addon in sorted(ADDONS_DIR.glob("kemfai_*")):
            tests_dir = addon / "tests"
            registered = _registered_test_modules(tests_dir / "__init__.py")
            for test_file in sorted(tests_dir.glob("test_*.py")):
                methods = _test_methods(test_file)
                if methods and test_file.stem not in registered:
                    undiscovered[addon.name][test_file.name] = methods

        self.assertEqual(
            {},
            dict(undiscovered),
            "Odoo would not discover these KEMFAI addon test methods",
        )

    def test_every_kemfai_test_method_has_an_odoo_test_case_ancestor(self) -> None:
        ineligible = {
            str(test_file.relative_to(ADDONS_DIR)): methods
            for test_file in sorted(ADDONS_DIR.glob("kemfai_*/tests/test_*.py"))
            if (methods := _odoo_ineligible_methods(test_file))
        }

        self.assertEqual(
            {},
            ineligible,
            "Odoo TagsSelector would reject these KEMFAI addon test methods",
        )


if __name__ == "__main__":
    unittest.main()
