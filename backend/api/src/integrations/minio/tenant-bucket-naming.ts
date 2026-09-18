/**
 * Bucket-per-tenant naming and evidence object-key layout, locked by research.md §5
 * ("One MinIO bucket per tenant, `kemfai-tenant-<tenant_id>`... holding payment-proof
 * objects under `payment-submissions/<submission_id>/<filename>`"). T044's provisioning
 * processor and T062's payment-proof upload must build keys through these helpers rather
 * than inlining the pattern, so the layout can never drift between call sites.
 */

export function tenantBucketName(tenantId: string): string {
  return `kemfai-tenant-${tenantId}`;
}

export function paymentSubmissionObjectKey(submissionId: string, filename: string): string {
  return `payment-submissions/${submissionId}/${filename}`;
}
