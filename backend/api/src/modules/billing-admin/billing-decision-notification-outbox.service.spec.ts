import controlDataSource from '../../database/data-source';
import { BillingDecisionNotificationOutboxService } from './billing-decision-notification-outbox.service';

jest.mock('../../database/data-source', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));

const mockedQuery = controlDataSource.query as jest.Mock;

const ROW_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REQUEST_BODY = JSON.stringify({
  from: 'Billing <b@example.invalid>',
  to: ['owner@example.invalid'],
  subject: 'Subject',
  text: 'Body.',
});

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ROW_ID,
    submission_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    tenant_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    decision: 'reject',
    decision_occurrence: 1,
    notes: 'Amount mismatch.',
    occurred_at: new Date('2026-10-05T00:00:00.000Z'),
    job_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.reject.1',
    state: 'enqueued',
    delivered_at: null,
    first_send_attempted_at: null,
    provider_request_body: null,
    provider_message_id: null,
    delivery_rejected_at: null,
    quarantined_at: null,
    retry_count: 0,
    lease_owner: null,
    lease_expires_at: null,
    ...overrides,
  };
}

/**
 * T070 targeted repair (parent-reported real-PG receipt, 2026-10-15): `UPDATE ...
 * RETURNING` comes back from `controlDataSource.query` as a `[rows, affectedRowCount]`
 * TUPLE, not a bare rows array — `claimBatchForRecovery` already unwraps this (comment
 * in this same file), but `beginSendAttempt` did not, so `updated[0]` was the inner
 * rows array (not a row), and every camelCase field — starting with
 * `firstSendAttemptedAt` — hydrated as `undefined`/null. That broke the processor's
 * non-null assertion on `claimed.firstSendAttemptedAt!.getTime()`.
 *
 * Independent review repair (2026-10-16), finding 1: `beginSendAttempt` persists the
 * COMPLETE serialized provider request body (including the sender) as a single
 * `provider_request_body` column, atomically alongside `first_send_attempted_at`, via
 * the same `COALESCE` idiom — the first caller's bytes win permanently; a later
 * caller's own (possibly different, e.g. after a locale OR `RESEND_FROM` change) build
 * is always discarded in favor of what is already persisted. This happens for every
 * path that calls `beginSendAttempt` (crash replay, lost ack, concurrency,
 * pre-provider failure, 409, quarantine). These tests pin the exact pg tuple shape so
 * this regression class cannot silently return.
 */
describe('BillingDecisionNotificationOutboxService.beginSendAttempt (T070 targeted repair)', () => {
  let service: BillingDecisionNotificationOutboxService;

  beforeEach(() => {
    service = new BillingDecisionNotificationOutboxService();
    mockedQuery.mockReset();
  });

  it('unwraps the real pg UPDATE...RETURNING tuple shape and hydrates a non-null firstSendAttemptedAt', async () => {
    const attemptedAt = new Date('2026-10-05T12:00:00.000Z');
    mockedQuery.mockResolvedValueOnce([
      [baseRow({ first_send_attempted_at: attemptedAt, provider_request_body: REQUEST_BODY })],
      1,
    ]);

    const row = await service.beginSendAttempt(ROW_ID, REQUEST_BODY);

    expect(row.firstSendAttemptedAt).toBeInstanceOf(Date);
    expect(row.firstSendAttemptedAt!.toISOString()).toBe(attemptedAt.toISOString());
    expect(row.id).toBe(ROW_ID);
    expect(row.deliveredAt).toBeNull();
    expect(mockedQuery).toHaveBeenCalledWith(expect.anything(), [ROW_ID, REQUEST_BODY]);
  });

  it('also accepts a bare rows array (defensive: tolerate either driver shape)', async () => {
    const attemptedAt = new Date('2026-10-05T12:00:00.000Z');
    mockedQuery.mockResolvedValueOnce([
      baseRow({ first_send_attempted_at: attemptedAt, provider_request_body: REQUEST_BODY }),
    ]);

    const row = await service.beginSendAttempt(ROW_ID, REQUEST_BODY);

    expect(row.firstSendAttemptedAt).toBeInstanceOf(Date);
    expect(row.providerRequestBody).toBe(REQUEST_BODY);
  });

  it('re-reads the authoritative row when the guarded UPDATE affects zero rows (already terminal)', async () => {
    const deliveredAt = new Date('2026-10-05T12:05:00.000Z');
    // First call: the guarded UPDATE matched nothing (already delivered elsewhere) — the
    // real pg driver still returns the tuple shape, just with an empty rows array.
    mockedQuery.mockResolvedValueOnce([[], 0]);
    mockedQuery.mockResolvedValueOnce([baseRow({ delivered_at: deliveredAt })]);

    const row = await service.beginSendAttempt(ROW_ID, REQUEST_BODY);

    expect(row.deliveredAt).toBeInstanceOf(Date);
    expect(mockedQuery).toHaveBeenCalledTimes(2);
  });

  it('is stable across repeated attempts: a second call never overwrites the first persisted body (COALESCE), proven against the same tuple shape', async () => {
    const firstAttempt = new Date('2026-10-05T12:00:00.000Z');
    const firstBody = JSON.stringify({
      from: 'Billing <b@example.invalid>',
      to: ['first@example.invalid'],
      subject: 'First',
      text: 'First body.',
    });
    const secondBody = JSON.stringify({
      from: 'Billing <changed@example.invalid>',
      to: ['first@example.invalid'],
      subject: 'First',
      text: 'First body.',
    });
    // The mocked DB always answers with the FIRST body — exactly what the real
    // COALESCE("provider_request_body", $2) would do once it is already non-null —
    // proving the second caller's own (different, e.g. post-RESEND_FROM-change) build
    // is discarded in favor of what is persisted.
    mockedQuery.mockResolvedValueOnce([
      [baseRow({ first_send_attempted_at: firstAttempt, provider_request_body: firstBody })],
      1,
    ]);
    mockedQuery.mockResolvedValueOnce([
      [baseRow({ first_send_attempted_at: firstAttempt, provider_request_body: firstBody })],
      1,
    ]);

    const first = await service.beginSendAttempt(ROW_ID, firstBody);
    const second = await service.beginSendAttempt(ROW_ID, secondBody);

    expect(first.firstSendAttemptedAt!.toISOString()).toBe(firstAttempt.toISOString());
    expect(second.firstSendAttemptedAt!.toISOString()).toBe(firstAttempt.toISOString());
    expect(second.providerRequestBody).toBe(firstBody);
    expect(second.providerRequestBody).not.toBe(secondBody);
  });

  it('defect-sensitive: the UPDATE text itself must COALESCE provider_request_body, never plain-overwrite it (the mock cannot catch this on its own)', () => {
    // A mock that always answers with the row I choose cannot, by itself, distinguish
    // a correct `COALESCE("provider_request_body", $2)` from a buggy plain
    // `"provider_request_body" = $2` (both would make the OTHER assertions in this file
    // pass, since the mock's canned response is fixed regardless of the SQL text). This
    // asserts on the ACTUAL SQL string `beginSendAttempt` sent, so a regression back to
    // a plain overwrite — which Postgres would happily execute as "always take the
    // latest attempt's bytes", silently reintroducing the config-drift defect reviewer
    // finding 1 reported — fails HERE even though the DB-shape tests above would not
    // catch it.
    mockedQuery.mockResolvedValueOnce([
      [baseRow({ first_send_attempted_at: new Date(), provider_request_body: REQUEST_BODY })],
      1,
    ]);

    void service.beginSendAttempt(ROW_ID, REQUEST_BODY);

    const [sql] = mockedQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/COALESCE\(\s*"provider_request_body"\s*,\s*\$2\s*\)/);
    // The buggy form (direct assignment, no COALESCE) would match this pattern; the
    // correct form never does, because COALESCE( sits between "=" and "$2".
    expect(sql).not.toMatch(/"provider_request_body"\s*=\s*\$2\b/);
  });
});

