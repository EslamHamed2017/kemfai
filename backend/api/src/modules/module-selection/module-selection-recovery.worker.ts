import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import controlDataSource from '../../database/data-source';
import { OdooRpcService } from '../../integrations/odoo-rpc/odoo-rpc.service';
import { provisioningCredentials } from '../../integrations/provisioning/credentials';
import { Tenant, TenantStatus } from '../tenants/entities/tenant.entity';
import { ModuleSelectionService } from './module-selection.service';

const POLL_MS = Number(process.env.KEMFAI_MODULE_SELECTION_RECOVERY_POLL_MS ?? 5_000);
const BATCH_SIZE = 10;

/** Feature-local bounded recovery for Odoo-committed, unaudited selection receipts. */
@Injectable()
export class ModuleSelectionRecoveryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ModuleSelectionRecoveryWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private scanOffset = 0;

  constructor(
    private readonly odoo: OdooRpcService,
    private readonly selections: ModuleSelectionService,
  ) {}

  onModuleInit(): void {
    if (process.env.KEMFAI_DISABLE_MODULE_SELECTION_RECOVERY_WORKER === '1') return;
    this.timer = setInterval(() => void this.tick(), POLL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const tenants = await controlDataSource.getRepository(Tenant).find({
        where: { status: TenantStatus.READY },
        take: BATCH_SIZE,
        skip: this.scanOffset,
        order: { createdAt: 'ASC' },
      });
      // Rotate through the complete READY set instead of permanently polling its oldest
      // page. An empty/short page completes a bounded pass and starts the next pass at 0.
      this.scanOffset = tenants.length < BATCH_SIZE ? 0 : this.scanOffset + tenants.length;
      for (const tenant of tenants.filter((candidate) => candidate.odooDbName)) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await this.recoverOne(tenant);
        } catch (error) {
          this.logger.warn(
            `module-selection recovery failed for tenant ${tenant.id}: ${(error as Error).message}`,
          );
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async recoverOne(tenant: Tenant): Promise<void> {
    const database = tenant.odooDbName!;
    const { login, password } = provisioningCredentials();
    const uid = await this.odoo.authenticate(database, login, password);
    const receipt = await this.odoo.executeKw(
      database,
      uid,
      password,
      'kemfai.module.selection',
      'kemfai_get_pending_selection_event',
      [],
    );
    if (!receipt) return;
    await this.selections.auditAndAcknowledge(database, uid, password, receipt as never);
  }
}
