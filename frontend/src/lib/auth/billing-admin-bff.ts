import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { accessTokenForSession } from './authenticated-session';
import type { AuthConfig } from './config';
import {
  clearInternalSessionCookie,
  getInternalAuthConfig,
  INTERNAL_SESSION_COOKIE,
} from './internal-auth';
import { hasSameOrigin } from './origin';
import { RedisSessionStore, type SessionStore } from './session-store';

type Action = 'approve' | 'reject' | 'request-more-info';
export interface BillingAdminBffDependencies {
  config: AuthConfig;
  sessionId?: string;
  store: SessionStore;
  fetcher?: typeof fetch;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const json = (body: Record<string, unknown>, status: number) => {
  const r = NextResponse.json(body, { status });
  r.headers.set('cache-control', 'no-store');
  return r;
};
async function token(deps: BillingAdminBffDependencies): Promise<string | NextResponse> {
  if (!deps.sessionId) return json({ code: 'AUTHENTICATION_REQUIRED' }, 401);
  const value = await accessTokenForSession(deps.sessionId, deps.config, deps.store);
  if (value) return value;
  const response = json({ code: 'AUTHENTICATION_REQUIRED' }, 401);
  clearInternalSessionCookie(response);
  return response;
}
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const isDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const isDateTime = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T/.test(value) &&
  !Number.isNaN(Date.parse(value));
function validDecisionResult(value: unknown, action: Action, submissionId: string): boolean {
  if (!isObject(value) || value.submissionId !== submissionId) return false;
  if (action === 'approve')
    return (
      isUuid(value.subscriptionId) &&
      value.status === 'Active' &&
      isDate(value.billingPeriodStart) &&
      isDate(value.billingPeriodEnd) &&
      isDateTime(value.activatedAt)
    );
  const expected =
    action === 'reject'
      ? { status: 'Rejected', decision: 'reject' }
      : { status: 'MoreInfoRequested', decision: 'more_info' };
  return (
    value.status === expected.status &&
    value.decision === expected.decision &&
    typeof value.decisionNotes === 'string' &&
    isDateTime(value.decidedAt)
  );
}
async function upstream(
  path: string,
  method: 'GET' | 'POST',
  deps: BillingAdminBffDependencies,
  bearer: string,
  body?: string,
  expected?: { action: Action; submissionId: string },
) {
  try {
    const response = await (deps.fetcher ?? fetch)(`${deps.config.apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 401) {
      const r = json({ code: 'AUTHENTICATION_REQUIRED' }, 401);
      clearInternalSessionCookie(r);
      return r;
    }
    const safeCode =
      response.status === 403
        ? 'FORBIDDEN'
        : response.status === 404
          ? 'NOT_FOUND'
          : response.status === 409
            ? 'CONFLICT'
            : response.status === 422
              ? 'INVALID_INPUT'
              : response.ok
                ? 'OK'
                : 'UPSTREAM_ERROR';
    const text = response.ok ? await response.text() : JSON.stringify({ code: safeCode });
    if (response.ok && expected) {
      if (
        !(response.headers.get('content-type') ?? '').toLowerCase().includes('application/json')
      ) {
        return json({ code: 'UNKNOWN_OUTCOME' }, 502);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return json({ code: 'UNKNOWN_OUTCOME' }, 502);
      }
      if (!validDecisionResult(parsed, expected.action, expected.submissionId))
        return json({ code: 'UNKNOWN_OUTCOME' }, 502);
    }
    return new NextResponse(text || null, {
      status: response.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch {
    return json({ code: 'UPSTREAM_UNAVAILABLE' }, 502);
  }
}
export async function getBillingReviewQueueWith(deps: BillingAdminBffDependencies) {
  const bearer = await token(deps);
  return typeof bearer === 'string'
    ? upstream('/internal/billing/review-queue', 'GET', deps, bearer)
    : bearer;
}
export async function postBillingDecisionWith(
  request: Request,
  id: string,
  action: Action,
  deps: BillingAdminBffDependencies,
) {
  if (!hasSameOrigin(request, deps.config.redirectUri))
    return json({ code: 'FORBIDDEN_ORIGIN' }, 403);
  if (!UUID.test(id)) return json({ code: 'INVALID_SUBMISSION' }, 400);
  let body: string | undefined;
  if (action !== 'approve') {
    let value: unknown;
    try {
      value = await request.json();
    } catch {
      return json({ code: 'INVALID_INPUT' }, 422);
    }
    const key = action === 'reject' ? 'reason' : 'details';
    const note =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)[key]
        : undefined;
    if (typeof note !== 'string' || !note.trim() || note.length > 4000)
      return json({ code: 'INVALID_INPUT' }, 422);
    body = JSON.stringify({ [key]: note.trim() });
  }
  const bearer = await token(deps);
  return typeof bearer === 'string'
    ? upstream(
        `/internal/billing/payment-submissions/${id}/${action}`,
        'POST',
        deps,
        bearer,
        body,
        { action, submissionId: id },
      )
    : bearer;
}
async function deps(): Promise<BillingAdminBffDependencies> {
  const config = getInternalAuthConfig();
  return {
    config,
    sessionId: (await cookies()).get(INTERNAL_SESSION_COOKIE)?.value,
    store: new RedisSessionStore(config.redisUrl),
  };
}
export const getBillingReviewQueue = async () => getBillingReviewQueueWith(await deps());
export const postBillingDecision = async (request: Request, id: string, action: Action) =>
  postBillingDecisionWith(request, id, action, await deps());
