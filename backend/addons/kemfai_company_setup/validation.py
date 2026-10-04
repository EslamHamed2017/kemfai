"""Pure country-dependent VAT/tax validation logic, kept free of the Odoo ORM
so it can be unit tested without a live registry (mirrors kemfai_tenant_core's
hooks.py pattern).
"""
import re


class ConfigurationGapError(Exception):
    """Raised when no validation rule exists for a given country.

    Per data-model.md's Company validation note, a launch country with no
    rule defined must block with a configuration-gap signal rather than
    silently accepting the value.
    """


class VatFormatError(Exception):
    """Raised when a vat_tax_registration value does not match its
    country's configured format.
    """


def validate_vat_tax_registration(country_code, vat_value, rules_by_country):
    """Validate ``vat_value`` for ``country_code`` against ``rules_by_country``.

    ``rules_by_country`` maps a country code to the regex pattern that a
    valid VAT/tax registration value for that country must fully match.

    An empty/falsy ``vat_value`` is a no-op: the field is optional until the
    wizard step actually submits a value, so there is nothing to validate or
    gate on yet.
    """
    if not vat_value:
        return
    if country_code not in rules_by_country:
        raise ConfigurationGapError(country_code)
    pattern = rules_by_country[country_code]
    if not re.fullmatch(pattern, vat_value):
        raise VatFormatError(country_code)
