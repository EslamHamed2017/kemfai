import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

/** Generous upper bound for a free-text decision reason (text column, review-screen sized). */
export const PAYMENT_DECISION_NOTES_MAX_LENGTH = 4000;

/**
 * Request body of `POST /internal/billing/payment-submissions/{id}/reject`
 * (contracts/openapi.yaml): the mandatory rejection reason shown to the customer (FR-035)
 * and preserved in `decision_notes`, `status_history`, and the FR-009 audit payload.
 * A missing, empty, blank, or non-string reason is malformed input — 422 via the global
 * ValidationPipe — because an unexplained rejection is undisputable and un-actionable.
 */
export class RejectPaymentSubmissionRequestDto {
  @IsString({ message: 'reason must be a string' })
  @IsNotEmpty({ message: 'reason must not be empty' })
  @Matches(/\S/, { message: 'reason must not be blank' })
  @MaxLength(PAYMENT_DECISION_NOTES_MAX_LENGTH, {
    message: `reason must be at most ${PAYMENT_DECISION_NOTES_MAX_LENGTH} characters`,
  })
  reason!: string;
}
