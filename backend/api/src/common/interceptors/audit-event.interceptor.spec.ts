import { CallHandler, ExecutionContext, InternalServerErrorException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of, throwError, firstValueFrom } from 'rxjs';
import {
  AUDIT_EVENT_KEY,
  AuditEventInterceptor,
  AuditEventResolver,
} from './audit-event.interceptor';
import { AuditService } from '../../modules/audit/audit.service';
import { TenantScopedRequest } from '../tenant-context/tenant-context.model';

function makeContext(req: Partial<TenantScopedRequest>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => jest.fn(),
    getClass: () => jest.fn(),
  } as unknown as ExecutionContext;
}

function makeReflector(resolver: AuditEventResolver | undefined) {
  return {
    get: jest.fn((key: string) => (key === AUDIT_EVENT_KEY ? resolver : undefined)),
  } as unknown as Reflector;
}

function makeHandler(source: unknown, isError = false): CallHandler {
  return { handle: () => (isError ? throwError(() => source) : of(source)) };
}

describe('AuditEventInterceptor (T019)', () => {
  it('passes the response through unchanged when no @Audited() metadata is present', async () => {
    const audit = {} as AuditService;
    const interceptor = new AuditEventInterceptor(makeReflector(undefined), audit);
    const result = await firstValueFrom(
      interceptor.intercept(makeContext({}), makeHandler({ ok: true })),
    );
    expect(result).toEqual({ ok: true });
  });

  it('invokes the resolver with (audit, req, result) after a successful response and forwards the result', async () => {
    const audit = {} as AuditService;
    const resolver = jest.fn().mockResolvedValue(undefined);
    const req = { auth: { keycloakUserId: 'sub-1', roles: [] } };
    const interceptor = new AuditEventInterceptor(makeReflector(resolver), audit);

    const result = await firstValueFrom(
      interceptor.intercept(makeContext(req), makeHandler({ id: 'account-1' })),
    );

    expect(result).toEqual({ id: 'account-1' });
    expect(resolver).toHaveBeenCalledWith(audit, req, { id: 'account-1' });
  });

  it('does not invoke the resolver when the handler itself throws', async () => {
    const audit = {} as AuditService;
    const resolver = jest.fn().mockResolvedValue(undefined);
    const interceptor = new AuditEventInterceptor(makeReflector(resolver), audit);

    await expect(
      firstValueFrom(interceptor.intercept(makeContext({}), makeHandler(new Error('boom'), true))),
    ).rejects.toThrow('boom');
    expect(resolver).not.toHaveBeenCalled();
  });

  it('fails the response with 500 (never a silent success) when the resolver itself fails', async () => {
    const audit = {} as AuditService;
    const resolver = jest.fn().mockRejectedValue(new Error('audit DB down'));
    const interceptor = new AuditEventInterceptor(makeReflector(resolver), audit);

    await expect(
      firstValueFrom(interceptor.intercept(makeContext({}), makeHandler({ id: '1' }))),
    ).rejects.toThrow(InternalServerErrorException);
  });
});
