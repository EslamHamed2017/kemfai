import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import * as tls from 'node:tls';
import {
  SmtpBillingDecisionNotificationTransport,
  SmtpTransportOptions,
} from './billing-decision-notification-transport';

/**
 * T070 SMTP security specification (Codex round-3 finding 1).
 *
 * The production transport MUST NOT leak credentials or trust unverified peers:
 * - `smtps://` verifies the relay certificate chain AND hostname (private CA via SMTP_CA);
 * - `smtp://` upgrades with STARTTLS (same verification) whenever the relay offers it;
 * - credentials are only ever transmitted over verified TLS — a plaintext relay that
 *   cannot STARTTLS gets NO AUTH line at all;
 * - plaintext (no TLS at all) is permitted ONLY to an explicitly loopback endpoint
 *   WITHOUT credentials — the local ESMTP sink used by the integration suite. Any
 *   non-loopback plaintext session is refused.
 *
 * Every case below talks to a REAL local socket (plain or TLS) with fixture
 * certificates committed under test/support/fixtures/tls — no protocol mocking.
 */

const FIXTURES = path.join(__dirname, '../../../test/support/fixtures/tls');
const CA_PEM = fs.readFileSync(path.join(FIXTURES, 'ca.pem'), 'utf8');
const SERVER_CERT = fs.readFileSync(path.join(FIXTURES, 'server.pem'), 'utf8');
const SERVER_KEY = fs.readFileSync(path.join(FIXTURES, 'server.key'), 'utf8');
const OTHER_CERT = fs.readFileSync(path.join(FIXTURES, 'other.pem'), 'utf8');
const OTHER_KEY = fs.readFileSync(path.join(FIXTURES, 'other.key'), 'utf8');
const SELF_SIGNED_CERT = fs.readFileSync(path.join(FIXTURES, 'selfsigned.pem'), 'utf8');
const SELF_SIGNED_KEY = fs.readFileSync(path.join(FIXTURES, 'selfsigned.key'), 'utf8');

interface RecordedSession {
  lines: string[];
  tlsUpgraded: boolean;
  authSeenAfterTls: boolean;
  authSeenBeforeTls: boolean;
  close(): Promise<void>;
}

interface TestSmtpServerOptions {
  implicitTls?: { cert: string; key: string };
  advertiseStartTls?: { cert: string; key: string };
}

function startTestSmtpServer(options: TestSmtpServerOptions = {}): Promise<{
  port: number;
  session: RecordedSession;
}> {
  const session: RecordedSession = {
    lines: [],
    tlsUpgraded: false,
    authSeenAfterTls: false,
    authSeenBeforeTls: false,
    close: () => Promise.resolve(),
  };

  const handleConnection = (initialSocket: net.Socket): void => {
    let socket = initialSocket;
    socket.setNoDelay(true);
    let inData = false;
    let buffer = '';
    if (options.implicitTls) {
      session.tlsUpgraded = true;
    }
    socket.write('220 test-smtp ESMTP\r\n');

    const record = (line: string): void => {
      session.lines.push(line);
      if (/^AUTH /i.test(line)) {
        if (session.tlsUpgraded) session.authSeenAfterTls = true;
        else session.authSeenBeforeTls = true;
      }
    };

    const handleLine = (wire: net.Socket, line: string): void => {
      const upper = line.toUpperCase();
      record(line);
      if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
        wire.write(
          options.advertiseStartTls
            ? '250-test-smtp\r\n250 STARTTLS\r\n'
            : '250-test-smtp\r\n250 8BITMIME\r\n',
        );
      } else if (upper === 'STARTTLS') {
        wire.write('220 go tls\r\n');
        wire.removeAllListeners('data');
        const secureSocket = new tls.TLSSocket(wire, {
          isServer: true,
          cert: options.advertiseStartTls?.cert,
          key: options.advertiseStartTls?.key,
        });
        session.tlsUpgraded = true;
        socket = secureSocket;
        attach(secureSocket);
      } else if (upper.startsWith('MAIL FROM')) {
        wire.write('250 ok\r\n');
      } else if (upper.startsWith('RCPT TO')) {
        wire.write('250 ok\r\n');
      } else if (upper === 'DATA') {
        inData = true;
        wire.write('354 go\r\n');
      } else if (upper.startsWith('AUTH')) {
        wire.write('235 ok\r\n');
      } else if (upper === 'QUIT') {
        wire.write('221 bye\r\n');
        wire.end();
      } else {
        wire.write('250 ok\r\n');
      }
    };

    const attach = (wire: net.Socket): void => {
      wire.setNoDelay(true);
      wire.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        if (inData) {
          if (buffer.includes('\r\n.\r\n')) {
            buffer = '';
            inData = false;
            wire.write('250 accepted\r\n');
          }
          return;
        }
        let newline = buffer.indexOf('\r\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 2);
          handleLine(wire, line);
          newline = buffer.indexOf('\r\n');
        }
      });
    };

    attach(socket);
  };

  return new Promise((resolve) => {
    if (options.implicitTls) {
      const server = tls.createServer(
        { cert: options.implicitTls.cert, key: options.implicitTls.key },
        handleConnection,
      );
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as net.AddressInfo).port;
        session.close = async () => {
          (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
          await new Promise<void>((done) => server.close(() => done()));
        };
        resolve({ port, session });
      });
      return;
    }
    const server = net.createServer(handleConnection);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      session.close = async () => {
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        await new Promise<void>((done) => server.close(() => done()));
      };
      resolve({ port, session });
    });
  });
}

function baseOptions(overrides: Partial<SmtpTransportOptions>): SmtpTransportOptions {
  return {
    host: 'smtp.test.invalid',
    port: 0,
    secure: false,
    from: 't070-security@example.invalid',
    ...overrides,
  };
}

