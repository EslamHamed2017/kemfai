import { Inject, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import controlDataSource from '../../database/data-source';
import { QUEUE_NOTIFICATION_BILLING_DECISION } from '../../common/queues/queue-names';
import { Locale } from '../accounts/entities/account.entity';
import {
  PaymentSubmission,
  PaymentSubmissionStatus,
} from '../billing-customer/entities/payment-submission.entity';
import {
  BILLING_DECISION_NOTIFICATION_TRANSPORT,
  BillingDecisionNotificationEmail,
  BillingDecisionNotificationTransport,
} from './billing-decision-notification-transport.contract';

export interface BillingDecisionNotificationJobData {
  submissionId: string;
  tenantId: string;
  decision: 'approve' | 'reject' | 'more_info';
  decisionOccurrence: number;
  notes: string | null;
  occurredAt: string;
}

const DECISION_STATUS: Record<
  BillingDecisionNotificationJobData['decision'],
  PaymentSubmissionStatus
> = {
  approve: PaymentSubmissionStatus.APPROVED,
  reject: PaymentSubmissionStatus.REJECTED,
  more_info: PaymentSubmissionStatus.MORE_INFO_REQUESTED,
};

/**
 * T070 (Codex round-2 finding 2) — the `notification.billing_decision` consumer that
 * makes FR-035 real: Acceptance Scenarios 6.3/6.4 require the CUSTOMER TO BE NOTIFIED
 * of the decision outcome ("notified with the reason", "notified of what is needed"),
 * not merely a durable queue handoff. This processor loads the sealed decision state
 * from the control plane and sends the workspace owner a localized email through the
 * configured transport (`SMTP_URL`/`SMTP_FROM`, e.g. the deployment's relay).
 *
 * Idempotency (Constitution Principle VII, events.md "safe to run more than once"):
 * before sending anything the processor re-reads the submission and verifies the
 * decision occurrence the job names still exists verbatim in the append-only
 * `status_history` — a replayed or redelivered job for a real occurrence re-sends the
 * same immutable content (at-least-once email semantics), while a job whose occurrence
 * no longer matches persisted history is rejected as stale. Tenant scope comes from the
 * sealed job payload and the submission row, never from caller input.
 *
 * `autorun` is disabled under Jest exactly like `TenantProvisionProcessor`, so this
 * processor never consumes other suites' queued jobs; integration coverage drives the
 * SAME production instance through a real BullMQ worker loop.
 */
@Processor(QUEUE_NOTIFICATION_BILLING_DECISION, {
  autorun: process.env.NODE_ENV !== 'test',
})
export class BillingDecisionNotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(BillingDecisionNotificationProcessor.name);

  constructor(
    @Inject(BILLING_DECISION_NOTIFICATION_TRANSPORT)
    private readonly transport: BillingDecisionNotificationTransport,
  ) {
    super();
  }

  async process(job: Job<BillingDecisionNotificationJobData>): Promise<void> {
    const data = this.validate(job);
    const paymentRepository = controlDataSource.getRepository(PaymentSubmission);
    const submission = await paymentRepository.findOne({
      where: { id: data.submissionId, tenantId: data.tenantId },
      relations: { tenant: { account: true } },
    });
    if (!submission || !submission.tenant?.account?.email) {
      throw new Error(
        `notification.billing_decision ${data.submissionId}: submission/tenant/account no longer resolvable`,
      );
    }

    // State check before mutating anything external (research.md §3): the occurrence
    // this job names must still be exactly that decision's own history entry.
    const occurrence = submission.statusHistory[data.decisionOccurrence];
    if (
      !occurrence ||
      occurrence.status !== DECISION_STATUS[data.decision] ||
      (occurrence.notes ?? null) !== (data.notes ?? null)
    ) {
      throw new Error(
        `notification.billing_decision ${data.submissionId}: history occurrence ` +
          `${data.decisionOccurrence} does not match decision ${data.decision} — stale job`,
      );
    }

    const account = submission.tenant.account;
    const email = renderDecisionEmail(account.preferredLocale ?? Locale.EN, data, submission);
    await this.transport.send(email);
    this.logger.log(
      `billing decision notification delivered: submission ${data.submissionId} ` +
        `(${data.decision}, occurrence ${data.decisionOccurrence}) to ${email.to}`,
    );
  }

  private validate(
    job: Job<BillingDecisionNotificationJobData>,
  ): BillingDecisionNotificationJobData {
    const data = job.data;
    const submissionId = typeof data?.submissionId === 'string' ? data.submissionId : '';
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(submissionId)) {
      throw new Error('notification.billing_decision: invalid submissionId');
    }
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(String(data?.tenantId ?? ''))) {
      throw new Error('notification.billing_decision: invalid tenantId');
    }
    if (!(data?.decision in DECISION_STATUS)) {
      throw new Error('notification.billing_decision: invalid decision');
    }
    if (!Number.isInteger(data?.decisionOccurrence) || data.decisionOccurrence < 0) {
      throw new Error('notification.billing_decision: invalid decisionOccurrence');
    }
    if (typeof data?.occurredAt !== 'string' || Number.isNaN(Date.parse(data.occurredAt))) {
      throw new Error('notification.billing_decision: invalid occurredAt');
    }
    if (data.notes !== null && typeof data.notes !== 'string') {
      throw new Error('notification.billing_decision: invalid notes');
    }
    return data;
  }
}

/** Locale-specific FR-035 message content (en/ar per the product's bilingual surface). */
function renderDecisionEmail(
  locale: Locale,
  data: BillingDecisionNotificationJobData,
  submission: PaymentSubmission,
): BillingDecisionNotificationEmail {
  const period = `${submission.billingPeriodStart} – ${submission.billingPeriodEnd}`;
  const notesLine =
    data.notes === null || data.notes === ''
      ? ''
      : locale === Locale.AR
        ? `التفاصيل: ${data.notes}\n`
        : `Details: ${data.notes}\n`;
  if (data.decision === 'approve') {
    return locale === Locale.AR
      ? {
          to: submission.tenant!.account!.email,
          subject: 'تم تفعيل اشتراكك',
          body: `تمت الموافقة على طلب الدفع الخاص بالفترة ${period} وتم تفعيل اشتراكك.\n`,
        }
      : {
          to: submission.tenant!.account!.email,
          subject: 'Your subscription is now active',
          body: `Your payment submission for the period ${period} was approved and your subscription is now active.\n`,
        };
  }
  if (data.decision === 'reject') {
    return locale === Locale.AR
      ? {
          to: submission.tenant!.account!.email,
          subject: 'تم رفض طلب الدفع',
          body: `نأسف، تم رفض طلب الدفع الخاص بالفترة ${period}.\n${notesLine}`,
        }
      : {
          to: submission.tenant!.account!.email,
          subject: 'Your payment submission was rejected',
          body: `Your payment submission for the period ${period} was rejected.\n${notesLine}`,
        };
  }
  return locale === Locale.AR
    ? {
        to: submission.tenant!.account!.email,
        subject: 'معلومات إضافية مطلوبة',
        body: `نحتاج معلومات إضافية بشأن طلب الدفع الخاص بالفترة ${period}.\n${notesLine}`,
      }
    : {
        to: submission.tenant!.account!.email,
        subject: 'More information needed about your payment submission',
        body: `We need more information about your payment submission for the period ${period}.\n${notesLine}`,
      };
}
