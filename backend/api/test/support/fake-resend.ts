import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedResendCall {
  idempotencyKey: string | null;
  authorization: string | null;
  bodyHash: string;
  body: unknown;
}

export interface FakeResend {
  url: string;
  /** Every HTTP POST /emails this fixture received, including cache-hit replays. */
  calls: RecordedResendCall[];
  /**
   * Only the sends this fixture genuinely ACCEPTED AS NEW (one entry per distinct
   * Idempotency-Key the fixture had never seen, or whose key had "expired" per
   * `expireKey`) — the assertion surface for "exactly one provider acceptance",
   * regardless of how many times the SAME key was replayed.
   */
  accepted: RecordedResendCall[];
  /** Backdates a key's recorded age so a later replay is treated as past its retention window. */
  expireKey(idempotencyKey: string, ageMs: number): void;
  close(): Promise<void>;
}

interface StoredResult {
  bodyHash: string;
  response: { id: string };
  recordedAt: number;
}

/**
 * HONEST LABEL: this is a LOCAL-ONLY PROTOCOL TEST FIXTURE, not a verification of the
 * real hosted Resend service. It implements, for `POST /emails`, exactly the documented
 * contract this design depends on
 * (https://resend.com/docs/dashboard/emails/idempotency-keys,
 * https://resend.com/docs/api-reference/emails/send-email):
 *
 *  - a request with an `Idempotency-Key` never seen before (or whose prior sighting has
 *    "expired", see `expireKey`) is accepted as a new send and gets a fresh `id`;
 *  - a replay with the SAME key and the byte-identical JSON body returns the EXACT same
 *    cached `{ id }` — no new email is "sent" (does not appear in `accepted` again);
 *  - a replay with the SAME key but a DIFFERENT body is rejected 409 (fail-closed —
 *    Resend's documented behavior for a mismatched replay).
 *
 * No real network egress ever leaves the test process; the adapter under test talks to
 * this server over real HTTP/loopback sockets exactly as it would talk to the real API,
 * which is what makes this a genuine protocol-level test of the adapter's own request
 * construction (headers, idempotency-key reuse, response parsing) — never a claim about
 * the real provider's production behavior.
 */
export async function startFakeResend(): Promise<FakeResend> {
  const calls: RecordedResendCall[] = [];
  const accepted: RecordedResendCall[] = [];
  const store = new Map<string, StoredResult>();

  const server: Server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/emails') {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const idempotencyKey = (req.headers['idempotency-key'] as string | undefined) ?? null;
      const authorization = (req.headers['authorization'] as string | undefined) ?? null;
      const body = raw.length ? JSON.parse(raw) : null;
      const bodyHash = createHash('sha256').update(raw).digest('hex');
      const call: RecordedResendCall = { idempotencyKey, authorization, bodyHash, body };
      calls.push(call);

      if (!idempotencyKey) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Idempotency-Key header is required' }));
        return;
      }

      const EXPIRY_MS = 24 * 60 * 60 * 1000;
      const existing = store.get(idempotencyKey);
      const expired = existing ? Date.now() - existing.recordedAt > EXPIRY_MS : false;

      if (existing && !expired) {
        if (existing.bodyHash === bodyHash) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(existing.response));
          return;
        }
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            message: 'Idempotency-Key already used with a different request body',
          }),
        );
        return;
      }

      // New key, or a prior sighting that "expired" — the documented 24h-retention
      // boundary this design's conservative quarantine cutoff exists to never reach.
      const stored: StoredResult = {
        bodyHash,
        response: { id: randomUUID() },
        recordedAt: Date.now(),
      };
      store.set(idempotencyKey, stored);
      accepted.push(call);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(stored.response));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    accepted,
    expireKey(idempotencyKey: string, ageMs: number): void {
      const existing = store.get(idempotencyKey);
      if (existing) existing.recordedAt = Date.now() - ageMs;
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
