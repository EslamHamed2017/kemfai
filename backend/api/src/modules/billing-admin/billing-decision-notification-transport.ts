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
  };
}

const REPLY_TIMEOUT_MS = 15_000;

/**
 * Smallest REAL email transport with zero new dependencies: a minimal RFC 5321/5322
 * SMTP client over node's own `net`/`tls` sockets — EHLO, optional AUTH PLAIN, MAIL
 * FROM, RCPT TO, DATA with base64 UTF-8 body (dot-stuffing-safe by construction),
 * QUIT. It speaks the actual wire protocol to the relay configured by `SMTP_URL`
 * (`smtp://` clear/STARTTLS-capable relay hop, `smtps://` implicit TLS), the same
 * contract any real deployment's mail relay satisfies. Configuration is missing or
 * the relay is unreachable → `send` rejects and BullMQ retries the job with backoff
 * (events.md: "Retried with backoff") — a notification is never silently dropped.
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
      await session.expectCommand('EHLO kemfai-bff.local', 250);
      if (config.user && config.pass) {
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

/** RFC 5321 envelope addresses are bare addr-specs; display names are header-only. */
function bareAddress(address: string): string {
  const bracketed = address.match(/<([^>]+)>/);
  return (bracketed ? bracketed[1] : address).trim();
}

async function withSmtpSession(
  config: SmtpTransportOptions,
  dialogue: (session: SmtpSession) => Promise<void>,
): Promise<void> {
  const socket: net.Socket = config.secure
    ? tls.connect({ host: config.host, port: config.port, rejectUnauthorized: false })
    : net.connect({ host: config.host, port: config.port });
  socket.setNoDelay(true);
  const session = new SmtpSession(socket);
  try {
    await session.expectGreeting(220);
    await dialogue(session);
  } finally {
    session.destroy();
  }
}

interface SmtpWaiter {
  resolve: (line: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class SmtpSession {
  private buffer = '';
  private readonly pending: SmtpWaiter[] = [];
  private closed = false;

  constructor(private readonly socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      this.drain();
    });
    socket.on('error', (error: Error) => this.failAll(error));
    socket.on('close', () => this.failAll(new Error('SMTP connection closed unexpectedly')));
  }

  async expectGreeting(code: number): Promise<void> {
    const line = await this.readLine();
    assertReplyCode(line, code);
  }

  async expectCommand(command: string, code: number | number[]): Promise<void> {
    this.socket.write(`${command}\r\n`);
    const line = await this.readLine();
    assertReplyCode(line, code);
  }

  async send(payload: string): Promise<void> {
    this.socket.write(payload);
  }

  /** Signals end-of-data; the server's final reply is awaited by expect('.', …). */
  async expect(payload: string, code: number | number[]): Promise<void> {
    this.socket.write(`${payload}\r\n`);
    const line = await this.readLine();
    assertReplyCode(line, code);
  }

  destroy(): void {
    this.closed = true;
    for (const waiter of this.pending) clearTimeout(waiter.timer);
    this.pending.length = 0;
    this.socket.destroy();
  }

  private readLine(): Promise<string> {
    if (this.closed) {
      return Promise.reject(new Error('SMTP session already closed'));
    }
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeFromPending(waiter);
        reject(new Error('SMTP reply timed out'));
      }, REPLY_TIMEOUT_MS);
      const waiter: SmtpWaiter = {
        resolve: (line: string) => {
          clearTimeout(timer);
          resolve(line);
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

  private drain(): void {
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      // Multi-line replies (`250-…` continuation lines) resolve on the final `NNN ` line.
      const isFinal = /^[0-9]{3} /.test(line) || !/^[0-9]{3}-/.test(line);
      if (isFinal) {
        const waiter = this.pending.shift();
        if (waiter) waiter.resolve(line);
        return;
      }
    }
  }

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

function assertReplyCode(line: string, expected: number | number[]): void {
  const codes = Array.isArray(expected) ? expected : [expected];
  const actual = Number(line.slice(0, 3));
  if (!codes.includes(actual)) {
    throw new Error(
      `SMTP reply ${JSON.stringify(line)} does not match expected ${codes.join('/')}`,
    );
  }
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
