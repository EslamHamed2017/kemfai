import { Injectable, Optional } from '@nestjs/common';

export interface BillingDecisionNotificationEmail {
  to: string;
  subject: string;
  body: string;
}

export interface BillingDecisionNotificationSendResult {
  /** The provider-assigned email id — persisted so an operator can look the send up by it. */
  providerMessageId: string;
}

/**
 * Thrown when the provider answers 409 for a replayed Idempotency-Key: the SAME key was
 * sent with a payload that no longer matches what the provider recorded for it. This is
 * the documented fail-closed outcome
 * (https://resend.com/docs/dashboard/emails/idempotency-keys) — the caller must never
 * retry it under a fresh key.
 */
export class IdempotencyKeyConflictError extends Error {
  constructor() {
    super('Resend rejected the idempotent replay (HTTP 409 payload conflict)');
    this.name = 'IdempotencyKeyConflictError';
  }
}

/**
 * The customer-facing delivery channel for FR-035. Split in two (independent review
 * repair, 2026-10-16, finding 1) so the exact bytes POSTed can be persisted ONCE and
 * reused verbatim on every retry:
 *
 * - `buildRequestBody` is a pure, synchronous builder — no network call — that bakes in
 *   every byte the provider will see, INCLUDING the sender (`RESEND_FROM`). Persisting
 *   only `to`/`subject`/`body` and re-reading the sender live at send time was exactly
 *   the gap that let a config change (or a redeploy with a different `RESEND_FROM`)
 *   between a first attempt and its retry silently change the request body under the
 *   SAME idempotency key, turning a legitimate retry into a provider-side 409.
 * - `sendRaw` POSTs an already-built body VERBATIM — it never reconstructs anything,
 *   so there is no code path left that can send bytes other than what was persisted.
 *
 * Implementations are injected into `BillingDecisionNotificationProcessor` via
 * `BILLING_DECISION_NOTIFICATION_TRANSPORT`.
 */
export abstract class BillingDecisionNotificationTransport {
  abstract buildRequestBody(email: BillingDecisionNotificationEmail): string;
  abstract sendRaw(
    serializedBody: string,
    idempotencyKey: string,
  ): Promise<BillingDecisionNotificationSendResult>;
}

export interface ResendTransportOptions {
  apiKey: string;
  from: string;
  /**
   * Resend's email-send endpoint (https://resend.com/docs/api-reference/emails/send-email).
   * Overridable ONLY via the explicit test-fixture opt-in
   * (`RESEND_ALLOW_LOOPBACK_FIXTURE=1`) to point at the local protocol-test fixture
   * (`test/support/fake-resend.ts`) — never to weaken TLS/origin pinning for a real send.
   */
  baseUrl: string;
  /** Request timeout; a provider that never answers is ambiguous, not a silent hang. */
  timeoutMs?: number;
}

/** The ONLY origin production sends are ever allowed to reach — no alternate host/port. */
const PRODUCTION_RESEND_ORIGIN = 'https://api.resend.com';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export function resendTransportOptionsFromEnv(env: NodeJS.ProcessEnv): ResendTransportOptions {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error(
      'RESEND_API_KEY is not configured — billing decision notifications cannot be sent',
    );
  }
  const from = env.RESEND_FROM;
  if (!from) {
    throw new Error(
      'RESEND_FROM is not configured — billing decision notifications cannot be sent',
    );
  }
  const baseUrl = env.RESEND_BASE_URL ?? PRODUCTION_RESEND_ORIGIN;
  return { apiKey, from, baseUrl };
}

/**
 * Independent review repair (2026-10-16), finding 3 — `RESEND_BASE_URL` carried a
 * bearer credential (the API key) in its `Authorization` header on every request;
 * accepting ANY `https://` origin meant a misconfigured or compromised env var could
 * silently exfiltrate that credential to an attacker-controlled HTTPS endpoint. The
 * fixed contract: outside the EXPLICIT test-fixture opt-in
 * (`RESEND_ALLOW_LOOPBACK_FIXTURE=1`, never set in a real deployment), the base URL
 * must be EXACTLY `https://api.resend.com` — no alternate host, no alternate port, no
 * userinfo (`user:pass@host`, which some HTTP clients forward as Basic auth), no path,
 * no query, no fragment. The test-fixture opt-in itself only ever allows an explicit
 * loopback `http://` host, never an arbitrary one. This check runs synchronously,
 * BEFORE any network attempt (`resolveOptions`, called at the top of every send path).
 */