describe('SmtpBillingDecisionNotificationTransport security (T070)', () => {
  let servers: RecordedSession[] = [];

  afterEach(async () => {
    for (const session of servers) await session.close();
    servers = [];
  });

  const track = (session: RecordedSession): RecordedSession => {
    servers.push(session);
    return session;
  };

  it('rejects an smtps:// relay whose certificate is not signed by a trusted CA', async () => {
    const { port, session } = await startTestSmtpServer({
      implicitTls: { cert: SELF_SIGNED_CERT, key: SELF_SIGNED_KEY },
    });
    track(session);
    const transport = new SmtpBillingDecisionNotificationTransport(
      baseOptions({ port, secure: true, ca: CA_PEM, connectHost: '127.0.0.1' }),
    );

    await expect(
      transport.send({ to: 'customer@example.invalid', subject: 's', body: 'b' }),
    ).rejects.toThrow(/certificate|verification|self-signed/i);
    expect(session.lines.length).toBe(0);
  });

  it('rejects an smtps:// relay whose certificate hostname does not match', async () => {
    const { port, session } = await startTestSmtpServer({
      implicitTls: { cert: OTHER_CERT, key: OTHER_KEY },
    });
    track(session);
    const transport = new SmtpBillingDecisionNotificationTransport(
      baseOptions({ port, secure: true, ca: CA_PEM, connectHost: '127.0.0.1' }),
    );

    await expect(
      transport.send({ to: 'customer@example.invalid', subject: 's', body: 'b' }),
    ).rejects.toThrow(/hostname|certificate/i);
    expect(session.lines.length).toBe(0);
  });

  it('accepts a verified smtps:// relay (trusted CA + matching hostname)', async () => {
    const { port, session } = await startTestSmtpServer({
      implicitTls: { cert: SERVER_CERT, key: SERVER_KEY },
    });
    track(session);
    const transport = new SmtpBillingDecisionNotificationTransport(
      baseOptions({
        port,
        secure: true,
        ca: CA_PEM,
        user: 'u',
        pass: 'p',
        connectHost: '127.0.0.1',
      }),
    );

    await expect(
      transport.send({ to: 'customer@example.invalid', subject: 's', body: 'b' }),
    ).resolves.toBeUndefined();
    expect(session.lines.some((line) => /^AUTH PLAIN/i.test(line))).toBe(true);
    expect(session.authSeenBeforeTls).toBe(false);
  });

  it('refuses plaintext to a non-loopback host that offers no STARTTLS', async () => {
    const { port, session } = await startTestSmtpServer();
    track(session);
    const transport = new SmtpBillingDecisionNotificationTransport(
      baseOptions({ port, connectHost: '127.0.0.1' }),
    );

    await expect(
      transport.send({ to: 'customer@example.invalid', subject: 's', body: 'b' }),
    ).rejects.toThrow(/plaintext|loopback|STARTTLS/i);
  });

  it('never transmits credentials to a plaintext relay without STARTTLS (no AUTH on the wire)', async () => {
    const { port, session } = await startTestSmtpServer();
    track(session);
    const transport = new SmtpBillingDecisionNotificationTransport(
      baseOptions({ port, connectHost: '127.0.0.1', user: 'secret-user', pass: 'secret-pass' }),
    );

    await expect(
      transport.send({ to: 'customer@example.invalid', subject: 's', body: 'b' }),
    ).rejects.toThrow(/plaintext|STARTTLS|credentials/i);
    expect(session.lines.some((line) => /^AUTH/i.test(line))).toBe(false);
    expect(session.lines.join(' ')).not.toContain('secret-user');
  });

  it('upgrades smtp:// via verified STARTTLS and authenticates only after TLS', async () => {
    const { port, session } = await startTestSmtpServer({
      advertiseStartTls: { cert: SERVER_CERT, key: SERVER_KEY },
    });
    track(session);
    const transport = new SmtpBillingDecisionNotificationTransport(
      baseOptions({
        port,
        connectHost: '127.0.0.1',
        user: 'tls-user',
        pass: 'tls-pass',
        ca: CA_PEM,
      }),
    );

    await expect(
      transport.send({ to: 'customer@example.invalid', subject: 's', body: 'b' }),
    ).resolves.toBeUndefined();
    expect(session.tlsUpgraded).toBe(true);
    expect(session.authSeenAfterTls).toBe(true);
    expect(session.authSeenBeforeTls).toBe(false);
  });

  it('allows plaintext ONLY to an explicit loopback host without credentials (local sink path)', async () => {
    const { port, session } = await startTestSmtpServer();
    track(session);
    const transport = new SmtpBillingDecisionNotificationTransport(
      baseOptions({ host: '127.0.0.1', port }),
    );

    await expect(
      transport.send({ to: 'customer@example.invalid', subject: 's', body: 'b' }),
    ).resolves.toBeUndefined();
    expect(session.lines.some((line) => /^AUTH/i.test(line))).toBe(false);
  });

  it('refuses loopback plaintext when credentials are configured (no cleartext AUTH, ever)', async () => {
    const { port, session } = await startTestSmtpServer();
    track(session);
    const transport = new SmtpBillingDecisionNotificationTransport(
      baseOptions({ host: '127.0.0.1', port, user: 'u', pass: 'p' }),
    );

    await expect(
      transport.send({ to: 'customer@example.invalid', subject: 's', body: 'b' }),
    ).rejects.toThrow(/plaintext|credentials|STARTTLS/i);
    expect(session.lines.some((line) => /^AUTH/i.test(line))).toBe(false);
  });
});
