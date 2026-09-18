import { Module } from '@nestjs/common';
import { createMinioClient } from './minio-client';
import { MinioStorageService } from './minio-storage.service';

export const MINIO_CLIENT = Symbol('MINIO_CLIENT');

/**
 * T025's Nest wiring point. Feature modules (T044 provisioning, T062 payment-proof
 * upload) import this module and inject `MinioStorageService` rather than constructing
 * a `minio` `Client` themselves, so bucket-per-tenant creation and presigned-URL issuance
 * always go through the single audited code path.
 */
@Module({
  providers: [
    { provide: MINIO_CLIENT, useFactory: createMinioClient },
    {
      provide: MinioStorageService,
      useFactory: (client: ReturnType<typeof createMinioClient>) => new MinioStorageService(client),
      inject: [MINIO_CLIENT],
    },
  ],
  exports: [MinioStorageService],
})
export class MinioModule {}
