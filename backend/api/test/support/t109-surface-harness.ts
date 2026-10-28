import { Body, Controller, Get, Header, INestApplication, Post, Query } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../src/app.module';
import { Public } from '../../src/common/decorators/public.decorator';
import controlDataSource from '../../src/database/data-source';
import type { KeycloakUserProvisioner } from '../../src/integrations/keycloak/keycloak-user-provisioner';
import { KEYCLOAK_USER_PROVISIONER } from '../../src/integrations/keycloak/keycloak-user-provisioner';
import type { MinioClientLike } from '../../src/integrations/minio/minio-client';
import { MINIO_CLIENT } from '../../src/integrations/minio/minio.module';
import type { OdooRpcClientLike } from '../../src/integrations/odoo-rpc/odoo-rpc-client';
import { ODOO_RPC_CLIENT } from '../../src/integrations/odoo-rpc/odoo-rpc.token';
import { BILLING_DECISION_NOTIFICATION_TRANSPORT } from '../../src/modules/billing-admin/billing-decision-notification-transport.contract';
import { computeCompanySetupScope } from '../../src/modules/company-setup/company-setup-scope.util';
import { hashVerificationToken } from '../../src/modules/accounts/tokens/email-verification-token';
import { startFakeKeycloak, type FakeKeycloak } from './fake-keycloak';

export const T109_FIXTURE_LABEL =
  'kemfai.phase12.operation=t109-parent-gates-continuation-20261025T153344Z';
export const T109_PLAN_ID = '10900000-0000-4000-8000-000000000001';
export const T109_ACCOUNT_ID = '10900000-0000-4000-8000-000000000002';
export const T109_TENANT_ID = '10900000-0000-4000-8000-000000000003';
export const T109_SUBMISSION_ID = '10900000-0000-4000-8000-000000000004';
export const T109_SUBSCRIPTION_ID = '10900000-0000-4000-8000-000000000005';
export const T109_GRANT_ID = '10900000-0000-4000-8000-000000000006';
export const T109_VERIFY_ACCOUNT_ID = '10900000-0000-4000-8000-000000000007';
export const T109_OWNER_SUB = '10900000-0000-4000-8000-000000000102';
export const T109_VERIFY_SUB = '10900000-0000-4000-8000-000000000107';
export const T109_ADMIN_SUB = '10900000-0000-4000-8000-000000000109';
export const T109_SUPPORT_SUB = '10900000-0000-4000-8000-000000000110';
export const T109_DENIED_SUB = '10900000-0000-4000-8000-000000000111';
export const T109_VERIFY_TOKEN = 't109-valid-token';
export const T109_CUSTOMER_EMAIL = 'owner.odoo@example.test';
export const T109_CUSTOMER_COMPANY = 'Odoo Enthusiasts Trading';
export const T109_SETUP_SCOPE = computeCompanySetupScope(T109_TENANT_ID, T109_ACCOUNT_ID, 1);

export type T109Surface =
  | 'plans'
  | 'signup'
  | 'verify-email'
  | 'mfa'
  | 'provisioning'
  | 'company-wizard'
  | 'company-settings'
  | 'billing'
  | 'modules'
  | 'checklist'
  | 'support-access'
  | 'billing-admin';

export type T109FixtureMode = 'clean' | 'raw-success' | 'raw-error';
export type T109Scenario =
  'baseline' | 'plans-error' | 'provisioning-failed' | 'billing-error' | 'billing-upload';

export interface T109Tokens {
  customer: string;
  admin: string;
  support: string;
  denied: string;
}

const RAW_UPSTREAM_LEAK = {
  jsonrpc: '2.0',
  model: 'res.company',
  relatedModel: 'res.partner',
  endpoint: 'http://odoo.internal:8069/jsonrpc',
  webClient: '/web/database/selector',
  encodedWebClient: '%2Fweb%2Fdatabase%2Fselector',
  database: 'kemfai_tenant_t109_injected',
  odooDbName: 'kemfai_tenant_t109_camel',
  odoo_db_name: 'kemfai_tenant_t109_snake',
  fault_code: 500,
  fault_string: 'xmlrpc upstream traceback',
};

