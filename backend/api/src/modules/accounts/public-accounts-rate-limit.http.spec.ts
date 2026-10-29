import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';
import {
  PublicAccountsRateLimiter,
  PublicAccountsRateLimitGuard,
} from './public-accounts-rate-limit';

const validSignup = {
  email: 'rate-limit@example.com',
  password: 'a-strong-password',
  planId: '11111111-1111-4111-8111-111111111111',
  billingCycle: 'monthly',
  acceptedTerms: true,
};

describe('PublicAccountsRateLimiter bounded overflow behavior', () => {
  it('reserves one fail-closed overflow bucket per scope without exceeding 10,000 buckets', () => {
    const limiter = new PublicAccountsRateLimiter();
    const now = 1_000;

    for (let index = 0; index < 9_998; index += 1) {
      expect(limiter.check('signup', `client-${index}`, now).allowed).toBe(true);
    }

    for (let index = 0; index < 5; index += 1) {
      expect(limiter.check('signup', `overflow-signup-${index}`, now).allowed).toBe(true);
    }
    expect(limiter.check('signup', 'overflow-signup-denied', now).allowed).toBe(false);

    for (let index = 0; index < 10; index += 1) {
      expect(limiter.check('verify-email', `overflow-verify-${index}`, now).allowed).toBe(true);
    }
    expect(limiter.check('verify-email', 'overflow-verify-denied', now).allowed).toBe(false);

    expect(limiter.check('signup', 'after-expiry', now + 60_001).allowed).toBe(true);
  });
});

describe('T096 public account HTTP rate limits', () => {
  let app: INestApplication;
  let accounts: { signup: jest.Mock; verifyEmail: jest.Mock };

  beforeEach(async () => {
    accounts = {
      signup: jest.fn().mockResolvedValue({ accountId: 'a1', verificationRequired: true }),
      verifyEmail: jest.fn().mockResolvedValue({ accountId: 'a1', provisioningQueued: true }),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [AccountsController],
      providers: [
        Reflector,
        PublicAccountsRateLimiter,
        PublicAccountsRateLimitGuard,
        { provide: AccountsService, useValue: accounts },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => app.close());

  it('allows five signup attempts per minute/IP, then returns localized English 429 without service side effects', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(app.getHttpServer()).post('/accounts/signup').send(validSignup).expect(201);
    }

    const denied = await request(app.getHttpServer())
      .post('/accounts/signup')
      .set('Accept-Language', 'en-US,en;q=0.9')
      .send(validSignup)
      .expect(429);

    expect(denied.headers['retry-after']).toMatch(/^\d+$/);
    expect(Number(denied.headers['retry-after'])).toBeGreaterThan(0);
    expect(denied.headers['content-language']).toBe('en');
    expect(denied.body).toEqual({
      statusCode: 429,
      message: 'Too many attempts. Please try again later.',
      error: 'Too Many Requests',
    });
    expect(accounts.signup).toHaveBeenCalledTimes(5);
  });

  it('uses a separate ten-attempt verification bucket and returns an Arabic 429', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await request(app.getHttpServer())
        .post('/accounts/verify-email')
        .send({ token: `token-${attempt}` })
        .expect(200);
    }

    const denied = await request(app.getHttpServer())
      .post('/accounts/verify-email')
      .set('Accept-Language', 'en;q=0.2, ar-AE;q=0.9')
      .send({ token: 'token-denied' })
      .expect(429);

    expect(denied.headers['content-language']).toBe('ar');
    expect(denied.body.message).toBe('عدد المحاولات كبير جدًا. يُرجى المحاولة مرة أخرى لاحقًا.');
    expect(accounts.verifyEmail).toHaveBeenCalledTimes(10);
  });
});
