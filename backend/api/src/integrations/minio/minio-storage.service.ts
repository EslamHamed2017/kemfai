import { Injectable } from '@nestjs/common';
import type { MinioClientLike } from './minio-client';
import { tenantBucketName } from './tenant-bucket-naming';

/**
 * Short-lived by design (T096 tunes the exact window later) — presigned URLs must never
 * be long-lived enough to outlive a normal upload/review session.
 */
const DEFAULT_PRESIGNED_URL_EXPIRY_SECONDS = 15 * 60;

/**
 * Bucket-per-tenant evidence storage (T025; research.md §5). `createTenantBucket` is the
 * ONLY place a tenant's MinIO bucket is created — T044's provisioning processor calls it
 * ahead of Odoo DB creation (data-model.md's Tenant "Provisioning order" note) and sets
 * `Tenant.minio_bucket` from its return value.
 */
@Injectable()
export class MinioStorageService {
  constructor(private readonly client: MinioClientLike) {}

  /**
   * Create-if-not-exists (Constitution Principle VII): re-running provisioning for a
   * tenant whose bucket already exists is a no-op, not an error. No `setBucketPolicy`
   * call is ever made here — the bucket is left on MinIO's default private policy, so no
   * code path in this service can grant anonymous/public access; only requests signed
   * with the API/BFF's own service credentials can ever reach it (research.md §5).
   */
  async createTenantBucket(tenantId: string): Promise<string> {
    const bucket = tenantBucketName(tenantId);
    const exists = await this.client.bucketExists(bucket);
    if (!exists) {
      await this.client.makeBucket(bucket);
    }
    return bucket;
  }

  async getPresignedUploadUrl(
    bucket: string,
    objectKey: string,
    expirySeconds: number = DEFAULT_PRESIGNED_URL_EXPIRY_SECONDS,
  ): Promise<string> {
    return this.client.presignedPutObject(bucket, objectKey, expirySeconds);
  }

  async getPresignedDownloadUrl(
    bucket: string,
    objectKey: string,
    expirySeconds: number = DEFAULT_PRESIGNED_URL_EXPIRY_SECONDS,
  ): Promise<string> {
    return this.client.presignedGetObject(bucket, objectKey, expirySeconds);
  }
}
