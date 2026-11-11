from datetime import date
import uuid

from odoo import api, models
from odoo.exceptions import AccessError, ValidationError

from .coa import operation_race_retry


def _company(model, company_id):
    company = model.env["res.company"].browse(company_id).exists()
    if not company or company not in model.env.user.company_ids:
        raise AccessError("ACCOUNT_SCOPE_DENIED")
    return company


def _receipt(model, operation_uuid):
    return model.env["kemfai.account.mutation.receipt"].kemfai_find_result(operation_uuid)


def _begin_create(model, operation_uuid, action, actor_identity, company_id, target_model, target_public_id, result):
    event = model.env["kemfai.account.audit.event"].kemfai_append(
        operation_uuid=operation_uuid,
        action=action,
        actor_identity=actor_identity,
        company_id=company_id,
        resource_model=target_model,
        resource_public_id=target_public_id,
        before=None,
        after=result,
    )
    response = dict(result, audit_event_id=event.public_id)
    receipt = model.env["kemfai.account.mutation.receipt"].kemfai_record_result(
        operation_uuid=operation_uuid,
        action=action,
        actor_identity=actor_identity,
        company_id=company_id,
        audit_event_uuid=event.public_id,
        result=response,
    )
    event.flush_recordset()
    receipt.flush_recordset()
    return response


def _finish(model, operation_uuid, action, actor_identity, record, before, result):
    event = model.env["kemfai.account.audit.event"].kemfai_append(
        operation_uuid=operation_uuid,
        action=action,
        actor_identity=actor_identity,
        company_id=record.company_id.id,
        resource_model=record._name,
        resource_public_id=record.public_id,
        before=before,
        after=result,
    )
    result = dict(result, audit_event_id=event.public_id)
    model.env["kemfai.account.mutation.receipt"].kemfai_record_result(
        operation_uuid=operation_uuid,
        action=action,
        actor_identity=actor_identity,
        company_id=record.company_id.id,
        audit_event_uuid=event.public_id,
        result=result,
    )
    return result


def _for_update(model, public_id, company_id, table, not_found):
    _company(model, company_id)
    model.env.cr.execute(
        f"SELECT id FROM {table} WHERE public_id = %s AND company_id = %s FOR UPDATE",
        [public_id, company_id],
    )
    row = model.env.cr.fetchone()
    if not row:
        raise ValidationError(not_found)
    return model.with_context(active_test=False).browse(row[0]).exists()


def _page(model, company_id, filters, result, extra_domain=None):
    _company(model, company_id)
    filters = dict(filters or {})
    limit = filters.get("limit", 200)
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 200:
        raise ValidationError("DIMENSION_LIMIT_INVALID")
    domain = [("company_id", "=", company_id)] + list(extra_domain or [])
    if "active" in filters and filters["active"] is not None:
        if not isinstance(filters["active"], bool):
            raise ValidationError("DIMENSION_ACTIVE_FILTER_INVALID")
        domain.append(("active", "=", filters["active"]))
    cursor = filters.get("cursor")
    if cursor:
        cursor_record = model.with_context(active_test=False).search(
            [("public_id", "=", cursor), ("company_id", "=", company_id)], limit=1
        )
        if not cursor_record:
            raise ValidationError("DIMENSION_CURSOR_INVALID")
        domain.append(("id", ">", cursor_record.id))
    records = model.with_context(active_test=False).search(domain, order="id", limit=limit + 1)
    page = records[:limit]
    return {
        "items": [result(record) for record in page],
        "next_cursor": page[-1].public_id if len(records) > limit and page else None,
    }


