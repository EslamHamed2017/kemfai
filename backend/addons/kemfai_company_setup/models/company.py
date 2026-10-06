import json
from datetime import datetime

from odoo import api, fields, models
from odoo.exceptions import ValidationError

from ..validation import (
    ConfigurationGapError,
    VatFormatError,
    validate_vat_tax_registration,
)

FISCAL_YEAR_START_MONTHS = [(str(i), str(i)) for i in range(1, 13)]

SETUP_WIZARD_STEPS = [
    ('country', 'Country'),
    ('identity', 'Identity'),
    ('currency', 'Currency'),
    ('fiscal_year', 'Fiscal Year'),
    ('vat_tax', 'VAT/Tax'),
    ('industry', 'Industry'),
    ('accounting_setup', 'Accounting Setup'),
]

ACCOUNTING_SETUP_TEMPLATES = [
    ('standard', 'Standard Chart of Accounts'),
]

# T054: fixed field-set per wizard step, in the same order as SETUP_WIZARD_STEPS.
# Every field listed here is required once the wizard reaches/passes that step —
# _kemfai_compute_current_step() returns the first step with any missing field,
# and _kemfai_resolve_step_values() rejects an explicitly-submitted-but-empty value
# for any of them (Acceptance Scenario 3.6).
STEP_FIELDS = {
    'country': ('country',),
    'identity': ('legal_name', 'trade_name'),
    'currency': ('base_currency',),
    'fiscal_year': ('fiscal_year_start_month', 'fiscal_year_start_day'),
    'vat_tax': ('vat_tax_registration',),
    'industry': ('industry',),
    'accounting_setup': ('accounting_setup_template',),
}


