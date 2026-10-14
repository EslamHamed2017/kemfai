import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { NextFunction, Request, Response } from 'express';
import request = require('supertest');
import { BillingAdminController } from './billing-admin.controller';
import { BillingAdminService } from './billing-admin.service';

const SUBMISSION_ID = '69000000-0000-4000-8000-000000000011';
const REVIEWER_ID = '69000000-0000-4000-8000-000000000012';

describe('BillingAdminController approval HTTP adapter (T069)', () => {
  let app: INestApplication;
  const approve = jest.fn().mockResolvedValue({
    submissionId: SUBMISSION_ID,
    subscriptionId: '69000000-0000-4000-8000-000000000013',
    status: 'Active',
    billingPeriodStart: '2026-11-01',
    billingPeriodEnd: '2026-11-30',
    activatedAt: '2026-10-12T09:00:00.000Z',
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [BillingAdminController],
      providers: [
        { provide: BillingAdminService, useValue: { approve, getReviewQueue: jest.fn() } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as Request & { auth: { keycloakUserId: string; roles: string[] } }).auth = {
        keycloakUserId: REVIEWER_ID,
        roles: ['BillingAdmin'],
      };
      next();
    });
    await app.init();
  });

  afterEach(async () => {
    try {
      jest.clearAllMocks();
    } finally {
      if (app) await app.close();
    }
  });

  it('maps POST approve to the authenticated internal subject and returns 200', async () => {
    const response = await request(app.getHttpServer()).post(
      `/internal/billing/payment-submissions/${SUBMISSION_ID}/approve`,
    );

    expect(response.status).toBe(200);
    expect(approve).toHaveBeenCalledWith(SUBMISSION_ID, REVIEWER_ID);
    expect(response.body).toMatchObject({ submissionId: SUBMISSION_ID, status: 'Active' });
  });
});
