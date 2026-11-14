import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { EntityManager, QueryRunner } from 'typeorm';
import { randomUUID } from 'crypto';
import controlDataSource from '../../database/data-source';
import { Account } from '../../modules/accounts/entities/account.entity';
import { Tenant, TenantStatus } from '../../modules/tenants/entities/tenant.entity';
import {
  Subscription,
  SubscriptionStatus,
  SubscriptionBillingCycle,
} from '../../modules/billing-customer/entities/subscription.entity';
import { AuditService } from '../../modules/audit/audit.service';
import { MinioStorageService } from '../minio/minio-storage.service';
import { OdooRpcService } from '../odoo-rpc/odoo-rpc.service';
import { QUEUE_TENANT_PROVISION } from '../../common/queues/queue-names';
import { initialPeriod } from './period';
import {
  KEYCLOAK_USER_PROVISIONER,
  KeycloakUserProvisioner,
} from '../keycloak/keycloak-user-provisioner';
import { Inject, Logger } from '@nestjs/common';
import { ProvisioningCredentials, provisioningCredentials } from './credentials';

/**
 * T056 point 4 — marks a failure that occurred strictly inside the narrow Ready/null
 * repair branch so the outer catch can recognize it and skip the ordinary
 * attempt-increment/Failed/readyAt-clearing transition entirely: Ready, the prior
 * readyAt, and a null `odooCompanyId` are already exactly as they were before this job
 * ran, and that is the correct retryable state — not a provisioning failure.
 */
class ReadyRepairFailedError extends Error {}

/** Dedicated session advisory lock serializes external operations across processes; the
 * Account row is FOR UPDATE across external operations in a separate transaction.
 * Attempt and success/failure transactions commit durably on the first session. */
// Jest drives process() explicitly; do not consume other integration suites' queued jobs.
@Processor(QUEUE_TENANT_PROVISION, { autorun: process.env.NODE_ENV !== 'test' })
export class TenantProvisionProcessor extends WorkerHost {
  private readonly credentials: ProvisioningCredentials;
  private readonly logger = new Logger(TenantProvisionProcessor.name);
  constructor(
    private readonly audit: AuditService,
    private readonly storage: MinioStorageService,
    private readonly odoo: OdooRpcService,
    @Inject(KEYCLOAK_USER_PROVISIONER) private readonly keycloak: KeycloakUserProvisioner,
  ) {
    super();
    this.credentials = provisioningCredentials();
  }

