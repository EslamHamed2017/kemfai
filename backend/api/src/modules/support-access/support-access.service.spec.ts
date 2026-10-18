import {
  ConflictException,
  InternalServerErrorException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { SupportAccessService } from './support-access.service';

describe('SupportAccessService grant validation (T088 RED)', () => {
  const service = new SupportAccessService({} as never, {} as never);
  const originalMaximum = process.env.SUPPORT_ACCESS_MAX_DURATION_HOURS;

  afterEach(() => {
    if (originalMaximum === undefined) delete process.env.SUPPORT_ACCESS_MAX_DURATION_HOURS;
    else process.env.SUPPORT_ACCESS_MAX_DURATION_HOURS = originalMaximum;
  });

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

  it('fails closed instead of inventing a maximum when deployment configuration is absent', () => {
    delete process.env.SUPPORT_ACCESS_MAX_DURATION_HOURS;
    expect(() =>
      service.validateExpiry('2026-10-19T19:00:00.000Z', new Date('2026-10-18T19:00:00.000Z')),
    ).toThrow(InternalServerErrorException);
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
