import { ResendBillingDecisionNotificationTransport } from './billing-decision-notification-transport';

const SENSITIVE = [
  're_live_SUPER_SECRET_credential',
  'victim+private@example.invalid',
  'CONFIDENTIAL rejection details',
];

/**
 * No sockets or external network: fetch acknowledges response headers immediately,
 * while the body stream remains pending until the request AbortSignal fires. The old
 * implementation cleared its timer after fetch/header resolution, so these promises
 * never settled and the tests timed out; the fixed implementation aborts body reading.
 */
describe('Resend transport whole-response deadline and error hygiene (T070)', () => {
  const originalFetch = global.fetch;
  const originalAllowLoopback = process.env.RESEND_ALLOW_LOOPBACK_FIXTURE;

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalAllowLoopback === undefined) delete process.env.RESEND_ALLOW_LOOPBACK_FIXTURE;
    else process.env.RESEND_ALLOW_LOOPBACK_FIXTURE = originalAllowLoopback;
  });

  function transport(timeoutMs = 40) {
    process.env.RESEND_ALLOW_LOOPBACK_FIXTURE = '1';
    return new ResendBillingDecisionNotificationTransport({
      apiKey: SENSITIVE[0],
      from: 'Billing <sender@example.invalid>',
      baseUrl: 'http://127.0.0.1:1',
      timeoutMs,
    });
  }

  function headersThenStalledBody(status: number): jest.Mock {
    return jest.fn().mockImplementation((_url: URL, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener('abort', () => controller.error(new Error(SENSITIVE.join('|'))));
        },
      });
      return Promise.resolve(new Response(body, { status }));
    });
  }

  it.each([200, 409, 500])(
    'bounds body consumption after HTTP %i headers have arrived',
    async (status) => {
      global.fetch = headersThenStalledBody(status);
      const started = Date.now();
      await expect(transport().sendRaw('{}', 'kemfai/test/deadline')).rejects.toThrow(/timed out/);
      expect(Date.now() - started).toBeLessThan(500);
    },
  );

  it.each([
    [500, JSON.stringify({ secret: SENSITIVE })],
    [409, JSON.stringify({ secret: SENSITIVE })],
    [200, `{ "id": "${SENSITIVE.join('|')}`],
    [200, JSON.stringify({ id: SENSITIVE.join('|') })],
  ])('does not retain an untrusted HTTP %i body in loggable errors', async (status, body) => {
    global.fetch = jest.fn().mockResolvedValue(new Response(body, { status }));
    const error = await transport(500)
      .sendRaw('{}', 'kemfai/test/redaction')
      .then(
        () => undefined,
        (caught: Error) => caught,
      );
    const loggable = `${error!.name}: ${error!.message}\n${error!.stack ?? ''}`;
    for (const value of SENSITIVE) expect(loggable).not.toContain(value);
  });

  it('does not retain raw network error text in loggable errors', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error(SENSITIVE.join('|')));
    const error = await transport(500)
      .sendRaw('{}', 'kemfai/test/network-redaction')
      .then(
        () => undefined,
        (caught: Error) => caught,
      );
    const loggable = `${error!.name}: ${error!.message}\n${error!.stack ?? ''}`;
    for (const value of SENSITIVE) expect(loggable).not.toContain(value);
  });

  it('accepts a success response whose encoded body is exactly 64 KiB', async () => {
    const prefix = '{"id":"provider-id","padding":"';
    const suffix = '"}';
    const body = `${prefix}${'x'.repeat(64 * 1024 - prefix.length - suffix.length)}${suffix}`;
    expect(new TextEncoder().encode(body)).toHaveLength(64 * 1024);
    global.fetch = jest.fn().mockResolvedValue(new Response(body, { status: 200 }));

    await expect(transport(500).sendRaw('{}', 'kemfai/test/exact-limit')).resolves.toEqual({
      providerMessageId: 'provider-id',
    });
  });

  it('rejects a response one byte above 64 KiB without retaining its content', async () => {
    const reflectedSecret = SENSITIVE.join('|');
    const body = `${'x'.repeat(64 * 1024 + 1 - reflectedSecret.length)}${reflectedSecret}`;
    expect(new TextEncoder().encode(body)).toHaveLength(64 * 1024 + 1);
    global.fetch = jest.fn().mockResolvedValue(new Response(body, { status: 200 }));

    const error = await transport(500)
      .sendRaw('{}', 'kemfai/test/overflow')
      .then(
        () => undefined,
        (caught: Error) => caught,
      );
    expect(error!.message).toBe('Resend response exceeded the permitted size');
    const loggable = `${error!.name}: ${error!.message}\n${error!.stack ?? ''}`;
    for (const value of SENSITIVE) expect(loggable).not.toContain(value);
  });
});
