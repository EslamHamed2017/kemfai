import * as net from 'node:net';

export interface SelectiveRedisProxy {
  port: number;
  url: string;
  /** How many client commands were answered with a forced error so far. */
  failedCommands: () => number;
  close: () => Promise<void>;
}

/**
 * T070 real-failure test infrastructure — a tiny local TCP proxy in front of the REAL
 * test Redis that answers client commands targeting a chosen key substring with a
 * genuine Redis protocol error (`-ERR ...`), while transparently proxying everything
 * else byte-for-byte. This produces REAL `Queue.add()` rejections (protocol-level, from
 * a real server role) for exactly the selected queue — no product mocking, no shared
 * instance mutation — so an application booted against the proxy keeps every other
 * Redis concern (sweep schedules, other queues) fully functional.
 *
 * The proxy pins its backend connection to the selected DB with an initial SELECT, so
 * the client never needs (and never gets) access to any other database.
 */
export async function startSelectiveRedisProxy(options: {
  backend: { host: string; port: number; db: number };
  failWhenArgMatches: RegExp;
}): Promise<SelectiveRedisProxy> {
  const clients = new Set<net.Socket>();
  const backends = new Set<net.Socket>();
  let failures = 0;
  let closing = false;

  const server = net.createServer((client) => {
    // Once teardown began, refuse new connections outright — a reconnecting client
    // must not be able to re-establish handles through an unref'd-but-listening
    // server and keep the suite's event loop alive.
    if (closing) {
      client.destroy();
      return;
    }
    clients.add(client);
    client.setNoDelay(true);

    const backend = net.connect(options.backend.port, options.backend.host);
    backend.setNoDelay(true);
    backends.add(backend);

    // Pin the backend connection to the chosen DB before any proxied traffic.
    backend.write(`SELECT ${options.backend.db}\r\n`);
    let backendHandshakeDone = false;

    backend.on('data', (chunk) => {
      if (!backendHandshakeDone) {
        backendHandshakeDone = true;
        // The handshake SELECT is the very first command on a fresh connection, so its
        // `+OK` reply arrives alone; consume exactly that and forward the remainder.
        const reply = chunk.toString('latin1');
        const okIndex = reply.indexOf('+OK\r\n');
        const rest = okIndex >= 0 ? chunk.subarray(okIndex + 5) : Buffer.alloc(0);
        if (rest.length > 0) client.write(rest);
        return;
      }
      client.write(chunk);
    });

    // Minimal RESP array parser over the client stream: whole commands are either
    // forwarded verbatim or swallowed and answered with a forced protocol error.
    let pending = Buffer.alloc(0);
    const tryDrain = (): void => {
      for (;;) {
        const command = readCompleteCommand(pending);
        if (!command) return;
        pending = pending.subarray(command.byteLength);
        if (command.args.some((arg) => options.failWhenArgMatches.test(arg))) {
          failures += 1;
          client.write('-ERR forced selectivity: command rejected by test proxy\r\n');
        } else {
          backend.write(command.raw);
        }
      }
    };

    client.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      tryDrain();
    });

    const drop = (): void => {
      clients.delete(client);
      backends.delete(backend);
      backend.destroy();
    };
    client.on('close', drop);
    client.on('error', drop);
    // When the real Redis ends the conversation (e.g. after a forwarded QUIT), the
    // client's socket must be FIN'd too — otherwise the pair lingers half-open
    // forever and keeps the suite's event loop alive.
    backend.on('close', () => {
      clients.delete(client);
      backends.delete(backend);
      client.end();
    });
    backend.on('error', () => {
      client.destroy();
      backends.delete(backend);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as net.AddressInfo;

  return {
    port: address.port,
    url: `redis://127.0.0.1:${address.port}`,
    failedCommands: () => failures,
    close: async () => {
      closing = true;
      for (const socket of [...clients, ...backends]) socket.destroy();
      await closeNetServer(server);
    },
  };
}

/**
 * Fixture-owned server teardown that guarantees the handle cannot outlive the suite:
 * destroy every tracked connection, ask the server to close (Node ≥18.2 additionally
 * drops anything straggling via closeAllConnections), then unref so the event loop is
 * never kept alive by a server whose close callback would not otherwise fire.
 */
export async function closeNetServer(server: net.Server): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1_000))]);
  server.unref();
}

interface CompleteCommand {
  raw: Buffer;
  args: string[];
  byteLength: number;
}

/** Reads one complete RESP array command (`*N` followed by N bulk strings) or null. */
function readCompleteCommand(buffer: Buffer): CompleteCommand | null {
  const header = buffer.indexOf('\r\n');
  if (header < 0) return null;
  const headerText = buffer.toString('latin1', 0, header);
  if (!headerText.startsWith('*')) {
    // Inline commands are not used by ioredis; treat any non-array leading byte as a
    // complete opaque command to forward (safest pass-through).
    return { raw: buffer.subarray(0, header + 2), args: [headerText], byteLength: header + 2 };
  }
  const count = Number(headerText.slice(1));
  if (!Number.isInteger(count) || count < 0) return null;

  const args: string[] = [headerText];
  let offset = header + 2;
  for (let index = 0; index < count; index += 1) {
    const lengthHeader = buffer.indexOf('\r\n', offset);
    if (lengthHeader < 0) return null;
    const lengthText = buffer.toString('latin1', offset, lengthHeader);
    if (!lengthText.startsWith('$')) return null;
    const length = Number(lengthText.slice(1));
    if (!Number.isInteger(length) || length < 0) return null;
    const valueEnd = lengthHeader + 2 + length + 2;
    if (buffer.length < valueEnd) return null;
    args.push(buffer.toString('latin1', lengthHeader + 2, lengthHeader + 2 + length));
    offset = valueEnd;
  }
  return { raw: buffer.subarray(0, offset), args, byteLength: offset };
}

/** A TCP server that accepts connections and then stays silent forever — a hung Redis. */
export interface SilentServer {
  port: number;
  url: string;
  close: () => Promise<void>;
}

export async function startSilentServer(): Promise<SilentServer> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    // Deliberately never reply: commands sent here block indefinitely
    // (maxRetriesPerRequest: null), which is exactly the "replica died mid-dispatch"
    // seam the lease-takeover test needs.
    socket.on('error', () => sockets.delete(socket));
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as net.AddressInfo;
  return {
    port: address.port,
    url: `redis://127.0.0.1:${address.port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await closeNetServer(server);
    },
  };
}
