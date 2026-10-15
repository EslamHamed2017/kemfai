import * as net from 'node:net';
import * as tls from 'node:tls';
import { Injectable, Optional } from '@nestjs/common';

export interface BillingDecisionNotificationEmail {
  to: string;
  subject: string;
  body: string;
}

/**
 * The customer-facing delivery channel for FR-035: an outbound email carrying the
 * decision outcome to the workspace owner. Implementations are injected into
 * `BillingDecisionNotificationProcessor` via `BILLING_DECISION_NOTIFICATION_TRANSPORT`.
 */
export abstract class BillingDecisionNotificationTransport {
  abstract send(email: BillingDecisionNotificationEmail): Promise<void>;
}

export interface SmtpTransportOptions {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  /** PEM bundle of trusted CA certificates for relay TLS verification (or SMTP_CA). */
  ca?: string;
  /**
   * Dial target override (defaults to `host`) for hosts-file-mapped relays and tests;
   * TLS servername/hostname verification always uses `host` and is never weakened.
   */
  connectHost?: string;
}

export function smtpTransportOptionsFromEnv(env: NodeJS.ProcessEnv): SmtpTransportOptions {
  const url = env.SMTP_URL;
  if (!url) {
    throw new Error('SMTP_URL is not configured — billing decision notifications cannot be sent');
  }
  const parsed = new URL(url);
  const from = env.SMTP_FROM;
  if (!from) {
    throw new Error('SMTP_FROM is not configured — billing decision notifications cannot be sent');
  }
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 25,
    secure: parsed.protocol === 'smtps:',
    user: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    pass: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    from,
    ca: env.SMTP_CA,
  };
}

const REPLY_TIMEOUT_MS = 15_000;

/**
 * Smallest REAL email transport with zero new dependencies: a minimal RFC 5321/5322
 * SMTP client over node's own `net`/`tls` sockets — EHLO, verified opportunistic
 * STARTTLS, AUTH PLAIN (TLS only), MAIL FROM, RCPT TO, DATA with base64 UTF-8 body
 * (dot-stuffing-safe by construction), QUIT.
 *
 * Security invariants (Codex round-3 finding 1):
 * - `smtps://` connects with implicit TLS and FULL certificate + hostname verification
 *   (trusted roots plus `SMTP_CA`); nothing is ever sent before the verified handshake.
 * - `smtp://` upgrades with STARTTLS (same verification) whenever the relay offers it;
 *   credentials are transmitted ONLY over verified TLS.
 * - A relay that offers no STARTTLS is accepted ONLY for an explicitly loopback host
 *   WITHOUT credentials — the local ESMTP sink used by the integration suite. Any
 *   other plaintext endpoint is refused, and credentials never touch a plaintext wire.
 */
@Injectable()
export class SmtpBillingDecisionNotificationTransport extends BillingDecisionNotificationTransport {
  private readonly options: () => SmtpTransportOptions;

  constructor(@Optional() options?: SmtpTransportOptions) {
    super();
    // Lazy resolution keeps module compilation working in environments without SMTP
    // configured (e.g. unit graphs) — the requirement bites at send time, not boot.
    this.options = options ? () => options : () => smtpTransportOptionsFromEnv(process.env);
  }

  async send(email: BillingDecisionNotificationEmail): Promise<void> {
    const config = this.options();
    const envelopeFrom = bareAddress(config.from);
    await withSmtpSession(config, async (session) => {
      let capabilities = await session.ehlo();
      if (!config.secure && /(^|\n)250[ -]STARTTLS/i.test(capabilities)) {
        await session.startTls();
        capabilities = await session.ehlo();
      } else if (!config.secure) {
        if (!isLoopbackHost(config.host)) {
          throw new Error(
            `plaintext SMTP refused: relay ${config.host} offers no STARTTLS ` +
              '(use smtps:// or a STARTTLS-capable relay)',
          );
        }
        if (config.user || config.pass) {
          throw new Error(
            'credentials refused on plaintext: loopback sink sessions must not carry credentials',
          );
        }
      }
      if (config.user && config.pass) {
        if (!session.isSecure()) {
          throw new Error('AUTH refused: session is not TLS-verified');
        }
        const credentials = Buffer.from(`\0${config.user}\0${config.pass}`, 'utf8').toString(
          'base64',
        );
        await session.expectCommand(`AUTH PLAIN ${credentials}`, 235);
      }
      await session.expectCommand(`MAIL FROM:<${envelopeFrom}>`, 250);
      await session.expectCommand(`RCPT TO:<${bareAddress(email.to)}>`, [250, 251]);
      await session.expectCommand('DATA', 354);
      await session.send(renderMessage(config, email));
      await session.expect('.', 250);
      await session.expectCommand('QUIT', 221);
    });
  }
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

async function withSmtpSession(
  config: SmtpTransportOptions,
  dialogue: (session: SmtpSession) => Promise<void>,
): Promise<void> {
  const dialHost = config.connectHost ?? config.host;
  let socket: net.Socket;
  if (config.secure) {
    socket = tls.connect({
      host: dialHost,
      port: config.port,
      servername: config.host,
      rejectUnauthorized: true,
      ca: config.ca,
    });
  } else {
    socket = net.connect({ host: dialHost, port: config.port });
  }
  socket.setNoDelay(true);
  const session = new SmtpSession(socket, config);
  try {
    await session.expectGreeting(220);
    await dialogue(session);
  } finally {
    session.destroy();
  }
}

interface SmtpWaiter {
  resolve: (reply: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class SmtpSession {
  private socket: net.Socket;
  private buffer = '';
  private readonly pending: SmtpWaiter[] = [];
  private closed = false;

  constructor(
    socket: net.Socket,
    private readonly config: SmtpTransportOptions,
  ) {
    this.socket = socket;
    this.attachSocket(socket);
  }

  isSecure(): boolean {
    return this.socket instanceof tls.TLSSocket && this.socket.encrypted === true;
  }

  async expectGreeting(code: number): Promise<void> {
    await this.readLine(code);
  }

  async ehlo(): Promise<string> {
    this.socket.write('EHLO kemfai-bff.local\r\n');
    return this.readLine(250);
  }

  /** RFC 3207 STARTTLS upgrade with full certificate/hostname verification. */
  startTls(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.socket.write('STARTTLS\r\n');
      this.readLine(220)
        .then(() => {
          this.detachSocket(this.socket);
          const upgraded = tls.connect({
            socket: this.socket,
            servername: this.config.host,
            rejectUnauthorized: true,
            ca: this.config.ca,
          });
          upgraded.setNoDelay(true);
          upgraded.once('secure', () => {
            this.socket = upgraded;
            this.attachSocket(upgraded);
            resolve();
          });
          upgraded.once('error', (error: Error) => reject(error));
        })
        .catch(reject);
    });
  }

