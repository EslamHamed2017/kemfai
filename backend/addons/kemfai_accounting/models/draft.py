import uuid

from odoo import api, fields, models


class KemfaiAccountDraft(models.Model):
    _name = "kemfai.account.draft"
    _description = "KEMFAI Minimal Account Draft"
    _order = "create_date, id"

    public_id = fields.Char(
        required=True,
        readonly=True,
        copy=False,
        default=lambda self: str(uuid.uuid4()),
        index=True,
    )
    company_id = fields.Many2one(
        "res.company", required=True, readonly=True, ondelete="restrict", index=True
    )
    actor_identity = fields.Char(required=True, readonly=True)
    journal_id = fields.Many2one(
        "account.journal", readonly=True, ondelete="restrict", index=True
    )
    accounting_date = fields.Date(readonly=True)
    description = fields.Text(readonly=True)
    transaction_type_key = fields.Char(readonly=True, index=True)
    source_type = fields.Char(readonly=True)
    source_public_id = fields.Char(readonly=True)
    version = fields.Integer(required=True, readonly=True, default=1)
    validation_state = fields.Selection(
        selection=[
            ("not_validated", "Not Validated"),
            ("stale", "Stale"),
            ("valid_for_draft", "Valid for Draft"),
            ("invalid", "Invalid"),
        ],
        required=True,
        readonly=True,
        default="not_validated",
    )
    payload_json = fields.Json(readonly=True)
    status = fields.Selection(
        selection=[("draft", "Draft")],
        required=True,
        readonly=True,
        default="draft",
    )
    line_ids = fields.One2many(
        "kemfai.account.draft.line", "draft_id", readonly=True
    )

    @api.model_create_multi
    def create(self, values_list):
        prepared_values = []
        payloads = []
        for values in values_list:
            prepared = dict(values)
            payload = prepared.get("payload_json") or {}
            source = payload.get("source") or {}
            company_id = prepared.get("company_id")
            journal_public_id = payload.get("journalId")
            journal_model = self.env["account.journal"]
            journal = journal_model
            if (
                journal_public_id
                and company_id
                and "kemfai_public_id" in journal_model._fields
            ):
                journal = journal_model.with_context(active_test=False).search(
                    [
                        ("kemfai_public_id", "=", journal_public_id),
                        ("company_id", "=", company_id),
                    ],
                    limit=1,
                )
            prepared.update(
                {
                    "journal_id": journal.id or False,
                    "accounting_date": payload.get("accountingDate") or False,
                    "description": payload.get("description") or False,
                    "transaction_type_key": payload.get("transactionType") or False,
                    "source_type": source.get("type") or False,
                    "source_public_id": source.get("id") or False,
                }
            )
            prepared_values.append(prepared)
            payloads.append(payload)

        drafts = super().create(prepared_values)
        line_values = []
        for draft, payload in zip(drafts, payloads):
            for line in payload.get("lines", []):
                account = self.env["account.account"].with_context(
                    active_test=False
                ).search(
                    [("kemfai_public_id", "=", line.get("accountId"))], limit=1
                )
                # Existing Story 1 deliberately saves invalid parent/inactive
                # selections for later non-posting validation. Keep those in the
                # immutable payload; materialize only eligible persisted lines.
                if (
                    not account
                    or account.company_id != draft.company_id
                    or not account.active
                    or account.kemfai_node_kind != "posting"
                ):
                    continue
                configuration = False
                if "kemfai.account.currency.config" in self.env:
                    configuration = self.env[
                        "kemfai.account.currency.config"
                    ].with_context(active_test=False).search(
                        [
                            ("company_id", "=", draft.company_id.id),
                            (
                                "currency_code",
                                "=",
                                line.get("transactionCurrencyCode"),
                            ),
                        ],
                        limit=1,
                    )
                line_values.append(
                    {
                        "public_id": line.get("id"),
                        "draft_id": draft.id,
                        "account_id": account.id,
                        "sequence": line.get("sequence", 1),
                        "description": line.get("description") or False,
                        "currency_config_id": configuration.public_id
                        if configuration
                        else False,
                        "transaction_currency_code": line.get(
                            "transactionCurrencyCode"
                        ),
                        "transaction_precision": line.get("transactionPrecision"),
                        "transaction_currency_metadata_version": line.get(
                            "transactionCurrencyMetadataVersion"
                        ),
                        "company_base_currency_code": line.get(
                            "companyBaseCurrencyCode"
                        ),
                        "base_precision": line.get("basePrecision"),
                        "base_currency_metadata_version": line.get(
                            "baseCurrencyMetadataVersion"
                        ),
                        "currency_configuration_version": line.get(
                            "currencyConfigurationVersion"
                        ),
                        "transaction_debit": line.get("transactionDebit"),
                        "transaction_credit": line.get("transactionCredit"),
                        "base_debit": line.get("baseDebit"),
                        "base_credit": line.get("baseCredit"),
                        "rate_reference": line.get("rateReference") or False,
                        "rate_effective_date": line.get("rateEffectiveDate") or False,
                        "account_version": account.version,
                        "journal_version": draft.journal_id.version
                        if draft.journal_id
                        else False,
                        "source_context": payload.get("source") or False,
                    }
                )
        if line_values:
            self.env["kemfai.account.draft.line"].create(line_values)
        return drafts

    _sql_constraints = [
        (
            "kemfai_account_draft_public_id_unique",
            "unique(public_id)",
            "Draft public UUID must be unique.",
        ),
        (
            "kemfai_account_draft_status_only",
            "CHECK(status = 'draft')",
            "Minimal accounting drafts have only the draft state.",
        ),
    ]


