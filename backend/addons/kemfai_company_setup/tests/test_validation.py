"""Pure logic tests for the country-dependent VAT/tax validation rule.

Mirrors kemfai_tenant_core/tests/test_bootstrap.py: exercises the plain
Python function directly so coverage does not depend on a live Odoo
registry. The scratch-install smoke test (test-install.sh) separately
proves the model/constraint wiring loads cleanly in a real Odoo instance.
"""
import importlib.util
import pathlib
import unittest

module_path = pathlib.Path(__file__).resolve().parents[1] / 'validation.py'
spec = importlib.util.spec_from_file_location('kemfai_company_setup_validation', module_path)
validation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validation)


class VatTaxRegistrationValidationTest(unittest.TestCase):
    def test_empty_value_is_a_noop_even_with_no_rule(self):
        validation.validate_vat_tax_registration('XX', '', rules_by_country={})
        validation.validate_vat_tax_registration('XX', None, rules_by_country={})

    def test_missing_rule_for_country_raises_configuration_gap(self):
        with self.assertRaises(validation.ConfigurationGapError):
            validation.validate_vat_tax_registration(
                'XX', '123456789', rules_by_country={}
            )

    def test_matching_format_passes(self):
        rules = {'AE': r'\d{15}'}
        validation.validate_vat_tax_registration('AE', '1' * 15, rules_by_country=rules)

    def test_non_matching_format_raises_vat_format_error(self):
        rules = {'AE': r'\d{15}'}
        with self.assertRaises(validation.VatFormatError):
            validation.validate_vat_tax_registration(
                'AE', 'not-a-number', rules_by_country=rules
            )

    def test_wrong_length_raises_vat_format_error(self):
        rules = {'AE': r'\d{15}'}
        with self.assertRaises(validation.VatFormatError):
            validation.validate_vat_tax_registration('AE', '123', rules_by_country=rules)

    def test_configuration_gap_takes_precedence_over_format_when_no_rule(self):
        # A country entirely absent from the rules table is a config gap,
        # not a format error, even though the value "looks" numeric.
        with self.assertRaises(validation.ConfigurationGapError):
            validation.validate_vat_tax_registration(
                'ZZ', '999999999', rules_by_country={'AE': r'\d{15}'}
            )


if __name__ == '__main__':
    unittest.main()
