import uuid

from odoo import api, fields, models
from odoo.addons.base.models.ir_model import MODULE_UNINSTALL_FLAG
from odoo.exceptions import ValidationError


class AccountJournal(models.Model):
    _inherit = "account.journal"

    kemfai_public_id = fields.Char(
        string="KEMFAI Public UUID",
        required=True,
        readonly=True,
        copy=False,
        default=lambda self: str(uuid.uuid4()),
        index=True,
    )
    name_en = fields.Char(
        string="English Name", required=True, default="Unnamed"
    )
    name_ar = fields.Char(
        string="Arabic Name",
        required=True,
        default="غير مسمى",
    )
    version = fields.Integer(
        required=True, readonly=True, copy=False, default=1
    )

    _sql_constraints = [
        (
            "kemfai_journal_public_id_unique",
            "unique(kemfai_public_id)",
            "KEMFAI journal public UUID must be unique.",
        ),
        (
            "kemfai_journal_company_code_unique",
            "unique(company_id, code)",
            "Journal code must be unique within a company.",
        ),
        (
            "kemfai_journal_version_positive",
            "CHECK(version >= 1)",
            "Journal version must be positive.",
        ),
    ]

    def write(self, values):
        for journal in self:
            if (
                "kemfai_public_id" in values
                and values["kemfai_public_id"] != journal.kemfai_public_id
            ):
                raise ValidationError("JOURNAL_PUBLIC_UUID_IMMUTABLE")
            if (
                "company_id" in values
                and values["company_id"] != journal.company_id.id
            ):
                raise ValidationError("JOURNAL_COMPANY_IMMUTABLE")
        if "version" in values:
            raise ValidationError("JOURNAL_VERSION_IMMUTABLE")

        for journal in self:
            record_values = dict(values)
            record_values["version"] = journal.version + 1
            super(AccountJournal, journal).write(record_values)
        return True

    def unlink(self):
        if self.env.context.get(MODULE_UNINSTALL_FLAG):
            return super().unlink()
        raise ValidationError("HISTORY_PROTECTED")

    @api.model
    def _kemfai_journal_result(self, journal):
        return {
            "id": journal.kemfai_public_id,
            "company_id": journal.company_id.kemfai_public_id,
            "code": journal.code,
            "name_en": journal.name_en,
            "name_ar": journal.name_ar,
            "type": journal.type,
            "active": journal.active,
            "version": journal.version,
        }

    @api.model
    def _kemfai_validate_company_scope(self, company_id):
        company = self.env["res.company"].browse(company_id).exists()
        if not company or company not in self.env.user.company_ids:
            raise ValidationError("JOURNAL_SCOPE_DENIED")
        return company

    @api.model
    def _kemfai_finish_mutation(
        self, operation_uuid, action, actor_id, journal, before
    ):
        result = self._kemfai_journal_result(journal)
        event = self.env["kemfai.account.audit.event"].kemfai_append(
            operation_uuid=operation_uuid,
            action=action,
            actor_identity=actor_id,
            company_id=journal.company_id.id,
            resource_model="account.journal",
            resource_public_id=journal.kemfai_public_id,
            before=before,
            after=result,
        )
        result = dict(result, audit_event_id=event.public_id)
        self.env["kemfai.account.mutation.receipt"].kemfai_record_result(
            operation_uuid=operation_uuid,
            action=action,
            actor_identity=actor_id,
            company_id=journal.company_id.id,
            audit_event_uuid=event.public_id,
            result=result,
        )
        return result

    @api.model
    def kemfai_create_journal(self, operation_uuid, actor_id, values):
        replay = self.env[
            "kemfai.account.mutation.receipt"
        ].kemfai_find_result(operation_uuid)
        if replay:
            return replay
        create_values = dict(values)
        company = self._kemfai_validate_company_scope(
            create_values.pop("company_id", None)
        )
        allowed = {"code", "name", "name_en", "name_ar", "type", "active"}
        if set(create_values) - allowed:
            raise ValidationError("JOURNAL_FIELDS_FORBIDDEN")
        if create_values.get("type", "general") != "general":
            raise ValidationError("JOURNAL_TYPE_INVALID")
        required = ("code", "name_en", "name_ar")
        if any(not create_values.get(field_name) for field_name in required):
            raise ValidationError("JOURNAL_FIELDS_INVALID")
        create_values.update(
            {
                "company_id": company.id,
                "name": create_values.get("name", create_values["name_en"]),
                "type": "general",
            }
        )
        journal = self.create(create_values)
        return self._kemfai_finish_mutation(
            operation_uuid, "journal.create", actor_id, journal, None
        )

    @api.model
    def kemfai_list_journals(self, company_id, filters=None):
        company = self._kemfai_validate_company_scope(company_id)
        filters = dict(filters or {})
        if set(filters) - {"active"}:
            raise ValidationError("JOURNAL_FILTER_INVALID")
        domain = [("company_id", "=", company.id), ("type", "=", "general")]
        if "active" in filters and filters["active"] is not None:
            if not isinstance(filters["active"], bool):
                raise ValidationError("JOURNAL_ACTIVE_FILTER_INVALID")
            domain.append(("active", "=", filters["active"]))
        journals = self.with_context(active_test=False).search(domain, order="id asc")
        return {"items": [self._kemfai_journal_result(item) for item in journals]}

    @api.model
    def kemfai_update_journal(
        self,
        public_id,
        operation_uuid,
        actor_id,
        expected_version,
        changes,
        company_id,
    ):
        replay = self.env[
            "kemfai.account.mutation.receipt"
        ].kemfai_find_result(operation_uuid)
        if replay:
            return replay
        self._kemfai_validate_company_scope(company_id)
        self.env.cr.execute(
            "SELECT id FROM account_journal "
            "WHERE kemfai_public_id = %s AND company_id = %s FOR UPDATE",
            (public_id, company_id),
        )
        row = self.env.cr.fetchone()
        if not row:
            raise ValidationError("JOURNAL_NOT_FOUND")

        journal = self.with_context(active_test=False).browse(row[0])
        journal.invalidate_recordset(["version"])
        if journal.version != expected_version:
            raise ValidationError("STALE_VERSION")

        allowed_fields = {"code", "name", "name_en", "name_ar", "active"}
        if not changes or set(changes) - allowed_fields:
            raise ValidationError("JOURNAL_FIELD_IMMUTABLE")
        before = self._kemfai_journal_result(journal)
        journal.write(changes)
        return self._kemfai_finish_mutation(
            operation_uuid, "journal.update", actor_id, journal, before
        )
