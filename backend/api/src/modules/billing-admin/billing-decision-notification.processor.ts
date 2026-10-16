import { Inject, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import controlDataSource from '../../database/data-source';
import {
  QUEUE_NOTIFICATION_BILLING_DECISION,
  billingDecisionNotificationJobId,
} from '../../common/queues/queue-names';
import { Locale } from '../accounts/entities/account.entity';
import {
  PaymentSubmission,
  PaymentSubmissionStatus,
} from '../billing-customer/entities/payment-submission.entity';
import {
  BILLING_DECISION_NOTIFICATION_TRANSPORT,
  BillingDecisionNotificationEmail,
  BillingDecisionNotificationTransport,
  IdempotencyKeyConflictError,
} from './billing-decision-notification-transport.contract';
import { BillingDecisionNotificationOutboxService } from './billing-decision-notification-outbox.service';
import { RESEND_RETRY_CUTOFF_MS, resendIdempotencyKey } from './resend-idempotency-key';

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
 * configured transport (Resend, `RESEND_API_KEY`/`RESEND_FROM`).
 *
 * Same-occurrence idempotency (Constitution Principle VII, events.md "safe to run more
 * than once for the same key — the handler checks current state before mutating"), owner
 * decision 2026-10-15T16:33:05Z: plain SMTP cannot atomically coordinate "the relay
 * accepted this message" with "PostgreSQL recorded that it did" — the gap between those
 * two facts is an irreducible crash window no amount of check/send/mark ordering can
 * close. The fix moves the delivery-acceptance boundary onto the provider itself: every
 * send carries the occurrence's own immutable, deterministic Idempotency-Key
 * (`resendIdempotencyKey`, derived only from the outbox row's own `id`, never from
 * mutable state) AND the occurrence's own immutable, PERSISTED payload
 * (`provider_request_body`: the complete serialized request including `from`, written
 * once by `beginSendAttempt` and reused verbatim on every later attempt — never
 * re-rendered from current state,
 * which could legitimately drift, e.g. `account.preferred_locale` changing between a
 * crashed attempt and its retry). So ANY retry — crash before `delivered_at` commits, a
 * lost acknowledgment, two processors racing the same job — reaches the provider with
 * the exact same key and exact same payload and therefore collapses to the exact same
 * accepted result. The durable `delivered_at`/`provider_message_id` marker is written
 * only after that confirmed acceptance; a replay of an already-delivered occurrence is a
 * silent no-op. A job whose occurrence no longer matches persisted `status_history` is
 * rejected as stale. The provider's documented key-retention window is finite (24h): an
 * unresolved (ambiguous) occurrence that crosses the conservative cutoff is quarantined
 * instead of retried — resending near/at that boundary risks the provider treating the
 * SAME key as expired and accepting a genuine duplicate, which this design exists to
 * prevent — and a quarantined or payload-mismatched (409) occurrence is NEVER retried
 * under a fresh key; both require explicit manual reconciliation
 * (`UnrecoverableError`, no further BullMQ retries). Tenant scope comes from the sealed
 * job payload and the submission row, never from caller input.
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
    private readonly notificationOutbox: BillingDecisionNotificationOutboxService,
  ) {
    super();
  }

  async process(job: Job<BillingDecisionNotificationJobData>): Promise<void> {
    const data = this.validate(job);

    const jobId = billingDecisionNotificationJobId(
      data.submissionId,
      data.decision,
      data.decisionOccurrence,
    );
    const outboxRow = await this.notificationOutbox.findByJobId(jobId);
    if (!outboxRow) {
      throw new Error(
        `notification.billing_decision ${jobId}: no outbox row for this occurrence — stale job`,
      );
    }
    // Same-occurrence idempotency: the durable `delivered_at` marker IS the delivery
    // boundary. Once it is set — which happens immediately after the provider confirmed
    // acceptance — every later replay of this job (redelivery, manual reprocess, retry
    // after a crash that happened after the marker write) is a silent no-op: the
    // customer is never notified twice for the same decision occurrence.
    if (outboxRow.deliveredAt) {
      this.logger.log(
        `billing decision notification already delivered — skipping replay of ${jobId}`,
      );
      return;
    }
    if (outboxRow.quarantinedAt) {
      throw new UnrecoverableError(
        `notification.billing_decision ${jobId}: quarantined (crossed the conservative ` +
          'provider idempotency-key retry window while unresolved) — needs manual reconciliation, never auto-resent under a new key',
      );
    }
    if (outboxRow.deliveryRejectedAt) {
      throw new UnrecoverableError(
        `notification.billing_decision ${jobId}: delivery was rejected (409 payload ` +
          'mismatch on the occurrence key) — needs manual reconciliation, never auto-resent under a new key',
      );
    }

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

    // Independent review repair (2026-10-16), finding 1: build the COMPLETE request
    // body BEFORE the claim — including the sender, via `buildRequestBody` — but this
    // build is only a CANDIDATE — whichever caller's `beginSendAttempt` commits first
    // durably persists its own build as the occurrence's permanent request body, and
    // every caller (including this one, on the very first attempt) sends back exactly
    // what got persisted, never its own local build. Rebuilding on every retry from
    // live state (`account.preferred_locale`, `RESEND_FROM`, etc.) could legitimately
    // drift between a crashed attempt and its retry, which would break "identical
    // payload on retry" — reusing the persisted bytes verbatim is what makes that a
    // proof, not an assumption.
    const account = submission.tenant.account;
    const candidateEmail = renderDecisionEmail(
      account.preferredLocale ?? Locale.EN,
      data,
      submission,
    );
    const candidateRequestBody = this.transport.buildRequestBody(candidateEmail);

    // The atomic pre-send claim: durably stamps `first_send_attempted_at` (the
    // reference point for the provider's 24h idempotency window) and the request body
    // ONCE, before any HTTP call, and re-reports the row's terminal-state markers so a
    // concurrent processor that just delivered/quarantined/rejected this SAME
    // occurrence is honored instead of raced against.
    const claimed = await this.notificationOutbox.beginSendAttempt(
      outboxRow.id,
      candidateRequestBody,
    );
    if (claimed.deliveredAt) {
      this.logger.log(
        `billing decision notification already delivered by a concurrent processor — skipping ${jobId}`,
      );
      return;
    }
    if (claimed.quarantinedAt || claimed.deliveryRejectedAt) {
      throw new UnrecoverableError(
        `notification.billing_decision ${jobId}: occurrence reached a terminal non-delivered ` +
          'state concurrently — needs manual reconciliation',
      );
    }

    const firstAttemptAgeMs = Date.now() - claimed.firstSendAttemptedAt!.getTime();
    if (firstAttemptAgeMs > RESEND_RETRY_CUTOFF_MS) {
      await this.notificationOutbox.markQuarantined(outboxRow.id);
      throw new UnrecoverableError(
        `notification.billing_decision ${jobId}: ambiguous occurrence crossed the conservative ` +
          'provider idempotency-key retry window without confirmed delivery — quarantined for ' +
          'manual reconciliation rather than risking a duplicate under an expired key',
      );
    }

    // Fail safely rather than guess: a row that somehow reached this point without a
    // persisted request body (hand-edited data, a legacy/pre-migration row) must never
    // fall back to rebuilding — that is exactly the non-determinism this design
    // removes.
    if (!claimed.providerRequestBody) {
      throw new UnrecoverableError(
        `notification.billing_decision ${jobId}: occurrence has no persisted provider ` +
          'request body after a successful claim — refusing to guess; needs manual reconciliation',
      );
    }
    const idempotencyKey = resendIdempotencyKey(outboxRow.id);
    try {
      const result = await this.transport.sendRaw(claimed.providerRequestBody, idempotencyKey);
      await this.notificationOutbox.markDelivered(outboxRow.id, result.providerMessageId);
    } catch (error) {
      if (error instanceof IdempotencyKeyConflictError) {
        await this.notificationOutbox.markDeliveryRejected(outboxRow.id);
        throw new UnrecoverableError(
          `notification.billing_decision ${jobId}: provider rejected the replay (409, payload ` +
            `mismatch on idempotency key ${idempotencyKey}) — fail-closed, needs manual reconciliation`,
        );
      }
      // Ambiguous (network/timeout/5xx) — rethrow for BullMQ retry. The retry reuses the
      // SAME idempotency key AND the SAME persisted request body (it depends only on
      // the immutable outbox row), so even a send the provider actually accepted but we
      // failed to acknowledge resolves to the SAME result on replay rather than a
      // duplicate.
      throw error;
    }
    // Independent review repair (2026-10-16), finding 4: never log the recipient
    // address or any body/subject content — only internal identifiers an operator can
    // correlate against the control-plane data itself.
    this.logger.log(
      `billing decision notification delivered: submission ${data.submissionId} ` +
        `(${data.decision}, occurrence ${data.decisionOccurrence})`,
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
