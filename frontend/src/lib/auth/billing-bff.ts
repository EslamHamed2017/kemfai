import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { accessTokenForSession } from './authenticated-session';
import { getAuthConfig, type AuthConfig } from './config';
import { clearSessionCookie, SESSION_COOKIE } from './cookies';
import { hasSameOrigin } from './origin';
import { RedisSessionStore, type SessionStore } from './session-store';

type BillingPath = '/billing/subscription' | '/billing/payment-submissions';
export const MAX_PAYMENT_MULTIPART_BYTES = 10 * 1024 * 1024 + 64 * 1024;

export interface BillingBffDependencies {
  config: AuthConfig;
  sessionId?: string;
  store: SessionStore;
  fetcher?: typeof fetch;
}

async function authenticate(
  dependencies: BillingBffDependencies,
): Promise<string | NextResponse> {
  const { config, sessionId, store } = dependencies;
  if (!sessionId) return NextResponse.json({ message: 'Authentication required' }, { status: 401 });

  const token = await accessTokenForSession(sessionId, config, store);
  if (token) return token;
  const response = NextResponse.json({ message: 'Authentication required' }, { status: 401 });
  clearSessionCookie(response);
  return response;
}

async function forwardAuthenticated(
  path: BillingPath,
  method: 'GET' | 'POST',
  dependencies: BillingBffDependencies,
  token: string,
  body?: ArrayBuffer,
  contentType?: string,
): Promise<NextResponse> {
  const { config } = dependencies;
  const fetcher = dependencies.fetcher ?? fetch;
  try {
    const upstream = await fetcher(`${config.apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(contentType ? { 'content-type': contentType } : {}),
      },
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
    if (upstream.status === 401) {
      const response = NextResponse.json({ message: 'Authentication required' }, { status: 401 });
      clearSessionCookie(response);
      return response;
    }
    const text = await upstream.text();
    return new NextResponse(text || null, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-store',
      },
    });
  } catch {
    return NextResponse.json({ message: 'Billing is temporarily unavailable' }, { status: 502 });
  }
}

async function forward(
  path: BillingPath,
  method: 'GET',
  dependencies: BillingBffDependencies,
): Promise<NextResponse> {
  const token = await authenticate(dependencies);
  if (typeof token !== 'string') return token;
  return forwardAuthenticated(path, method, dependencies, token);
}

function paymentProofTooLarge(): NextResponse {
  return NextResponse.json(
    {
      statusCode: 422,
      code: 'PAYMENT_PROOF_TOO_LARGE',
      message: 'Proof file exceeds the upload size limit',
    },
    { status: 422 },
  );
}

async function readBoundedMultipartBody(request: Request): Promise<ArrayBuffer | NextResponse> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength && Number(declaredLength) > MAX_PAYMENT_MULTIPART_BYTES) {
    return paymentProofTooLarge();
  }
  if (!request.body) return new ArrayBuffer(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PAYMENT_MULTIPART_BYTES) {
        await reader.cancel().catch(() => undefined);
        return paymentProofTooLarge();
      }
      chunks.push(value);
    }
  } catch {
    return NextResponse.json({ message: 'Malformed multipart body' }, { status: 400 });
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

export function getBillingSubscriptionWith(
  dependencies: BillingBffDependencies,
): Promise<NextResponse> {
  return forward('/billing/subscription', 'GET', dependencies);
}

export function getPaymentSubmissionsWith(
  dependencies: BillingBffDependencies,
): Promise<NextResponse> {
  return forward('/billing/payment-submissions', 'GET', dependencies);
}

export async function postPaymentSubmissionWith(
  request: Request,
  dependencies: BillingBffDependencies,
): Promise<NextResponse> {
  if (!hasSameOrigin(request, dependencies.config.redirectUri)) {
    return NextResponse.json({ message: 'Forbidden origin' }, { status: 403 });
  }
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data;\s*boundary=/i.test(contentType)) {
    return NextResponse.json({ message: 'Multipart form data is required' }, { status: 415 });
  }
  const token = await authenticate(dependencies);
  if (typeof token !== 'string') return token;
  const body = await readBoundedMultipartBody(request);
  if (body instanceof NextResponse) return body;
  return forwardAuthenticated(
    '/billing/payment-submissions',
    'POST',
    dependencies,
    token,
    body,
    contentType,
  );
}

async function dependencies(): Promise<BillingBffDependencies> {
  const config = getAuthConfig();
  return {
    config,
    sessionId: (await cookies()).get(SESSION_COOKIE)?.value,
    store: new RedisSessionStore(config.redisUrl),
  };
}

export async function getBillingSubscription(): Promise<NextResponse> {
  return getBillingSubscriptionWith(await dependencies());
}

export async function getPaymentSubmissions(): Promise<NextResponse> {
  return getPaymentSubmissionsWith(await dependencies());
}

export async function postPaymentSubmission(request: Request): Promise<NextResponse> {
  return postPaymentSubmissionWith(request, await dependencies());
}
