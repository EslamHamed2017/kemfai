import type { MinioClientLike } from './minio-client';
import { MinioStorageService } from './minio-storage.service';

function fakeClient(opts: { bucketExists: boolean } = { bucketExists: false }) {
  const calls: { setBucketPolicy: unknown[] } = { setBucketPolicy: [] };
  const client: MinioClientLike & { setBucketPolicy: (...args: unknown[]) => Promise<void> } = {
    bucketExists: jest.fn(async () => opts.bucketExists),
    makeBucket: jest.fn(async () => undefined),
    presignedPutObject: jest.fn(async () => 'https://minio.example/put'),
    presignedGetObject: jest.fn(async () => 'https://minio.example/get'),
    setBucketPolicy: jest.fn(async (...args: unknown[]) => {
      calls.setBucketPolicy.push(args);
    }),
  };
  return { client, calls };
}

/**
 * T025: bucket-per-tenant client + presigned URL helper. Idempotent creation and
 * "never sets a public policy" are both structural guarantees the provisioning
 * processor (T044) and payment-proof upload (T062) depend on.
 */
describe('MinioStorageService (T025)', () => {
  describe('createTenantBucket', () => {
    it('creates the tenant bucket kemfai-tenant-<tenant_id> when it does not yet exist', async () => {
      const { client } = fakeClient({ bucketExists: false });
      const service = new MinioStorageService(client);

      const bucket = await service.createTenantBucket('t-abc');

      expect(bucket).toBe('kemfai-tenant-t-abc');
      expect(client.makeBucket).toHaveBeenCalledWith('kemfai-tenant-t-abc');
    });

    it('is a no-op (create-if-not-exists) when the tenant bucket already exists', async () => {
      const { client } = fakeClient({ bucketExists: true });
      const service = new MinioStorageService(client);

      const bucket = await service.createTenantBucket('t-abc');

      expect(bucket).toBe('kemfai-tenant-t-abc');
      expect(client.makeBucket).not.toHaveBeenCalled();
    });

    it('never sets a bucket policy, leaving the tenant bucket on MinIO default-private', async () => {
      const { client, calls } = fakeClient({ bucketExists: false });
      const service = new MinioStorageService(client);

      await service.createTenantBucket('t-abc');

      expect(client.setBucketPolicy).not.toHaveBeenCalled();
      expect(calls.setBucketPolicy).toHaveLength(0);
    });
  });

  describe('presigned URLs', () => {
    it('issues a presigned upload URL with the default 15-minute expiry', async () => {
      const { client } = fakeClient();
      const service = new MinioStorageService(client);

      const url = await service.getPresignedUploadUrl(
        'kemfai-tenant-t-abc',
        'payment-submissions/s1/f.pdf',
      );

      expect(url).toBe('https://minio.example/put');
      expect(client.presignedPutObject).toHaveBeenCalledWith(
        'kemfai-tenant-t-abc',
        'payment-submissions/s1/f.pdf',
        15 * 60,
      );
    });

    it('issues a presigned download URL and honors a caller-supplied expiry override', async () => {
      const { client } = fakeClient();
      const service = new MinioStorageService(client);

      const url = await service.getPresignedDownloadUrl(
        'kemfai-tenant-t-abc',
        'payment-submissions/s1/f.pdf',
        60,
      );

      expect(url).toBe('https://minio.example/get');
      expect(client.presignedGetObject).toHaveBeenCalledWith(
        'kemfai-tenant-t-abc',
        'payment-submissions/s1/f.pdf',
        60,
      );
    });
  });
});
