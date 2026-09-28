import { Account, Locale } from './entities/account.entity';
import { AccountsService } from './accounts.service';
import controlDataSource from '../../database/data-source';

/**
 * T104 — unit coverage of the locale-persistence service semantics: authenticated
 * identity scoping (keycloakUserId lookup), persistence, readback, and the documented
 * missing-account no-op. Repository-backed (stubbed controlDataSource), mirroring the
 * established accounts.service.spec.ts unit pattern.
 */
describe('AccountsService locale persistence (T104, unit)', () => {
  function makeRepo(existing: Account | null) {
    return {
      findOne: jest.fn().mockResolvedValue(existing),
      save: jest.fn(async (a: Account) => a),
    };
  }

  afterEach(() => jest.restoreAllMocks());

  it('persists the chosen locale on the caller own account only', async () => {
    const account = { id: 'a1', keycloakUserId: 'k1', preferredLocale: null } as Account;
    const repo = makeRepo(account);
    const manager = { getRepository: () => repo };
    jest.spyOn(controlDataSource, 'transaction').mockImplementation(async (cb: any) => cb(manager));
    jest.spyOn(controlDataSource, 'getRepository').mockReturnValue(repo as any);
    const service = new AccountsService(
      { recordAccountLocaleChanged: jest.fn() } as any, { add: jest.fn() } as any, { add: jest.fn() } as any, { createUser: jest.fn() } as any,
    );
    await service.setPreferredLocale('k1', Locale.AR);
    expect(repo.findOne).toHaveBeenCalledWith({ where: { keycloakUserId: 'k1' } });
    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ preferredLocale: Locale.AR }));
  });

  it('reads back the persisted locale; null before a choice was made', async () => {
    const account = { id: 'a1', keycloakUserId: 'k1', preferredLocale: Locale.EN } as Account;
    const repo = makeRepo(account);
    repo.findOne = jest.fn(async ({ where }: { where: { keycloakUserId: string } }) =>
      where.keycloakUserId === 'k1' ? account : null);
    const manager = { getRepository: () => repo };
    jest.spyOn(controlDataSource, 'transaction').mockImplementation(async (cb: any) => cb(manager));
    jest.spyOn(controlDataSource, 'getRepository').mockReturnValue(repo as any);
    const service = new AccountsService(
      { recordAccountLocaleChanged: jest.fn() } as any, { add: jest.fn() } as any, { add: jest.fn() } as any, { createUser: jest.fn() } as any,
    );
    await expect(service.getPreferredLocale('k1')).resolves.toEqual({ locale: Locale.EN });
    await expect(service.getPreferredLocale('k2')).resolves.toEqual({ locale: null });
  });

  it('emits account.locale_changed on a real change (and only then)', async () => {
    const account = { id: 'a1', keycloakUserId: 'k1', preferredLocale: 'en' } as Account;
    const repo = makeRepo(account);
    const manager = { getRepository: () => repo };
    jest.spyOn(controlDataSource, 'transaction').mockImplementation(async (cb: any) => cb(manager));
    jest.spyOn(controlDataSource, 'getRepository').mockReturnValue(repo as any);
    const audit = { recordAccountLocaleChanged: jest.fn() };
    const service = new AccountsService(
      audit as any, { add: jest.fn() } as any, { add: jest.fn() } as any, { createUser: jest.fn() } as any,
    );

    await service.setPreferredLocale('k1', Locale.AR); // real change en→ar
    expect(audit.recordAccountLocaleChanged).toHaveBeenCalledWith(
      { accountId: 'a1', fromLocale: 'en', toLocale: 'ar' },
      expect.objectContaining({ getRepository: expect.any(Function) }), // T035-style tx manager
    );

    (audit.recordAccountLocaleChanged as jest.Mock).mockClear();
    await service.setPreferredLocale('k1', Locale.AR); // idempotent re-save
    expect(audit.recordAccountLocaleChanged).not.toHaveBeenCalled();
  });

  it('missing account is a logged no-op, never a crash', async () => {
    const repo = makeRepo(null);
    const manager = { getRepository: () => repo };
    jest.spyOn(controlDataSource, 'transaction').mockImplementation(async (cb: any) => cb(manager));
    jest.spyOn(controlDataSource, 'getRepository').mockReturnValue(repo as any);
    const service = new AccountsService(
      { recordAccountLocaleChanged: jest.fn() } as any, { add: jest.fn() } as any, { add: jest.fn() } as any, { createUser: jest.fn() } as any,
    );
    await expect(service.setPreferredLocale('ghost', Locale.AR)).resolves.toBeUndefined();
    expect(repo.save).not.toHaveBeenCalled();
  });
});