  async process(job: Job<{ accountId: string }>): Promise<void> {
    const accountId = job.data?.accountId;
    if (!accountId || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(accountId)) {
      throw new Error('Invalid account ID');
    }
    const runner = controlDataSource.createQueryRunner();
    await runner.connect();
    let tenantId: string | undefined;
    let ownerBindingAttempted = false;
    let accountLock: QueryRunner | undefined;
    try {
      await runner.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [accountId]);
      let account: Account | undefined;
      let tenant: Tenant | undefined;
      try {
        await this.transaction(runner, async (manager) => {
          account =
            (await manager
              .getRepository(Account)
              .createQueryBuilder('account')
              .setLock('pessimistic_write')
              .where('account.id = :id', { id: accountId })
              .getOne()) ?? undefined;
          if (!account?.emailVerified || !account.selectedPlanId || !account.selectedBillingCycle) {
            throw new Error('Verified account and selected plan/cycle required');
          }
          await manager
            .createQueryBuilder()
            .insert()
            .into(Tenant)
            .values({
              id: randomUUID(),
              accountId,
              status: TenantStatus.PENDING,
              provisioningAttempts: 0,
            })
            .orIgnore()
            .execute();
          tenant = (await manager.getRepository(Tenant).findOneBy({ accountId })) ?? undefined;
          if (!tenant || tenant.accountId !== accountId)
            throw new Error('Tenant ownership mismatch');
        });
        if (!tenant || !account) throw new Error('Tenant unavailable');
        tenantId = tenant.id;
        if (tenant.status === TenantStatus.READY) {
          await this.repairReadyOdooCompanyMapping(runner, tenant, account);
          return;
        }
        // Attempt state and audit commit together. An audit failure rolls this transaction back.
        await this.transaction(runner, async (manager) => {
          await this.lockAccount(manager, accountId);
          await manager.getRepository(Tenant).update(tenant!.id, {
            status: TenantStatus.CREATING,
            provisioningAttempts: tenant!.provisioningAttempts + 1,
            readyAt: null,
            failureReason: null,
          });
          await this.audit.recordTenantProvisioningAttempted(
            {
              tenantId: tenant!.id,
              attemptNumber: tenant!.provisioningAttempts + 1,
            },
            manager,
          );
        });
        // Keep the Account row FOR UPDATE while all external effects run. The
        // separate session allows the attempted audit to commit before I/O.
        accountLock = controlDataSource.createQueryRunner();
        await accountLock.connect();
        await accountLock.startTransaction();
        await this.lockAccount(accountLock.manager, accountId);
        const bucket = await this.storage.createTenantBucket(tenant.id);
        if (!(await this.storage.bucketExists(bucket)))
          throw new Error('Bucket verification failed');
        if (tenant.minioBucket && tenant.minioBucket !== bucket) throw new Error('Bucket mismatch');
        await this.transaction(runner, async (manager) => {
          await manager.getRepository(Tenant).update(tenant!.id, { minioBucket: bucket });
        });
        const db = `kemfai_tenant_${tenant.id.replace(/-/g, '')}`;
        if (tenant.odooDbName && tenant.odooDbName !== db) throw new Error('Database mismatch');
        await this.ensureDatabase(db);
        await this.installModules(db);
        const odooCompanyId = await this.verifyCompany(db);
        await this.transaction(runner, async (manager) => {
          const period = initialPeriod(new Date(), account!.selectedBillingCycle!);
          await manager
            .createQueryBuilder()
            .insert()
            .into(Subscription)
            .values({
              id: randomUUID(),
              tenantId: tenant!.id,
              planId: account!.selectedPlanId!,
              billingCycle: account!.selectedBillingCycle! as unknown as SubscriptionBillingCycle,
              status: SubscriptionStatus.PENDING_ACTIVATION,
              currentPeriodStart: period.start,
              currentPeriodEnd: period.end,
            })
            .orIgnore()
            .execute();
          const subscription = await manager
            .getRepository(Subscription)
            .findOneBy({ tenantId: tenant!.id });
          if (
            !subscription ||
            subscription.planId !== account!.selectedPlanId ||
            String(subscription.billingCycle) !== String(account!.selectedBillingCycle)
          )
            throw new Error('Subscription mismatch');
          // All external resources and the subscription have been validated. Bind
          // immediately before the final Ready + success-audit transaction commits.
          ownerBindingAttempted = true;
          await this.keycloak.assignWorkspaceOwner(account!.keycloakUserId, tenant!.id);
          await manager.getRepository(Tenant).update(tenant!.id, {
            odooDbName: db,
            odooCompanyId,
            status: TenantStatus.READY,
            readyAt: new Date(),
            failureReason: null,
          });
          await this.audit.recordTenantProvisioningSucceeded(
            { tenantId: tenant!.id, odooDbName: db },
            manager,
          );
        });
      } catch (_error) {
        if (_error instanceof ReadyRepairFailedError) {
          // Ready, the prior readyAt, and a null odooCompanyId are already exactly as
          // they were before this job ran (the repair branch never mutated them on
          // failure) — never run the ordinary attempt-increment/Failed transition here,
          // and never compensate a role bind that is itself idempotent and safe to retry.
          throw new Error('Tenant repair failed; retry required');
        }
        // Roll back the long-held row lock before writing the failure transition.
        if (accountLock?.isTransactionActive) await accountLock.rollbackTransaction();
        if (ownerBindingAttempted && tenantId && account) {
          try {
            await this.keycloak.revokeWorkspaceOwner(account.keycloakUserId, tenantId);
          } catch {
            // Never log the remote exception: it can contain credentials. The DB
            // failure transition is mandatory even when remote cleanup fails.
            this.logger.warn('Workspace owner compensation failed; retry required');
          }
        }
        if (tenantId) {
          await this.transaction(runner, async (manager) => {
            await this.lockAccount(manager, accountId);
            await manager.getRepository(Tenant).update(tenantId!, {
              status: TenantStatus.FAILED,
              readyAt: null,
              failureReason: 'Provisioning failed; retry or contact support',
            });
            await this.audit.recordTenantProvisioningFailed(
              {
                tenantId: tenantId!,
                failureReason: 'Provisioning failed; retry or contact support',
              },
              manager,
            );
          });
        }
        // Never pass through RPC/MinIO errors: they may contain credentials or payloads.
        throw new Error('Tenant provisioning failed');
      }
    } finally {
      if (accountLock) {
        try {
          if (accountLock.isTransactionActive) await accountLock.commitTransaction();
        } finally {
          await accountLock.release();
        }
      }
      try {
        await runner.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [accountId]);
      } finally {
        await runner.release();
      }
    }
  }

  private async transaction<T>(
    runner: QueryRunner,
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    await runner.startTransaction();
    try {
      const result = await work(runner.manager);
      await runner.commitTransaction();
      return result;
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    }
  }
  private async lockAccount(manager: EntityManager, id: string): Promise<void> {
    await manager
      .getRepository(Account)
      .createQueryBuilder('account')
      .setLock('pessimistic_write')
      .where('account.id = :id', { id })
      .getOneOrFail();
  }
  /**
   * T056 round-6/point 4 — a `Ready` tenant provisioned before the `odoo_company_id`
   * column existed has a valid row with that field left `NULL` by the migration (it only
   * adds the nullable column; it cannot safely guess a company id for data it has never
   * read). This is the ONLY exceptional Ready retry: `TenantsService.retry()` gates
   * entry so this is reached exclusively when `odooDbName` is non-null and
   * `odooCompanyId` is null (a mapped Ready tenant, or one with no database at all, is a
   * 409 the caller never reaches here).
   *
   * Order matters: resolve the company, then bind WorkspaceOwner (already idempotent —
   * safe to repeat on every retry), and persist `odooCompanyId` LAST. If binding failed
   * before the mapping was persisted, the branch condition (`odooCompanyId === null`)
   * still matches on the next retry, so the role bind is retried too. Persisting the
   * mapping FIRST would let a subsequent role-bind failure strand a "mapped but not
   * owned" tenant that no retry could ever reach again.
   *
   * Every failure here (zero/multiple companies, an Odoo RPC error, a subscription
   * mismatch, a role-binding error, or a persistence error) is caught locally and
   * re-thrown as `ReadyRepairFailedError`: Ready, the prior `readyAt`, and a null mapping
   * are left completely untouched — no bucket/database/subscription creation, no module
   * install, no `provisioningAttempts` increment, no ordinary audit transition, and no
   * Failed status — so the tenant remains retryable through this exact same path.
   */
  private async repairReadyOdooCompanyMapping(
    runner: QueryRunner,
    tenant: Tenant,
    account: Account,
  ): Promise<void> {
    if (tenant.odooCompanyId !== null || !tenant.odooDbName) return;
    try {
      await this.verifySubscription(tenant, account);
      const odooCompanyId = await this.verifyCompany(tenant.odooDbName);
      await this.keycloak.assignWorkspaceOwner(account.keycloakUserId, tenant.id);
      await this.transaction(runner, async (manager) => {
        await manager.getRepository(Tenant).update(tenant.id, { odooCompanyId });
      });
      tenant.odooCompanyId = odooCompanyId;
    } catch {
      // Never surface the underlying RPC/Keycloak exception: it can carry credentials.
      this.logger.warn('Ready tenant repair failed; retry required');
      throw new ReadyRepairFailedError('Ready tenant repair failed; retry required');
    }
  }
  private async verifySubscription(tenant: Tenant, account: Account): Promise<void> {
    const sub = await controlDataSource
      .getRepository(Subscription)
      .findOneBy({ tenantId: tenant.id });
    if (
      !sub ||
      sub.planId !== account.selectedPlanId ||
      String(sub.billingCycle) !== String(account.selectedBillingCycle)
    )
      throw new Error('Subscription mismatch');
  }
  private async databaseExists(db: string): Promise<boolean> {
    const names = await this.odoo.databaseList();
    return names.includes(db);
  }
  private async ensureDatabase(db: string): Promise<void> {
    if (!(await this.databaseExists(db))) {
      try {
        await this.odoo.createDatabase(
          this.credentials.master,
          db,
          this.credentials.login,
          this.credentials.password,
        );
      } catch (error) {
        if (!(await this.databaseExists(db))) throw error;
      }
    }
    if (!(await this.databaseExists(db))) throw new Error('Odoo database verification failed');
  }
  private async installModules(db: string): Promise<void> {
    const uid = await this.odoo.authenticate(db, this.credentials.login, this.credentials.password);
    const upgradeableAccountingAddons = new Set(['kemfai_dimensions', 'kemfai_accounting']);
    const names = [
      'kemfai_tenant_core',
      'kemfai_company_setup',
      'kemfai_module_selection',
      'kemfai_onboarding_checklist',
      'kemfai_dimensions',
      'kemfai_accounting',
    ];
    await this.odoo.executeKw(
      db,
      uid,
      this.credentials.password,
      'ir.module.module',
      'update_list',
      [],
    );
    const rows = (await this.odoo.executeKw(
      db,
      uid,
      this.credentials.password,
      'ir.module.module',
      'search_read',
      [[['name', 'in', names]]],
      { fields: ['id', 'name', 'state'] },
    )) as Array<{ id: number; name: string; state: string }>;
    if (!Array.isArray(rows) || names.some((name) => !rows.some((row) => row.name === name)))
      throw new Error('Required Odoo addon missing');
    const rowsByName = new Map(rows.map((row) => [row.name, row]));
    for (const name of names) {
      const row = rowsByName.get(name)!;
      if (row.state === 'installed' && upgradeableAccountingAddons.has(name)) {
        await this.odoo.executeKw(
          db,
          uid,
          this.credentials.password,
          'ir.module.module',
          'button_immediate_upgrade',
          [[row.id]],
        );
      } else if (row.state !== 'installed') {
        await this.odoo.executeKw(
          db,
          uid,
          this.credentials.password,
          'ir.module.module',
          'button_immediate_install',
          [[row.id]],
        );
      }
    }
    const verified = (await this.odoo.executeKw(
      db,
      uid,
      this.credentials.password,
      'ir.module.module',
      'search_read',
      [[['name', 'in', names]]],
      { fields: ['name', 'state'] },
    )) as Array<{ name: string; state: string }>;
    if (
      !Array.isArray(verified) ||
      names.some((name) => !verified.some((row) => row.name === name && row.state === 'installed'))
    )
      throw new Error('Required Odoo addon not installed');

    const storyOneThroughThreeModels = [
      'account.account',
      'kemfai.account.audit.event',
      'kemfai.account.mutation.receipt',
      'kemfai.account.draft',
      'kemfai.account.draft.line',
      'kemfai.dimension.definition',
      'kemfai.dimension.value',
      'kemfai.dimension.rule',
      'kemfai.account.draft.dimension',
      'account.journal',
      'kemfai.account.currency.config',
      'kemfai.account.draft.validation',
    ];
    for (const model of storyOneThroughThreeModels) {
      const fields = await this.odoo.executeKw(
        db,
        uid,
        this.credentials.password,
        model,
        'fields_get',
        [],
      );
      if (!fields || typeof fields !== 'object' || Array.isArray(fields))
        throw new Error('Required accounting model not callable');
    }
  }
  /**
   * T056 round-5 — resolves the id, not merely the count, of the tenant's single
   * `res.company` record, so the final Ready transition below can persist it to the
   * control plane (`Tenant.odooCompanyId`) for `CompanyOdooContextService.resolveCompanyTarget`
   * to read back later without any further Odoo RPC.
   */
  private async verifyCompany(db: string): Promise<number> {
    const uid = await this.odoo.authenticate(db, this.credentials.login, this.credentials.password);
    const companyIds = (await this.odoo.executeKw(
      db,
      uid,
      this.credentials.password,
      'res.company',
      'search',
      [[]],
    )) as number[];
    if (companyIds.length !== 1) throw new Error('Expected exactly one company');
    return companyIds[0];
  }
}
