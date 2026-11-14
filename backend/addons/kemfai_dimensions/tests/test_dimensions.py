import re
import uuid

from odoo.exceptions import ValidationError
from odoo.tests import tagged
from odoo.tests.common import HttpCase


UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)


@tagged("post_install", "-at_install", "kemfai_dimensions", "story_2")
class TestKemfaiDimensions(HttpCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.Definition = cls.env["kemfai.dimension.definition"]
        cls.Value = cls.env["kemfai.dimension.value"]
        cls.company_a = cls.env.company
        cls.company_b = cls.env["res.company"].create(
            {"name": "KEMFAI T072 Company B"}
        )

    def _definition(
        self,
        company,
        key,
        *,
        kind="custom",
        active=True,
    ):
        return self.Definition.create(
            {
                "company_id": company.id,
                "key": key,
                "kind": kind,
                "name_en": key.replace("_", " ").title(),
                "name_ar": f"بُعد {key}",
                "active": active,
            }
        )

    def _value(self, definition, code, *, company=None, active=True):
        company = company or definition.company_id
        return self.Value.create(
            {
                "company_id": company.id,
                "definition_id": definition.id,
                "code": code,
                "name_en": f"Value {code}",
                "name_ar": f"قيمة {code}",
                "active": active,
            }
        )

    def test_definition_has_immutable_uuid_and_explicit_company_owner(self):
        definition = self._definition(self.company_a, "project_t072")
        self.assertRegex(definition.public_id, UUID_PATTERN)
        self.assertEqual(definition.company_id, self.company_a)
        with self.assertRaises(ValidationError):
            definition.write({"public_id": str(uuid.uuid4())})
        with self.assertRaises(ValidationError):
            definition.write({"company_id": self.company_b.id})

    def test_definition_kind_is_exact_and_builtin_identity_is_immutable(self):
        selection = dict(self.Definition._fields["kind"].selection)
        self.assertEqual({"built_in", "custom", "tag"}, set(selection))
        definition = self._definition(
            self.company_a, "department_t072", kind="built_in"
        )
        with self.assertRaises(ValidationError):
            definition.write({"key": "renamed_department_t072"})
        with self.assertRaises(ValidationError):
            definition.write({"kind": "custom"})

    def test_definition_key_is_unique_per_company_and_reusable_elsewhere(self):
        first = self._definition(self.company_a, "cost_center_t072")
        with self.assertRaises(ValidationError):
            self._definition(self.company_a, "cost_center_t072")
        other_company = self._definition(self.company_b, "cost_center_t072")
        self.assertEqual(first.key, other_company.key)
        self.assertNotEqual(first.company_id, other_company.company_id)

    def test_value_is_owned_by_definition_company_and_rejects_cross_company_link(self):
        definition_a = self._definition(self.company_a, "branch_t072")
        value = self._value(definition_a, "CAI")
        self.assertRegex(value.public_id, UUID_PATTERN)
        self.assertEqual(value.company_id, self.company_a)
        self.assertEqual(value.definition_id, definition_a)
        with self.assertRaises(ValidationError):
            self._value(definition_a, "FOREIGN", company=self.company_b)
        with self.assertRaises(ValidationError):
            value.write({"company_id": self.company_b.id})

    def test_value_code_is_unique_in_definition_but_reusable_in_other_scope(self):
        project_a = self._definition(self.company_a, "project_code_t072")
        branch_a = self._definition(self.company_a, "branch_code_t072")
        project_b = self._definition(self.company_b, "project_code_t072")
        self._value(project_a, "001")
        with self.assertRaises(ValidationError):
            self._value(project_a, "001")
        self.assertTrue(self._value(branch_a, "001"))
        self.assertTrue(self._value(project_b, "001"))

    def test_deactivation_excludes_new_selection_but_preserves_history(self):
        definition = self._definition(self.company_a, "salesperson_t072")
        value = self._value(definition, "SP-01")
        definition.write({"active": False})
        value.write({"active": False})

        self.assertFalse(self.Definition.search([("id", "=", definition.id)]))
        self.assertFalse(self.Value.search([("id", "=", value.id)]))
        historical_definition = self.Definition.with_context(active_test=False).search(
            [("id", "=", definition.id)]
        )
        historical_value = self.Value.with_context(active_test=False).search(
            [("id", "=", value.id)]
        )
        self.assertEqual(historical_definition, definition)
        self.assertEqual(historical_value, value)
        self.assertFalse(historical_definition.active)
        self.assertFalse(historical_value.active)

    def test_definitions_and_values_are_deactivated_never_deleted(self):
        definition = self._definition(self.company_a, "entity_t072")
        value = self._value(definition, "ENTITY-01")
        with self.assertRaisesRegex(ValidationError, "HISTORY_PROTECTED"):
            value.unlink()
        with self.assertRaisesRegex(ValidationError, "HISTORY_PROTECTED"):
            definition.unlink()
        self.assertTrue(
            self.Value.with_context(active_test=False).search(
                [("id", "=", value.id)]
            )
        )
        self.assertTrue(
            self.Definition.with_context(active_test=False).search(
                [("id", "=", definition.id)]
            )
        )