class KemfaiAccountDraftLine(models.Model):
    _name = "kemfai.account.draft.line"
    _description = "KEMFAI Minimal Account Draft Line"
    _order = "id"

    public_id = fields.Char(
        required=True,
        readonly=True,
        copy=False,
        default=lambda self: str(uuid.uuid4()),
        index=True,
    )
    draft_id = fields.Many2one(
        "kemfai.account.draft", required=True, readonly=True, ondelete="cascade", index=True
    )
    company_id = fields.Many2one(
        related="draft_id.company_id", store=True, readonly=True, index=True
    )
    account_id = fields.Many2one(
        "account.account",
        required=True,
        readonly=True,
        ondelete="restrict",
        index=True,
        domain="[('company_id', '=', company_id), ('kemfai_node_kind', '=', 'posting'), ('active', '=', True)]",
    )
    sequence = fields.Integer(required=True, readonly=True, default=1)
    description = fields.Text(readonly=True)
    # Stored as the immutable public identifier until T119 registers the
    # currency model and access controls as one complete addon upgrade.
    currency_config_id = fields.Char(readonly=True, index=True)
    transaction_currency_code = fields.Char(readonly=True)
    transaction_precision = fields.Integer(readonly=True)
    transaction_currency_metadata_version = fields.Char(readonly=True)
    company_base_currency_code = fields.Char(readonly=True)
    base_precision = fields.Integer(readonly=True)
    base_currency_metadata_version = fields.Char(readonly=True)
    currency_configuration_version = fields.Integer(readonly=True)
    transaction_debit = fields.Char(readonly=True)
    transaction_credit = fields.Char(readonly=True)
    base_debit = fields.Char(readonly=True)
    base_credit = fields.Char(readonly=True)
    rate_reference = fields.Char(readonly=True)
    rate_effective_date = fields.Date(readonly=True)
    account_version = fields.Integer(readonly=True)
    journal_version = fields.Integer(readonly=True)
    source_context = fields.Json(readonly=True)

    _sql_constraints = [
        (
            "kemfai_account_draft_line_public_id_unique",
            "unique(public_id)",
            "Draft-line public UUID must be unique.",
        ),
    ]
