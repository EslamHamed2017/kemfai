from odoo import fields, models


class KemfaiCompanyMutationReceipt(models.Model):
    """T055 arbiter binding resolution, point 2 — the feature-specific receipt that lives
    in the SAME Odoo transaction as the company mutation it records. `operation_uuid` is
    the control-plane `company_mutation_handoff.id` threaded through the RPC call; a
    repeated call with the same `operation_uuid` (see `ResCompany._kemfai_get_receipt`)
    returns this stored `result_json` verbatim instead of re-applying the mutation —
    including the original `changedFields` for a settings update, never recomputed from
    whatever the repeat call happens to submit.
    """

    _name = 'kemfai.company.mutation.receipt'
    _description = 'Durable idempotent receipt for a KEMFAI company mutation RPC'

    operation_uuid = fields.Char(required=True, index=True)
    company_id = fields.Many2one('res.company', required=True, ondelete='cascade')
    action = fields.Char(required=True)
    # Original control-plane actor/occurrence identity, passed in by the BFF alongside the
    # operation UUID (arbiter point 2) — kept here only for provenance/audit cross-checking;
    # the BFF's own handoff row remains the authoritative source the audit event is built from.
    actor_id = fields.Char()
    occurred_at = fields.Datetime()
    result_json = fields.Char(required=True)

    _sql_constraints = [
        (
            'operation_uuid_uniq',
            'unique(operation_uuid)',
            'A receipt already exists for this operation UUID.',
        ),
    ]
