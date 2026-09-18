import { paymentSubmissionObjectKey, tenantBucketName } from './tenant-bucket-naming';

/**
 * T025: locks the bucket-per-tenant and evidence object-key layout to research.md §5's
 * exact patterns so no call site can drift.
 */
describe('tenant-bucket-naming (T025)', () => {
  it('names a tenant bucket kemfai-tenant-<tenant_id>', () => {
    expect(tenantBucketName('t-123')).toBe('kemfai-tenant-t-123');
  });

  it('lays out payment-submission proof objects under payment-submissions/<submission_id>/<filename>', () => {
    expect(paymentSubmissionObjectKey('sub-9', 'receipt.pdf')).toBe(
      'payment-submissions/sub-9/receipt.pdf',
    );
  });
});
