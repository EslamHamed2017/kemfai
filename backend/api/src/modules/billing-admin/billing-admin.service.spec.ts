import controlDataSource from '../../database/data-source';
import { MinioStorageService } from '../../integrations/minio/minio-storage.service';
import { BillingAdminService } from './billing-admin.service';

describe('BillingAdminService review queue (T068)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('requests a stable oldest-first order when submission timestamps tie', async () => {
    const find = jest.fn().mockResolvedValue([]);
    jest.spyOn(controlDataSource, 'getRepository').mockReturnValue({ find } as never);
    const service = new BillingAdminService({} as MinioStorageService);

    await service.getReviewQueue();

    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        order: { submittedAt: 'ASC', id: 'ASC' },
      }),
    );
  });
});
