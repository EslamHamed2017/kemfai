import { ForbiddenException } from '@nestjs/common';
import { SupportAccessGuard } from './support-access.guard';

describe('SupportAccessGuard policy surface (T085/T089 RED)', () => {
  it('uses a fixed safe action key and never a raw URL/query/header summary', () => {
    expect(SupportAccessGuard.safeActionSummary('workspace.summary.read')).toBe(
      'workspace.summary.read',
    );
    expect(() => SupportAccessGuard.safeActionSummary('GET /x?token=secret')).toThrow(
      ForbiddenException,
    );
  });

  it('requires explicit matching tenant, grant and Support role', () => {
    expect(
      SupportAccessGuard.validateRequestShape({
        roles: ['Support'],
        targetTenantId: '10000000-0000-4000-8000-000000000001',
        grantTenantId: '10000000-0000-4000-8000-000000000001',
        grantRole: 'Support',
      }),
    ).toBe(true);
    expect(() =>
      SupportAccessGuard.validateRequestShape({
        roles: ['SuperAdmin'],
        targetTenantId: '10000000-0000-4000-8000-000000000001',
        grantTenantId: '10000000-0000-4000-8000-000000000001',
        grantRole: 'Support',
      }),
    ).toThrow(ForbiddenException);
  });
});
