import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import controlDataSource from '../../database/data-source';
import { Tenant } from '../../modules/tenants/entities/tenant.entity';
import {
  Subscription,
  SubscriptionStatus,
} from '../../modules/billing-customer/entities/subscription.entity';
import { AuditEvent } from '../../modules/audit/entities/audit-event.entity';
import { AuditService } from '../../modules/audit/audit.service';
import { EntitlementsService } from '../../modules/entitlements/entitlements.service';
import { QUEUE_TRIAL_EXPIRY_SWEEP } from '../../common/queues/queue-names';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const TRIAL_RESTRICTED_ACTION = 'tenant.trial.restricted';

/**
 * T102: observability/notification-only sweep mirroring the intended
 * `support_access.expiry_sweep` (T090) shape. It NEVER gates access itself — live denial is
 * always `TrialWindowGuard`'s (T101) job — so unlike a state-flipping sweep it has no
 * persisted per-tenant status to mutate. data-model.md is explicit that no "restricted"
 * column is introduced on Tenant; idempotency ("does not double-audit", mirrors T086) is
 * therefore derived directly from the append-only audit_event log: a
 * `tenant.trial.restricted` row already existing for a tenant IS the "already handled"
 * marker. This also gives the self-heal guarantee in contracts/events.md for free — if a
 * tick's audit write fails, no state was mutated beforehand, so the tenant is simply
 * reconsidered (and retried) on the next tick.
 */
@Processor(QUEUE_TRIAL_EXPIRY_SWEEP)
export class TrialExpirySweepProcessor extends WorkerHost {
  constructor(
    private readonly auditService: AuditService,
    private readonly entitlements: EntitlementsService,
  ) {
    super();
  }

  // The BullMQ job carries no per-tenant payload (events.md: "N/A (sweep, not per-entity)")
  // — every tick performs the same full scan, so `job` itself is unused.
  async process(job: Job): Promise<void> {
    void job;
    const tenantRepo = controlDataSource.getRepository(Tenant);
    const subscriptionRepo = controlDataSource.getRepository(Subscription);
    const auditRepo = controlDataSource.getRepository(AuditEvent);

    const tenants = await tenantRepo
      .createQueryBuilder('tenant')
      .where('tenant.ready_at IS NOT NULL')
      .getMany();

    for (const tenant of tenants) {
      // eslint-disable-next-line no-await-in-loop
      await this.sweepOne(tenant, subscriptionRepo, auditRepo);
    }
  }

  private async sweepOne(
    tenant: Tenant,
    subscriptionRepo: ReturnType<typeof controlDataSource.getRepository<Subscription>>,
    auditRepo: ReturnType<typeof controlDataSource.getRepository<AuditEvent>>,
  ): Promise<void> {
    const subscription = await subscriptionRepo.findOne({ where: { tenantId: tenant.id } });
    // No Subscription row yet (provisioning not finished) or already Active — nothing to
    // restrict, same pass-through condition TrialWindowGuard applies live.
    if (!subscription || subscription.status === SubscriptionStatus.ACTIVE || !tenant.readyAt) {
      return;
    }

    const entitlementSet = await this.entitlements.getEntitlementSet(subscription.planId);
    if (!entitlementSet.autoRestrictUnpaid) {
      return;
    }

    const elapsedMs = Date.now() - tenant.readyAt.getTime();
    const windowMs = entitlementSet.trialWindowDays * MS_PER_DAY;
    if (elapsedMs <= windowMs) {
      return;
    }

    const alreadyRestricted = await auditRepo.exists({
      where: { tenantId: tenant.id, action: TRIAL_RESTRICTED_ACTION },
    });
    if (alreadyRestricted) {
      return;
    }

    await this.auditService.recordTenantTrialRestricted({
      tenantId: tenant.id,
      trialWindowDays: entitlementSet.trialWindowDays,
      elapsedDays: Math.floor(elapsedMs / MS_PER_DAY),
      autoRestrictUnpaid: entitlementSet.autoRestrictUnpaid,
    });
  }
}