const RAW_UPSTREAM_ERROR =
  `Upstream Odoo res.partner failed at /web/database/selector through jsonrpc ` +
  `for kemfai_tenant_t109_injected (fault_code/fault_string; odooDbName)`;

const COMPANY_VALUES = {
  country: 'AE',
  legal_name: 'T109 Clean Company LLC',
  trade_name: T109_CUSTOMER_COMPANY,
  base_currency: 'AED',
  fiscal_year_start_month: '1',
  fiscal_year_start_day: 1,
  vat_tax_registration: '100000000000003',
  industry: 7,
  accounting_setup_template: 'standard',
};

function assertOwnedFixtureEnvironment(): void {
  if (process.env.T109_FIXTURE_LABEL !== T109_FIXTURE_LABEL) {
    throw new Error(`T109_FIXTURE_LABEL must equal ${T109_FIXTURE_LABEL}`);
  }
  if (process.env.T109_CONTROL_DB_OWNED !== '1') {
    throw new Error('T109_CONTROL_DB_OWNED=1 is required before resetting the fixture database');
  }
  if (process.env.CONTROL_DB_HOST !== '127.0.0.1') {
    throw new Error('T109 control database must be bound to 127.0.0.1');
  }
  if (process.env.CONTROL_DB_NAME !== 'kemfai_control') {
    throw new Error('T109 control database must use the disposable kemfai_control database');
  }
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('T109 AppModule fixture requires NODE_ENV=test before module loading');
  }
}

export class T109FixtureState {
  private readonly modes = new Map<T109Surface, T109FixtureMode>();

  constructor(readonly tokens: T109Tokens) {}

  mode(surface: T109Surface): T109FixtureMode {
    return this.modes.get(surface) ?? 'clean';
  }

  async setMode(surface: T109Surface, mode: T109FixtureMode): Promise<void> {
    this.modes.set(surface, mode);
    if (surface === 'provisioning' && mode !== 'clean') {
      await controlDataSource.query(
        `UPDATE tenant SET status = 'Failed', failure_reason = $2 WHERE id = $1`,
        [T109_TENANT_ID, RAW_UPSTREAM_ERROR],
      );
    }
  }

  async prepare(scenario: T109Scenario): Promise<void> {
    await this.reset();
    if (scenario === 'plans-error') {
      await controlDataSource.query('DELETE FROM entitlement_default');
    } else if (scenario === 'provisioning-failed') {
      await controlDataSource.query(
        `UPDATE tenant SET status = 'Failed', failure_reason = $2 WHERE id = $1`,
        [T109_TENANT_ID, RAW_UPSTREAM_ERROR],
      );
    } else if (scenario === 'billing-error') {
      await controlDataSource.query('DELETE FROM payment_submission');
      await controlDataSource.query('DELETE FROM subscription');
    } else if (scenario === 'billing-upload') {
      await controlDataSource.query('DELETE FROM billing_decision_notification_outbox');
      await controlDataSource.query('DELETE FROM payment_submission');
    }
  }

