import { HttpStatus, INestApplication } from '@nestjs/common';
import request = require('supertest');
import type { Response } from 'supertest';
import {
  T109_ACCOUNT_ID,
  T109_CUSTOMER_COMPANY,
  T109_CUSTOMER_EMAIL,
  T109_GRANT_ID,
  T109_PLAN_ID,
  T109_SETUP_SCOPE,
  T109_SUBMISSION_ID,
  T109_TENANT_ID,
  T109_VERIFY_TOKEN,
  T109FixtureMode,
  T109FixtureState,
  T109Scenario,
  T109Surface,
  createT109SurfaceApp,
} from '../support/t109-surface-harness';

const EXPOSURE_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ['native product name', /\bodoo\b/i],
  ['company model', /\bres\.company\b/i],
  ['contact model', /\bres\.partner\b/i],
  ['native web route', /\/web(?:[/?#"'\s]|$)/i],
  ['XML-RPC transport', /\bxml[\s_-]?rpc\b|\/xmlrpc(?:\/|\b)/i],
  ['JSON-RPC transport', /\bjson[\s_-]?rpc\b|\/jsonrpc(?:\/|\b)/i],
  ['tenant database identifier', /\bkemfai_tenant_[a-z0-9_-]+\b/i],
  ['database implementation key', /\bodoo(?:DbName|_db_name)\b/i],
  ['raw RPC fault', /\b(?:faultCode|faultString|fault_code|fault_string)\b|"debug"\s*:/i],
  ['internal engine URL', /https?:\/\/[^\s"'<>]*odoo[^\s"'<>]*/i],
];

const CUSTOMER_VALUES_ALLOWED_VERBATIM = [T109_CUSTOMER_EMAIL, T109_CUSTOMER_COMPANY];

function maskAllowedCustomerValues(value: string): string {
  return CUSTOMER_VALUES_ALLOWED_VERBATIM.reduce(
    (text, allowed) => text.replaceAll(allowed, '[legitimate-customer-value]'),
    value,
  );
}

function canonicalForms(value: unknown): string[] {
  const original = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  const forms = new Set([original]);
  let decoded = original;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded);
      forms.add(next);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  forms.add(
    decoded
      .replace(/\\u002f/gi, '/')
      .replace(/\\x2f/gi, '/')
      .replace(/&#0*47;|&#x0*2f;|&sol;/gi, '/'),
  );
  return [...forms].map(maskAllowedCustomerValues);
}

function assertNoOdooExposure(value: unknown, label: string): void {
  for (const text of canonicalForms(value)) {
    for (const [kind, pattern] of EXPOSURE_PATTERNS) {
      const match = text.match(pattern);
      if (match) throw new Error(`${label} exposed ${kind}: ${match[0]}`);
    }
  }
}

function assertCleanResponse(response: Response, label: string): void {
  assertNoOdooExposure(response.text, `${label} response text`);
  assertNoOdooExposure(response.body, `${label} parsed body`);
  assertNoOdooExposure(response.headers, `${label} response headers`);
  const requestPath = (response as Response & { req?: { path?: string } }).req?.path ?? '';
  assertNoOdooExposure(requestPath, `${label} response URL`);
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

type HttpCase = {
  surface: T109Surface;
  label: string;
  execute: (app: INestApplication, state: T109FixtureState) => request.Test;
  status?: number;
  prepare?: T109Scenario;
};

const successCases: HttpCase[] = [
  {
    surface: 'plans',
    label: 'public plans GET',
    execute: (app) => request(app.getHttpServer()).get('/public/plans'),
  },
  {
    surface: 'signup',
    label: 'signup POST',
    status: 201,
    execute: (app) =>
      request(app.getHttpServer()).post('/accounts/signup').send({
        email: 't109-new@example.test',
        password: 't109-strong-password',
        planId: T109_PLAN_ID,
        billingCycle: 'monthly',
        acceptedTerms: true,
      }),
  },
  {
    surface: 'verify-email',
    label: 'verify-email POST',
    execute: (app) =>
      request(app.getHttpServer())
        .post('/accounts/verify-email')
        .send({ token: T109_VERIFY_TOKEN }),
  },
  {
    surface: 'verify-email',
    label: 'resend-verification POST',
    status: 202,
    execute: (app) =>
      request(app.getHttpServer())
        .post('/accounts/resend-verification')
        .send({ email: 'verify-odoo@example.test' }),
  },
  {
    surface: 'mfa',
    label: 'MFA enroll POST',
    execute: (app, state) =>
      request(app.getHttpServer()).post('/accounts/mfa/enroll').set(auth(state.tokens.customer)),
  },
  {
    surface: 'mfa',
    label: 'MFA confirm POST',
    execute: (app, state) =>
      request(app.getHttpServer()).post('/accounts/mfa/confirm').set(auth(state.tokens.customer)),
  },
  {
    surface: 'provisioning',
    label: 'provisioning status GET',
    execute: (app, state) =>
      request(app.getHttpServer()).get('/tenants/me').set(auth(state.tokens.customer)),
  },
  {
    surface: 'provisioning',
    label: 'provisioning retry POST',
    status: 202,
    prepare: 'provisioning-failed',
    execute: (app, state) =>
      request(app.getHttpServer())
        .post('/tenants/me/provisioning-retry')
        .set(auth(state.tokens.customer)),
  },
  {
    surface: 'company-wizard',
    label: 'company wizard GET',
    execute: (app, state) =>
      request(app.getHttpServer()).get('/companies/current/setup').set(auth(state.tokens.customer)),
  },
  {
    surface: 'company-wizard',
    label: 'company wizard PUT',
    execute: (app, state) =>
      request(app.getHttpServer())
        .put('/companies/current/setup')
        .set(auth(state.tokens.customer))
        .set('x-kemfai-setup-scope', T109_SETUP_SCOPE)
        .send({ step: 'country', values: { country: 'AE' }, baseVersion: 0 }),
  },
  {
    surface: 'company-wizard',
    label: 'company wizard completion POST',
    execute: (app, state) =>
      request(app.getHttpServer())
        .post('/companies/current/setup/complete')
        .set(auth(state.tokens.customer))
        .set('x-kemfai-setup-scope', T109_SETUP_SCOPE),
  },
  {
    surface: 'company-settings',
    label: 'company settings GET',
    execute: (app, state) =>
      request(app.getHttpServer())
        .get('/companies/current/settings')
        .set(auth(state.tokens.customer)),
  },
  {
    surface: 'company-settings',
    label: 'company settings PUT',
    execute: (app, state) =>
      request(app.getHttpServer())
        .put('/companies/current/settings')
        .set(auth(state.tokens.customer))
        .send({ values: { trade_name: T109_CUSTOMER_COMPANY } }),
  },
  {
    surface: 'billing',
    label: 'billing subscription GET',
    execute: (app, state) =>
      request(app.getHttpServer()).get('/billing/subscription').set(auth(state.tokens.customer)),
  },
  {
    surface: 'billing',
    label: 'billing submissions GET',
    execute: (app, state) =>
      request(app.getHttpServer())
        .get('/billing/payment-submissions')
        .set(auth(state.tokens.customer)),
  },
  {
    surface: 'billing',
    label: 'billing proof POST',
    status: 201,
    prepare: 'billing-upload',
    execute: (app, state) =>
      request(app.getHttpServer())
        .post('/billing/payment-submissions')
        .set(auth(state.tokens.customer))
        .field('bankReference', `BANK-${randomTestSuffix()}`)
        .attach('proofFile', Buffer.from('%PDF-1.7\nT109 synthetic proof\n%%EOF\n'), {
          filename: 'proof.pdf',
          contentType: 'application/pdf',
        }),
  },
  {
    surface: 'modules',
    label: 'module catalog GET',
    execute: (app, state) =>
      request(app.getHttpServer()).get('/modules').set(auth(state.tokens.customer)),
  },
  {
    surface: 'modules',
    label: 'module selection PUT',
    execute: (app, state) =>
      request(app.getHttpServer())
        .put('/modules/selection')
        .set(auth(state.tokens.customer))
        .send({ featureKeys: ['module.accounting'] }),
  },
  {
    surface: 'checklist',
    label: 'onboarding checklist GET',
    execute: (app, state) =>
      request(app.getHttpServer()).get('/onboarding/checklist').set(auth(state.tokens.customer)),
  },
  {
    surface: 'support-access',
    label: 'support-access history GET',
    execute: (app, state) =>
      request(app.getHttpServer()).get('/support-access/grants').set(auth(state.tokens.customer)),
  },
  {
    surface: 'support-access',
    label: 'support-access grant POST',
    status: 201,
    execute: (app, state) =>
      request(app.getHttpServer())
        .post('/support-access/grants')
        .set(auth(state.tokens.customer))
        .send({
          granteeRole: 'Support',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
  },
  {
    surface: 'support-access',
    label: 'support-access revoke POST',
    execute: (app, state) =>
      request(app.getHttpServer())
        .post(`/support-access/grants/${T109_GRANT_ID}/revoke`)
        .set(auth(state.tokens.customer)),
  },
  {
    surface: 'support-access',
    label: 'support workspace summary GET',
    execute: (app, state) =>
      request(app.getHttpServer())
        .get(`/internal/support-access/workspaces/${T109_TENANT_ID}/summary`)
        .query({ grantId: T109_GRANT_ID })
        .set(auth(state.tokens.support)),
  },
  {
    surface: 'billing-admin',
    label: 'Billing Admin queue GET',
    execute: (app, state) =>
      request(app.getHttpServer())
        .get('/internal/billing/review-queue')
        .set(auth(state.tokens.admin)),
  },
  {
    surface: 'billing-admin',
    label: 'Billing Admin approve POST',
    execute: (app, state) =>
      request(app.getHttpServer())
        .post(`/internal/billing/payment-submissions/${T109_SUBMISSION_ID}/approve`)
        .set(auth(state.tokens.admin)),
  },
  {
    surface: 'billing-admin',
    label: 'Billing Admin reject POST',
    execute: (app, state) =>
      request(app.getHttpServer())
        .post(`/internal/billing/payment-submissions/${T109_SUBMISSION_ID}/reject`)
        .set(auth(state.tokens.admin))
        .send({ reason: 'Reference did not match' }),
  },
  {
    surface: 'billing-admin',
    label: 'Billing Admin more-information POST',
    execute: (app, state) =>
      request(app.getHttpServer())
        .post(`/internal/billing/payment-submissions/${T109_SUBMISSION_ID}/request-more-info`)
        .set(auth(state.tokens.admin))
        .send({ details: 'Upload a complete receipt' }),
  },
];

function randomTestSuffix(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

type DenialCase = {
  label: string;
  expected: number;
  execute: (app: INestApplication, state: T109FixtureState) => request.Test;
  prepare?: T109Scenario;
  mode?: [T109Surface, T109FixtureMode];
};

const anonymousCases: DenialCase[] = successCases
  .filter(({ surface }) => !['plans', 'signup', 'verify-email'].includes(surface))
  .map((fixture) => ({
    label: `${fixture.label} anonymous denial`,
    expected: 401,
    execute: (app) => {
      const operation = request(app.getHttpServer());
      const path = fixture.execute.toString().match(/['`](\/[A-Za-z0-9_/${}:.?-]+)/)?.[1];
      void path;
      switch (fixture.label) {
        case 'MFA enroll POST':
          return operation.post('/accounts/mfa/enroll');
        case 'MFA confirm POST':
          return operation.post('/accounts/mfa/confirm');
        case 'provisioning status GET':
          return operation.get('/tenants/me');
        case 'provisioning retry POST':
          return operation.post('/tenants/me/provisioning-retry');
        case 'company wizard GET':
          return operation.get('/companies/current/setup');
        case 'company wizard PUT':
          return operation.put('/companies/current/setup');
        case 'company wizard completion POST':
          return operation.post('/companies/current/setup/complete');
        case 'company settings GET':
          return operation.get('/companies/current/settings');
        case 'company settings PUT':
          return operation.put('/companies/current/settings');
        case 'billing subscription GET':
          return operation.get('/billing/subscription');
        case 'billing submissions GET':
          return operation.get('/billing/payment-submissions');
        case 'billing proof POST':
          return operation.post('/billing/payment-submissions');
        case 'module catalog GET':
          return operation.get('/modules');
        case 'module selection PUT':
          return operation.put('/modules/selection');
        case 'onboarding checklist GET':
          return operation.get('/onboarding/checklist');
        case 'support-access history GET':
          return operation.get('/support-access/grants');
        case 'support-access grant POST':
          return operation.post('/support-access/grants');
        case 'support-access revoke POST':
          return operation.post(`/support-access/grants/${T109_GRANT_ID}/revoke`);
        case 'support workspace summary GET':
          return operation.get(`/internal/support-access/workspaces/${T109_TENANT_ID}/summary`);
        case 'Billing Admin queue GET':
          return operation.get('/internal/billing/review-queue');
        case 'Billing Admin approve POST':
          return operation.post(
            `/internal/billing/payment-submissions/${T109_SUBMISSION_ID}/approve`,
          );
        case 'Billing Admin reject POST':
          return operation.post(
            `/internal/billing/payment-submissions/${T109_SUBMISSION_ID}/reject`,
          );
        default:
          return operation.post(
            `/internal/billing/payment-submissions/${T109_SUBMISSION_ID}/request-more-info`,
          );
      }
    },
  }));

const branchCases: DenialCase[] = [
  {
    label: 'plans database error',
    expected: 500,
    prepare: 'plans-error',
    execute: (app) => request(app.getHttpServer()).get('/public/plans'),
  },
  {
    label: 'signup validation',
    expected: 422,
    execute: (app) =>
      request(app.getHttpServer()).post('/accounts/signup').send({ email: 'invalid' }),
  },
  {
    label: 'verify invalid token',
    expected: 410,
    execute: (app) =>
      request(app.getHttpServer()).post('/accounts/verify-email').send({ token: 'not-valid' }),
  },
  {
    label: 'resend malformed email',
    expected: 422,
    execute: (app) =>
      request(app.getHttpServer()).post('/accounts/resend-verification').send({ email: 'bad' }),
  },
  {
    label: 'provisioning failed diagnostics projection',
    expected: 200,
    prepare: 'provisioning-failed',
    execute: (app, state) =>
      request(app.getHttpServer()).get('/tenants/me').set(auth(state.tokens.customer)),
  },
  {
    label: 'company setup missing scope',
    expected: 412,
    execute: (app, state) =>
      request(app.getHttpServer())
        .put('/companies/current/setup')
        .set(auth(state.tokens.customer))
        .send({ step: 'country', values: { country: 'AE' }, baseVersion: 0 }),
  },
  {
    label: 'company completion missing scope',
    expected: 412,
    execute: (app, state) =>
      request(app.getHttpServer())
        .post('/companies/current/setup/complete')
        .set(auth(state.tokens.customer)),
  },
  {
    label: 'billing missing subscription',
    expected: 404,
    prepare: 'billing-error',
    execute: (app, state) =>
      request(app.getHttpServer()).get('/billing/subscription').set(auth(state.tokens.customer)),
  },
  {
    label: 'billing invalid upload',
    expected: 422,
    prepare: 'billing-upload',
    execute: (app, state) =>
      request(app.getHttpServer())
        .post('/billing/payment-submissions')
        .set(auth(state.tokens.customer))
        .field('bankReference', 'BAD')
        .attach('proofFile', Buffer.from('not a PDF'), {
          filename: 'proof.exe',
          contentType: 'application/octet-stream',
        }),
  },
  {
    label: 'module entitlement denial',
    expected: 403,
    execute: (app, state) =>
      request(app.getHttpServer())
        .put('/modules/selection')
        .set(auth(state.tokens.customer))
        .send({ featureKeys: ['module.not-entitled'] }),
  },
  {
    label: 'support expiry validation',
    expected: 422,
    execute: (app, state) =>
      request(app.getHttpServer())
        .post('/support-access/grants')
        .set(auth(state.tokens.customer))
        .send({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
  },
  {
    label: 'support summary missing grant',
    expected: 403,
    execute: (app, state) =>
      request(app.getHttpServer())
        .get(`/internal/support-access/workspaces/${T109_TENANT_ID}/summary`)
        .set(auth(state.tokens.support)),
  },
  {
    label: 'Billing Admin wrong role',
    expected: 403,
    execute: (app, state) =>
      request(app.getHttpServer())
        .get('/internal/billing/review-queue')
        .set(auth(state.tokens.denied)),
  },
  {
    label: 'Billing Admin reject validation',
    expected: 422,
    execute: (app, state) =>
      request(app.getHttpServer())
        .post(`/internal/billing/payment-submissions/${T109_SUBMISSION_ID}/reject`)
        .set(auth(state.tokens.admin))
        .send({ reason: '' }),
  },
  {
    label: 'tenant-scope header denial',
    expected: 403,
    execute: (app, state) =>
      request(app.getHttpServer())
        .get('/modules')
        .set(auth(state.tokens.customer))
        .set('x-tenant-id', '20900000-0000-4000-8000-000000000003'),
  },
];

const odooBoundaryCases: Array<HttpCase & { rawSuccessStatus: number }> = [
  { ...successCases.find((item) => item.label === 'company wizard GET')!, rawSuccessStatus: 200 },
  { ...successCases.find((item) => item.label === 'company wizard PUT')!, rawSuccessStatus: 200 },
  {
    ...successCases.find((item) => item.label === 'company wizard completion POST')!,
    rawSuccessStatus: 200,
  },
  { ...successCases.find((item) => item.label === 'company settings GET')!, rawSuccessStatus: 200 },
  { ...successCases.find((item) => item.label === 'company settings PUT')!, rawSuccessStatus: 200 },
  { ...successCases.find((item) => item.label === 'module catalog GET')!, rawSuccessStatus: 200 },
  { ...successCases.find((item) => item.label === 'module selection PUT')!, rawSuccessStatus: 500 },
  {
    ...successCases.find((item) => item.label === 'onboarding checklist GET')!,
    rawSuccessStatus: 500,
  },
];

describe('T109 full-surface Nest HTTP Odoo-exposure sweep', () => {
  let app: INestApplication;
  let state: T109FixtureState;
  let closeFixture: () => Promise<void>;

  beforeAll(async () => {
    const fixture = await createT109SurfaceApp();
    ({ app, state } = fixture);
    closeFixture = fixture.close;
  });

  beforeEach(async () => state.reset());
  afterAll(async () => closeFixture?.());

  it.each([
    ['native name', 'Native Odoo screen'],
    ['company model', 'res.company'],
    ['contact model', 'res.partner'],
    ['native route', '/web/database/selector'],
    ['encoded native route', '%2Fweb%2Fdatabase%2Fselector'],
    ['XML-RPC', 'xmlrpc'],
    ['JSON-RPC', 'jsonrpc'],
    ['tenant database', 'kemfai_tenant_injected'],
    ['camel database key', 'odooDbName'],
    ['snake database key', 'odoo_db_name'],
    ['camel fault code', 'faultCode'],
    ['camel fault string', 'faultString'],
    ['snake fault code', 'fault_code'],
    ['snake fault string', 'fault_string'],
    ['internal URL', 'http://odoo.internal:8069'],
  ])('one-marker scanner control detects %s', (_label, marker) => {
    expect(() => assertNoOdooExposure(marker, 'one-marker control')).toThrow();
  });

  it('does not suppress legitimate customer values containing the word Odoo', () => {
    expect(() => assertNoOdooExposure(T109_CUSTOMER_EMAIL, 'customer email')).not.toThrow();
    expect(() => assertNoOdooExposure(T109_CUSTOMER_COMPANY, 'company name')).not.toThrow();
  });

  it.each(['model', 'rpc', 'database', 'route', 'fault'])(
    'real HTTP-body capture rejects the %s leak control',
    async (kind) => {
      const response = await request(app.getHttpServer()).get('/__t109/leak/body').query({ kind });
      expect(() => assertCleanResponse(response, `HTTP ${kind} control`)).toThrow();
    },
  );

  it('real HTTP-header capture rejects a leak control', async () => {
    const response = await request(app.getHttpServer()).get('/__t109/leak/header');
    expect(() => assertCleanResponse(response, 'HTTP header control')).toThrow();
  });

  it.each(successCases)('$label returns a clean mapped body through AppModule', async (fixture) => {
    if (fixture.prepare) await state.prepare(fixture.prepare);
    const response = await fixture.execute(app, state).expect(fixture.status ?? HttpStatus.OK);
    assertCleanResponse(response, fixture.label);
  });

  it('preserves legitimate customer Odoo values while projecting private fields', async () => {
    const settings = await request(app.getHttpServer())
      .get('/companies/current/settings')
      .set(auth(state.tokens.customer))
      .expect(200);
    const queue = await request(app.getHttpServer())
      .get('/internal/billing/review-queue')
      .set(auth(state.tokens.admin))
      .expect(200);
    expect(settings.text).toContain(T109_CUSTOMER_COMPANY);
    expect(queue.text).toContain(T109_CUSTOMER_EMAIL);
    assertCleanResponse(settings, 'legitimate company value');
    assertCleanResponse(queue, 'legitimate email value');
  });

  it.each(anonymousCases)('$label has a clean response body', async (fixture) => {
    const response = await fixture.execute(app, state).expect(fixture.expected);
    assertCleanResponse(response, fixture.label);
  });

  it.each(branchCases)('$label has a clean response body', async (fixture) => {
    if (fixture.prepare) await state.prepare(fixture.prepare);
    if (fixture.mode) await state.setMode(...fixture.mode);
    const response = await fixture.execute(app, state).expect(fixture.expected);
    assertCleanResponse(response, fixture.label);
  });

  it.each(odooBoundaryCases)(
    '$label projects or rejects a raw Odoo success without echoing it',
    async (fixture) => {
      await state.setMode(fixture.surface, 'raw-success');
      const response = await fixture.execute(app, state).expect(fixture.rawSuccessStatus);
      assertCleanResponse(response, `${fixture.label} raw success`);
    },
  );

  it.each(odooBoundaryCases)(
    '$label translates a raw Odoo error without echoing it',
    async (fixture) => {
      await state.setMode(fixture.surface, 'raw-error');
      const response = await fixture.execute(app, state).expect(500);
      assertCleanResponse(response, `${fixture.label} raw error`);
    },
  );

  it.each([
    ['signup', successCases.find((item) => item.label === 'signup POST')!, 503],
    ['verify-email', successCases.find((item) => item.label === 'verify-email POST')!, 503],
    ['mfa', successCases.find((item) => item.label === 'MFA enroll POST')!, 503],
    ['mfa', successCases.find((item) => item.label === 'MFA confirm POST')!, 503],
  ] as const)(
    '%s external-adapter diagnostics are translated cleanly',
    async (surface, fixture, status) => {
      await state.setMode(surface, 'raw-error');
      const response = await fixture.execute(app, state).expect(status);
      assertCleanResponse(response, `${surface} adapter error`);
    },
  );

  it('Billing Admin storage diagnostics are not exposed', async () => {
    await state.setMode('billing-admin', 'raw-error');
    const response = await request(app.getHttpServer())
      .get('/internal/billing/review-queue')
      .set(auth(state.tokens.admin))
      .expect(500);
    assertCleanResponse(response, 'billing-admin storage error');
  });

  it('billing proof-storage diagnostics are not exposed', async () => {
    await state.prepare('billing-upload');
    await state.setMode('billing', 'raw-error');
    const fixture = successCases.find((item) => item.label === 'billing proof POST')!;
    const response = await fixture.execute(app, state).expect(500);
    assertCleanResponse(response, 'billing proof storage error');
  });

  it('provisioning diagnostics persisted by a worker are projected to a stable customer message', async () => {
    await state.prepare('provisioning-failed');
    const response = await request(app.getHttpServer())
      .get('/tenants/me')
      .set(auth(state.tokens.customer))
      .expect(200);
    expect(response.body).toEqual({
      tenantId: T109_TENANT_ID,
      status: 'Failed',
      failureReason: 'Retry or contact support',
    });
    assertCleanResponse(response, 'provisioning diagnostic projection');
  });

  it('the seeded customer identity remains the production tenant-context source', async () => {
    const response = await request(app.getHttpServer())
      .get('/support-access/grants')
      .set(auth(state.tokens.customer))
      .expect(200);
    expect(response.body[0]).toMatchObject({ grantedBy: T109_ACCOUNT_ID });
    assertCleanResponse(response, 'tenant-context production mapping');
  });
});
