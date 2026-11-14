import hashlib
import uuid

from psycopg2.errors import SerializationFailure

from odoo import api, fields, models
from odoo.exceptions import ValidationError


class KemfaiAccountCurrencyConfig(models.Model):
    _name = "kemfai.account.currency.config"
    _description = "KEMFAI Company Currency Configuration"
    _order = "company_id, currency_code, id"
    _rec_name = "currency_code"

    public_id = fields.Char(
        required=True,
        readonly=True,
        copy=False,
        default=lambda self: str(uuid.uuid4()),
        index=True,
    )
    company_id = fields.Many2one(
        "res.company",
        required=True,
        readonly=True,
        ondelete="restrict",
        index=True,
    )
    currency_id = fields.Many2one(
        "res.currency",
        required=True,
        readonly=True,
        ondelete="restrict",
        index=True,
    )
    currency_code = fields.Char(required=True, readonly=True)
    native_decimal_places = fields.Integer(required=True, readonly=True)
    native_metadata_version = fields.Char(required=True, readonly=True)
    is_base = fields.Boolean(required=True, readonly=True)
    enabled = fields.Boolean(required=True, default=False, index=True)
    version = fields.Integer(required=True, readonly=True, copy=False, default=1)

    _sql_constraints = [
        (
            "kemfai_currency_config_public_id_unique",
            "unique(public_id)",
            "Currency configuration public UUID must be unique.",
        ),
        (
            "kemfai_currency_config_company_currency_unique",
            "unique(company_id, currency_id)",
            "Currency configuration must be unique within a company.",
        ),
        (
            "kemfai_currency_config_version_positive",
            "CHECK(version >= 1)",
            "Currency configuration version must be positive.",
        ),
    ]

    @staticmethod
    def _metadata_version(currency_code, decimal_places):
        snapshot = f"{currency_code}:{decimal_places}".encode("utf-8")
        return hashlib.sha256(snapshot).hexdigest()

    @staticmethod
    def _public_id(company_public_id, currency_code):
        return str(
            uuid.uuid5(
                uuid.NAMESPACE_URL,
                f"kemfai:currency-config:{company_public_id}:{currency_code}",
            )
        )

    @api.model
    def _validate_company(self, company_id):
        company = self.env["res.company"].browse(company_id).exists()
        if not company or company not in self.env.user.company_ids:
            raise ValidationError("CURRENCY_SCOPE_DENIED")
        return company

    @staticmethod
    def _parse_etag(if_match):
        if (
            not isinstance(if_match, str)
            or len(if_match) < 3
            or not if_match.startswith('"')
            or not if_match.endswith('"')
            or not if_match[1:-1].isdigit()
        ):
            raise ValidationError("PRECONDITION_FAILED")
        return int(if_match[1:-1])

    def _result(self):
        self.ensure_one()
        return {
            "id": self.public_id,
            "company_id": self.company_id.kemfai_public_id,
            "currency_code": self.currency_code,
            "native_decimal_places": self.native_decimal_places,
            "native_metadata_version": self.native_metadata_version,
            "is_base": self.is_base,
            "enabled": self.enabled,
            "version": self.version,
        }

    @api.model
    def kemfai_list_currency_configurations(self, company_id, filters=None):
        company = self._validate_company(company_id)
        filters = dict(filters or {})
        if set(filters) - {"enabled"}:
            raise ValidationError("CURRENCY_FILTER_INVALID")
        enabled_filter = filters.get("enabled")
        if enabled_filter is not None and not isinstance(enabled_filter, bool):
            raise ValidationError("CURRENCY_ENABLED_FILTER_INVALID")

        configurations = self.with_context(active_test=False).search(
            [("company_id", "=", company.id)]
        )
        by_currency = {item.currency_id.id: item for item in configurations}
        items = []
        currencies = self.env["res.currency"].with_context(active_test=False).search(
            [], order="id asc"
        )
        for currency in currencies:
            configuration = by_currency.get(currency.id)
            enabled = configuration.enabled if configuration else False
            if enabled_filter is not None and enabled != enabled_filter:
                continue
            if configuration:
                result = configuration._result()
            else:
                result = {
                    "id": self._public_id(
                        company.kemfai_public_id, currency.name
                    ),
                    "company_id": company.kemfai_public_id,
                    "currency_code": currency.name,
                    "native_decimal_places": currency.decimal_places,
                    "native_metadata_version": self._metadata_version(
                        currency.name, currency.decimal_places
                    ),
                    "is_base": company.currency_id == currency,
                    "enabled": False,
                    "version": 1,
                }
            items.append(result)
        return {"items": items}

    @api.model
    def _finish_mutation(
        self, operation_uuid, actor_id, configuration, before
    ):
        result = configuration._result()
        event = self.env["kemfai.account.audit.event"].kemfai_append(
            operation_uuid=operation_uuid,
            action="currency.put",
            actor_identity=actor_id,
            company_id=configuration.company_id.id,
            resource_model=self._name,
            resource_public_id=configuration.public_id,
            before=before,
            after=result,
        )
        result = dict(result, audit_event_id=event.public_id)
        self.env["kemfai.account.mutation.receipt"].kemfai_record_result(
            operation_uuid=operation_uuid,
            action="currency.put",
            actor_identity=actor_id,
            company_id=configuration.company_id.id,
            audit_event_uuid=event.public_id,
            result=result,
        )
        return result

    @api.model
    def _configuration_for_update(self, company_id, currency_id):
        self.env.cr.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
            [f"kemfai:currency-config:{company_id}:{currency_id}"],
        )
        self.env.cr.execute(
            f"SELECT id FROM {self._table} "
            "WHERE company_id = %s AND currency_id = %s FOR UPDATE",
            (company_id, currency_id),
        )
        row = self.env.cr.fetchone()
        return self.browse(row[0]) if row else self.browse()

    @api.model
    def kemfai_put_currency_configuration(
        self,
        company_id,
        currency_code,
        operation_uuid,
        actor_id,
        if_match,
        changes,
    ):
        company = self._validate_company(company_id)
        replay = self.env[
            "kemfai.account.mutation.receipt"
        ].kemfai_find_result(operation_uuid)
        if replay:
            return replay
        if set(changes) != {"enabled"} or not isinstance(changes["enabled"], bool):
            raise ValidationError("CURRENCY_CONFIGURATION_FIELDS_INVALID")

        currency = self.env["res.currency"].with_context(active_test=False).search(
            [("name", "=", currency_code)], limit=1
        )
        if not currency:
            raise ValidationError("CURRENCY_NOT_FOUND")

        record = self._configuration_for_update(company.id, currency.id)
        if not record:
            if if_match != "*":
                raise ValidationError("PRECONDITION_FAILED")
            decimal_places = currency.decimal_places
            self.env.cr.execute(
                f"INSERT INTO {self._table} "
                "(public_id, company_id, currency_id, currency_code, "
                "native_decimal_places, native_metadata_version, is_base, "
                "enabled, version, create_uid, write_uid, create_date, write_date) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 1, %s, %s, "
                "now() at time zone 'UTC', now() at time zone 'UTC') "
                "ON CONFLICT DO NOTHING RETURNING id",
                (
                    self._public_id(company.kemfai_public_id, currency.name),
                    company.id,
                    currency.id,
                    currency.name,
                    decimal_places,
                    self._metadata_version(currency.name, decimal_places),
                    company.currency_id == currency,
                    changes["enabled"],
                    self.env.uid,
                    self.env.uid,
                ),
            )
            row = self.env.cr.fetchone()
            if not row:
                # A concurrent winner committed after this REPEATABLE READ snapshot.
                # Retry the whole Odoo transaction so the fresh snapshot applies
                # create-only If-Match deterministically as PRECONDITION_FAILED.
                raise SerializationFailure(
                    "concurrent currency configuration creation"
                )
            record = self.browse(row[0])
            return self._finish_mutation(
                operation_uuid, actor_id, record, None
            )

        if if_match == "*":
            raise ValidationError("PRECONDITION_FAILED")
        record.invalidate_recordset(["version"])
        if record.version != self._parse_etag(if_match):
            raise ValidationError("PRECONDITION_FAILED")
        before = record._result()
        record.write({"enabled": changes["enabled"]})
        return self._finish_mutation(
            operation_uuid, actor_id, record, before
        )

    def write(self, values):
        immutable_codes = {
            "public_id": "CURRENCY_PUBLIC_UUID_IMMUTABLE",
            "company_id": "COMPANY_IMMUTABLE",
            "currency_id": "CURRENCY_IMMUTABLE",
            "currency_code": "CURRENCY_IMMUTABLE",
            "native_decimal_places": "NATIVE_METADATA_IMMUTABLE",
            "native_metadata_version": "NATIVE_METADATA_IMMUTABLE",
            "is_base": "BASE_CURRENCY_IMMUTABLE",
        }
        relational_fields = {"company_id", "currency_id"}
        for record in self:
            for field_name, error_code in immutable_codes.items():
                if field_name not in values:
                    continue
                current = (
                    record[field_name].id
                    if field_name in relational_fields
                    else record[field_name]
                )
                if values[field_name] != current:
                    raise ValidationError(error_code)
        if "version" in values:
            raise ValidationError("CURRENCY_CONFIGURATION_VERSION_IMMUTABLE")
        if set(values) != {"enabled"} or not isinstance(values["enabled"], bool):
            raise ValidationError("CURRENCY_CONFIGURATION_FIELDS_INVALID")

        for record in self:
            super(KemfaiAccountCurrencyConfig, record).write(
                {"enabled": values["enabled"], "version": record.version + 1}
            )
        return True

    def unlink(self):
        if self.env.context.get("module_uninstall"):
            return super().unlink()
        raise ValidationError("HISTORY_PROTECTED")
