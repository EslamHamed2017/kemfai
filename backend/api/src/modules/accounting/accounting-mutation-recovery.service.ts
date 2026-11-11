import { Injectable } from '@nestjs/common';
import { deterministicAccountingFaultCode } from './accounting-odoo-fault';
import { AccountingMutationHandoff } from './entities/accounting-mutation-handoff.entity';

type RecoverableHandoff = AccountingMutationHandoff & {
  requestPayload?: Record<string, unknown>;
};

type RecoveryHandoffStore = {
  claimBatchForRecovery(
    owner: string,
    durationMs: number,
    size: number,
  ): Promise<RecoverableHandoff[]>;
  markOdooCommitted(id: string, response: unknown): Promise<void>;
  markRejected(id: string, errorCode: string): Promise<void>;
  markAudited(id: string): Promise<void>;
  scheduleRetryBackoff(id: string, delayMs: number): Promise<void>;
};

type RecoveryOdooClient = {
  executeKw(
    context: { db: string; companyId: number },
    model: string,
    method: string,
    args: unknown[],
    kwargs: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
};

type RecoveryAuditMirror = {
  recordAccountingMutation(
    input: RecoverableHandoff & {
      operationUuid: string;
      result: Record<string, unknown>;
      finalResponse: Record<string, unknown>;
    },
  ): Promise<unknown>;
};

export type AccountingRecoveryOptions = {
  workerId: string;
  batchSize: number;
  leaseMs: number;
  maxBackoffMs: number;
};

@Injectable()
export class AccountingMutationRecoveryService {
  constructor(
    private readonly handoffs: RecoveryHandoffStore,
    private readonly odoo: RecoveryOdooClient,
    private readonly audit: RecoveryAuditMirror,
    private readonly options: AccountingRecoveryOptions,
  ) {}

  async recoverOnce(): Promise<{ recovered: number; retryable: number }> {
    const claimed = await this.handoffs.claimBatchForRecovery(
      this.options.workerId,
      this.options.leaseMs,
      this.options.batchSize,
    );
    let recovered = 0;
    let retryable = 0;
    for (const handoff of claimed) {
      try {
        await this.recover(handoff);
        recovered += 1;
      } catch (error) {
        const deterministicCode = deterministicAccountingFaultCode(error);
        if (deterministicCode) {
          await this.handoffs.markRejected(handoff.id, deterministicCode);
          continue;
        }
        retryable += 1;
        await this.handoffs.scheduleRetryBackoff(handoff.id, this.backoff(handoff.retryCount));
      }
    }
    return { recovered, retryable };
  }

  private async recover(handoff: RecoverableHandoff): Promise<void> {
    let result = handoff.finalResponse;
    if (handoff.state === 'pending') {
      const target = this.targetFor(handoff);
      result = await this.odoo.executeKw(
        { db: handoff.odooDbName, companyId: handoff.odooCompanyId },
        target.model,
        target.method,
        target.args,
        {
          context: {
            allowed_company_ids: [handoff.odooCompanyId],
            force_company: handoff.odooCompanyId,
          },
        },
      );
      await this.handoffs.markOdooCommitted(handoff.id, result);
    }
    if (handoff.state === 'audited') return;
    if (!result) throw new Error('Committed accounting recovery row has no final response');
    await this.audit.recordAccountingMutation({
      ...handoff,
      operationUuid: handoff.id,
      result,
      finalResponse: result,
    });
    await this.handoffs.markAudited(handoff.id);
  }

  private targetFor(handoff: RecoverableHandoff): {
    model: string;
    method: string;
    args: unknown[];
  } {
    const payload = handoff.requestPayload ?? handoff.requestPayloadRedacted;
    if (handoff.action === 'account.create') {
      return {
        model: 'account.account',
        method: 'kemfai_create_account',
        args: [handoff.id, payload.actor_identity ?? handoff.principalIdentity, payload.values],
      };
    }
    if (handoff.action === 'account.update') {
      return {
        model: 'account.account',
        method: 'kemfai_update_account',
        args: [
          payload.account_id,
          handoff.id,
          payload.actor_identity ?? handoff.principalIdentity,
          payload.expected_version,
          payload.values,
          handoff.odooCompanyId,
        ],
      };
    }
    if (handoff.action === 'account.deactivate') {
      return {
        model: 'account.account',
        method: 'kemfai_deactivate_account',
        args: [
          payload.account_id,
          handoff.id,
          payload.actor_identity ?? handoff.principalIdentity,
          payload.expected_version,
          handoff.odooCompanyId,
        ],
      };
    }
    const dimensionMatch = /^dimension\.(definition|value|rule)\.(create|update)$/.exec(
      handoff.action,
    );
    if (dimensionMatch) {
      const [, kind, operation] = dimensionMatch;
      const suffix = kind === 'definition' ? 'definition' : kind;
      return {
        model: `kemfai.dimension.${kind}`,
        method: `kemfai_${operation}_dimension_${suffix}`,
        args:
          operation === 'create'
            ? [handoff.id, payload.actor_identity ?? handoff.principalIdentity, payload.values]
            : [
                payload.resource_id,
                handoff.id,
                payload.actor_identity ?? handoff.principalIdentity,
                payload.expected_version,
                payload.values,
                handoff.odooCompanyId,
              ],
      };
    }
    if (handoff.action === 'journal.create') {
      return {
        model: 'account.journal',
        method: 'kemfai_create_journal',
        args: [handoff.id, payload.actor_identity ?? handoff.principalIdentity, payload.values],
      };
    }
    if (handoff.action === 'journal.update') {
      return {
        model: 'account.journal',
        method: 'kemfai_update_journal',
        args: [
          payload.journal_id,
          handoff.id,
          payload.actor_identity ?? handoff.principalIdentity,
          payload.expected_version,
          payload.values,
          handoff.odooCompanyId,
        ],
      };
    }
    if (handoff.action === 'currency.put') {
      return {
        model: 'kemfai.account.currency.config',
        method: 'kemfai_put_currency_configuration',
        args: [
          handoff.odooCompanyId,
          payload.currency_code,
          handoff.id,
          payload.actor_identity ?? handoff.principalIdentity,
          payload.if_match,
          payload.values,
        ],
      };
    }
    if (handoff.action === 'draft.save') {
      return {
        model: 'kemfai.account.draft',
        method: 'kemfai_save_minimal_draft',
        args: [
          handoff.id,
          payload.actor_identity ?? handoff.principalIdentity,
          handoff.odooCompanyId,
          payload.values,
        ],
      };
    }
    if (handoff.action === 'draft.update') {
      return {
        model: 'kemfai.account.draft',
        method: 'kemfai_update_minimal_draft',
        args: [
          handoff.id,
          payload.actor_identity ?? handoff.principalIdentity,
          payload.draft_id,
          payload.expected_version,
          handoff.odooCompanyId,
          payload.values,
        ],
      };
    }
    if (handoff.action === 'draft.validate') {
      return {
        model: 'kemfai.account.draft',
        method: 'kemfai_validate_minimal_draft',
        args: [
          handoff.id,
          payload.actor_identity ?? handoff.principalIdentity,
          payload.draft_id,
          payload.expected_version,
          handoff.odooCompanyId,
        ],
      };
    }
    throw new Error(`Unsupported accounting recovery action: ${handoff.action}`);
  }

  private backoff(retryCount: number): number {
    const exponent = Math.max(0, Math.min(retryCount, 16));
    return Math.min(this.options.maxBackoffMs, 1_000 * 2 ** exponent);
  }
}
