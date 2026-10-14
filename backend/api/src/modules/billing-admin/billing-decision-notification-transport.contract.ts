import { BillingDecisionNotificationEmail } from './billing-decision-notification-transport';

/**
 * DI token for the FR-035 customer-notification delivery channel consumed by
 * `BillingDecisionNotificationProcessor`. The default binding is the real SMTP
 * transport (`SmtpBillingDecisionNotificationTransport`, configured by
 * SMTP_URL/SMTP_FROM); integration coverage binds fixture-local fakes where it needs
 * to observe deliveries without any external send.
 */
export const BILLING_DECISION_NOTIFICATION_TRANSPORT = Symbol(
  'BILLING_DECISION_NOTIFICATION_TRANSPORT',
);

export type { BillingDecisionNotificationEmail };
export { BillingDecisionNotificationTransport } from './billing-decision-notification-transport';
