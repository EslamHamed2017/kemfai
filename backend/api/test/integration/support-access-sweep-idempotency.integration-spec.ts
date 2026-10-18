import { randomUUID } from 'crypto';
import controlDataSource from '../../src/database/data-source';
import { Account } from '../../src/modules/accounts/entities/account.entity';
import { Tenant } from '../../src/modules/tenants/entities/tenant.entity';
import { AuditEvent } from '../../src/modules/audit/entities/audit-event.entity';
import { AuditService } from '../../src/modules/audit/audit.service';
import {
  SupportAccessGrant,
  SupportAccessGranteeRole,
  SupportAccessGrantStatus,
} from '../../src/modules/support-access/entities/support-access-grant.entity';
import { SupportAccessSweepProcessor } from '../../src/integrations/provisioning/support-access-sweep.processor';

describe('support access expiry sweep exact-once (T086/T090)', () => {
  let grantId: string;
  beforeAll(async () => {
    if (!controlDataSource.isInitialized) await controlDataSource.initialize();
    await controlDataSource.runMigrations();
  });
  beforeEach(async () => {
    const account = await controlDataSource.getRepository(Account).save({
      keycloakUserId: randomUUID(),
      email: `${randomUUID()}@example.test`,
      emailVerified: true,
    });
    const tenant = await controlDataSource.getRepository(Tenant).save({ accountId: account.id });
    grantId = (
      await controlDataSource.getRepository(SupportAccessGrant).save({
        tenantId: tenant.id,
        grantedBy: account.id,
        granteeRole: SupportAccessGranteeRole.SUPPORT,
        expiresAt: new Date(Date.now() - 1000),
        permittedActions: ['workspace.summary.read'],
      })
    ).id;
  });
  afterEach(async () => {
    await controlDataSource.query(
      `DELETE FROM audit_event WHERE action='support_access.grant.expired'`,
    );
    await controlDataSource.query('DELETE FROM support_access_grant');
    await controlDataSource.query('DELETE FROM tenant');
    await controlDataSource.query('DELETE FROM account');
  });
  afterAll(async () => {
    if (controlDataSource.isInitialized) await controlDataSource.destroy();
  });
  const job = {} as never;
  it('concurrent and repeated runs flip and audit exactly once', async () => {
    const processor = new SupportAccessSweepProcessor(new AuditService());
    await Promise.all([processor.process(job), processor.process(job)]);
    await processor.process(job);
    expect(
      (await controlDataSource.getRepository(SupportAccessGrant).findOneByOrFail({ id: grantId }))
        .status,
    ).toBe(SupportAccessGrantStatus.EXPIRED);
    expect(
      await controlDataSource
        .getRepository(AuditEvent)
        .countBy({ subjectId: grantId, action: 'support_access.grant.expired' }),
    ).toBe(1);
  });
  it('rolls back the state flip when audit fails, then succeeds on retry', async () => {
    const failing = new SupportAccessSweepProcessor({
      recordSupportAccessGrantExpired: async () => {
        throw new Error('synthetic audit failure');
      },
    } as unknown as AuditService);
    await expect(failing.process(job)).rejects.toThrow('synthetic audit failure');
    expect(
      (await controlDataSource.getRepository(SupportAccessGrant).findOneByOrFail({ id: grantId }))
        .status,
    ).toBe(SupportAccessGrantStatus.ACTIVE);
    await new SupportAccessSweepProcessor(new AuditService()).process(job);
    expect(
      await controlDataSource
        .getRepository(AuditEvent)
        .countBy({ subjectId: grantId, action: 'support_access.grant.expired' }),
    ).toBe(1);
  });
});
