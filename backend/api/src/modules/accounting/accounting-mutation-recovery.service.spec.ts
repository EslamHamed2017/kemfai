type HandoffRow = {
  id: string;
  state: 'pending' | 'odoo_committed' | 'audited';
  action: string;
  tenantId: string;
  actorAccountId: string;
  principalIdentity: string;
  odooDbName: string;
  odooCompanyId: number;
  requestPayload: Record<string, unknown>;
  finalResponse: unknown;
  retryCount: number;
};

type RecoveryResult = { recovered: number; retryable: number };
type RecoveryContract = { recoverOnce(): Promise<RecoveryResult> };

function row(overrides: Partial<HandoffRow> = {}): HandoffRow {
  return {
    id: '25252525-1111-4111-8111-111111111111',
    state: 'pending',
    action: 'account.create',
    tenantId: '25252525-2222-4222-8222-222222222222',
    actorAccountId: '25252525-3333-4333-8333-333333333333',
    principalIdentity: 'keycloak-t025-user',
    odooDbName: 'kemfai_t025_tenant_a',
    odooCompanyId: 101,
    requestPayload: { code: '1000', nameEn: 'Cash' },
    finalResponse: null,
    retryCount: 1,
    ...overrides,
  };
}

describe('AccountingMutationRecoveryService', () => {
  function makeService(
    options: {
      claimed?: HandoffRow[];
      executeKw?: jest.Mock;
      audit?: jest.Mock;
      claim?: jest.Mock;
    } = {},
  ) {
    const claimBatchForRecovery =
      options.claim ?? jest.fn().mockResolvedValue(options.claimed ?? [row()]);
    const markOdooCommitted = jest.fn().mockResolvedValue(undefined);
    const markRejected = jest.fn().mockResolvedValue(undefined);
    const markAudited = jest.fn().mockResolvedValue(undefined);
    const scheduleRetryBackoff = jest.fn().mockResolvedValue(undefined);
    const executeKw =
      options.executeKw ??
      jest.fn().mockResolvedValue({
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        version: 1,
      });
    const recordAccountingMutation = options.audit ?? jest.fn().mockResolvedValue(undefined);
    const handoffs = {
      claimBatchForRecovery,
      markOdooCommitted,
      markRejected,
      markAudited,
      scheduleRetryBackoff,
    };
    const odoo = { executeKw };
    const audit = { recordAccountingMutation };
    const implementationPath = './accounting-' + 'mutation-recovery.service';
    const implementation = jest.requireActual<Record<string, unknown>>(implementationPath);
    const Service = implementation.AccountingMutationRecoveryService as new (
      handoffService: typeof handoffs,
      odooService: typeof odoo,
      auditService: typeof audit,
      options: { workerId: string; batchSize: number; leaseMs: number; maxBackoffMs: number },
    ) => RecoveryContract;
    return {
      service: new Service(handoffs, odoo, audit, {
        workerId: 't025-worker',
        batchSize: 10,
        leaseMs: 5_000,
        maxBackoffMs: 60_000,
      }),
      claimBatchForRecovery,
      markOdooCommitted,
      markRejected,
      markAudited,
      scheduleRetryBackoff,
      executeKw,
      recordAccountingMutation,
    };
  }

  it('replays a pending lost-response handoff by operation UUID then audits exactly once', async () => {
    const harness = makeService();
    await expect(harness.service.recoverOnce()).resolves.toEqual({ recovered: 1, retryable: 0 });
    expect(harness.claimBatchForRecovery).toHaveBeenCalledWith('t025-worker', 5_000, 10);
    expect(harness.executeKw).toHaveBeenCalledWith(
      expect.objectContaining({ db: 'kemfai_t025_tenant_a', companyId: 101 }),
      'account.account',
      'kemfai_create_account',
      expect.arrayContaining(['25252525-1111-4111-8111-111111111111']),
      expect.any(Object),
    );
    expect(harness.markOdooCommitted).toHaveBeenCalledTimes(1);
    expect(harness.recordAccountingMutation).toHaveBeenCalledTimes(1);
    expect(harness.markAudited).toHaveBeenCalledTimes(1);
  });

  it('recovers an odoo_committed row from the stored response without replaying Odoo', async () => {
    const stored = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', version: 1 };
    const harness = makeService({
      claimed: [row({ state: 'odoo_committed', finalResponse: stored })],
    });
    await expect(harness.service.recoverOnce()).resolves.toEqual({ recovered: 1, retryable: 0 });
    expect(harness.executeKw).not.toHaveBeenCalled();
    expect(harness.recordAccountingMutation).toHaveBeenCalledWith(
      expect.objectContaining({ operationUuid: row().id, result: stored }),
    );
    expect(harness.markAudited).toHaveBeenCalledWith(row().id);
  });

  it('replays draft save and validation through the same guarded receipt-bearing RPC methods', async () => {
    const savePayload = {
      actor_identity: 'keycloak-t051-user',
      company_id: 101,
      values: { description: 'exact draft' },
    };
    const validatePayload = {
      actor_identity: 'keycloak-t051-user',
      company_id: 101,
      draft_id: '51515151-5555-4555-8555-555555555555',
      expected_version: 1,
    };
    const save = makeService({
      claimed: [row({ action: 'draft.save', requestPayload: savePayload })],
    });
    const validate = makeService({
      claimed: [
        row({
          id: '51515151-4444-4444-8444-444444444445',
          action: 'draft.validate',
          requestPayload: validatePayload,
        }),
      ],
    });

    await save.service.recoverOnce();
    await validate.service.recoverOnce();

    expect(save.executeKw).toHaveBeenCalledWith(
      expect.any(Object),
      'kemfai.account.draft',
      'kemfai_save_minimal_draft',
      [row().id, 'keycloak-t051-user', 101, savePayload.values],
      expect.any(Object),
    );
    expect(validate.executeKw).toHaveBeenCalledWith(
      expect.any(Object),
      'kemfai.account.draft',
      'kemfai_validate_minimal_draft',
      [
        '51515151-4444-4444-8444-444444444445',
        'keycloak-t051-user',
        validatePayload.draft_id,
        1,
        101,
      ],
      expect.any(Object),
    );
  });

  it('replays dimension mutations through their guarded receipt-bearing RPC methods', async () => {
    const payload = {
      actor_identity: 'keycloak-t092-user',
      resource_id: '92929292-5555-4555-8555-555555555555',
      expected_version: 3,
      values: { requirement: 'optional' },
    };
    const harness = makeService({
      claimed: [row({ action: 'dimension.rule.update', requestPayload: payload })],
    });

    await expect(harness.service.recoverOnce()).resolves.toEqual({ recovered: 1, retryable: 0 });
    expect(harness.executeKw).toHaveBeenCalledWith(
      expect.any(Object),
      'kemfai.dimension.rule',
      'kemfai_update_dimension_rule',
      [payload.resource_id, row().id, 'keycloak-t092-user', 3, payload.values, 101],
      expect.any(Object),
    );
  });

  it.each([
    {
      action: 'journal.create',
      payload: { actor_identity: 'keycloak-t123-user', values: { company_id: 101, code: 'GJ' } },
      model: 'account.journal',
      method: 'kemfai_create_journal',
      args: [row().id, 'keycloak-t123-user', { company_id: 101, code: 'GJ' }],
    },
    {
      action: 'journal.update',
      payload: {
        actor_identity: 'keycloak-t123-user',
        journal_id: '23232323-5555-4555-8555-555555555555',
        expected_version: 2,
        values: { active: false },
      },
      model: 'account.journal',
      method: 'kemfai_update_journal',
      args: [
        '23232323-5555-4555-8555-555555555555',
        row().id,
        'keycloak-t123-user',
        2,
        { active: false },
        101,
      ],
    },
    {
      action: 'currency.put',
      payload: {
        actor_identity: 'keycloak-t123-user',
        currency_code: 'AED',
        if_match: '*',
        values: { enabled: true },
      },
      model: 'kemfai.account.currency.config',
      method: 'kemfai_put_currency_configuration',
      args: [101, 'AED', row().id, 'keycloak-t123-user', '*', { enabled: true }],
    },
  ])(
    'replays $action through its receipt-bearing RPC method',
    async ({ action, payload, model, method, args }) => {
      const harness = makeService({ claimed: [row({ action, requestPayload: payload })] });

      await expect(harness.service.recoverOnce()).resolves.toEqual({ recovered: 1, retryable: 0 });
      expect(harness.executeKw).toHaveBeenCalledWith(
        expect.objectContaining({ db: 'kemfai_t025_tenant_a', companyId: 101 }),
        model,
        method,
        args,
        { context: { allowed_company_ids: [101], force_company: 101 } },
      );
      expect(harness.markOdooCommitted).toHaveBeenCalledWith(row().id, expect.any(Object));
      expect(harness.markAudited).toHaveBeenCalledWith(row().id);
    },
  );

  it('terminally rejects a deterministic fault discovered during recovery without backoff', async () => {
    const harness = makeService({
      executeKw: jest.fn().mockRejectedValue(new Error('DRAFT_LINES_INVALID')),
    });

    await expect(harness.service.recoverOnce()).resolves.toEqual({ recovered: 0, retryable: 0 });
    expect(harness.markRejected).toHaveBeenCalledWith(row().id, 'DRAFT_LINES_INVALID');
    expect(harness.scheduleRetryBackoff).not.toHaveBeenCalled();
  });

  it('mirror outage never returns recovery success and schedules bounded retry backoff', async () => {
    const harness = makeService({ audit: jest.fn().mockRejectedValue(new Error('audit down')) });
    await expect(harness.service.recoverOnce()).resolves.toEqual({ recovered: 0, retryable: 1 });
    expect(harness.markAudited).not.toHaveBeenCalled();
    expect(harness.scheduleRetryBackoff).toHaveBeenCalledWith(row().id, expect.any(Number));
    const delay = harness.scheduleRetryBackoff.mock.calls[0][1] as number;
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(60_000);
  });

  it('audited rows are never replayed, re-audited, or reported as recovered', async () => {
    const harness = makeService({ claimed: [] });
    await expect(harness.service.recoverOnce()).resolves.toEqual({ recovered: 0, retryable: 0 });
    expect(harness.executeKw).not.toHaveBeenCalled();
    expect(harness.recordAccountingMutation).not.toHaveBeenCalled();
    expect(harness.markAudited).not.toHaveBeenCalled();
  });

  it('two concurrent workers can recover one lease-owned handoff exactly once', async () => {
    let claimed = false;
    const claim = jest.fn().mockImplementation(async () => {
      if (claimed) return [];
      claimed = true;
      return [row()];
    });
    const executeKw = jest.fn().mockResolvedValue({ id: 'account-1', version: 1 });
    const audit = jest.fn().mockResolvedValue(undefined);
    const first = makeService({ claim, executeKw, audit });
    const second = makeService({ claim, executeKw, audit });
    const results = await Promise.all([first.service.recoverOnce(), second.service.recoverOnce()]);
    expect(results).toEqual(
      expect.arrayContaining([
        { recovered: 1, retryable: 0 },
        { recovered: 0, retryable: 0 },
      ]),
    );
    expect(executeKw).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(first.markAudited.mock.calls.length + second.markAudited.mock.calls.length).toBe(1);
  });
});
