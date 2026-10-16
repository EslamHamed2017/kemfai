import {
  BillingDecisionNotificationEmail,
  BillingDecisionNotificationSendResult,
} from './billing-decision-notification-transport';

/**
 * DI token for the FR-035 customer-notification delivery channel consumed by
 * `BillingDecisionNotificationProcessor`. The default binding is the real Resend
 * transport (`ResendBillingDecisionNotificationTransport`, configured by
 * RESEND_API_KEY/RESEND_FROM); integration coverage binds a local fake-provider fixture
 * (`test/support/fake-resend.ts`) where it needs to observe deliveries without any
 * external send, never a real hosted Resend call.
 */
export const BILLING_DECISION_NOTIFICATION_TRANSPORT = Symbol(
  'BILLING_DECISION_NOTIFICATION_TRANSPORT',
);

export type { BillingDecisionNotificationEmail, BillingDecisionNotificationSendResult };
export {
  BillingDecisionNotificationTransport,
  IdempotencyKeyConflictError,
} from './billing-decision-notification-transport';