class KemfaiDimensionDefinitionService(models.Model):
    _inherit = "kemfai.dimension.definition"

    @api.model
    def _kemfai_result(self, record):
        return {
            "id": record.public_id,
            "key": record.key,
            "kind": record.kind,
            "name_en": record.name_en,
            "name_ar": record.name_ar,
            "active": record.active,
            "version": record.version,
        }

    @api.model
    def kemfai_list_dimension_definitions(self, company_id, filters=None):
        allowed = {"active"}
        if set(filters or {}) - allowed:
            raise ValidationError("DIMENSION_FILTER_INVALID")
        return _page(self, company_id, dict(filters or {}, limit=200), self._kemfai_result)

    @api.model
    @operation_race_retry(0)
    def kemfai_create_dimension_definition(self, operation_uuid, actor_identity, values):
        replay = _receipt(self, operation_uuid)
        if replay:
            return replay
        values = dict(values)
        company_id = values.get("company_id")
        _company(self, company_id)
        allowed = {"company_id", "key", "kind", "name_en", "name_ar", "active"}
        if set(values) - allowed or values.get("kind", "custom") == "built_in":
            raise ValidationError("DIMENSION_DEFINITION_FIELDS_FORBIDDEN")
        public_id = str(uuid.uuid4())
        result = {
            "id": public_id,
            "key": values["key"],
            "kind": values.get("kind", "custom"),
            "name_en": values["name_en"],
            "name_ar": values["name_ar"],
            "active": values.get("active", True),
            "version": 1,
        }
        response = _begin_create(self, operation_uuid, "dimension.definition.create", actor_identity, company_id, self._name, public_id, result)
        self.create(dict(values, public_id=public_id))
        return response

    @api.model
    @operation_race_retry(1)
    def kemfai_update_dimension_definition(self, public_id, operation_uuid, actor_identity, expected_version, values, company_id):
        replay = _receipt(self, operation_uuid)
        if replay:
            return replay
        if set(values) - {"name_en", "name_ar", "active"}:
            raise ValidationError("DIMENSION_DEFINITION_FIELDS_FORBIDDEN")
        record = _for_update(self, public_id, company_id, "kemfai_dimension_definition", "DIMENSION_DEFINITION_NOT_FOUND")
        if record.version != expected_version:
            raise ValidationError("STALE_VERSION")
        before = self._kemfai_result(record)
        record.write(values)
        return _finish(self, operation_uuid, "dimension.definition.update", actor_identity, record, before, self._kemfai_result(record))


class KemfaiDimensionValueService(models.Model):
    _inherit = "kemfai.dimension.value"

    @api.model
    def _kemfai_result(self, record):
        return {
            "id": record.public_id,
            "definition_id": record.definition_id.public_id,
            "code": record.code,
            "name_en": record.name_en,
            "name_ar": record.name_ar,
            "active": record.active,
            "version": record.version,
        }

    @api.model
    def kemfai_list_dimension_values(self, company_id, filters=None):
        filters = dict(filters or {})
        if set(filters) - {"cursor", "limit", "definitionId", "active"}:
            raise ValidationError("DIMENSION_FILTER_INVALID")
        domain = []
        definition_id = filters.pop("definitionId", None)
        if definition_id:
            definition = self.env["kemfai.dimension.definition"].with_context(active_test=False).search(
                [("public_id", "=", definition_id), ("company_id", "=", company_id)], limit=1
            )
            if not definition:
                raise ValidationError("DIMENSION_DEFINITION_NOT_FOUND")
            domain.append(("definition_id", "=", definition.id))
        return _page(self, company_id, filters, self._kemfai_result, domain)

    @api.model
    @operation_race_retry(0)
    def kemfai_create_dimension_value(self, operation_uuid, actor_identity, values):
        replay = _receipt(self, operation_uuid)
        if replay:
            return replay
        values = dict(values)
        company_id = values.get("company_id")
        _company(self, company_id)
        definition_public_id = values.pop("definition_public_id", None)
        definition = self.env["kemfai.dimension.definition"].with_context(active_test=False).search(
            [("public_id", "=", definition_public_id), ("company_id", "=", company_id)], limit=1
        )
        if not definition:
            raise ValidationError("DIMENSION_DEFINITION_NOT_FOUND")
        allowed = {"company_id", "code", "name_en", "name_ar", "active"}
        if set(values) - allowed:
            raise ValidationError("DIMENSION_VALUE_FIELDS_FORBIDDEN")
        public_id = str(uuid.uuid4())
        result = {
            "id": public_id,
            "definition_id": definition.public_id,
            "code": values["code"],
            "name_en": values["name_en"],
            "name_ar": values["name_ar"],
            "active": values.get("active", True),
            "version": 1,
        }
        response = _begin_create(self, operation_uuid, "dimension.value.create", actor_identity, company_id, self._name, public_id, result)
        self.create(dict(values, definition_id=definition.id, public_id=public_id))
        return response

    @api.model
    @operation_race_retry(1)
    def kemfai_update_dimension_value(self, public_id, operation_uuid, actor_identity, expected_version, values, company_id):
        replay = _receipt(self, operation_uuid)
        if replay:
            return replay
        if set(values) - {"code", "name_en", "name_ar", "active"}:
            raise ValidationError("DIMENSION_VALUE_FIELDS_FORBIDDEN")
        record = _for_update(self, public_id, company_id, "kemfai_dimension_value", "DIMENSION_VALUE_NOT_FOUND")
        if record.version != expected_version:
            raise ValidationError("STALE_VERSION")
        before = self._kemfai_result(record)
        record.write(values)
        return _finish(self, operation_uuid, "dimension.value.update", actor_identity, record, before, self._kemfai_result(record))


