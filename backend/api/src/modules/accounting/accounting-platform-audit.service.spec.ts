import { AuditService } from '../audit/audit.service';
import { AuditActorType } from '../audit/entities/audit-event.entity';
import { AccountingPlatformAuditService } from './accounting-platform-audit.service';
import {
  AccountingMutationHandoff,
  AccountingMutationHandoffState,
} from './entities/accounting-mutation-handoff.entity';

const OPERATION = '35353535-1111-4111-8111-111111111111';
const TENANT = '35353535-2222-4222-8222-222222222222';
const COMPANY = '35353535-3333-4333-8333-333333333333';
const ACTOR = '35353535-4444-4444-8444-444444444444';
const RESOURCE = '35353535-5555-4555-8555-555555555555';

function committed(): AccountingMutationHandoff {
  return Object.assign(new AccountingMutationHandoff(), {
    id: OPERATION,
    tenantId: TENANT,
    companyUuid: COMPANY,
    actorAccountId: ACTOR,
    action: 'account.created',
    state: AccountingMutationHandoffState.ODOO_COMMITTED,
    finalResponse: { resource: { id: RESOURCE, version: 1 } },
    createdAt: new Date('2026-11-02T08:00:00Z'),
    odooCommittedAt: new Date('2026-11-02T08:00:01Z'),
  });
}

describe('AccountingPlatformAuditService', () => {
  const append = jest.fn<Promise<void>, [unknown]>();
  let service: AccountingPlatformAuditService;

  beforeEach(() => {
    append.mockReset().mockResolvedValue(undefined);
    service = new AccountingPlatformAuditService({ append } as unknown as AuditService);
  });

  it('dedupes by operation UUID, links public scope, then releases the durable response', async () => {
    await expect(service.recordAccountingMutation(committed())).resolves.toEqual({
      resource: { id: RESOURCE, version: 1 },
    });
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: AuditActorType.ACCOUNT,
        actorId: ACTOR,
        tenantId: TENANT,
        subjectId: RESOURCE,
        dedupeKey: `accounting.mutation:${OPERATION}`,
        payload: {
          operation_uuid: OPERATION,
          company_uuid: COMPANY,
          state: 'odoo_committed',
        },
      }),
    );
  });

  it('withholds success and leaves the handoff committed when the mirror append fails', async () => {
    append.mockRejectedValueOnce(new Error('control audit unavailable'));
    await expect(service.recordAccountingMutation(committed())).rejects.toThrow(
      'control audit unavailable',
    );
  });

  it('uses the same dedupe anchor for recovery retries', async () => {
    await service.recordAccountingMutation(committed());
    await service.recordAccountingMutation(committed());
    expect(append.mock.calls.map(([event]) => (event as { dedupeKey: string }).dedupeKey)).toEqual([
      `accounting.mutation:${OPERATION}`,
      `accounting.mutation:${OPERATION}`,
    ]);
  });

  it('persists an opaque pre-domain denial without target tenant, Odoo, or DB details', async () => {
    await service.recordPreDomainDenial({
      operationUuid: OPERATION,
      tenantId: TENANT,
      companyUuid: COMPANY,
      actorAccountId: ACTOR,
      route: '/v1/accounting/accounts',
      reason: 'permission_denied',
    });
    const event = append.mock.calls[0][0] as Record<string, unknown>;
    expect(event).toMatchObject({
      action: 'accounting.access.denied',
      tenantId: TENANT,
      subjectId: COMPANY,
      dedupeKey: `accounting.denial:${OPERATION}`,
    });
    expect(JSON.stringify(event)).not.toMatch(/odoo|database|target_tenant/i);
  });
});