  async expectCommand(command: string, code: number | number[]): Promise<void> {
    this.socket.write(`${command}\r\n`);
    await this.readLine(code);
  }

  async send(payload: string): Promise<void> {
    this.socket.write(payload);
  }

  /** Signals end-of-data; the server's final reply is awaited by expect('.', …). */
  async expect(payload: string, code: number | number[]): Promise<void> {
    this.socket.write(`${payload}\r\n`);
    await this.readLine(code);
  }

  destroy(): void {
    this.closed = true;
    for (const waiter of this.pending) clearTimeout(waiter.timer);
    this.pending.length = 0;
    this.detachSocket(this.socket);
    this.socket.destroy();
  }

  private readLine(expectedCode: number | number[]): Promise<string> {
    if (this.closed) {
      return Promise.reject(new Error('SMTP session already closed'));
    }
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeFromPending(waiter);
        reject(new Error('SMTP reply timed out'));
      }, REPLY_TIMEOUT_MS);
      const waiter: SmtpWaiter = {
        resolve: (reply: string) => {
          clearTimeout(timer);
          try {
            assertReplyCode(reply, expectedCode);
            resolve(reply);
          } catch (error) {
            reject(error as Error);
          }
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
        timer,
      };
      this.pending.push(waiter);
      this.drain();
    });
  }

  private attachSocket(socket: net.Socket): void {
    socket.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      this.drain();
    });
    socket.on('error', (error: Error) => this.failAll(error));
    socket.on('close', () => this.failAll(new Error('SMTP connection closed unexpectedly')));
  }

  private detachSocket(socket: net.Socket): void {
    socket.removeAllListeners('data');
    socket.removeAllListeners('error');
    socket.removeAllListeners('close');
  }

  /**
   * Resolves the oldest waiter with the COMPLETE reply once its final `NNN ` line has
   * arrived: `NNN-` continuation lines accumulate into `stash` and only the final line
   * settles the waiter (with all lines joined by `\n`).
   */
  private drain(): void {
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (/^[0-9]{3}-/.test(line)) {
        (this.stash ??= []).push(line);
        continue;
      }
      const stashed = this.stash ?? [];
      this.stash = undefined;
      const waiter = this.pending.shift();
      if (waiter) waiter.resolve([...stashed, line].join('\n'));
      return;
    }
  }

  private stash: string[] | undefined;

  private removeFromPending(waiter: SmtpWaiter): void {
    const index = this.pending.indexOf(waiter);
    if (index >= 0) this.pending.splice(index, 1);
  }

  private failAll(error: Error): void {
    this.closed = true;
    for (const waiter of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.length = 0;
  }
}

function assertReplyCode(reply: string, expected: number | number[]): void {
  const codes = Array.isArray(expected) ? expected : [expected];
  const finalLine = reply.split('\n').pop() ?? reply;
  const actual = Number(finalLine.slice(0, 3));
  if (!codes.includes(actual)) {
    throw new Error(
      `SMTP reply ${JSON.stringify(finalLine)} does not match expected ${codes.join('/')}`,
    );
  }
}

/** RFC 5321 envelope addresses are bare addr-specs; display names are header-only. */
function bareAddress(address: string): string {
  const bracketed = address.match(/<([^>]+)>/);
  return (bracketed ? bracketed[1] : address).trim();
}

/** Renders an RFC 5322 message with a base64 UTF-8 body (dot-stuffing-safe by encoding). */
function renderMessage(
  config: SmtpTransportOptions,
  email: BillingDecisionNotificationEmail,
): string {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(email.subject, 'utf8').toString('base64')}?=`;
  const encodedBody = Buffer.from(email.body, 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n');
  return [
    `From: ${config.from}`,
    `To: <${email.to}>`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    `Date: ${new Date().toUTCString()}`,
    '',
    encodedBody,
    '',
  ].join('\r\n');
}
