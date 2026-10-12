import { Client } from 'minio';

/**
 * The subset of the `minio` SDK's `Client` surface {@link MinioStorageService} depends
 * on. Keeping this as a narrow structural interface (rather than importing `Client`
 * directly into the service) is what lets unit tests substitute a fake in-memory client
 * with no live MinIO server, mirroring how `QueueSchedulingService` (T021) is tested
 * against a fake `Queue`.
 */
export interface MinioClientLike {
  bucketExists(bucketName: string): Promise<boolean>;
  makeBucket(bucketName: string, region?: string): Promise<void>;
  presignedPutObject(
    bucketName: string,
    objectName: string,
    expirySeconds?: number,
  ): Promise<string>;
  presignedGetObject(
    bucketName: string,
    objectName: string,
    expirySeconds?: number,
  ): Promise<string>;
  putObject(
    bucketName: string,
    objectName: string,
    data: Buffer,
    size: number,
    metadata?: Record<string, string>,
  ): Promise<unknown>;
  removeObject(bucketName: string, objectName: string): Promise<void>;
}

/**
 * Config is read from `process.env` on every call (mirrors bearer-auth.guard.ts's
 * `resolveAuthConfig` pattern) so tests can point at a different endpoint/credentials
 * without a module reload. `STORAGE_ENDPOINT` is the full URL wired by
 * infra/docker/docker-compose.yml (`http://minio:9000`); local default matches the
 * compose port mapping on 127.0.0.1:9000.
 */
export function resolveMinioConfig(): {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
} {
  const endpoint = process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000';
  const url = new URL(endpoint);
  const useSSL = url.protocol === 'https:';
  return {
    endPoint: url.hostname,
    port: url.port ? Number(url.port) : useSSL ? 443 : 80,
    useSSL,
    accessKey: process.env.STORAGE_ACCESS_KEY ?? 'kemfai_minio',
    secretKey: process.env.STORAGE_SECRET_KEY ?? 'kemfai_dev_minio_secret',
  };
}

export function createMinioClient(): MinioClientLike {
  return new Client({
    ...resolveMinioConfig(),
    // MinIO defaults to us-east-1. Supplying it lets the SDK sign short-lived review URLs
    // locally instead of making a bucket-region request on every queue read. Deployments with
    // a non-default region remain configuration-driven.
    region: process.env.STORAGE_REGION ?? 'us-east-1',
  });
}
