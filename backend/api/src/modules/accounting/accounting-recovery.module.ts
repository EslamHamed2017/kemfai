import { hostname } from 'node:os';
import { Module, Injectable } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QueuesModule } from '../../common/queues/queues.module';
import {
  ACCOUNTING_RECOVERY_JOB_NAME,
  QUEUE_ACCOUNTING_MUTATION_RECOVERY,
} from '../../common/queues/queue-names';
import { OdooRpcModule } from '../../integrations/odoo-rpc/odoo-rpc.module';
import { OdooRpcService } from '../../integrations/odoo-rpc/odoo-rpc.service';
import { provisioningCredentials } from '../../integrations/provisioning/credentials';
import { AuditModule } from '../audit/audit.module';
import { AccountingMutationHandoffService } from './accounting-mutation-handoff.service';
import { AccountingMutationRecoveryService } from './accounting-mutation-recovery.service';
import { AccountingPlatformAuditService } from './accounting-platform-audit.service';

@Injectable()
export class AccountingRecoveryOdooAdapter {
  constructor(private readonly odoo: OdooRpcService) {}

  async executeKw(
    context: { db: string; companyId: number },
    model: string,
    method: string,
    args: unknown[],
    kwargs: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { login, password } = provisioningCredentials();
    const uid = await this.odoo.authenticate(context.db, login, password);
    const suppliedContext =
      kwargs.context && typeof kwargs.context === 'object' && !Array.isArray(kwargs.context)
        ? (kwargs.context as Record<string, unknown>)
        : {};
    const result = await this.odoo.executeKw(context.db, uid, password, model, method, args, {
      ...kwargs,
      context: {
        ...suppliedContext,
        allowed_company_ids: [context.companyId],
        force_company: context.companyId,
      },
    });
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error('Accounting recovery RPC returned an invalid result');
    }
    return result as Record<string, unknown>;
  }
}

@Processor(QUEUE_ACCOUNTING_MUTATION_RECOVERY, {
  autorun:
    process.env.NODE_ENV !== 'test' &&
    process.env.KEMFAI_DISABLE_ACCOUNTING_RECOVERY_WORKER !== '1',
})
export class AccountingMutationRecoveryProcessor extends WorkerHost {
  constructor(private readonly recovery: AccountingMutationRecoveryService) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name !== ACCOUNTING_RECOVERY_JOB_NAME) return;
    await this.recovery.recoverOnce();
  }
}

@Module({
  imports: [QueuesModule, OdooRpcModule, AuditModule],
  providers: [
    AccountingMutationHandoffService,
    AccountingPlatformAuditService,
    AccountingRecoveryOdooAdapter,
    {
      provide: AccountingMutationRecoveryService,
      inject: [
        AccountingMutationHandoffService,
        AccountingRecoveryOdooAdapter,
        AccountingPlatformAuditService,
      ],
      useFactory: (
        handoffs: AccountingMutationHandoffService,
        odoo: AccountingRecoveryOdooAdapter,
        audit: AccountingPlatformAuditService,
      ) =>
        new AccountingMutationRecoveryService(handoffs, odoo, audit, {
          workerId: `accounting-recovery-${hostname()}-${process.pid}`,
          batchSize: 25,
          leaseMs: 30_000,
          maxBackoffMs: 60_000,
        }),
    },
    AccountingMutationRecoveryProcessor,
  ],
  exports: [AccountingMutationRecoveryService],
})
export class AccountingRecoveryModule {}
