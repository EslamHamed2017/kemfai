import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { accessTokenForSession } from './authenticated-session';
import { getAuthConfig, type AuthConfig } from './config';
import { clearSessionCookie, SESSION_COOKIE } from './cookies';
import { hasSameOrigin } from './origin';
import { RedisSessionStore, type SessionStore } from './session-store';

export type AccountingBffMethod = 'GET' | 'POST' | 'PATCH' | 'PUT';

export interface AccountingBffRequest {
  method: AccountingBffMethod;
  /** Relative to the fixed `/v1/accounting` API boundary. */
  path: string;
  body?: unknown;
}

export interface AccountingBffDependencies {
  config: AuthConfig;
  sessionId?: string;
  store: SessionStore;
  fetcher?: typeof fetch;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ERROR_KEYS = new Set(['statusCode', 'code', 'messageKey', 'correlationId', 'issues']);
const SAFE_ISSUE_KEYS = new Set([
  'code',
  'messageKey',
  'messageParams',
  'lineId',
  'resourceId',
  'field',
]);
const SAFE_CLIENT_ERRORS: Readonly<Record<number, { code: string; messageKey: string }>> = {
  400: { code: 'ACCOUNTING_REQUEST_INVALID', messageKey: 'accounting.errors.invalidRequest' },
  403: { code: 'ACCOUNTING_FORBIDDEN', messageKey: 'accounting.errors.forbidden' },
  404: { code: 'ACCOUNTING_NOT_FOUND', messageKey: 'accounting.errors.notFound' },
  409: { code: 'ACCOUNTING_CONFLICT', messageKey: 'accounting.errors.conflict' },
  412: {
    code: 'ACCOUNTING_PRECONDITION_FAILED',
    messageKey: 'accounting.errors.staleConflict',
  },
  422: { code: 'ACCOUNTING_VALIDATION_FAILED', messageKey: 'accounting.errors.validation' },
  429: { code: 'ACCOUNTING_RATE_LIMITED', messageKey: 'accounting.errors.rateLimited' },
};

function jsonError(
  status: number,
  code: string,
  messageKey: string,
  correlationId: string = randomUUID(),
): NextResponse {
  return NextResponse.json(
    { statusCode: status, code, messageKey, correlationId },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isSafeIssue(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).some((key) => !SAFE_ISSUE_KEYS.has(key))) return false;
  return (
    typeof value.code === 'string' &&
    value.code.length > 0 &&
    typeof value.messageKey === 'string' &&
    value.messageKey.length > 0 &&
    (value.lineId === undefined || value.lineId === null || UUID.test(String(value.lineId))) &&
    (value.resourceId === undefined ||
      value.resourceId === null ||
      UUID.test(String(value.resourceId))) &&
    (value.field === undefined || value.field === null || typeof value.field === 'string') &&
    (value.messageParams === undefined || isRecord(value.messageParams))
  );
}

function isSafeErrorEnvelope(value: unknown, status: number): boolean {
  if (!isRecord(value) || Object.keys(value).some((key) => !SAFE_ERROR_KEYS.has(key))) return false;
  return (
    value.statusCode === status &&
    typeof value.code === 'string' &&
    value.code.length > 0 &&
    typeof value.messageKey === 'string' &&
    value.messageKey.length > 0 &&
    typeof value.correlationId === 'string' &&
    UUID.test(value.correlationId) &&
    (value.issues === undefined ||
      (Array.isArray(value.issues) && value.issues.every((issue) => isSafeIssue(issue))))
  );
}

function safePath(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('#') || path.includes('\\'))
    return false;
  try {
    const decoded = decodeURIComponent(path);
    return !decoded.split(/[/?]/).some((segment) => segment === '..' || segment === '.');
  } catch {
    return false;
  }
}

function locale(request: Request): 'en' | 'ar' {
  return request.headers.get('accept-language')?.trim().toLowerCase().startsWith('ar')
    ? 'ar'
    : 'en';
}

