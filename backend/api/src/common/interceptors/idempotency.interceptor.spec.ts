import { CallHandler, ConflictException, ExecutionContext } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { firstValueFrom, of, throwError } from 'rxjs';
import { IdempotencyKeyInterceptor } from './idempotency.interceptor';
import { IdempotencyRecordStatus } from '../../modules/idempotency/entities/idempotency-key.entity';
import { IdempotencyService } from '../../modules/idempotency/idempotency.service';
import { TenantScopedRequest } from '../tenant-context/tenant-context.model';

function makeContext(req: Partial<TenantScopedRequest>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function makeHandler(source: unknown, isError = false): CallHandler {
  return { handle: () => (isError ? throwError(() => source) : of(source)) };
}

function makeReq(overrides: Partial<TenantScopedRequest> = {}): TenantScopedRequest {
  return {
    method: 'POST',
    path: '/accounts',
    headers: {},
    body: { email: 'a@example.com' },
    auth: { keycloakUserId: 'user-42', roles: [] },
    ...overrides,
  } as unknown as TenantScopedRequest;
}

function fingerprintOf(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

function makeService(overrides: Partial<jest.Mocked<IdempotencyService>> = {}) {
  return {
    claim: jest.fn(),
    find: jest.fn(),
    reclaimStale: jest.fn(),
    complete: jest.fn(),
    release: jest.fn(),
    ...overrides,
  } as unknown as jest.Mocked<IdempotencyService>;
}

describe('IdempotencyKeyInterceptor (T020)', () => {
  it('passes the request through unchanged when no Idempotency-Key header is present', async () => {
    const service = makeService();
    const interceptor = new IdempotencyKeyInterceptor(service);
    const req = makeReq();

    const result = await firstValueFrom(
      interceptor.intercept(makeContext(req), makeHandler({ ok: true })),
    );

    expect(result).toEqual({ ok: true });
    expect(service.claim).not.toHaveBeenCalled();
  });

  it('passes GET requests through unchanged even when an Idempotency-Key header is present', async () => {
    const service = makeService();
    const interceptor = new IdempotencyKeyInterceptor(service);
    const req = makeReq({ method: 'GET', headers: { 'idempotency-key': 'key-1' } });

    const result = await firstValueFrom(
      interceptor.intercept(makeContext(req), makeHandler({ ok: true })),
    );

    expect(result).toEqual({ ok: true });
    expect(service.claim).not.toHaveBeenCalled();
  });

  it('rejects an Idempotency-Key on multipart before claiming an empty-body fingerprint', async () => {
    const service = makeService({ claim: jest.fn().mockResolvedValue('claim-1') });
    const interceptor = new IdempotencyKeyInterceptor(service);
    const req = makeReq({
      headers: {
        'idempotency-key': 'key-1',
        'content-type': 'multipart/form-data; boundary=t062-private-boundary',
      },
      body: undefined,
    });
    const handler = makeHandler({ shouldNotRun: true });
    const handleSpy = jest.spyOn(handler, 'handle');

    await expect(firstValueFrom(interceptor.intercept(makeContext(req), handler))).rejects.toThrow(
      ConflictException,
    );
    expect(service.claim).not.toHaveBeenCalled();
    expect(handleSpy).not.toHaveBeenCalled();
  });

  it('claims the slot, runs the handler exactly once, and marks it completed with the result', async () => {
    const service = makeService({ claim: jest.fn().mockResolvedValue('claim-1') });
    const interceptor = new IdempotencyKeyInterceptor(service);
    const req = makeReq({ headers: { 'idempotency-key': 'key-1' } });
    const handler = makeHandler({ id: 'account-1' });
    const handleSpy = jest.spyOn(handler, 'handle');

    const result = await firstValueFrom(interceptor.intercept(makeContext(req), handler));

    expect(result).toEqual({ id: 'account-1' });
    expect(handleSpy).toHaveBeenCalledTimes(1);
    expect(service.claim).toHaveBeenCalledWith({
      scope: 'keycloak:user-42',
      idempotencyKey: 'key-1',
      method: 'POST',
      path: '/accounts',
      fingerprint: expect.any(String),
    });
    expect(service.complete).toHaveBeenCalledWith('claim-1', { id: 'account-1' });
    expect(service.release).not.toHaveBeenCalled();
  });

  it('includes the caller tenant in the scope so claims are tenant-isolated, not just user-isolated', async () => {
    const service = makeService({ claim: jest.fn().mockResolvedValue('claim-1') });
    const interceptor = new IdempotencyKeyInterceptor(service);
    const req = makeReq({
      headers: { 'idempotency-key': 'key-1' },
      tenantContext: {
        keycloakUserId: 'user-42',
        accountId: 'account-9',
        callerTenantId: 'tenant-7',
      },
    });

    await firstValueFrom(interceptor.intercept(makeContext(req), makeHandler({ ok: true })));

    expect(service.claim).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'keycloak:user-42:tenant:tenant-7' }),
    );
  });

  it('never stores or replays anything for unauthenticated callers: the request always executes, even with a key header', async () => {
    const service = makeService();
    const interceptor = new IdempotencyKeyInterceptor(service);
    const handler = makeHandler({ callNumber: 1 });
    const handleSpy = jest.spyOn(handler, 'handle');
    const req = makeReq({
      headers: { 'idempotency-key': 'shared-by-two-anonymous-callers' },
      auth: undefined as unknown as TenantScopedRequest['auth'],
    });

    const first = await firstValueFrom(interceptor.intercept(makeContext(req), handler));
    const second = await firstValueFrom(interceptor.intercept(makeContext(req), handler));

    // Both execute — no stored response ever existed that a second (possibly different,
    // possibly same-NAT-IP) anonymous caller could receive or be served.
    expect(first).toEqual({ callNumber: 1 });
    expect(second).toEqual({ callNumber: 1 });
    expect(handleSpy).toHaveBeenCalledTimes(2);
    expect(service.claim).not.toHaveBeenCalled();
    expect(service.find).not.toHaveBeenCalled();
    expect(service.complete).not.toHaveBeenCalled();
  });

  it('scopes the claim by the authenticated caller, not by any network signal', async () => {
    const service = makeService({ claim: jest.fn().mockResolvedValue('claim-1') });
    const interceptor = new IdempotencyKeyInterceptor(service);
    const req = makeReq({
      headers: { 'idempotency-key': 'key-1' },
      auth: { keycloakUserId: 'user-42', roles: [] },
    });

    await firstValueFrom(interceptor.intercept(makeContext(req), makeHandler({ ok: true })));

    expect(service.claim).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'keycloak:user-42' }),
    );
  });

  it('releases the claim and rethrows when the handler fails, so a genuine retry is not blocked', async () => {
    const service = makeService({ claim: jest.fn().mockResolvedValue('claim-1') });
    const interceptor = new IdempotencyKeyInterceptor(service);
    const req = makeReq({ headers: { 'idempotency-key': 'key-1' } });

    await expect(
      firstValueFrom(interceptor.intercept(makeContext(req), makeHandler(new Error('boom'), true))),
    ).rejects.toThrow('boom');

    expect(service.release).toHaveBeenCalledWith('claim-1');
    expect(service.complete).not.toHaveBeenCalled();
  });

  it('replays the stored response without invoking the handler when a completed row matches the fingerprint', async () => {
    const req = makeReq({ headers: { 'idempotency-key': 'key-1' } });
    const computedFingerprint = fingerprintOf(req.body);
    const service = makeService({
      claim: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue({
        id: 'claim-1',
        fingerprint: computedFingerprint,
        status: IdempotencyRecordStatus.COMPLETED,
        responseBody: { id: 'account-1', replayed: true },
        lockedAt: new Date(),
      }),
    });
    const interceptor = new IdempotencyKeyInterceptor(service);
    const handler = makeHandler({ id: 'should-not-run' });
    const handleSpy = jest.spyOn(handler, 'handle');

    const result = await firstValueFrom(interceptor.intercept(makeContext(req), handler));

    expect(result).toEqual({ id: 'account-1', replayed: true });
    expect(handleSpy).not.toHaveBeenCalled();
  });

  it('throws 409 without invoking the handler when the same key is reused with a different payload', async () => {
    const req = makeReq({
      headers: { 'idempotency-key': 'key-1' },
      body: { email: 'a@example.com' },
    });
    const service = makeService({
      claim: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue({
        id: 'claim-1',
        fingerprint: 'a-completely-different-fingerprint',
        status: IdempotencyRecordStatus.COMPLETED,
        responseBody: { id: 'account-1' },
        lockedAt: new Date(),
      }),
    });
    const interceptor = new IdempotencyKeyInterceptor(service);
    const handler = makeHandler({ id: 'should-not-run' });
    const handleSpy = jest.spyOn(handler, 'handle');

    await expect(firstValueFrom(interceptor.intercept(makeContext(req), handler))).rejects.toThrow(
      ConflictException,
    );
    expect(handleSpy).not.toHaveBeenCalled();
  });

  it('polls a pending in-flight claim and replays once the original owner completes it, never running the handler itself', async () => {
    const req = makeReq({ headers: { 'idempotency-key': 'key-1' } });
    const fingerprint = fingerprintOf(req.body);
    const service = makeService({ claim: jest.fn().mockResolvedValue(null) });
    (service.find as jest.Mock)
      .mockResolvedValueOnce({
        id: 'claim-1',
        fingerprint,
        status: IdempotencyRecordStatus.PENDING,
        responseBody: null,
        lockedAt: new Date(),
      })
      .mockResolvedValueOnce({
        id: 'claim-1',
        fingerprint,
        status: IdempotencyRecordStatus.COMPLETED,
        responseBody: { id: 'account-1', wonByOther: true },
        lockedAt: new Date(),
      });
    const interceptor = new IdempotencyKeyInterceptor(service);
    const handler = makeHandler({ id: 'should-not-run' });
    const handleSpy = jest.spyOn(handler, 'handle');

    const result = await firstValueFrom(interceptor.intercept(makeContext(req), handler));

    expect(result).toEqual({ id: 'account-1', wonByOther: true });
    expect(handleSpy).not.toHaveBeenCalled();
    expect(service.find).toHaveBeenCalledTimes(2);
  });

  it('reclaims and executes a stale pending claim (prior claimant presumed crashed) via compare-and-swap', async () => {
    const req = makeReq({ headers: { 'idempotency-key': 'key-1' } });
    const fingerprint = fingerprintOf(req.body);
    const staleLockedAt = new Date(Date.now() - 60_000);
    const service = makeService({
      claim: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue({
        id: 'claim-1',
        fingerprint,
        status: IdempotencyRecordStatus.PENDING,
        responseBody: null,
        lockedAt: staleLockedAt,
      }),
      reclaimStale: jest.fn().mockResolvedValue(true),
    });
    const interceptor = new IdempotencyKeyInterceptor(service);
    const handler = makeHandler({ id: 'reclaimed' });
    const handleSpy = jest.spyOn(handler, 'handle');

    const result = await firstValueFrom(interceptor.intercept(makeContext(req), handler));

    expect(result).toEqual({ id: 'reclaimed' });
    expect(handleSpy).toHaveBeenCalledTimes(1);
    expect(service.reclaimStale).toHaveBeenCalledWith('claim-1', staleLockedAt);
    expect(service.complete).toHaveBeenCalledWith('claim-1', { id: 'reclaimed' });
  });
});
