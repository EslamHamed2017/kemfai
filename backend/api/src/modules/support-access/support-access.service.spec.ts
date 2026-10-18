import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { SupportAccessService } from './support-access.service';

describe('SupportAccessService grant validation (T088 RED)', () => {
  const service = new SupportAccessService({} as never, {} as never);

  it('requires a finite future expiry within configured bounds', () => {
    process.env.SUPPORT_ACCESS_MAX_DURATION_HOURS = '48';
    const now = new Date('2026-10-18T19:00:00.000Z');
    expect(() => service.validateExpiry('not-a-date', now)).toThrow(UnprocessableEntityException);
    expect(() => service.validateExpiry('2026-10-18T18:59:59.000Z', now)).toThrow(
      UnprocessableEntityException,
    );
    expect(() => service.validateExpiry('2026-10-21T19:00:00.000Z', now)).toThrow(
      UnprocessableEntityException,
    );
    expect(service.validateExpiry('2026-10-19T19:00:00.000Z', now)).toEqual(
      new Date('2026-10-19T19:00:00.000Z'),
    );
  });

  it('rejects revocation when wall-clock expiry has passed before the sweep', () => {
    expect(() =>
      service.assertRevocable(
        {
          status: 'Active',
          revokedAt: null,
          expiresAt: new Date('2026-10-18T18:59:59.000Z'),
        } as never,
        new Date('2026-10-18T19:00:00.000Z'),
      ),
    ).toThrow(ConflictException);
  });
});
