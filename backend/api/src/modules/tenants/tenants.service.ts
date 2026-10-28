import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import controlDataSource from '../../database/data-source';
import { QUEUE_TENANT_PROVISION, tenantProvisionJobId } from '../../common/queues/queue-names';
import { Account } from '../accounts/entities/account.entity';
import { Tenant, TenantStatus } from './entities/tenant.entity';

export interface TenantStatusResponse {
  tenantId: string | null;
  status: TenantStatus;
  failureReason: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class TenantsService {
  constructor(@InjectQueue(QUEUE_TENANT_PROVISION) private readonly queue: Queue) {}

  private async accountFor(sub: string): Promise<Account> {
    if (!UUID.test(sub)) throw new NotFoundException('Account not found');
    const account = await controlDataSource
      .getRepository(Account)
      .findOneBy({ keycloakUserId: sub });
    if (!account) throw new NotFoundException('Account not found');
    if (!account.emailVerified)
      throw new ForbiddenException('Verify your email before accessing a workspace');
    return account;
  }

  private view(tenant: Tenant | null): TenantStatusResponse {
    return {
      tenantId: tenant?.id ?? null,
      status: tenant?.status ?? TenantStatus.PENDING,
      // Worker diagnostics remain in the control-plane row/audit trail.  The customer
      // boundary exposes only the actionable, stable product message so an upstream URL,
      // model name, database identifier, or stack detail can never be persisted into this
      // DTO accidentally.
      failureReason:
        tenant?.status === TenantStatus.FAILED
          ? 'Retry or contact support'
          : null,
    };
  }

  async status(sub: string): Promise<TenantStatusResponse> {
    const account = await this.accountFor(sub);
    return this.view(
      await controlDataSource.getRepository(Tenant).findOneBy({ accountId: account.id }),
    );
  }

  /** The worker also locks Account; hold this lock through Redis enqueue and state flip.
   * Failed enqueue rolls back Pending. Never remove a live job. */
  async retry(sub: string): Promise<TenantStatusResponse> {
    const account = await this.accountFor(sub);
    return controlDataSource.transaction(async (manager) => {
      const locked = await manager
        .getRepository(Account)
        .createQueryBuilder('account')
        .setLock('pessimistic_write')
        .where('account.id = :id', { id: account.id })
        .getOneOrFail();
      if (!locked.emailVerified)
        throw new ForbiddenException('Verify your email before accessing a workspace');
      const tenant = await manager.getRepository(Tenant).findOneBy({ accountId: account.id });
      if (tenant?.status === TenantStatus.CREATING) {
        throw new ConflictException(this.view(tenant));
      }
      // A Ready tenant with a provisioned Odoo database but no captured company id (e.g. a
      // row that predates the odoo_company_id column, or a lost mapping) is the one Ready
      // case this must let through: it enqueues the SAME idempotent job the worker already
      // uses to re-resolve the mapping from that tenant's own Odoo database (see
      // TenantProvisionProcessor.repairOdooCompanyMapping). A Ready tenant that already has
      // its mapping, or has no database at all, stays rejected; retrying it is a conflict.
      if (
        tenant?.status === TenantStatus.READY &&
        (!tenant.odooDbName || tenant.odooCompanyId !== null)
      ) {
        throw new ConflictException(this.view(tenant));
      }
      const jobId = tenantProvisionJobId(account.id);
      try {
        const job = await this.queue.getJob(jobId);
        if (job) {
          const state = await job.getState();
          if (state === 'active') throw new ConflictException(this.view(tenant));
          if (
            state === 'waiting' ||
            state === 'delayed' ||
            state === 'prioritized' ||
            state === 'waiting-children'
          ) {
            // Existing queued job is already the desired retry.
          } else if (state === 'failed' || state === 'completed') {
            // BullMQ reprocessJob is a single Redis script: it removes the terminal
            // set membership and pushes this SAME job into wait atomically. Removing
            // then adding leaves a gap and can discard the failed job on add failure.
            try {
              await job.retry(state);
            } catch (error) {
              // The worker can change state after getState(). BullMQ reports -3
              // when the job is no longer in the expected terminal set. Only
              // classify this known race by reading its current state; connection
              // failures and all other script errors must remain 503.
              if ((error as { code?: number }).code !== -3) throw error;
              const current = await job.getState();
              if (current === 'active') throw new ConflictException(this.view(tenant));
              if (
                current !== 'waiting' &&
                current !== 'delayed' &&
                current !== 'prioritized' &&
                current !== 'waiting-children'
              ) {
                throw new ConflictException(this.view(tenant));
              }
            }
          } else {
            throw new ConflictException(this.view(tenant));
          }
        } else {
          await this.queue.add('provision', { accountId: account.id }, { jobId });
        }
      } catch (error) {
        if (error instanceof ConflictException) throw error;
        throw new ServiceUnavailableException(
          'Provisioning retry is temporarily unavailable; try again',
        );
      }
      if (tenant?.status === TenantStatus.FAILED) {
        await manager.getRepository(Tenant).update(
          { id: tenant.id, status: TenantStatus.FAILED },
          {
            status: TenantStatus.PENDING,
            failureReason: null,
          },
        );
        tenant.status = TenantStatus.PENDING;
        tenant.failureReason = null;
      }
      return this.view(tenant);
    });
  }
}
