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


def _relative_imports(initializer: Path) -> set[str]:
    if not initializer.is_file():
        return set()
    tree = ast.parse(initializer.read_text(encoding="utf-8"), filename=str(initializer))
    imported: set[str] = set()
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and node.level == 1:
            if node.module:
                imported.add(node.module)
            imported.update(alias.name for alias in node.names)
    return imported


def _manifest(path: Path) -> dict[str, object]:
    if not path.is_file():
        return {}
    expression = ast.parse(path.read_text(encoding="utf-8"), filename=str(path), mode="eval")
    value = ast.literal_eval(expression.body)
    return value if isinstance(value, dict) else {}


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


class TestAccountingFoundationAddonDiscovery(unittest.TestCase):
    addon = ADDONS_DIR / "kemfai_accounting"

    def test_manifest_is_installable_and_declares_only_real_addon_dependencies(self) -> None:
        manifest = _manifest(self.addon / "__manifest__.py")
        self.assertTrue(manifest, "missing evaluable kemfai_accounting/__manifest__.py")
        self.assertIs(manifest.get("installable"), True)
        depends = manifest.get("depends")
        self.assertIsInstance(depends, list)
        for dependency in depends if isinstance(depends, list) else []:
            self.assertTrue(
                (ADDONS_DIR / str(dependency)).is_dir() or dependency in {"base", "mail", "account"},
                f"manifest dependency does not exist in the owned addon path: {dependency}",
            )
        for data_file in manifest.get("data", []):
            self.assertTrue(
                (self.addon / str(data_file)).is_file(),
                f"manifest data target does not exist: {data_file}",
            )

    def test_root_and_models_packages_are_importable_without_future_targets(self) -> None:
        root_initializer = self.addon / "__init__.py"
        models_initializer = self.addon / "models" / "__init__.py"
        self.assertTrue(root_initializer.is_file(), "missing kemfai_accounting/__init__.py")
        self.assertTrue(models_initializer.is_file(), "missing kemfai_accounting/models/__init__.py")
        self.assertIn("models", _relative_imports(root_initializer))
        for module in _relative_imports(models_initializer):
            self.assertTrue(
                (models_initializer.parent / f"{module}.py").is_file()
                or (models_initializer.parent / module / "__init__.py").is_file(),
                f"models initializer imports a missing target: {module}",
            )

    def test_story_two_dependency_and_service_registration_are_complete(self) -> None:
        manifest = _manifest(self.addon / "__manifest__.py")
        dependencies = manifest.get("depends", [])
        self.assertIn(
            "kemfai_dimensions",
            dependencies,
            "accounting must depend on dimensions so Odoo installs it first",
        )

        services_initializer = self.addon / "services" / "__init__.py"
        self.assertTrue(services_initializer.is_file())
        self.assertIn("draft_validation", _relative_imports(services_initializer))
        self.assertTrue((services_initializer.parent / "draft_validation.py").is_file())

        validation_tree = ast.parse(
            (services_initializer.parent / "draft_validation.py").read_text(encoding="utf-8")
        )
        direct_dimension_imports = [
            node
            for node in ast.walk(validation_tree)
            if (
                isinstance(node, ast.ImportFrom)
                and (node.module or "").startswith("kemfai_dimensions")
            )
            or (
                isinstance(node, ast.Import)
                and any(
                    alias.name.startswith("kemfai_dimensions") for alias in node.names
                )
            )
        ]
        self.assertEqual(
            [],
            direct_dimension_imports,
            "accounting must integrate through the Odoo registry, not circular addon imports",
        )

    def test_story_one_test_package_registers_every_created_test_module(self) -> None:
        tests_initializer = self.addon / "tests" / "__init__.py"
        self.assertTrue(tests_initializer.is_file(), "missing kemfai_accounting/tests/__init__.py")
        expected = {"test_coa", "test_audit_receipts", "test_drafts"}
        registered = _registered_test_modules(tests_initializer)
        self.assertEqual(expected, expected & registered)
        for module in expected:
            test_file = tests_initializer.parent / f"{module}.py"
            self.assertTrue(test_file.is_file(), f"missing registered Odoo test module: {module}")
            self.assertTrue(_test_methods(test_file), f"{module} has no executable test methods")
            self.assertEqual([], _odoo_ineligible_methods(test_file))


if __name__ == "__main__":
    unittest.main()