  async reset(): Promise<void> {
    assertOwnedFixtureEnvironment();
    this.modes.clear();
    const rows = (await controlDataSource.query(
      `SELECT tablename FROM pg_tables
         WHERE schemaname = 'public' AND tablename <> 'migrations'
         ORDER BY tablename`,
    )) as Array<{ tablename: string }>;
    if (rows.length > 0) {
      const tables = rows.map(({ tablename }) => `"${tablename.replaceAll('"', '""')}"`).join(', ');
      await controlDataSource.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
    }

    await controlDataSource.query(
      `INSERT INTO entitlement_default
         (id, default_trial_window_days, default_auto_restrict_unpaid)
       VALUES (1, 14, true)`,
    );
    await controlDataSource.query(
      `INSERT INTO plan
         (id, name, name_en, name_ar, published, monthly_price, annual_price, currency)
       VALUES ($1, 'Growth', 'Growth', 'النمو', true, 125, 1250, 'AED')`,
      [T109_PLAN_ID],
    );
    for (const feature of [
      ['module.accounts', 'Accounts', 'Accounts', 'الحسابات'],
      ['module.company_setup', 'Company setup', 'Company setup', 'إعداد الشركة'],
      ['module.module_selection', 'Module selection', 'Module selection', 'اختيار الوحدات'],
      [
        'module.onboarding_checklist',
        'Onboarding checklist',
        'Onboarding checklist',
        'قائمة الإعداد',
      ],
      ['module.support_access', 'Support access', 'Support access', 'وصول الدعم'],
      ['module.accounting', 'Accounting', 'Accounting', 'المحاسبة'],
      ['module.inventory', 'Inventory', 'Inventory', 'المخزون'],
    ]) {
      await controlDataSource.query(
        `INSERT INTO feature (id, key, display_name, display_name_en, display_name_ar, kind)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'module')`,
        feature,
      );
    }
    for (const key of [
      'module.accounts',
      'module.company_setup',
      'module.module_selection',
      'module.onboarding_checklist',
      'module.support_access',
    ]) {
      await controlDataSource.query(
        `INSERT INTO feature_flag (feature_key, enabled, notes) VALUES ($1, true, 'T109 fixture')`,
        [key],
      );
    }
    for (const key of ['module.accounting', 'module.inventory']) {
      await controlDataSource.query(
        `INSERT INTO plan_feature_entitlement (plan_id, feature_key, enabled, limit_value)
         VALUES ($1, $2, true, NULL)`,
        [T109_PLAN_ID, key],
      );
    }
    await controlDataSource.query(
      `INSERT INTO plan_setting (plan_id, trial_window_days, auto_restrict_unpaid)
       VALUES ($1, 14, true)`,
      [T109_PLAN_ID],
    );
    await controlDataSource.query(
      `INSERT INTO account
         (id, keycloak_user_id, email, email_verified, mfa_enrolled,
          selected_plan_id, selected_billing_cycle, preferred_locale)
       VALUES ($1, $2, $3, true, false, $4, 'monthly', NULL),
              ($5, $6, 'verify-odoo@example.test', false, false, $4, 'monthly', NULL)`,
      [
        T109_ACCOUNT_ID,
        T109_OWNER_SUB,
        T109_CUSTOMER_EMAIL,
        T109_PLAN_ID,
        T109_VERIFY_ACCOUNT_ID,
        T109_VERIFY_SUB,
      ],
    );
    await controlDataSource.query(
      `INSERT INTO email_verification_token
         (id, account_id, token_hash, token_version, expires_at)
       VALUES (gen_random_uuid(), $1, $2, gen_random_uuid(), now() + interval '1 hour')`,
      [T109_VERIFY_ACCOUNT_ID, hashVerificationToken(T109_VERIFY_TOKEN)],
    );
    await controlDataSource.query(
      `INSERT INTO tenant
         (id, account_id, status, odoo_db_name, odoo_company_id, minio_bucket,
          provisioning_attempts, failure_reason, ready_at)
       VALUES ($1, $2, 'Ready', 'private_fixture_workspace', 1, $3, 1, NULL, now())`,
      [T109_TENANT_ID, T109_ACCOUNT_ID, `kemfai-tenant-${T109_TENANT_ID}`],
    );
    await controlDataSource.query(
      `INSERT INTO subscription
         (id, tenant_id, plan_id, billing_cycle, status,
          current_period_start, current_period_end)
       VALUES ($1, $2, $3, 'monthly', 'PendingActivation', '2026-10-01', '2026-10-31')`,
      [T109_SUBSCRIPTION_ID, T109_TENANT_ID, T109_PLAN_ID],
    );
    const submittedAt = new Date().toISOString();
    await controlDataSource.query(
      `INSERT INTO payment_submission
         (id, tenant_id, subscription_id, billing_period_start, billing_period_end,
          amount, currency, bank_reference, proof_object_key, status, submitted_at,
          status_history)
       VALUES ($1, $2, $3, '2026-10-01', '2026-10-31', 125, 'AED',
               'BANK-T109-REF', 'payment-submissions/t109/proof.pdf',
               'PendingReview', $4, $5::jsonb)`,
      [
        T109_SUBMISSION_ID,
        T109_TENANT_ID,
        T109_SUBSCRIPTION_ID,
        submittedAt,
        JSON.stringify([
          {
            status: 'PendingReview',
            changedAt: submittedAt,
            changedBy: T109_ACCOUNT_ID,
            notes: null,
          },
        ]),
      ],
    );
    await controlDataSource.query(
      `INSERT INTO support_access_grant
         (id, tenant_id, granted_by, grantee_role, permitted_actions, expires_at, status)
       VALUES ($1, $2, $3, 'Support', ARRAY['workspace.summary.read'],
               now() + interval '2 hours', 'Active')`,
      [T109_GRANT_ID, T109_TENANT_ID, T109_ACCOUNT_ID],
    );
  }

