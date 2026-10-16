import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startFakeResend, type FakeResend } from '../../../test/support/fake-resend';
import {
  IdempotencyKeyConflictError,
  ResendBillingDecisionNotificationTransport,
  resendTransportOptionsFromEnv,
} from './billing-decision-notification-transport';

const EMAIL = { to: 'owner@example.invalid', subject: 'Subject', body: 'Body text.' };

/**
 * T070 (owner decision 2026-10-15T16:33:05Z; independent review repair 2026-10-16,
 * finding 3) — real HTTP-over-loopback coverage of the Resend adapter's own request
 * construction, origin pinning, and response handling, against the documented
 * local-only protocol-test fixture (`fake-resend.ts`, honestly labeled: NOT a
 * verification of the real hosted Resend service). No real hosted request is ever
 * made: every "production origin accepted" assertion below stops at
 * `resendTransportOptionsFromEnv` validation (synchronous, before any network attempt)
 * and never calls `sendRaw`.
 */
describe('ResendBillingDecisionNotificationTransport (T070)', () => {
  let fixture: FakeResend;
  const originalAllowLoopback = process.env.RESEND_ALLOW_LOOPBACK_FIXTURE;

  beforeAll(async () => {
    fixture = await startFakeResend();
  });

  afterAll(async () => {
    await fixture.close();
  });

  afterEach(() => {
    if (originalAllowLoopback === undefined) {
      delete process.env.RESEND_ALLOW_LOOPBACK_FIXTURE;
    } else {
      process.env.RESEND_ALLOW_LOOPBACK_FIXTURE = originalAllowLoopback;
    }
  });

  it('requires RESEND_API_KEY', () => {
    expect(() =>
      resendTransportOptionsFromEnv({ RESEND_FROM: 'Billing <b@example.invalid>' }),
    ).toThrow(/RESEND_API_KEY/);
  });

  it('requires RESEND_FROM', () => {
    expect(() => resendTransportOptionsFromEnv({ RESEND_API_KEY: 'key' })).toThrow(/RESEND_FROM/);
  });

  describe('finding 3 — RESEND_BASE_URL origin pinning (credential exfiltration hardening)', () => {
    function transportWith(baseUrl: string | undefined) {
      return new ResendBillingDecisionNotificationTransport({
        apiKey: 'resend-test-key',
        from: 'Billing <b@example.invalid>',
        baseUrl: baseUrl ?? 'https://api.resend.com',
      });
    }

    it('accepts the exact production origin with no RESEND_BASE_URL override', () => {
      delete process.env.RESEND_ALLOW_LOOPBACK_FIXTURE;
      expect(() => transportWith(undefined).buildRequestBody(EMAIL)).not.toThrow();
    });

    it('accepts the exact production origin explicitly', () => {
      delete process.env.RESEND_ALLOW_LOOPBACK_FIXTURE;
      expect(() => transportWith('https://api.resend.com').buildRequestBody(EMAIL)).not.toThrow();
    });

    it('rejects an arbitrary HTTPS origin BEFORE any network attempt (no loopback flag)', () => {
      delete process.env.RESEND_ALLOW_LOOPBACK_FIXTURE;
      expect(() => transportWith('https://evil.example.invalid').buildRequestBody(EMAIL)).toThrow(
        /not the exact production Resend origin/,
      );
    });

    it('rejects an alternate port on the real hostname', () => {
      delete process.env.RESEND_ALLOW_LOOPBACK_FIXTURE;
      expect(() => transportWith('https://api.resend.com:8443').buildRequestBody(EMAIL)).toThrow(
        /not the exact production Resend origin/,
      );
    });

    it('rejects embedded userinfo (user:pass@host) even on the real hostname', () => {
      delete process.env.RESEND_ALLOW_LOOPBACK_FIXTURE;
      expect(() =>
        transportWith('https://user:pass@api.resend.com').buildRequestBody(EMAIL),
      ).toThrow(/userinfo/);
    });

    it('rejects a path/query/fragment on the base URL', () => {
      delete process.env.RESEND_ALLOW_LOOPBACK_FIXTURE;
      expect(() => transportWith('https://api.resend.com/evil').buildRequestBody(EMAIL)).toThrow(
        /bare origin/,
      );
      expect(() => transportWith('https://api.resend.com?x=1').buildRequestBody(EMAIL)).toThrow(
        /bare origin/,
      );
    });

    it('rejects an explicit loopback http:// origin WITHOUT the test-fixture opt-in', () => {
      delete process.env.RESEND_ALLOW_LOOPBACK_FIXTURE;
      expect(() => transportWith(fixture.url).buildRequestBody(EMAIL)).toThrow(
        /not the exact production Resend origin/,
      );
    });

    it('accepts the explicit loopback fixture ONLY with RESEND_ALLOW_LOOPBACK_FIXTURE=1', () => {
      process.env.RESEND_ALLOW_LOOPBACK_FIXTURE = '1';
      expect(() => transportWith(fixture.url).buildRequestBody(EMAIL)).not.toThrow();
    });

    it('the test-fixture opt-in still refuses a non-loopback or non-http origin', () => {
      process.env.RESEND_ALLOW_LOOPBACK_FIXTURE = '1';
      expect(() => transportWith('https://evil.example.invalid').buildRequestBody(EMAIL)).toThrow(
        /only permits an explicit/,
      );
      expect(() => transportWith('http://evil.example.invalid').buildRequestBody(EMAIL)).toThrow(
        /only permits an explicit/,
      );
    });

    it('a direct-options construction is validated identically to env-based resolution (no bypass)', () => {
      delete process.env.RESEND_ALLOW_LOOPBACK_FIXTURE;
      // Constructing with explicit options (exactly what every test in this file, and
      // nothing in the real module graph, does) must still be refused for an arbitrary
      // origin — validation cannot be skipped by supplying options directly.
      const transport = new ResendBillingDecisionNotificationTransport({
        apiKey: 'resend-test-key',
        from: 'Billing <b@example.invalid>',
        baseUrl: 'https://attacker.example.invalid',
      });
      expect(() => transport.buildRequestBody(EMAIL)).toThrow(
        /not the exact production Resend origin/,
      );
    });

    it('never follows a redirect — the Authorization header never reaches a second origin', async () => {
      let attackerReceivedRequest = false;
      const attacker: Server = createServer((_req, res) => {
        attackerReceivedRequest = true;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'should-never-be-reached' }));
      });
      await new Promise<void>((resolve) => attacker.listen(0, '127.0.0.1', resolve));
      const attackerPort = (attacker.address() as AddressInfo).port;

      const redirector: Server = createServer((_req, res) => {
        res.writeHead(302, { location: `http://127.0.0.1:${attackerPort}/emails` });
        res.end();
      });
      await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', resolve));
      const redirectorPort = (redirector.address() as AddressInfo).port;

      process.env.RESEND_ALLOW_LOOPBACK_FIXTURE = '1';
      try {
        const transport = new ResendBillingDecisionNotificationTransport({
          apiKey: 'resend-test-key',
          from: 'Billing <b@example.invalid>',
          baseUrl: `http://127.0.0.1:${redirectorPort}`,
        });
        const body = transport.buildRequestBody(EMAIL);
        await expect(
          transport.sendRaw(body, 'kemfai/notification.billing_decision/redirect-test'),
        ).rejects.toThrow(/Resend request failed/);
        expect(attackerReceivedRequest).toBe(false);
      } finally {
        await new Promise<void>((resolve) => redirector.close(() => resolve()));
        await new Promise<void>((resolve) => attacker.close(() => resolve()));
      }
    });
  });

  function loopbackTransport() {
    process.env.RESEND_ALLOW_LOOPBACK_FIXTURE = '1';
    return new ResendBillingDecisionNotificationTransport({
      apiKey: 'resend-test-key',
      from: 'Billing <b@example.invalid>',
      baseUrl: fixture.url,
    });
  }

  it('buildRequestBody bakes the sender in now, as a complete serialized JSON body', () => {
    const transport = loopbackTransport();
    const body = transport.buildRequestBody(EMAIL);
    expect(JSON.parse(body)).toEqual({
      from: 'Billing <b@example.invalid>',
      to: [EMAIL.to],
      subject: EMAIL.subject,
      text: EMAIL.body,
    });
  });

  it('sendRaw posts the exact given bytes with the Authorization bearer and Idempotency-Key headers, returning the provider id', async () => {
    const transport = loopbackTransport();
    const key = `kemfai/notification.billing_decision/${crypto.randomUUID()}`;
    const body = transport.buildRequestBody(EMAIL);

    const result = await transport.sendRaw(body, key);

    expect(result.providerMessageId).toMatch(/^[0-9a-f-]{36}$/);
    const call = fixture.accepted.at(-1)!;
    expect(call.idempotencyKey).toBe(key);
    expect(call.authorization).toBe('Bearer resend-test-key');
    expect(JSON.stringify(call.body)).toBe(body);
  });

  it('replaying the SAME key with the SAME bytes returns the SAME provider id and accepts nothing new', async () => {
    const transport = loopbackTransport();
    const key = `kemfai/notification.billing_decision/${crypto.randomUUID()}`;
    const body = transport.buildRequestBody(EMAIL);

    const first = await transport.sendRaw(body, key);
    const before = fixture.accepted.length;
    const second = await transport.sendRaw(body, key);

    expect(second.providerMessageId).toBe(first.providerMessageId);
    expect(fixture.accepted.length).toBe(before);
  });

  it('replaying the SAME key with DIFFERENT bytes throws IdempotencyKeyConflictError (fail-closed 409)', async () => {
    const transport = loopbackTransport();
    const key = `kemfai/notification.billing_decision/${crypto.randomUUID()}`;

    await transport.sendRaw(transport.buildRequestBody(EMAIL), key);
    await expect(
      transport.sendRaw(transport.buildRequestBody({ ...EMAIL, body: 'different' }), key),
    ).rejects.toThrow(IdempotencyKeyConflictError);
  });

  it('treats a non-2xx/non-409 provider response as ambiguous (plain Error, caller retries)', async () => {
    const errorServer: Server = createServer((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'internal error' }));
    });
    await new Promise<void>((resolve) => errorServer.listen(0, '127.0.0.1', resolve));
    const port = (errorServer.address() as AddressInfo).port;
    try {
      process.env.RESEND_ALLOW_LOOPBACK_FIXTURE = '1';
      const transport = new ResendBillingDecisionNotificationTransport({
        apiKey: 'resend-test-key',
        from: 'Billing <b@example.invalid>',
        baseUrl: `http://127.0.0.1:${port}`,
      });
      await expect(
        transport.sendRaw(
          transport.buildRequestBody(EMAIL),
          'kemfai/notification.billing_decision/x',
        ),
      ).rejects.toThrow(/500/);
    } finally {
      await new Promise<void>((resolve) => errorServer.close(() => resolve()));
    }
  });

  it('treats a network failure as ambiguous (plain Error, caller retries with the same key and same bytes)', async () => {
    process.env.RESEND_ALLOW_LOOPBACK_FIXTURE = '1';
    const transport = new ResendBillingDecisionNotificationTransport({
      apiKey: 'resend-test-key',
      from: 'Billing <b@example.invalid>',
      // Nothing listens here (loopback, unused high port) — a real connection failure.
      baseUrl: 'http://127.0.0.1:1',
    });
    await expect(
      transport.sendRaw(
        transport.buildRequestBody(EMAIL),
        'kemfai/notification.billing_decision/unreachable',
      ),
    ).rejects.toThrow(/Resend request failed/);
  });

  describe('whole-response deadline and log-safe failures', () => {
    const secrets = {
      credential: 're_live_SUPER_SECRET_credential',
      email: 'victim+private@example.invalid',
      message: 'CONFIDENTIAL rejection details and bank reference 12345',
    };

    async function withServer(
      handler: RequestListener,
      run: (baseUrl: string) => Promise<void>,
    ): Promise<void> {
      const server = createServer(handler);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }

    function transport(baseUrl: string, timeoutMs = 60) {
      process.env.RESEND_ALLOW_LOOPBACK_FIXTURE = '1';
      return new ResendBillingDecisionNotificationTransport({
        apiKey: secrets.credential,
        from: 'Billing <sender@example.invalid>',
        baseUrl,
        timeoutMs,
      });
    }

    it.each([
      ['success', 200],
      ['error', 500],
      ['conflict', 409],
    ] as const)(
      'keeps the abort deadline active after %s headers while the body stalls',
      async (_label, status) => {
        await withServer(
          (_req, res) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.flushHeaders();
            setTimeout(() => res.end(JSON.stringify({ id: 'too-late' })), 250);
          },
          async (baseUrl) => {
            const started = Date.now();
            const pending = transport(baseUrl).sendRaw('{}', 'kemfai/test/stalled-body');
            await expect(pending).rejects.toThrow(/timed out/);
            expect(Date.now() - started).toBeLessThan(220);
          },
        );
      },
    );

    it.each([
      ['non-2xx', 500, JSON.stringify(secrets)],
      ['conflict', 409, JSON.stringify(secrets)],
      ['malformed success', 200, `{ "id": "${secrets.message}`],
      ['sensitive success without a valid id', 200, JSON.stringify(secrets)],
    ] as const)('never retains provider body data in a %s error', async (_label, status, body) => {
      await withServer(
        (_req, res) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(body);
        },
        async (baseUrl) => {
          const error = await transport(baseUrl, 500)
            .sendRaw('{}', 'kemfai/test/sanitized')
            .then(
              () => undefined,
              (caught: Error) => caught,
            );
          expect(error).toBeInstanceOf(Error);
          const loggable = `${error!.name}: ${error!.message}\n${error!.stack ?? ''}`;
          for (const sensitive of Object.values(secrets)) expect(loggable).not.toContain(sensitive);
        },
      );
    });

    it('never retains raw network error text in the thrown error', async () => {
      const originalFetch = global.fetch;
      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error(`${secrets.credential} ${secrets.email} ${secrets.message}`));
      try {
        const error = await transport('http://127.0.0.1:1', 500)
          .sendRaw('{}', 'kemfai/test/network-redaction')
          .then(
            () => undefined,
            (caught: Error) => caught,
          );
        const loggable = `${error!.name}: ${error!.message}\n${error!.stack ?? ''}`;
        for (const sensitive of Object.values(secrets)) expect(loggable).not.toContain(sensitive);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });
});
