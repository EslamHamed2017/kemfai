import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { PAYMENT_DECISION_NOTES_MAX_LENGTH } from './reject-payment-submission.request.dto';

/**
 * Request body of `POST /internal/billing/payment-submissions/{id}/request-more-info`
 * (contracts/openapi.yaml): the mandatory specifics of what the customer must still
 * provide (FR-035, Acceptance Scenario 6.4). Recorded as the latest request in
 * `decision_notes` and as a new append-only `status_history` cycle; a missing, empty,
 * blank, or non-string value is malformed input — 422 via the global ValidationPipe.
 */
export class RequestMoreInfoPaymentSubmissionRequestDto {
  @IsString({ message: 'details must be a string' })
  @IsNotEmpty({ message: 'details must not be empty' })
  @Matches(/\S/, { message: 'details must not be blank' })
  @MaxLength(PAYMENT_DECISION_NOTES_MAX_LENGTH, {
    message: `details must be at most ${PAYMENT_DECISION_NOTES_MAX_LENGTH} characters`,
  })
  details!: string;
}