function assertSafeBaseUrl(baseUrl: string, env: NodeJS.ProcessEnv): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('RESEND_BASE_URL refused: value is not a valid URL');
  }
  if (parsed.username || parsed.password) {
    throw new Error('RESEND_BASE_URL refused: embedded userinfo (user:pass@host) is not allowed');
  }
  if ((parsed.pathname !== '/' && parsed.pathname !== '') || parsed.search || parsed.hash) {
    throw new Error('RESEND_BASE_URL refused: must be a bare origin — no path, query, or fragment');
  }

  const allowLoopbackFixture = env.RESEND_ALLOW_LOOPBACK_FIXTURE === '1';
  if (allowLoopbackFixture) {
    if (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname)) return;
    throw new Error(
      'RESEND_BASE_URL refused: RESEND_ALLOW_LOOPBACK_FIXTURE=1 only permits an explicit ' +
        'loopback http:// origin',
    );
  }
  if (parsed.protocol === 'https:' && parsed.hostname === 'api.resend.com' && parsed.port === '') {
    return;
  }
  throw new Error(
    `RESEND_BASE_URL refused: value is not the exact production Resend origin ` +
      `(${PRODUCTION_RESEND_ORIGIN}) and RESEND_ALLOW_LOOPBACK_FIXTURE is not set — the API ` +
      'key must never be sent to an arbitrary origin',
  );
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '127.0.0.1' ||
    normalized.startsWith('127.')
  );
}

interface ResendEmailResponse {
  id: string;
}

/** Marker for messages authored here from bounded, allowlisted metadata only. */
class SafeResendTransportError extends Error {}

/** Reads provider bytes under the caller's still-active AbortSignal and a hard size cap. */
async function readBoundedResponseBody(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new SafeResendTransportError('Resend response exceeded the permitted size');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Resend HTTP transport (https://resend.com/docs/api-reference/emails/send-email).
 * Zero new dependencies: Node's own global `fetch`. Every send carries the occurrence's
 * stable `Idempotency-Key` header — the provider-side boundary this design relies on to
 * make a retried/duplicated/concurrent send collapse to exactly one accepted email.
 */
@Injectable()
export class ResendBillingDecisionNotificationTransport extends BillingDecisionNotificationTransport {
  private readonly resolveOptions: () => ResendTransportOptions;

  constructor(@Optional() options?: ResendTransportOptions) {
    super();
    // Lazy resolution keeps module compilation working in environments without Resend
    // configured (e.g. unit graphs) — the requirement bites at send time, not boot.
    // The base-URL safety check runs here EVERY time, regardless of whether options
    // came from the environment or were passed in directly — there is no construction
    // path that skips it (finding 3: validating only the env-reading helper left a
    // bypass for anyone constructing the transport with explicit options).
    this.resolveOptions = () => {
      const resolved = options ?? resendTransportOptionsFromEnv(process.env);
      assertSafeBaseUrl(resolved.baseUrl, process.env);
      return resolved;
    };
  }

  /** Pure, synchronous: bakes the sender in NOW, so it can be persisted before any send. */
  buildRequestBody(email: BillingDecisionNotificationEmail): string {
    const config = this.resolveOptions();
    return JSON.stringify({
      from: config.from,
      to: [email.to],
      subject: email.subject,
      text: email.body,
    });
  }

  async sendRaw(
    serializedBody: string,
    idempotencyKey: string,
  ): Promise<BillingDecisionNotificationSendResult> {
    const config = this.resolveOptions();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetch(new URL('/emails', config.baseUrl), {
        method: 'POST',
        signal: controller.signal,
        // Finding 3: never silently follow a redirect to a different origin carrying
        // the Authorization header — a redirecting/misbehaving endpoint fails closed.
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: serializedBody,
      });
      // Keep the same deadline alive through ALL response consumption. Fetch resolves
      // as soon as headers arrive; clearing the timer there leaves a stalled success,
      // 409, or error body able to hold a BullMQ worker forever.
      const body = await readBoundedResponseBody(response);

      if (response.status === 409) throw new IdempotencyKeyConflictError();
      if (!response.ok) {
        // Provider-controlled text is intentionally discarded. Status is bounded,
        // allowlisted protocol metadata and is the only response detail exposed to
        // logs/BullMQ failedReason.
        throw new SafeResendTransportError(`Resend request failed (HTTP ${response.status})`);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new SafeResendTransportError('Resend returned an invalid success response');
      }
      const providerMessageId = (parsed as Partial<ResendEmailResponse> | null)?.id;
      if (
        typeof providerMessageId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,200}$/.test(providerMessageId)
      ) {
        throw new SafeResendTransportError('Resend returned an invalid success response');
      }
      return { providerMessageId };
    } catch (error) {
      // Network failure / abort / refused redirect: ambiguous — we do not know whether
      // the provider ever saw this request. The caller retries with the SAME
      // idempotency key AND the SAME persisted body, never anything fresh, so even an
      // actually-accepted-but-unacknowledged send is recovered by replay rather than
      // duplicated.
      if (error instanceof IdempotencyKeyConflictError) throw error;
      if (controller.signal.aborted) throw new Error('Resend request timed out');
      // Never retain raw fetch/parser/provider error text: runtimes and malicious
      // endpoints can reflect URLs, credentials, addresses, or message content into it.
      if (error instanceof SafeResendTransportError) throw new Error(error.message);
      throw new Error('Resend request failed (network or protocol error)');
    } finally {
      clearTimeout(timeout);
    }
  }
}