class KemfaiDimensionRuleService(models.Model):
    _inherit = "kemfai.dimension.rule"

    @api.model
    def _kemfai_result(self, record):
        return {
            "id": record.public_id,
            "account_id": record.account_id.kemfai_public_id or None,
            "transaction_type": record.transaction_type_key or None,
            "dimension_definition_id": record.dimension_definition_id.public_id,
            "requirement": record.requirement,
            "effective_from": str(record.effective_from),
            "effective_to": str(record.effective_to) if record.effective_to else None,
            "active": record.active,
            "version": record.version,
        }

    @api.model
    def kemfai_list_dimension_rules(self, company_id, filters=None):
        filters = dict(filters or {})
        if set(filters) - {"accountId", "transactionType", "active"}:
            raise ValidationError("DIMENSION_FILTER_INVALID")
        domain = []
        account_public_id = filters.pop("accountId", None)
        if account_public_id:
            account = self.env["account.account"].with_context(active_test=False).search(
                [("kemfai_public_id", "=", account_public_id), ("company_id", "=", company_id)], limit=1
            )
            if not account:
                raise ValidationError("DIMENSION_RULE_ACCOUNT_NOT_FOUND")
            domain.append(("account_id", "=", account.id))
        transaction_type = filters.pop("transactionType", None)
        if transaction_type:
            domain.append(("transaction_type_key", "=", transaction_type))
        return _page(self, company_id, dict(filters, limit=200), self._kemfai_result, domain)

    @api.model
    def _kemfai_create_values(self, values):
        values = dict(values)
        company_id = values.get("company_id")
        _company(self, company_id)
        definition_public_id = values.pop("dimension_definition_public_id", None)
        definition = self.env["kemfai.dimension.definition"].with_context(active_test=False).search(
            [("public_id", "=", definition_public_id), ("company_id", "=", company_id)], limit=1
        )
        if not definition:
            raise ValidationError("DIMENSION_DEFINITION_NOT_FOUND")
        account_public_id = values.pop("account_public_id", False)
        account_id = False
        if account_public_id:
            account = self.env["account.account"].with_context(active_test=False).search(
                [("kemfai_public_id", "=", account_public_id), ("company_id", "=", company_id)], limit=1
            )
            if not account:
                raise ValidationError("DIMENSION_RULE_ACCOUNT_NOT_FOUND")
            account_id = account.id
        allowed = {"company_id", "transaction_type_key", "requirement", "effective_from", "effective_to", "active"}
        if set(values) - allowed:
            raise ValidationError("DIMENSION_RULE_FIELDS_FORBIDDEN")
        return dict(values, dimension_definition_id=definition.id, account_id=account_id, effective_from=values.get("effective_from") or date.today())

    @api.model
    @operation_race_retry(0)
    def kemfai_create_dimension_rule(self, operation_uuid, actor_identity, values):
        replay = _receipt(self, operation_uuid)
        if replay:
            return replay
        create_values = self._kemfai_create_values(values)
        public_id = str(uuid.uuid4())
        definition = self.env["kemfai.dimension.definition"].browse(create_values["dimension_definition_id"])
        account = self.env["account.account"].browse(create_values.get("account_id"))
        result = {
            "id": public_id,
            "account_id": account.kemfai_public_id or None,
            "transaction_type": create_values.get("transaction_type_key") or None,
            "dimension_definition_id": definition.public_id,
            "requirement": create_values["requirement"],
            "effective_from": str(create_values["effective_from"]),
            "effective_to": str(create_values["effective_to"]) if create_values.get("effective_to") else None,
            "active": create_values.get("active", True),
            "version": 1,
        }
        response = _begin_create(self, operation_uuid, "dimension.rule.create", actor_identity, create_values["company_id"], self._name, public_id, result)
        self.create(dict(create_values, public_id=public_id))
        return response

    @api.model
    @operation_race_retry(1)
    def kemfai_update_dimension_rule(self, public_id, operation_uuid, actor_identity, expected_version, values, company_id):
        replay = _receipt(self, operation_uuid)
        if replay:
            return replay
        if set(values) - {"requirement", "effective_from", "effective_to", "active"}:
            raise ValidationError("DIMENSION_RULE_FIELDS_FORBIDDEN")
        record = _for_update(self, public_id, company_id, "kemfai_dimension_rule", "DIMENSION_RULE_NOT_FOUND")
        if record.version != expected_version:
            raise ValidationError("STALE_VERSION")
        before = self._kemfai_result(record)
        record.write(values)
        return _finish(self, operation_uuid, "dimension.rule.update", actor_identity, record, before, self._kemfai_result(record))
