import {
  ALL_QUEUE_NAMES,
  BILLING_DECISION_NOTIFICATION_ATTEMPTS,
  BILLING_DECISION_NOTIFICATION_BACKOFF,
  QUEUE_ACCOUNTING_MUTATION_RECOVERY,
  QUEUE_EMAIL_SEND_VERIFICATION,
  QUEUE_NOTIFICATION_BILLING_DECISION,
  QUEUE_SUPPORT_ACCESS_EXPIRY_SWEEP,
  QUEUE_TENANT_PROVISION,
  QUEUE_TRIAL_EXPIRY_SWEEP,
  SWEEP_JOB_NAME,
  SWEEP_REPEAT_INTERVAL_MS,
  billingDecisionNotificationJobId,
  emailVerificationJobId,
  tenantProvisionJobId,
} from './queue-names';

/**
 * T021 acceptance: names and job-id/dedupe-key strategies must match the BullMQ signal
 * table in specs/001-saas-onboarding-shell/contracts/events.md verbatim — these tests
 * restate that table so any drift in either direction fails the suite.
 */
describe('Queue names & job-id strategies (T021, contracts/events.md)', () => {
  it('retains the five Phase 1 queues and adds the Accounting recovery queue', () => {
    expect(ALL_QUEUE_NAMES).toEqual([
      'tenant.provision',
      'email.send_verification',
      'notification.billing_decision',
      'support_access.expiry_sweep',
      'trial.expiry_sweep',
      'accounting.mutation_recovery',
    ]);
    expect(QUEUE_TENANT_PROVISION).toBe('tenant.provision');
    expect(QUEUE_EMAIL_SEND_VERIFICATION).toBe('email.send_verification');
    expect(QUEUE_NOTIFICATION_BILLING_DECISION).toBe('notification.billing_decision');
    expect(QUEUE_SUPPORT_ACCESS_EXPIRY_SWEEP).toBe('support_access.expiry_sweep');
    expect(QUEUE_TRIAL_EXPIRY_SWEEP).toBe('trial.expiry_sweep');
    expect(QUEUE_ACCOUNTING_MUTATION_RECOVERY).toBe('accounting.mutation_recovery');
  });

  it('tenant.provision uses the bare account_id as its unique job id', () => {
    const accountId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    expect(tenantProvisionJobId(accountId)).toBe(accountId);
  });

  it('email.send_verification keys on account_id + issued token version, so a re-issued link is a distinct job', () => {
    const accountId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    expect(emailVerificationJobId(accountId, 'v1')).toBe(`${accountId}.v1`);
    expect(emailVerificationJobId(accountId, 'v2')).not.toBe(
      emailVerificationJobId(accountId, 'v1'),
    );
  });

  it('notification.billing_decision keys on submission_id + decision + decision occurrence, so every decision cycle is a distinct job', () => {
    const submissionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    expect(billingDecisionNotificationJobId(submissionId, 'approve', 1)).toBe(
      `${submissionId}.approve.1`,
    );
    expect(billingDecisionNotificationJobId(submissionId, 'more_info', 1)).not.toBe(
      billingDecisionNotificationJobId(submissionId, 'reject', 1),
    );
    // FR-035: a repeated more_info cycle on the SAME submission row must get its own
    // job — the occurrence index disambiguates it from the prior cycle's job, which
    // may still be sitting in the queue (or already completed) under its own key.
    expect(billingDecisionNotificationJobId(submissionId, 'more_info', 3)).not.toBe(
      billingDecisionNotificationJobId(submissionId, 'more_info', 1),
    );
  });

  it('notification.billing_decision jobs carry explicit retry attempts and exponential backoff (events.md "retried with backoff")', () => {
    expect(BILLING_DECISION_NOTIFICATION_ATTEMPTS).toBeGreaterThanOrEqual(2);
    expect(BILLING_DECISION_NOTIFICATION_BACKOFF).toEqual({
      type: 'exponential',
      delay: expect.any(Number),
    });
  });

  it('sweeps carry no per-entity key: one fixed job name, every 30s (events.md "N/A, scheduled")', () => {
    expect(SWEEP_JOB_NAME).toBe('sweep');
    expect(SWEEP_REPEAT_INTERVAL_MS).toBe(30_000);
  });
});
