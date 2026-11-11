import * as Minio from 'minio';

import { MinioStorageService } from './minio-storage.service';

describe('MinioStorageService with the real MinIO signing SDK (T096)', () => {
  it('emits a five-minute signature and rejects a longer override before signing', async () => {
    const client = new Minio.Client({
      endPoint: '127.0.0.1',
      port: 9000,
      useSSL: false,
      accessKey: 'test-only',
      secretKey: 'test-only-secret',
      region: 'us-east-1',
    });
    const service = new MinioStorageService(client);

    const url = await service.getPresignedDownloadUrl('tenant-evidence', 'proof/object.pdf');
    expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('300');
    await expect(
      service.getPresignedDownloadUrl('tenant-evidence', 'proof/object.pdf', 301),
    ).rejects.toBeInstanceOf(RangeError);
  });
});