  private activeOdooMode(): T109FixtureMode {
    for (const surface of ['company-wizard', 'company-settings', 'modules', 'checklist'] as const) {
      const mode = this.mode(surface);
      if (mode !== 'clean') return mode;
    }
    return 'clean';
  }

  odooMode(
    surface: Extract<T109Surface, 'company-wizard' | 'company-settings' | 'modules' | 'checklist'>,
  ): T109FixtureMode {
    return this.mode(surface);
  }

  maybeThrowOdooAuthenticationError(): void {
    if (this.activeOdooMode() === 'raw-error') throw new Error(RAW_UPSTREAM_ERROR);
  }
}

class T109OdooRpcClient implements OdooRpcClientLike {
  constructor(private readonly state: T109FixtureState) {}

  async call(service: string, method: string, args: unknown[]): Promise<unknown> {
    if (service === 'common' && method === 'login') {
      this.state.maybeThrowOdooAuthenticationError();
      return 109;
    }
    if (service !== 'object' || method !== 'execute_kw') return undefined;

    const model = args[3];
    const operation = args[4];
    const positional = (args[5] as unknown[] | undefined) ?? [];
    const surface =
      model === 'res.company'
        ? String(operation).startsWith('kemfai_settings')
          ? 'company-settings'
          : 'company-wizard'
        : model === 'kemfai.module.selection'
          ? 'modules'
          : 'checklist';
    const mode = this.state.odooMode(surface);
    if (mode === 'raw-error') throw new Error(RAW_UPSTREAM_ERROR);
    const leak = mode === 'raw-success' ? { upstreamDiagnostics: RAW_UPSTREAM_LEAK } : {};

    if (model === 'res.company') {
      if (operation === 'search') return [1];
      if (operation === 'kemfai_settings_get') {
        return { values: { ...COMPANY_VALUES }, setupComplete: true, ...leak };
      }
      if (operation === 'kemfai_settings_update') {
        const submitted = (positional[1] as Record<string, unknown> | undefined) ?? {};
        return {
          values: { ...COMPANY_VALUES, ...submitted },
          setupComplete: true,
          changedFields: Object.keys(submitted),
          ...leak,
        };
      }
      const state = {
        currentStep: 'country',
        setupComplete: operation === 'kemfai_setup_complete',
        values: { ...COMPANY_VALUES },
        version: operation === 'kemfai_setup_save_step' ? 1 : 0,
        stale: false,
        ...(operation === 'kemfai_setup_complete' ? { alreadyComplete: false } : {}),
        ...leak,
      };
      return state;
    }

    if (model === 'kemfai.module.selection') {
      if (operation === 'kemfai_get_selection') {
        return mode === 'raw-success'
          ? ['module.accounting', 'res.company']
          : ['module.accounting'];
      }
      if (operation === 'kemfai_get_pending_selection_event') return null;
      if (operation === 'kemfai_ack_selection_event') return true;
      if (operation === 'kemfai_replace_selection') {
        const requested = (positional[0] as string[] | undefined) ?? [];
        const featureKeys = mode === 'raw-success' ? [...requested, 'res.company'] : requested;
        return {
          operationUuid: positional[1],
          tenantId: positional[2],
          accountId: positional[3],
          actorKeycloakUserId: positional[4],
          occurredAt: positional[5],
          featureKeys,
          added: featureKeys,
          removed: [],
          ...leak,
        };
      }
    }

    if (model === 'kemfai.onboarding.checklist' && operation === 'kemfai_get_state') {
      return {
        customerAdded: false,
        bankAdded: false,
        productAdded: false,
        firstInvoiceReady: false,
        ...leak,
      };
    }
    return undefined;
  }
}

class T109KeycloakProvisioner implements KeycloakUserProvisioner {
  constructor(private readonly state: T109FixtureState) {}

