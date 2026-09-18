import {
  ALL_QUEUE_NAMES,
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
  it('registers exactly the five queues documented in events.md', () => {
    expect(ALL_QUEUE_NAMES).toEqual([
      'tenant.provision',
      'email.send_verification',
      'notification.billing_decision',
      'support_access.expiry_sweep',
      'trial.expiry_sweep',
    ]);
    expect(QUEUE_TENANT_PROVISION).toBe('tenant.provision');
    expect(QUEUE_EMAIL_SEND_VERIFICATION).toBe('email.send_verification');
    expect(QUEUE_NOTIFICATION_BILLING_DECISION).toBe('notification.billing_decision');
    expect(QUEUE_SUPPORT_ACCESS_EXPIRY_SWEEP).toBe('support_access.expiry_sweep');
    expect(QUEUE_TRIAL_EXPIRY_SWEEP).toBe('trial.expiry_sweep');
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

  it('notification.billing_decision keys on submission_id + decision, so each decision outcome is a distinct job', () => {
    const submissionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    expect(billingDecisionNotificationJobId(submissionId, 'approve')).toBe(
      `${submissionId}.approve`,
    );
    expect(billingDecisionNotificationJobId(submissionId, 'more_info')).not.toBe(
      billingDecisionNotificationJobId(submissionId, 'approve'),
    );
  });

  it('sweeps carry no per-entity key: one fixed job name, every 30s (events.md "N/A, scheduled")', () => {
    expect(SWEEP_JOB_NAME).toBe('sweep');
    expect(SWEEP_REPEAT_INTERVAL_MS).toBe(30_000);
  });
});
