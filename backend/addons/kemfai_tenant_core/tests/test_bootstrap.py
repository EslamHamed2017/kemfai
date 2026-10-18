"""Pure hook tests; the scratch Odoo install test exercises the actual registry."""
import importlib.util
import pathlib
import unittest

try:
    from odoo.tests.common import BaseCase as OdooTestCase
except ModuleNotFoundError as exc:
    if exc.name != 'odoo':
        raise
    from unittest import TestCase as OdooTestCase

hook_path = pathlib.Path(__file__).resolve().parents[1] / 'hooks.py'
spec = importlib.util.spec_from_file_location('tenant_core_hooks', hook_path)
hooks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hooks)


class Companies:
    def __init__(self, count):
        self.count = count
        self.created = []

    def sudo(self):
        return self

    def search(self, domain):
        assert domain == []
        return [object()] * self.count

    def create(self, values):
        self.created.append(values)


class BootstrapTest(OdooTestCase):
    def test_retains_existing_base_company(self):
        companies = Companies(1)
        hooks.ensure_initial_company({'res.company': companies})
        self.assertEqual(companies.created, [])

    def test_creates_only_if_missing(self):
        companies = Companies(0)
        hooks.ensure_initial_company({'res.company': companies})
        self.assertEqual(companies.created, [{'name': 'KEMFAI'}])

    def test_rejects_multiple_companies(self):
        companies = Companies(2)
        with self.assertRaisesRegex(ValueError, 'multiple companies'):
            hooks.ensure_initial_company({'res.company': companies})
        self.assertEqual(companies.created, [])


if __name__ == '__main__':
    unittest.main()
