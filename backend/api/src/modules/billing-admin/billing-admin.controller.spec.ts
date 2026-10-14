import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { NextFunction, Request, Response } from 'express';
import request = require('supertest');
import { BillingAdminController } from './billing-admin.controller';
import { BillingAdminService } from './billing-admin.service';

const SUBMISSION_ID = '69000000-0000-4000-8000-000000000011';
const REVIEWER_ID = '69000000-0000-4000-8000-000000000012';
const REASON = 'Payment could not be reconciled with the bank statement.';
const DETAILS = 'Please provide the bank confirmation number.';

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

describe('BillingAdminController decision HTTP adapter (T070)', () => {
  let app: INestApplication;
  const reject = jest.fn().mockResolvedValue({
    submissionId: SUBMISSION_ID,
    status: 'Rejected',
    decision: 'reject',
    decisionNotes: REASON,
    decidedAt: '2026-10-14T09:00:00.000Z',
  });
  const requestMoreInfo = jest.fn().mockResolvedValue({
    submissionId: SUBMISSION_ID,
    status: 'MoreInfoRequested',
    decision: 'more_info',
    decisionNotes: DETAILS,
    decidedAt: '2026-10-14T09:00:00.000Z',
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [BillingAdminController],
      providers: [
        {
          provide: BillingAdminService,
          useValue: { reject, requestMoreInfo, approve: jest.fn(), getReviewQueue: jest.fn() },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ errorHttpStatusCode: 422, whitelist: true }));
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

  it('maps POST reject to the authenticated internal subject and returns 200', async () => {
    const response = await request(app.getHttpServer())
      .post(`/internal/billing/payment-submissions/${SUBMISSION_ID}/reject`)
      .send({ reason: REASON });

    expect(response.status).toBe(200);
    expect(reject).toHaveBeenCalledWith(SUBMISSION_ID, REVIEWER_ID, REASON);
    expect(response.body).toMatchObject({ submissionId: SUBMISSION_ID, status: 'Rejected' });
  });

  it('maps POST request-more-info to the authenticated internal subject and returns 200', async () => {
    const response = await request(app.getHttpServer())
      .post(`/internal/billing/payment-submissions/${SUBMISSION_ID}/request-more-info`)
      .send({ details: DETAILS });

    expect(response.status).toBe(200);
    expect(requestMoreInfo).toHaveBeenCalledWith(SUBMISSION_ID, REVIEWER_ID, DETAILS);
    expect(response.body).toMatchObject({
      submissionId: SUBMISSION_ID,
      status: 'MoreInfoRequested',
    });
  });

  it.each([
    ['reject', 'reason', {}],
    ['reject', 'reason', { reason: '' }],
    ['reject', 'reason', { reason: '   ' }],
    ['request-more-info', 'details', {}],
    ['request-more-info', 'details', { details: '' }],
    ['request-more-info', 'details', { details: '   ' }],
  ])(
    'answers 422 without reaching the service when %s notes are %j',
    async (action, _notesKey, body) => {
      const response = await request(app.getHttpServer())
        .post(`/internal/billing/payment-submissions/${SUBMISSION_ID}/${action}`)
        .send(body);

      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({ statusCode: 422 });
      expect(reject).not.toHaveBeenCalled();
      expect(requestMoreInfo).not.toHaveBeenCalled();
    },
  );

  it('strips unknown properties from the decision body (whitelist)', async () => {
    const response = await request(app.getHttpServer())
      .post(`/internal/billing/payment-submissions/${SUBMISSION_ID}/reject`)
      .send({ reason: REASON, injected: 'drop me' });

    expect(response.status).toBe(200);
    expect(reject).toHaveBeenCalledWith(SUBMISSION_ID, REVIEWER_ID, REASON);
  });
});