  private failIf(surface: 'signup' | 'verify-email' | 'mfa'): void {
    if (this.state.mode(surface) === 'raw-error') throw new Error(RAW_UPSTREAM_ERROR);
  }

  async createUser(): Promise<string> {
    this.failIf('signup');
    return randomUUID();
  }
  async assignWorkspaceOwner(): Promise<void> {}
  async revokeWorkspaceOwner(): Promise<void> {}
  async deleteUser(): Promise<void> {}
  async markEmailVerified(): Promise<void> {
    this.failIf('verify-email');
  }
  async beginTotpEnrollment(): Promise<void> {
    this.failIf('mfa');
  }
  async hasActiveTotpCredential(): Promise<boolean> {
    this.failIf('mfa');
    return true;
  }
}

class T109MinioClient implements MinioClientLike {
  constructor(private readonly state: T109FixtureState) {}

  async bucketExists(): Promise<boolean> {
    return true;
  }
  async makeBucket(): Promise<void> {}
  async presignedPutObject(): Promise<string> {
    return 'https://storage.example.test/upload/t109';
  }
  async presignedGetObject(): Promise<string> {
    if (this.state.mode('billing-admin') === 'raw-error') throw new Error(RAW_UPSTREAM_ERROR);
    return 'https://storage.example.test/proofs/t109.pdf';
  }
  async putObject(): Promise<void> {
    if (this.state.mode('billing') === 'raw-error') throw new Error(RAW_UPSTREAM_ERROR);
  }
  async removeObject(): Promise<void> {}
}

function validSurface(value: unknown): value is T109Surface {
  return [
    'plans',
    'signup',
    'verify-email',
    'mfa',
    'provisioning',
    'company-wizard',
    'company-settings',
    'billing',
    'modules',
    'checklist',
    'support-access',
    'billing-admin',
  ].includes(String(value));
}

function validMode(value: unknown): value is T109FixtureMode {
  return ['clean', 'raw-success', 'raw-error'].includes(String(value));
}

function validScenario(value: unknown): value is T109Scenario {
  return [
    'baseline',
    'plans-error',
    'provisioning-failed',
    'billing-error',
    'billing-upload',
  ].includes(String(value));
}

@Controller('__t109')
@Public()
class T109ControlController {
  constructor(private readonly state: T109FixtureState) {}

  @Get('health')
  health() {
    return { status: 'ready', fixture: 't109' };
  }

  @Get('session-fixture')
  sessionFixture() {
    return { tokens: this.state.tokens, setupScope: T109_SETUP_SCOPE };
  }

  @Post('mode')
  async mode(@Body() body: { surface?: unknown; mode?: unknown }) {
    if (!validSurface(body.surface) || !validMode(body.mode)) return { changed: false };
    await this.state.setMode(body.surface, body.mode);
    return { changed: true };
  }

  @Post('prepare')
  async prepare(@Body() body: { scenario?: unknown }) {
    if (!validScenario(body.scenario)) return { changed: false };
    await this.state.prepare(body.scenario);
    return { changed: true };
  }

  @Post('reset')
  async reset() {
    await this.state.reset();
    return { reset: true };
  }

  @Get('leak/body')
  leakBody(@Query('kind') kind?: string) {
    const values: Record<string, unknown> = {
      model: 'res.company',
      rpc: { jsonrpc: '2.0' },
      database: { odoo_db_name: 'kemfai_tenant_t109_control' },
      route: '%2Fweb%2Fdatabase%2Fselector',
      fault: { fault_string: 'xmlrpc traceback' },
    };
    return { injected: values[kind ?? 'model'] ?? values.model };
  }

  @Get('leak/header')
  @Header('x-t109-upstream', 'odooDbName=kemfai_tenant_t109_header')
  leakHeader() {
    return { ok: true };
  }
}

