import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import controlDataSource from '../../database/data-source';
import { QUEUE_SUPPORT_ACCESS_EXPIRY_SWEEP } from '../../common/queues/queue-names';
import { AuditService } from '../../modules/audit/audit.service';

interface ExpiredGrantRow {
  id: string;
  tenant_id: string;
  expired_at: Date;
}

@Processor(QUEUE_SUPPORT_ACCESS_EXPIRY_SWEEP)
export class SupportAccessSweepProcessor extends WorkerHost {
  static readonly atomicExpirySql = `
    UPDATE support_access_grant
       SET status = 'Expired', expired_at = $1
     WHERE status = 'Active' AND expires_at <= $1
    RETURNING id, tenant_id, expired_at`;

  constructor(private readonly audit: AuditService) {
    super();
  }

  async process(job: Job): Promise<void> {
    void job;
    const cutoff = new Date();
    await controlDataSource.transaction(async (manager) => {
      const result = (await manager.query(SupportAccessSweepProcessor.atomicExpirySql, [
        cutoff,
      ])) as ExpiredGrantRow[] | [ExpiredGrantRow[], number];
      const rows = Array.isArray(result[0]) ? result[0] : (result as ExpiredGrantRow[]);
      for (const row of rows) {
        await this.audit.recordSupportAccessGrantExpired(
          { tenantId: row.tenant_id, grantId: row.id, occurredAt: cutoff },
          manager,
        );
      }
    });
  }
}
