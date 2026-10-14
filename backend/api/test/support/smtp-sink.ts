import * as net from 'node:net';

export interface RecordedMail {
  from: string | null;
  recipients: string[];
  data: string;
}

export interface SmtpSink {
  port: number;
  url: string;
  mails: RecordedMail[];
  /** Resolves once at least `count` mails were received (throws on timeout). */
  waitFor: (count: number, timeoutMs?: number) => Promise<RecordedMail[]>;
  close: () => Promise<void>;
}

/**
 * T070 delivery test infrastructure — a minimal real SMTP server (netcat-level ESMTP
 * dialogue: 220 greeting, EHLO, MAIL FROM, RCPT TO, DATA, '.', QUIT) that records whole
 * messages in memory. The PRODUCTION SMTP transport talks to it over a real socket with
 * the real protocol, so an integration assertion against `mails` is an assertion about
 * an actual wire-level delivery to a fixture-owned local destination — never an external
 * send (test fixtures only ever address *.example.invalid recipients).
 */
export async function startSmtpSink(): Promise<SmtpSink> {
  const mails: RecordedMail[] = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);

    let from: string | null = null;
    const recipients: string[] = [];
    let inData = false;
    let dataBuffer = '';

    socket.write('220 t070-sink.example.invalid ESMTP sink\r\n');

    socket.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (inData) {
        dataBuffer += text;
        const terminator = dataBuffer.indexOf('\r\n.\r\n');
        if (terminator >= 0) {
          const message = dataBuffer.slice(0, terminator);
          mails.push({ from, recipients: [...recipients], data: message });
          for (const waiter of [...waiters]) {
            if (mails.length >= waiter.count) {
              waiter.resolve();
              waiters.splice(waiters.indexOf(waiter), 1);
            }
          }
          inData = false;
          dataBuffer = '';
          socket.write('250 accepted\r\n');
        }
        return;
      }

      for (const line of text.split('\r\n')) {
        if (!line) continue;
        const command = line.toUpperCase();
        if (command.startsWith('EHLO') || command.startsWith('HELO')) {
          socket.write('250-t070-sink.example.invalid\r\n250 8BITMIME\r\n');
        } else if (command.startsWith('MAIL FROM:')) {
          from = line.slice('MAIL FROM:'.length).trim().replace(/^<|>$/g, '');
          socket.write('250 ok\r\n');
        } else if (command.startsWith('RCPT TO:')) {
          recipients.push(line.slice('RCPT TO:'.length).trim().replace(/^<|>$/g, ''));
          socket.write('250 ok\r\n');
        } else if (command === 'DATA') {
          inData = true;
          dataBuffer = '';
          socket.write('354 end data with <CR><LF>.<CR><LF>\r\n');
        } else if (command === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else {
          socket.write('250 ok\r\n');
        }
      }
    });

    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as net.AddressInfo;

  return {
    port: address.port,
    url: `smtp://127.0.0.1:${address.port}`,
    mails,
    waitFor: (count: number, timeoutMs = 10_000) =>
      new Promise<RecordedMail[]>((resolve, reject) => {
        const check = (): void => {
          if (mails.length >= count) {
            resolve([...mails]);
            return;
          }
          waiters.push({ count, resolve: () => resolve([...mails]) });
        };
        check();
        setTimeout(
          () => reject(new Error(`SMTP sink did not receive ${count} mail(s)`)),
          timeoutMs,
        ).unref?.();
      }),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1_000))]);
      server.unref();
    },
  };
}
