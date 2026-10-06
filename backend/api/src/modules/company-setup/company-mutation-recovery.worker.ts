import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { OdooRpcService } from '../../integrations/odoo-rpc/odoo-rpc.service';
import { AuditService } from '../audit/audit.service';
import { CompanyOdooContextService } from './company-odoo-context.service';
import {
  CompanyMutationHandoffRow,
  CompanyMutationHandoffService,
} from './company-mutation-handoff.service';
import {
  CompanyMutationAction,
  CompanyMutationHandoffState,
} from './entities/company-mutation-handoff.entity';

const POLL_INTERVAL_MS = Number(process.env.KEMFAI_MUTATION_RECOVERY_POLL_MS ?? 5_000);
const LEASE_DURATION_MS = Number(process.env.KEMFAI_MUTATION_RECOVERY_LEASE_MS ?? 30_000);
const BATCH_SIZE = Number(process.env.KEMFAI_MUTATION_RECOVERY_BATCH_SIZE ?? 10);
const BACKOFF_MS = Number(process.env.KEMFAI_MUTATION_RECOVERY_BACKOFF_MS ?? 15_000);

/**
 * T055 arbiter binding resolution, point 4 — an application-booted worker, registered as
 * an ordinary provider in `CompanySetupModule` (so it lives in the real production
 * module graph — `AppModule` imports `CompanySetupModule` — never an isolated test-only
 * module missing the decorators that actually start it), that continuously claims
 * pending/stale `company_mutation_handoff` rows and finishes them WITHOUT any further
 * client request:
 *
 * - if the handoff never reached Odoo at all (`pending` — e.g. the process crashed
 *   between committing the handoff and issuing the RPC), it replays the SAME Odoo RPC
 *   with the SAME operation UUID and the handoff's own stored `requestPayload`;
 * - if Odoo already committed (`odoo_committed` — the RPC succeeded but the audit
 *   append never ran: lost response, crash, or an audit-store outage), it skips
 *   straight to appending the audit event from the handoff's persisted actor/time;
 * - either way, the audit event's actor/occurrence-time/source/payload all come from the
 *   immutable handoff row, never from this worker's own identity or the time it happens
 *   to run.
 *
 * Bounded, lease-based concurrent claiming (`claimBatchForRecovery`'s
 * `FOR UPDATE SKIP LOCKED` + lease expiry — safe with multiple API replicas each running
 * this worker) and bounded backoff on failure (`scheduleRetryBackoff`) — never an
 * unbounded hot loop against a dependency that is still down. `onModuleDestroy` clears
 * the interval for a clean shutdown.
 */
@Injectable()
export class CompanyMutationRecoveryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CompanyMutationRecoveryWorker.name);
  private readonly workerId = `recovery-${randomUUID()}`;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;

  constructor(
    private readonly handoffs: CompanyMutationHandoffService,
    private readonly context: CompanyOdooContextService,
    private readonly odoo: OdooRpcService,
    private readonly auditService: AuditService,
  ) {}

  onModuleInit(): void {
    // Escape hatch for unit/contract test module graphs that boot CompanySetupModule
    // without a real control-plane DB behind it — never set in a real deployment.
    if (process.env.KEMFAI_DISABLE_MUTATION_RECOVERY_WORKER === '1') {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, POLL_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One claim-and-recover pass. Exposed (not just the interval) so tests can trigger
   * recovery deterministically instead of racing the poll interval. */
  async tick(): Promise<void> {
    if (this.ticking || this.stopped) {
      return;
    }
    this.ticking = true;
    try {
      const batch = await this.handoffs.claimBatchForRecovery(
        this.workerId,
        LEASE_DURATION_MS,
        BATCH_SIZE,
      );
      for (const handoff of batch) {
        await this.recoverOne(handoff);
      }
    } catch (error) {
      this.logger.error(`recovery tick failed: ${(error as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  private async recoverOne(handoff: CompanyMutationHandoffRow): Promise<void> {
    try {
      const { uid, password, db, companyId } = await this.context.resolveByTenantId(
        handoff.tenantId,
      );
      // B3: the handoff's stored `odooDbName`/`odooCompanyId` are the IMMUTABLE target
      // this operation UUID was created against. If the tenant's current provisioning
      // mapping has since changed (re-provisioning, migration, data repair), resolving
      // "the tenant's current Odoo database/company" can silently diverge from that
      // target. Replaying there would mutate the wrong database and audit a false
      // source. Never dispatch the RPC on a mismatch — fail this attempt with bounded
      // backoff instead, same as any other recovery failure.
      if (db !== handoff.odooDbName || companyId !== handoff.odooCompanyId) {
        this.logger.warn(
          `recovery skipped for handoff ${handoff.id} (${handoff.action}): resolved Odoo ` +
            `target no longer matches the handoff's stored target for tenant ${handoff.tenantId}`,
        );
        await this.handoffs.scheduleRetryBackoff(handoff.id, BACKOFF_MS);
        return;
      }
      let result: unknown = handoff.finalResponse;
      if (handoff.state === CompanyMutationHandoffState.PENDING) {
        result = await this.replayOdoo(handoff, db, uid, password);
        await this.handoffs.markOdooCommitted(handoff.id, result);
      }
      await this.appendAudit(handoff, result);
      await this.handoffs.markAudited(handoff.id);
    } catch (error) {
      this.logger.warn(
        `recovery attempt failed for handoff ${handoff.id} (${handoff.action}): ` +
          `${(error as Error).message}`,
      );
      await this.handoffs.scheduleRetryBackoff(handoff.id, BACKOFF_MS);
    }
  }

  private async replayOdoo(
    handoff: CompanyMutationHandoffRow,
    db: string,
    uid: number,
    password: string,
  ): Promise<unknown> {
    if (handoff.action === CompanyMutationAction.SETUP_COMPLETE) {
      return this.odoo.executeKw(db, uid, password, 'res.company', 'kemfai_setup_complete', [
        [handoff.odooCompanyId],
        handoff.id,
        handoff.occurredAt.toISOString(),
        handoff.actorAccountId,
      ]);
    }
    return this.odoo.executeKw(db, uid, password, 'res.company', 'kemfai_settings_update', [
      [handoff.odooCompanyId],
      handoff.requestPayload,
      handoff.id,
      handoff.occurredAt.toISOString(),
      handoff.actorAccountId,
    ]);
  }

  private async appendAudit(handoff: CompanyMutationHandoffRow, result: unknown): Promise<void> {
    if (handoff.action === CompanyMutationAction.SETUP_COMPLETE) {
      await this.auditService.recordCompanySetupCompleted({
        accountId: handoff.actorAccountId,
        tenantId: handoff.tenantId,
        companyId: handoff.tenantId,
        odooDbName: handoff.odooDbName,
        odooCompanyId: handoff.odooCompanyId,
        occurredAt: handoff.occurredAt,
        operationUuid: handoff.id,
      });
      return;
    }
    const settingsResult = result as { changedFields?: string[] } | null;
    await this.auditService.recordCompanySettingsUpdated({
      accountId: handoff.actorAccountId,
      tenantId: handoff.tenantId,
      companyId: handoff.tenantId,
      odooDbName: handoff.odooDbName,
      odooCompanyId: handoff.odooCompanyId,
      changedFields: settingsResult?.changedFields ?? [],
      occurredAt: handoff.occurredAt,
      operationUuid: handoff.id,
    });
  }
}
