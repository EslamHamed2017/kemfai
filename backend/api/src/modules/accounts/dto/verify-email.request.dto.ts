import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

/** Generous upper bound: minted tokens are 43-char base64url; larger inputs are rejected as malformed. */
export const VERIFICATION_TOKEN_MAX_LENGTH = 256;

/**
 * Request body of `POST /accounts/verify-email` (contracts/openapi.yaml): the opaque
 * bearer token from the emailed link. A missing/empty/non-string token is malformed
 * input (422 via the global ValidationPipe); a well-formed but unknown/expired/
 * superseded/used token is a 410 decided by the service (Edge Cases, FR-021).
 */
export class VerifyEmailRequestDto {
  @IsString({ message: 'token must be a string' })
  @IsNotEmpty({ message: 'token must not be empty' })
  @MaxLength(VERIFICATION_TOKEN_MAX_LENGTH, {
    message: `token must be at most ${VERIFICATION_TOKEN_MAX_LENGTH} characters`,
  })
  token!: string;
}
