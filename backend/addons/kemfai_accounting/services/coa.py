from functools import wraps

from psycopg2 import IntegrityError, errorcodes
from psycopg2.errors import SerializationFailure

from odoo import api, models
from odoo.exceptions import AccessError, ValidationError


class OperationRaceSerializationFailure(SerializationFailure):
    @property
    def pgcode(self):
        return errorcodes.SERIALIZATION_FAILURE


MUTABLE_ACCOUNT_FIELDS = {
    "code",
    "name",
    "name_en",
    "name_ar",
    "account_type",
    "kemfai_parent_id",
    "kemfai_node_kind",
    "active",
}


def operation_race_retry(operation_argument_index):
    def decorate(method):
        @wraps(method)
        def guarded(self, *args, **kwargs):
            operation_uuid = args[operation_argument_index]
            try:
                with self.env.cr.savepoint():
                    return method(self, *args, **kwargs)
            except IntegrityError as exc:
                detail = str(exc)
                if str(operation_uuid) in detail and "duplicate key value" in detail:
                    raise OperationRaceSerializationFailure("KEMFAI_OPERATION_RACE") from exc
                raise

        return guarded

    return decorate


class AccountAccountService(models.Model):
    _inherit = "account.account"

    @api.model
    def _kemfai_account_result(self, account):
        return {
            "id": account.kemfai_public_id,
            "code": account.code,
            "name_en": account.name_en,
            "name_ar": account.name_ar,
            "account_type": account.account_type,
            "node_kind": account.kemfai_node_kind,
            "parent_id": account.kemfai_parent_id.kemfai_public_id or None,
            "active": account.active,
            "version": account.version,
        }

    @api.model
    def _kemfai_account_for_update(self, public_id, company_id=None):
        query = """
            SELECT id
              FROM account_account
             WHERE kemfai_public_id = %s
        """
        parameters = [public_id]
        if company_id is not None:
            query += " AND company_id = %s"
            parameters.append(company_id)
        query += " FOR UPDATE"
        self.env.cr.execute(query, parameters)
        row = self.env.cr.fetchone()
        if not row:
            raise ValidationError("ACCOUNT_NOT_FOUND")
        return self.with_context(active_test=False).browse(row[0]).exists()

    @api.model
    def _kemfai_validate_company_scope(self, company_id):
        company = self.env["res.company"].browse(company_id).exists()
        if not company or company not in self.env.user.company_ids:
            raise AccessError("ACCOUNT_SCOPE_DENIED")
        return company

    @api.model
    def _kemfai_parent_database_id(self, public_id, company_id):
        if not public_id:
            return False
        parent = self.with_context(active_test=False).search(
            [
                ("kemfai_public_id", "=", public_id),
                ("company_id", "=", company_id),
                ("kemfai_node_kind", "=", "parent"),
            ],
            limit=1,
        )
        if not parent:
            raise ValidationError("ACCOUNT_PARENT_NOT_FOUND")
        return parent.id

    @api.model
    def _kemfai_receipt(self, operation_uuid):
        return self.env["kemfai.account.mutation.receipt"].kemfai_find_result(
            operation_uuid
        )

    @api.model
    def _kemfai_finish_mutation(
        self,
        operation_uuid,
        action,
        actor_identity,
        account,
        before,
    ):
        result = self._kemfai_account_result(account)
        event = self.env["kemfai.account.audit.event"].kemfai_append(
            operation_uuid=operation_uuid,
            action=action,
            actor_identity=actor_identity,
            company_id=account.company_id.id,
            resource_model="account.account",
            resource_public_id=account.kemfai_public_id,
            before=before,
            after=result,
        )
        result_with_receipt = dict(result, audit_event_id=event.public_id)
        self.env["kemfai.account.mutation.receipt"].kemfai_record_result(
            operation_uuid=operation_uuid,
            action=action,
            actor_identity=actor_identity,
            company_id=account.company_id.id,
            audit_event_uuid=event.public_id,
            result=result_with_receipt,
        )
        return result_with_receipt

    @api.model
    @operation_race_retry(0)
    def kemfai_create_account(self, operation_uuid, actor_identity, values):
        replay = self._kemfai_receipt(operation_uuid)
        if replay:
            return replay
        create_values = dict(values)
        company_id = create_values.pop("company_id", None)
        company = self._kemfai_validate_company_scope(company_id)
        forbidden = set(create_values) - MUTABLE_ACCOUNT_FIELDS - {"kemfai_node_kind"}
        if forbidden:
            raise ValidationError("ACCOUNT_FIELDS_FORBIDDEN")
        create_values["company_id"] = company.id
        if "kemfai_parent_id" in create_values:
            create_values["kemfai_parent_id"] = self._kemfai_parent_database_id(
                create_values["kemfai_parent_id"], company.id
            )
        create_values.setdefault("name", create_values.get("name_en"))
        account = self.create(create_values)
        return self._kemfai_finish_mutation(
            operation_uuid,
            "account.create",
            actor_identity,
            account,
            None,
        )

    @api.model
    def kemfai_list_accounts(self, company_id, filters=None):
        company = self._kemfai_validate_company_scope(company_id)
        filters = dict(filters or {})
        allowed_filters = {"cursor", "limit", "active", "nodeKind", "search"}
        if set(filters) - allowed_filters:
            raise ValidationError("ACCOUNT_FILTER_INVALID")
        limit = filters.get("limit", 50)
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 200:
            raise ValidationError("ACCOUNT_LIMIT_INVALID")

        domain = [("company_id", "=", company.id)]
        cursor = filters.get("cursor")
        if cursor:
            cursor_account = self.with_context(active_test=False).search(
                [
                    ("kemfai_public_id", "=", cursor),
                    ("company_id", "=", company.id),
                ],
                limit=1,
            )
            if not cursor_account:
                raise ValidationError("ACCOUNT_CURSOR_INVALID")
            domain.append(("id", ">", cursor_account.id))
        if "active" in filters and filters["active"] is not None:
            if not isinstance(filters["active"], bool):
                raise ValidationError("ACCOUNT_ACTIVE_FILTER_INVALID")
            domain.append(("active", "=", filters["active"]))
        node_kind = filters.get("nodeKind")
        if node_kind is not None:
            if node_kind not in {"parent", "posting"}:
                raise ValidationError("ACCOUNT_NODE_KIND_FILTER_INVALID")
            domain.append(("kemfai_node_kind", "=", node_kind))
        search = filters.get("search")
        if search is not None:
            if not isinstance(search, str) or not search or len(search) > 100:
                raise ValidationError("ACCOUNT_SEARCH_INVALID")
            domain.extend(
                [
                    "|",
                    "|",
                    ("code", "ilike", search),
                    ("name_en", "ilike", search),
                    ("name_ar", "ilike", search),
                ]
            )

        accounts = self.with_context(active_test=False).search(
            domain,
            order="id asc",
            limit=limit + 1,
        )
        has_more = len(accounts) > limit
        page = accounts[:limit]
        return {
            "items": [self._kemfai_account_result(account) for account in page],
            "next_cursor": page[-1].kemfai_public_id if has_more and page else None,
        }

    @api.model
    def kemfai_read_account(self, public_id, company_id):
        company = self._kemfai_validate_company_scope(company_id)
        account = self.with_context(active_test=False).search(
            [
                ("kemfai_public_id", "=", public_id),
                ("company_id", "=", company.id),
            ],
            limit=1,
        )
        if not account:
            raise ValidationError("ACCOUNT_NOT_FOUND")
        return self._kemfai_account_result(account)

    @api.model
    @operation_race_retry(1)
    def kemfai_update_account(
        self,
        public_id,
        operation_uuid,
        actor_identity,
        expected_version,
        changes,
        company_id=None,
    ):
        replay = self._kemfai_receipt(operation_uuid)
        if replay:
            return replay
        forbidden = set(changes) - MUTABLE_ACCOUNT_FIELDS
        if forbidden:
            raise ValidationError("ACCOUNT_FIELDS_FORBIDDEN")
        account = self._kemfai_account_for_update(public_id, company_id)
        selected_company_id = company_id or account.company_id.id
        self._kemfai_validate_company_scope(selected_company_id)
        if account.version != expected_version:
            raise ValidationError("STALE_VERSION")
        before = self._kemfai_account_result(account)
        write_values = dict(changes)
        if "kemfai_parent_id" in write_values:
            write_values["kemfai_parent_id"] = self._kemfai_parent_database_id(
                write_values["kemfai_parent_id"], account.company_id.id
            )
        account.write(dict(write_values, version=account.version + 1))
        return self._kemfai_finish_mutation(
            operation_uuid,
            "account.update",
            actor_identity,
            account,
            before,
        )

    @api.model
    @operation_race_retry(1)
    def kemfai_deactivate_account(
        self,
        public_id,
        operation_uuid,
        actor_identity,
        expected_version,
        company_id=None,
    ):
        replay = self._kemfai_receipt(operation_uuid)
        if replay:
            return replay
        account = self._kemfai_account_for_update(public_id, company_id)
        selected_company_id = company_id or account.company_id.id
        self._kemfai_validate_company_scope(selected_company_id)
        if account.version != expected_version:
            raise ValidationError("STALE_VERSION")
        before = self._kemfai_account_result(account)
        account.write({"active": False, "version": account.version + 1})
        return self._kemfai_finish_mutation(
            operation_uuid,
            "account.deactivate",
            actor_identity,
            account,
            before,
        )

    def unlink(self):
        if self.env.context.get("module_uninstall"):
            return super().unlink()
        if self.filtered("kemfai_public_id"):
            raise ValidationError("HISTORY_PROTECTED_USE_DEACTIVATE")
        return super().unlink()