function responseHeaders(upstream: Response): HeadersInit {
  const headers: Record<string, string> = {
    'content-type': upstream.headers.get('content-type') ?? 'application/json',
    'cache-control': 'no-store',
  };
  const etag = upstream.headers.get('etag');
  if (etag) headers.etag = etag;
  return headers;
}

export async function forwardAccountingWith(
  request: Request,
  accountingRequest: AccountingBffRequest,
  dependencies: AccountingBffDependencies,
): Promise<NextResponse> {
  const { config, sessionId, store } = dependencies;
  if (!safePath(accountingRequest.path)) {
    return jsonError(400, 'ACCOUNTING_PATH_INVALID', 'accounting.errors.invalidPath');
  }
  if (accountingRequest.method !== 'GET' && !hasSameOrigin(request, config.redirectUri)) {
    return jsonError(403, 'FORBIDDEN_ORIGIN', 'accounting.errors.forbiddenOrigin');
  }
  if (!sessionId) {
    return jsonError(401, 'AUTHENTICATION_REQUIRED', 'accounting.errors.authenticationRequired');
  }
  const token = await accessTokenForSession(sessionId, config, store);
  if (!token) {
    const response = jsonError(
      401,
      'AUTHENTICATION_REQUIRED',
      'accounting.errors.authenticationRequired',
    );
    clearSessionCookie(response);
    return response;
  }

  const companyId = request.headers.get('x-kemfai-company-id')?.trim();
  const incomingCorrelationId = request.headers.get('x-correlation-id')?.trim();
  const correlationId =
    incomingCorrelationId && UUID.test(incomingCorrelationId)
      ? incomingCorrelationId
      : randomUUID();
  if (!companyId || !UUID.test(companyId)) {
    return jsonError(
      400,
      'ACCOUNTING_COMPANY_REQUIRED',
      'accounting.errors.companyRequired',
      correlationId,
    );
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
    'x-kemfai-company-id': companyId,
    'accept-language': locale(request),
    'x-correlation-id': correlationId,
  };
  if (accountingRequest.body !== undefined) headers['content-type'] = 'application/json';
  for (const name of ['idempotency-key', 'if-match'] as const) {
    const value = request.headers.get(name)?.trim();
    if (value) headers[name] = value;
  }

  try {
    const upstream = await (dependencies.fetcher ?? fetch)(
      `${config.apiUrl}/v1/accounting${accountingRequest.path}`,
      {
        method: accountingRequest.method,
        headers,
        body:
          accountingRequest.body === undefined ? undefined : JSON.stringify(accountingRequest.body),
        cache: 'no-store',
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (upstream.status === 401) {
      const response = jsonError(
        401,
        'AUTHENTICATION_REQUIRED',
        'accounting.errors.authenticationRequired',
        correlationId,
      );
      clearSessionCookie(response);
      return response;
    }

    const text = await upstream.text();
    if (!upstream.ok) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      if (!isSafeErrorEnvelope(parsed, upstream.status)) {
        const safeClientError = SAFE_CLIENT_ERRORS[upstream.status];
        if (safeClientError) {
          return jsonError(
            upstream.status,
            safeClientError.code,
            safeClientError.messageKey,
            correlationId,
          );
        }
        return jsonError(
          502,
          'ACCOUNTING_UPSTREAM_UNAVAILABLE',
          'accounting.errors.unavailable',
          correlationId,
        );
      }
    }
    return new NextResponse(text || null, {
      status: upstream.status,
      headers: responseHeaders(upstream),
    });
  } catch {
    return jsonError(
      502,
      'ACCOUNTING_UPSTREAM_UNAVAILABLE',
      'accounting.errors.unavailable',
      correlationId,
    );
  }
}

async function dependencies(): Promise<AccountingBffDependencies> {
  const config = getAuthConfig();
  return {
    config,
    sessionId: (await cookies()).get(SESSION_COOKIE)?.value,
    store: new RedisSessionStore(config.redisUrl),
  };
}

export async function forwardAccounting(
  request: Request,
  accountingRequest: AccountingBffRequest,
): Promise<NextResponse> {
  return forwardAccountingWith(request, accountingRequest, await dependencies());
}