async function startIdentityFixture(): Promise<{
  keycloak: FakeKeycloak;
  tokens: T109Tokens;
}> {
  const customerIssuer = 'https://identity.t109.invalid/realms/customer';
  const internalIssuer = 'https://identity.t109.invalid/realms/internal';
  const audience = 'kemfai-api-t109';
  const keycloak = await startFakeKeycloak({ issuer: customerIssuer, audience });
  process.env.KEYCLOAK_ISSUER = customerIssuer;
  process.env.KEYCLOAK_JWKS_URI = keycloak.jwksUri;
  process.env.KEYCLOAK_API_AUDIENCE = audience;
  process.env.KEYCLOAK_INTERNAL_ISSUER = internalIssuer;
  process.env.KEYCLOAK_INTERNAL_JWKS_URI = keycloak.jwksUri;
  process.env.KEYCLOAK_INTERNAL_API_AUDIENCE = audience;
  return {
    keycloak,
    tokens: {
      customer: await keycloak.signAccessToken({
        sub: T109_OWNER_SUB,
        roles: ['WorkspaceOwner'],
        tenantId: T109_TENANT_ID,
      }),
      admin: await keycloak.signAccessToken({
        sub: T109_ADMIN_SUB,
        issuer: internalIssuer,
        roles: ['BillingAdmin'],
      }),
      support: await keycloak.signAccessToken({
        sub: T109_SUPPORT_SUB,
        issuer: internalIssuer,
        roles: ['Support'],
      }),
      denied: await keycloak.signAccessToken({
        sub: T109_DENIED_SUB,
        issuer: internalIssuer,
        roles: ['TechnicalAdmin'],
      }),
    },
  };
}

export async function createT109SurfaceApp(
  options: { listen?: boolean; port?: number; corsOrigin?: string } = {},
): Promise<{
  app: INestApplication;
  state: T109FixtureState;
  close: () => Promise<void>;
}> {
  assertOwnedFixtureEnvironment();
  process.env.NODE_ENV = 'test';
  process.env.SUPPORT_ACCESS_MAX_DURATION_HOURS = '48';
  process.env.KEMFAI_BANK_TRANSFER_INSTRUCTIONS_EN =
    'Transfer to the KEMFAI account shown on your invoice.';
  process.env.KEMFAI_BANK_TRANSFER_INSTRUCTIONS_AR = 'حوّل إلى حساب KEMFAI الموضح في فاتورتك.';
  process.env.KEMFAI_ODOO_MASTER_PASSWORD = 't109-synthetic-master';
  process.env.KEMFAI_TENANT_ADMIN_LOGIN = 't109-synthetic-login';
  process.env.KEMFAI_TENANT_ADMIN_PASSWORD = 't109-synthetic-password';
  process.env.KEMFAI_DISABLE_MODULE_SELECTION_RECOVERY_WORKER = '1';
  process.env.KEMFAI_DISABLE_MUTATION_RECOVERY_WORKER = '1';
  process.env.KEMFAI_DISABLE_BILLING_NOTIFICATION_RECOVERY_WORKER = '1';

  if (!controlDataSource.isInitialized) await controlDataSource.initialize();
  await controlDataSource.runMigrations();
  const { keycloak, tokens } = await startIdentityFixture();
  const state = new T109FixtureState(tokens);
  let app: INestApplication | undefined;
  try {
    await state.reset();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [T109ControlController],
      providers: [{ provide: T109FixtureState, useValue: state }],
    })
      .overrideProvider(ODOO_RPC_CLIENT)
      .useValue(new T109OdooRpcClient(state))
      .overrideProvider(KEYCLOAK_USER_PROVISIONER)
      .useValue(new T109KeycloakProvisioner(state))
      .overrideProvider(MINIO_CLIENT)
      .useValue(new T109MinioClient(state))
      .overrideProvider(BILLING_DECISION_NOTIFICATION_TRANSPORT)
      .useValue({ send: async () => undefined })
      .compile();

    app = moduleRef.createNestApplication();
    if (options.corsOrigin) app.enableCors({ origin: options.corsOrigin });
    await app.init();
    if (options.listen) await app.listen(options.port ?? 0, '127.0.0.1');
  } catch (error) {
    if (app) await app.close().catch(() => undefined);
    await keycloak.close().catch(() => undefined);
    if (controlDataSource.isInitialized) await controlDataSource.destroy().catch(() => undefined);
    throw error;
  }

  let closed = false;
  return {
    app,
    state,
    close: async () => {
      if (closed) return;
      closed = true;
      await app.close();
      await keycloak.close();
      if (controlDataSource.isInitialized) await controlDataSource.destroy();
    },
  };
}