class ResCompany(models.Model):
    _inherit = 'res.company'

    # country, base_currency: distinct from the native country_id/currency_id
    # so the setup wizard owns its own field set per data-model.md's Company
    # table, verbatim.
    country = fields.Many2one('res.country', string='Setup Country')
    legal_name = fields.Char()
    trade_name = fields.Char()
    base_currency = fields.Many2one('res.currency')
    fiscal_year_start_month = fields.Selection(FISCAL_YEAR_START_MONTHS)
    fiscal_year_start_day = fields.Integer()
    vat_tax_registration = fields.Char()
    industry = fields.Many2one('res.partner.industry')
    accounting_setup_template = fields.Selection(ACCOUNTING_SETUP_TEMPLATES)
    setup_wizard_step = fields.Selection(SETUP_WIZARD_STEPS, default='country')
    setup_complete = fields.Boolean(default=False)
    setup_completed_at = fields.Datetime()
    # T054 (arbiter binding resolution #1): advanced by exactly one on every successful
    # kemfai_setup_save_step(), under the row's SELECT ... FOR UPDATE lock, in the same
    # write() as the field changes themselves — the single source of truth the BFF
    # compares its caller-supplied baseVersion against to compute `stale`.
    setup_wizard_version = fields.Integer(default=0)

    @api.constrains('country', 'vat_tax_registration')
    def _kemfai_check_vat_tax_registration(self):
        rules = self.env['kemfai.company.setup.country.rule'].sudo().search([])
        rules_by_country = {rule.country_id.id: rule.vat_regex for rule in rules}
        for company in self:
            if not company.country:
                continue
            try:
                validate_vat_tax_registration(
                    company.country.id, company.vat_tax_registration, rules_by_country
                )
            except ConfigurationGapError:
                raise ValidationError(
                    'KEMFAI_CONFIG_GAP: no VAT/tax validation rule is configured for '
                    f'country {company.country.display_name!r}.'
                )
            except VatFormatError:
                raise ValidationError(
                    'KEMFAI_VAT_FORMAT: vat_tax_registration does not match the '
                    f'expected format for country {company.country.display_name!r}.'
                )

    # -- T054: GET/PUT /companies/current/setup RPC surface -----------------------
    #
    # Called by the BFF (backend/api/src/modules/company-setup) via execute_kw as
    # plain model methods, never through the native Odoo Settings UI. Every typed
    # failure is raised as a ValidationError whose message is prefixed with a
    # stable `KEMFAI_<CODE>:` token; the BFF parses that prefix to translate into
    # the documented 409 (configuration gap) or 422 (field-level) HTTP response —
    # this addon never decides HTTP status codes itself, and never raises a bare/
    # unprefixed exception for an expected validation outcome (arbiter resolution
    # points 2/3: all VAT regex evaluation and error classification live here in
    # Python; the NestJS layer only translates).

    def _kemfai_resolve_country(self, raw):
        """Normalize a wizard 'country' input (ISO-3166 alpha-2 code or an Odoo
        res.country id) into a res.country id, immediately after resolution —
        never left as a bare integer for the caller to re-interpret (arbiter
        resolution point 2).
        """
        if raw in (None, False, ''):
            return False
        if isinstance(raw, bool):
            raise ValidationError('KEMFAI_INVALID_COUNTRY: country must be a code or id.')
        if isinstance(raw, int):
            country = self.env['res.country'].browse(raw).exists()
            if not country:
                raise ValidationError(f'KEMFAI_INVALID_COUNTRY: no country with id {raw!r}.')
            return country.id
        code = str(raw).strip().upper()
        country = self.env['res.country'].search([('code', '=', code)], limit=1)
        if not country:
            raise ValidationError(f'KEMFAI_INVALID_COUNTRY: unknown country code {raw!r}.')
        return country.id

    def _kemfai_resolve_currency(self, raw):
        if raw in (None, False, ''):
            return False
        if isinstance(raw, bool):
            raise ValidationError('KEMFAI_INVALID_CURRENCY: base_currency must be a code or id.')
        if isinstance(raw, int):
            currency = self.env['res.currency'].with_context(active_test=False).browse(raw).exists()
            if not currency:
                raise ValidationError(f'KEMFAI_INVALID_CURRENCY: no currency with id {raw!r}.')
            return currency.id
        code = str(raw).strip().upper()
        # Most currencies ship inactive by default (only a handful are active out of the
        # box) — a currency code must resolve regardless of that display-only flag.
        currency = (
            self.env['res.currency']
            .with_context(active_test=False)
            .search([('name', '=', code)], limit=1)
        )
        if not currency:
            raise ValidationError(f'KEMFAI_INVALID_CURRENCY: unknown currency code {raw!r}.')
        return currency.id

    def _kemfai_resolve_industry(self, raw):
        if raw in (None, False, ''):
            return False
        if isinstance(raw, bool) or not isinstance(raw, int):
            raise ValidationError('KEMFAI_INVALID_INDUSTRY: industry must be an id.')
        industry = self.env['res.partner.industry'].browse(raw).exists()
        if not industry:
            raise ValidationError(f'KEMFAI_INVALID_INDUSTRY: no industry with id {raw!r}.')
        return industry.id

    def _kemfai_resolve_step_values(self, step, values):
        """Resolve one wizard step's submitted `values` into a res.company
        write()-ready dict. Many2one inputs are normalized to ids immediately here
        (arbiter resolution point 2); every field this step owns that is present
        in `values` must be non-empty — an explicitly-submitted blank value is a
        required-field failure (Acceptance Scenario 3.6), while a field this step
        owns but that is simply absent from `values` is left untouched (per-field
        last-writer-wins partial save).
        """
        self.ensure_one()
        allowed = STEP_FIELDS.get(step)
        if not allowed:
            raise ValidationError(f'KEMFAI_UNKNOWN_STEP: {step!r} is not a setup wizard step.')
        if not isinstance(values, dict):
            raise ValidationError('KEMFAI_INVALID_PAYLOAD: values must be an object.')

        write_vals = {}
        for key in allowed:
            if key not in values:
                continue
            raw = values[key]
            if key == 'country':
                if raw in (None, False, ''):
                    raise ValidationError('KEMFAI_REQUIRED_FIELD: country is required.')
                write_vals[key] = self._kemfai_resolve_country(raw)
            elif key == 'base_currency':
                if raw in (None, False, ''):
                    raise ValidationError('KEMFAI_REQUIRED_FIELD: base_currency is required.')
                write_vals[key] = self._kemfai_resolve_currency(raw)
            elif key == 'industry':
                if raw in (None, False, ''):
                    raise ValidationError('KEMFAI_REQUIRED_FIELD: industry is required.')
                write_vals[key] = self._kemfai_resolve_industry(raw)
            elif key == 'fiscal_year_start_day':
                if not isinstance(raw, int) or isinstance(raw, bool) or raw < 1 or raw > 31:
                    raise ValidationError(
                        'KEMFAI_REQUIRED_FIELD: fiscal_year_start_day must be an integer 1-31.'
                    )
                write_vals[key] = raw
            elif key == 'fiscal_year_start_month':
                if not raw or str(raw) not in dict(FISCAL_YEAR_START_MONTHS):
                    raise ValidationError(
                        'KEMFAI_REQUIRED_FIELD: fiscal_year_start_month must be 1-12.'
                    )
                write_vals[key] = str(raw)
            elif key == 'accounting_setup_template':
                if not raw or raw not in dict(ACCOUNTING_SETUP_TEMPLATES):
                    raise ValidationError(
                        'KEMFAI_REQUIRED_FIELD: accounting_setup_template is invalid.'
                    )
                write_vals[key] = raw
            else:
                # legal_name, trade_name, vat_tax_registration: plain required char fields.
                if raw in (None, False, ''):
                    raise ValidationError(f'KEMFAI_REQUIRED_FIELD: {key} is required.')
                write_vals[key] = str(raw)

        if not write_vals:
            raise ValidationError(
                'KEMFAI_REQUIRED_FIELD: no recognized field for this step was submitted.'
            )
        return write_vals

    def _kemfai_compute_current_step(self):
        """First incomplete step in fixed wizard order, computed fresh from every
        persisted required-step field — never advanced merely because the
        previous call submitted a given step (arbiter resolution point 4).
        """
        self.ensure_one()
        for step_id, _label in SETUP_WIZARD_STEPS:
            for field_name in STEP_FIELDS[step_id]:
                if not getattr(self, field_name):
                    return step_id
        return SETUP_WIZARD_STEPS[-1][0]

    def _kemfai_setup_values_dict(self):
        self.ensure_one()
        return {
            'country': self.country.code if self.country else False,
            'legal_name': self.legal_name or False,
            'trade_name': self.trade_name or False,
            'base_currency': self.base_currency.name if self.base_currency else False,
            'fiscal_year_start_month': self.fiscal_year_start_month or False,
            'fiscal_year_start_day': self.fiscal_year_start_day or False,
            'vat_tax_registration': self.vat_tax_registration or False,
            'industry': self.industry.id if self.industry else False,
            'accounting_setup_template': self.accounting_setup_template or False,
        }

    # -- T055 arbiter binding resolution, point 2: durable idempotent receipt ----
    #
    # `operation_uuid` is the control-plane `company_mutation_handoff.id` the BFF
    # generates and commits BEFORE calling this RPC. A repeated call with the SAME
    # operation_uuid (lost-response retry, or the autonomous recovery worker replaying
    # a handoff that already reached Odoo) returns the stored receipt verbatim — never
    # re-applies the mutation, never recomputes `changedFields` from whatever the
    # repeat call happens to submit. The receipt is created in the SAME method
    # invocation (and therefore the SAME Odoo transaction) as the company mutation
    # itself: Odoo commits both together, or rolls back both together, on return.

    def _kemfai_get_receipt(self, operation_uuid):
        if not operation_uuid:
            return None
        receipt = self.env['kemfai.company.mutation.receipt'].search(
            [('operation_uuid', '=', operation_uuid)], limit=1
        )
        if not receipt:
            return None
        return json.loads(receipt.result_json)

    def _kemfai_parse_occurred_at(self, raw):
        """Normalizes the BFF's ISO-8601 `occurred_at` (e.g. '2026-10-05T12:00:00.000Z')
        into an Odoo Datetime-field-writable value. Best-effort: an unparseable/absent
        value is simply omitted from the receipt rather than failing the RPC — the
        receipt's `occurred_at` is provenance only, never the audit event's source of
        truth (that remains the control-plane handoff row)."""
        if not raw:
            return False
        try:
            return datetime.fromisoformat(str(raw).replace('Z', '+00:00')).replace(tzinfo=None)
        except ValueError:
            return False

    def _kemfai_store_receipt(self, operation_uuid, action, result, occurred_at=None, actor_id=None):
        if not operation_uuid:
            return
        self.env['kemfai.company.mutation.receipt'].create({
            'operation_uuid': operation_uuid,
            'company_id': self.id,
            'action': action,
            'actor_id': actor_id,
            'occurred_at': self._kemfai_parse_occurred_at(occurred_at),
            'result_json': json.dumps(result),
        })

    def kemfai_setup_get_state(self):
        """GET /companies/current/setup RPC body (T054)."""
        self.ensure_one()
        return {
            'currentStep': self._kemfai_compute_current_step(),
            'setupComplete': self.setup_complete,
            'values': self._kemfai_setup_values_dict(),
            'version': self.setup_wizard_version,
            'stale': False,
        }

    def _kemfai_missing_required_steps(self):
        """Every wizard step with at least one unset required field, computed fresh
        from persisted state (never from any client-supplied flag) — the single
        source of truth T055's `kemfai_setup_complete()` gates on.
        """
        self.ensure_one()
        return [
            step_id for step_id, _label in SETUP_WIZARD_STEPS
            if any(not getattr(self, field_name) for field_name in STEP_FIELDS[step_id])
        ]

    def kemfai_setup_complete(self, operation_uuid=None, occurred_at=None, actor_id=None):
        """POST /companies/current/setup/complete RPC body (T055, FR-028,
        Acceptance Scenario 3.7).

        Locks the row (same `SELECT ... FOR UPDATE` pattern as
        `kemfai_setup_save_step`) before re-checking persisted state, so a
        concurrent save/complete call on this company can never race past this
        check. A company already marked complete is a no-op success —
        `alreadyComplete=True` tells the BFF not to append a second
        `company.setup.completed` audit row for a retry (never trusts a client
        flag either way: this method is the only place that flips
        `setup_complete`).

        `operation_uuid` (arbiter resolution point 2): when the BFF's
        control-plane handoff for this operation already has a stored receipt
        here (a prior attempt's RPC reached and committed on Odoo, even if its
        HTTP response never reached the caller), that exact stored result is
        returned verbatim and the row is NOT re-locked/re-written — a repeated
        operation UUID can never apply a second mutation.
        """
        self.ensure_one()
        self.env.cr.execute('SELECT id FROM res_company WHERE id = %s FOR UPDATE', (self.id,))
        company = self.browse(self.id)

        existing_receipt = company._kemfai_get_receipt(operation_uuid)
        if existing_receipt is not None:
            return existing_receipt

        if company.setup_complete:
            result = {
                'alreadyComplete': True,
                'currentStep': company._kemfai_compute_current_step(),
                'setupComplete': True,
                'values': company._kemfai_setup_values_dict(),
                'version': company.setup_wizard_version,
                'stale': False,
            }
            company._kemfai_store_receipt(
                operation_uuid, 'setup.complete', result, occurred_at, actor_id
            )
            return result

        missing_steps = company._kemfai_missing_required_steps()
        if missing_steps:
            raise ValidationError(
                'KEMFAI_SETUP_INCOMPLETE: required step(s) not yet submitted: '
                + ', '.join(missing_steps)
            )

        company.write({
            'setup_complete': True,
            'setup_completed_at': fields.Datetime.now(),
            'setup_wizard_version': company.setup_wizard_version + 1,
        })
        result = {
            'alreadyComplete': False,
            'currentStep': company._kemfai_compute_current_step(),
            'setupComplete': True,
            'values': company._kemfai_setup_values_dict(),
            'version': company.setup_wizard_version,
            'stale': False,
        }
        company._kemfai_store_receipt(
            operation_uuid, 'setup.complete', result, occurred_at, actor_id
        )
        return result

    # -- T055: GET/PUT /companies/current/settings RPC surface (FR-028) ----------
    #
    # A distinct, post-completion-only surface over the SAME wizard-captured
    # fields, reusing _kemfai_resolve_step_values/_kemfai_setup_values_dict
    # (and therefore the SAME country/VAT validation constraint) rather than
    # inventing a second validation path. Reachable only once setup_complete is
    # True — checked here, against the authoritative persisted column, never a
    # client-supplied flag.

    def kemfai_settings_get(self):
        self.ensure_one()
        if not self.setup_complete:
            raise ValidationError(
                'KEMFAI_SETUP_INCOMPLETE: settings are not reachable until setup is complete.'
            )
        return {
            'values': self._kemfai_setup_values_dict(),
            'setupComplete': True,
        }

    def kemfai_settings_update(self, values, operation_uuid=None, occurred_at=None, actor_id=None):
        """`operation_uuid` (arbiter resolution point 2): a repeated operation UUID
        returns the stored receipt verbatim — including the ORIGINAL `changedFields` —
        without re-applying the mutation or recomputing `changedFields` from whatever
        the repeat call's `values` happens to be."""
        self.ensure_one()
        self.env.cr.execute('SELECT id FROM res_company WHERE id = %s FOR UPDATE', (self.id,))
        company = self.browse(self.id)

        existing_receipt = company._kemfai_get_receipt(operation_uuid)
        if existing_receipt is not None:
            return existing_receipt

        if not company.setup_complete:
            raise ValidationError(
                'KEMFAI_SETUP_INCOMPLETE: settings are not reachable until setup is complete.'
            )
        if not isinstance(values, dict):
            raise ValidationError('KEMFAI_INVALID_PAYLOAD: values must be an object.')

        write_vals = {}
        changed_fields = []
        for step_id, _label in SETUP_WIZARD_STEPS:
            step_input = {key: values[key] for key in STEP_FIELDS[step_id] if key in values}
            if not step_input:
                continue
            resolved = company._kemfai_resolve_step_values(step_id, step_input)
            write_vals.update(resolved)
            changed_fields.extend(sorted(resolved.keys()))

        if not write_vals:
            raise ValidationError(
                'KEMFAI_REQUIRED_FIELD: no recognized settings field was submitted.'
            )
        company.write(write_vals)
        result = {
            'values': company._kemfai_setup_values_dict(),
            'setupComplete': True,
            'changedFields': changed_fields,
        }
        company._kemfai_store_receipt(
            operation_uuid, 'settings.update', result, occurred_at, actor_id
        )
        return result

    def kemfai_setup_save_step(self, step, values, base_version=None):
        """PUT /companies/current/setup RPC body (T054).

        Concurrency (arbiter resolution point 1): locks this company row with
        `SELECT ... FOR UPDATE`, re-browses it, compares the caller's
        `base_version` against the locked `setup_wizard_version`, then applies
        the submitted fields and advances `setup_wizard_version` by exactly one
        in the SAME write() — all inside this one method's transaction, so the
        lock is held across the compare-and-write. A stale caller's save still
        succeeds field-by-field (last-writer-wins); only `stale` tells the
        caller it was not the version it started from.
        """
        self.ensure_one()
        self.env.cr.execute('SELECT id FROM res_company WHERE id = %s FOR UPDATE', (self.id,))
        company = self.browse(self.id)
        locked_version = company.setup_wizard_version
        stale = base_version is not None and int(base_version) != locked_version

        write_vals = company._kemfai_resolve_step_values(step, values)
        write_vals['setup_wizard_version'] = locked_version + 1
        company.write(write_vals)

        return {
            'currentStep': company._kemfai_compute_current_step(),
            'setupComplete': company.setup_complete,
            'values': company._kemfai_setup_values_dict(),
            'version': company.setup_wizard_version,
            'stale': stale,
        }