/**
 * Independent review repair (2026-10-16), finding 2 — automatic quarantine. BullMQ's
 * own `attempts` (5, exponential backoff, ~155s total) can exhaust long before the
 * provider's 24h idempotency-key window does; once exhausted, nothing ever calls
 * `process()` for that job again, so the processor's OWN cutoff check never re-runs.
 * `sweepAmbiguousPastCutoff` is the fix: a pure, time-based, idempotent sweep the
 * recovery worker's tick runs independent of any BullMQ job or processor invocation.
 */
describe('BillingDecisionNotificationOutboxService.sweepAmbiguousPastCutoff (independent review repair 2026-10-16, finding 2)', () => {
  let service: BillingDecisionNotificationOutboxService;

  beforeEach(() => {
    service = new BillingDecisionNotificationOutboxService();
    mockedQuery.mockReset();
  });

  it('unwraps the UPDATE...RETURNING tuple shape and counts the quarantined rows', async () => {
    mockedQuery.mockResolvedValueOnce([[{ id: ROW_ID }, { id: 'bbbbbbbb-...' }], 2]);

    const count = await service.sweepAmbiguousPastCutoff(23 * 60 * 60 * 1000);

    expect(count).toBe(2);
    expect(mockedQuery).toHaveBeenCalledWith(expect.anything(), [23 * 60 * 60 * 1000]);
  });

  it('also accepts a bare rows array (defensive: tolerate either driver shape)', async () => {
    mockedQuery.mockResolvedValueOnce([{ id: ROW_ID }]);

    const count = await service.sweepAmbiguousPastCutoff(23 * 60 * 60 * 1000);

    expect(count).toBe(1);
  });

  it('reports zero when nothing is past the cutoff', async () => {
    mockedQuery.mockResolvedValueOnce([[], 0]);

    const count = await service.sweepAmbiguousPastCutoff(23 * 60 * 60 * 1000);

    expect(count).toBe(0);
  });
});

describe('BillingDecisionNotificationOutboxService terminal-state SQL guards', () => {
  let service: BillingDecisionNotificationOutboxService;

  beforeEach(() => {
    service = new BillingDecisionNotificationOutboxService();
    mockedQuery.mockReset().mockResolvedValue([]);
  });

  it('provider acceptance wins and atomically clears either non-delivered marker', async () => {
    await service.markDelivered(ROW_ID, 'provider-id');
    const [sql] = mockedQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/"delivery_rejected_at"\s*=\s*NULL/);
    expect(sql).toMatch(/"quarantined_at"\s*=\s*NULL/);
    expect(sql).toMatch(/WHERE\s+"id"\s*=\s*\$1\s+AND\s+"delivered_at"\s+IS\s+NULL/);
  });

  it('a concrete 409 supersedes quarantine but can never overwrite delivery', async () => {
    await service.markDeliveryRejected(ROW_ID);
    const [sql] = mockedQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/"quarantined_at"\s*=\s*NULL/);
    expect(sql).toMatch(/"delivered_at"\s+IS\s+NULL/);
    expect(sql).toMatch(/"delivery_rejected_at"\s+IS\s+NULL/);
  });

  it('quarantine is lowest precedence and only claims a completely unresolved row', async () => {
    await service.markQuarantined(ROW_ID);
    const [sql] = mockedQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/"delivered_at"\s+IS\s+NULL/);
    expect(sql).toMatch(/"delivery_rejected_at"\s+IS\s+NULL/);
    expect(sql).toMatch(/"quarantined_at"\s+IS\s+NULL/);
  });
});
