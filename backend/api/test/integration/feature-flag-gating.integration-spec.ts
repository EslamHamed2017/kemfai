import { INestApplication, RequestMethod, Type } from '@nestjs/common';
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { APP_GUARD, ModulesContainer, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { AppModule } from '../../src/app.module';
import { FEATURE_FLAG_KEY } from '../../src/common/decorators/feature-flag.decorator';
import { FeatureFlagGuard } from '../../src/common/guards/feature-flag.guard';
import controlDataSource from '../../src/database/data-source';
import { Account, BillingCycle } from '../../src/modules/accounts/entities/account.entity';
import { AccountsModule } from '../../src/modules/accounts/accounts.module';
import { AccountingModule } from '../../src/modules/accounting/accounting.module';
import { AccountsService as AccountingAccountsService } from '../../src/modules/accounting/accounts/accounts.service';
import { DraftsService as AccountingDraftsService } from '../../src/modules/accounting/drafts/drafts.service';
import { AccountingOdooContextService } from '../../src/modules/accounting/accounting-odoo-context.service';
import { DimensionsService } from '../../src/modules/accounting/dimensions/dimensions.service';
import { DraftValidationService } from '../../src/modules/accounting/drafts/draft-validation.service';
import { JournalsCurrenciesService } from '../../src/modules/accounting/journals-currencies/journals-currencies.service';
import { AccountsService } from '../../src/modules/accounts/accounts.service';
import { MfaService } from '../../src/modules/accounts/mfa.service';
import {
  Subscription,
  SubscriptionBillingCycle,
  SubscriptionStatus,
} from '../../src/modules/billing-customer/entities/subscription.entity';
import { ChecklistModule } from '../../src/modules/checklist/checklist.module';
import { ChecklistService } from '../../src/modules/checklist/checklist.service';
import { CompanySettingsService } from '../../src/modules/company-setup/company-settings.service';
import { CompanySetupModule } from '../../src/modules/company-setup/company-setup.module';
import { CompanySetupService } from '../../src/modules/company-setup/company-setup.service';
import { FeatureFlag } from '../../src/modules/entitlements/entities/feature-flag.entity';
import { PlanFeatureEntitlement } from '../../src/modules/entitlements/entities/plan-feature-entitlement.entity';
import { PlanSetting } from '../../src/modules/entitlements/entities/plan-setting.entity';
import { Plan } from '../../src/modules/entitlements/entities/plan.entity';
import { ModuleSelectionModule } from '../../src/modules/module-selection/module-selection.module';
import { ModuleSelectionService } from '../../src/modules/module-selection/module-selection.service';
import {
  SUPPORT_WORKSPACE_SUMMARY_ACTION,
  SupportAccessGrant,
  SupportAccessGranteeRole,
  SupportAccessGrantStatus,
} from '../../src/modules/support-access/entities/support-access-grant.entity';
import { SupportAccessUsage } from '../../src/modules/support-access/entities/support-access-usage.entity';
import { SupportAccessModule } from '../../src/modules/support-access/support-access.module';
import { SupportAccessService } from '../../src/modules/support-access/support-access.service';
import { SupportWorkspaceService } from '../../src/modules/support-access/support-workspace.service';
import { Tenant, TenantStatus } from '../../src/modules/tenants/entities/tenant.entity';
import { FakeKeycloak, startFakeKeycloak } from '../support/fake-keycloak';

const CUSTOMER_SUBJECT = '11200000-0000-4000-8000-000000000001';
const INTERNAL_SUBJECT = '11200000-0000-4000-8000-000000000002';
const ACCOUNT_ID = '11200000-0000-4000-8000-000000000003';
const TENANT_ID = '11200000-0000-4000-8000-000000000004';
const PLAN_ID = '11200000-0000-4000-8000-000000000005';
const SUBSCRIPTION_ID = '11200000-0000-4000-8000-000000000006';
const GRANT_ID = '11200000-0000-4000-8000-000000000007';
const COMPANY_ID = '11200000-0000-4000-8000-000000000008';
const ACCOUNTING_RESOURCE_ID = '11200000-0000-4000-8000-000000000009';
const DRAFT_ID = '11200000-0000-4000-8000-000000000010';
const SUPPORT_GRANT_EXPIRES_AT = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();

const CUSTOMER_ISSUER = 'http://127.0.0.1/realms/t112-customers';
const INTERNAL_ISSUER = 'http://127.0.0.1/realms/t112-internal';
const AUDIENCE = 'kemfai-api-t112';

const FLAG_KEYS = [
  'module.accounts',
  'module.company_setup',
  'module.module_selection',
  'module.onboarding_checklist',
  'module.support_access',
  'module.accounting_foundation',
] as const;

type FlagKey = (typeof FLAG_KEYS)[number];
type HttpMethod = 'get' | 'patch' | 'post' | 'put';
type CallShape = 'ui' | 'raw';
type AuthKind = 'none' | 'owner' | 'support';

const setupState = {
  currentStep: 'country',
  setupComplete: false,
  values: {},
  version: 0,
  stale: false,
  scope: 't112-owned-scope',
};
const grantView = {
  id: GRANT_ID,
  granteeRole: SupportAccessGranteeRole.SUPPORT,
  grantedBy: ACCOUNT_ID,
  grantedAt: '2026-10-25T00:00:00.000Z',
  expiresAt: SUPPORT_GRANT_EXPIRES_AT,
  revokedAt: null,
  expiredAt: null,
  status: 'active' as const,
  permittedActions: [SUPPORT_WORKSPACE_SUMMARY_ACTION],
  usage: [],
};

const accounts = {
  signup: jest.fn().mockResolvedValue({ accountId: ACCOUNT_ID }),
  verifyEmail: jest.fn().mockResolvedValue({ accountId: ACCOUNT_ID }),
  resendVerification: jest.fn().mockResolvedValue(undefined),
  setPreferredLocale: jest.fn().mockResolvedValue(undefined),
  getPreferredLocale: jest.fn().mockResolvedValue({ locale: 'en' }),
};
const mfa = {
  enroll: jest.fn().mockResolvedValue({ accountId: ACCOUNT_ID }),
  confirm: jest.fn().mockResolvedValue({ accountId: ACCOUNT_ID, mfaEnrolled: true }),
};
const companySetup = {
  getState: jest.fn().mockResolvedValue(setupState),
  saveStep: jest.fn().mockResolvedValue(setupState),
  completeSetup: jest.fn().mockResolvedValue(setupState),
};
const companySettings = {
  getSettings: jest.fn().mockResolvedValue({ values: { country: 'AE' }, setupComplete: true }),
  updateSettings: jest.fn().mockResolvedValue({ values: { country: 'AE' }, setupComplete: true }),
};
const moduleSelection = {
  list: jest.fn().mockResolvedValue([
    {
      key: 'module.accounting',
      name: 'Accounting',
      nameAr: 'المحاسبة',
      includedInCurrentPlan: true,
      selected: true,
      requiredPlanTier: null,
      requiredPlanTierAr: null,
    },
  ]),
  replace: jest.fn().mockResolvedValue({ featureKeys: ['module.accounting'] }),
};
const checklist = {
  get: jest.fn().mockResolvedValue({
    customerAdded: false,
    bankAdded: false,
    productAdded: false,
    firstInvoiceReady: false,
    gatedOnSubscriptionActivation: false,
  }),
};
const supportAccess = {
  list: jest.fn().mockResolvedValue([]),
  create: jest.fn().mockResolvedValue(grantView),
  revoke: jest.fn().mockResolvedValue({
    ...grantView,
    status: 'revoked',
    revokedAt: '2026-10-25T01:00:00.000Z',
  }),
};
const accountingResource = {
  id: ACCOUNTING_RESOURCE_ID,
  companyId: COMPANY_ID,
  version: 1,
  active: true,
  code: '1000',
  name: { en: 'Cash', ar: 'النقدية' },
  accountType: 'asset_current',
  nodeKind: 'posting',
  parentId: null,
  selectableForDraftLines: true,
};
const accountingAccounts = {
  list: jest.fn().mockResolvedValue({ items: [accountingResource], nextCursor: null }),
  create: jest.fn().mockResolvedValue({ resource: accountingResource }),
  get: jest.fn().mockResolvedValue(accountingResource),
  update: jest.fn().mockResolvedValue({ resource: accountingResource }),
};
const draftResource = { id: DRAFT_ID, companyId: COMPANY_ID, version: 1, status: 'draft' };
const accountingDrafts = {
  list: jest.fn().mockResolvedValue({ items: [draftResource], nextCursor: null }),
  save: jest.fn().mockResolvedValue({ resource: draftResource, ledgerEffect: 'none' }),
  update: jest.fn().mockResolvedValue({ resource: draftResource, ledgerEffect: 'none' }),
  get: jest.fn().mockResolvedValue(draftResource),
};
const draftValidation = {
  validate: jest.fn().mockResolvedValue({ result: { draftVersion: 1 }, ledgerEffect: 'none' }),
};
const dimensionResource = { id: ACCOUNTING_RESOURCE_ID, version: 1, active: true };
const dimensions = {
  listDefinitions: jest.fn().mockResolvedValue({ items: [dimensionResource] }),
  createDefinition: jest.fn().mockResolvedValue({ resource: dimensionResource }),
  updateDefinition: jest.fn().mockResolvedValue({ resource: dimensionResource }),
  listValues: jest.fn().mockResolvedValue({ items: [dimensionResource], nextCursor: null }),
  createValue: jest.fn().mockResolvedValue({ resource: dimensionResource }),
  updateValue: jest.fn().mockResolvedValue({ resource: dimensionResource }),
  listRules: jest.fn().mockResolvedValue({ items: [dimensionResource] }),
  createRule: jest.fn().mockResolvedValue({ resource: dimensionResource }),
  updateRule: jest.fn().mockResolvedValue({ resource: dimensionResource }),
};
const journalCurrencyResource = { id: ACCOUNTING_RESOURCE_ID, version: 1, active: true };
const journalsCurrencies = {
  listJournals: jest.fn().mockResolvedValue({ items: [journalCurrencyResource] }),
  createJournal: jest.fn().mockResolvedValue({ resource: journalCurrencyResource }),
  updateJournal: jest.fn().mockResolvedValue({ resource: journalCurrencyResource }),
  listCurrencies: jest.fn().mockResolvedValue({ items: [journalCurrencyResource] }),
  putCurrencyConfiguration: jest.fn().mockResolvedValue({ resource: journalCurrencyResource }),
};
const accountingContext = { resolve: jest.fn().mockResolvedValue({}) };
const supportWorkspace = {
  summary: jest.fn().mockResolvedValue({
    tenantId: TENANT_ID,
    workspaceStatus: TenantStatus.READY,
    subscriptionStatus: SubscriptionStatus.ACTIVE,
    billingCycle: SubscriptionBillingCycle.MONTHLY,
    currentPeriodEnd: '2099-01-01',
  }),
};

const draftWriteBody = {
  journalId: ACCOUNTING_RESOURCE_ID,
  accountingDate: '2026-11-04',
  description: 'Non-posting draft',
  transactionType: 'manual_journal',
  source: null,
  lines: [
    {
      id: DRAFT_ID,
      sequence: 1,
      accountId: ACCOUNTING_RESOURCE_ID,
      transactionCurrencyCode: 'USD',
      transactionPrecision: 2,
      transactionCurrencyMetadataVersion: 'usd-v1',
      companyBaseCurrencyCode: 'USD',
      basePrecision: 2,
      baseCurrencyMetadataVersion: 'usd-v1',
      currencyConfigurationVersion: 1,
      transactionDebit: '0.00',
      transactionCredit: '0.00',
      baseDebit: '0.00',
      baseCredit: '0.00',
      rateReference: null,
      rateEffectiveDate: null,
      dimensions: [],
    },
  ],
};

interface EndpointCase {
  label: string;
  featureKey: FlagKey;
  method: HttpMethod;
  path: string;
  auth: AuthKind;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  enabledStatus: number;
  serviceCall: jest.Mock;
  setupScopeArgumentIndex?: number;
}

const ENDPOINTS: EndpointCase[] = [
  {
    label: 'POST /accounts/signup',
    featureKey: 'module.accounts',
    method: 'post',
    path: '/accounts/signup',
    auth: 'none',
    body: {
      email: 't112@example.invalid',
      password: 't112-password',
      planId: PLAN_ID,
      billingCycle: BillingCycle.MONTHLY,
      acceptedTerms: true,
    },
    enabledStatus: 201,
    serviceCall: accounts.signup,
  },
  {
    label: 'POST /accounts/verify-email',
    featureKey: 'module.accounts',
    method: 'post',
    path: '/accounts/verify-email',
    auth: 'none',
    body: { token: 't112-verification-token' },
    enabledStatus: 200,
    serviceCall: accounts.verifyEmail,
  },
  {
    label: 'POST /accounts/resend-verification',
    featureKey: 'module.accounts',
    method: 'post',
    path: '/accounts/resend-verification',
    auth: 'none',
    body: { email: 't112@example.invalid' },
    enabledStatus: 202,
    serviceCall: accounts.resendVerification,
  },
  {
    label: 'PATCH /accounts/me/locale',
    featureKey: 'module.accounts',
    method: 'patch',
    path: '/accounts/me/locale',
    auth: 'owner',
    body: { locale: 'en' },
    enabledStatus: 200,
    serviceCall: accounts.setPreferredLocale,
  },
  {
    label: 'GET /accounts/me/locale',
    featureKey: 'module.accounts',
    method: 'get',
    path: '/accounts/me/locale',
    auth: 'owner',
    enabledStatus: 200,
    serviceCall: accounts.getPreferredLocale,
  },
  {
    label: 'POST /accounts/mfa/enroll',
    featureKey: 'module.accounts',
    method: 'post',
    path: '/accounts/mfa/enroll',
    auth: 'owner',
    enabledStatus: 200,
    serviceCall: mfa.enroll,
  },
  {
    label: 'POST /accounts/mfa/confirm',
    featureKey: 'module.accounts',
    method: 'post',
    path: '/accounts/mfa/confirm',
    auth: 'owner',
    enabledStatus: 200,
    serviceCall: mfa.confirm,
  },
  {
    label: 'GET /companies/current/setup',
    featureKey: 'module.company_setup',
    method: 'get',
    path: '/companies/current/setup',
    auth: 'owner',
    enabledStatus: 200,
    serviceCall: companySetup.getState,
  },
  {
    label: 'PUT /companies/current/setup',
    featureKey: 'module.company_setup',
    method: 'put',
    path: '/companies/current/setup',
    auth: 'owner',
    headers: { 'X-KEMFAI-Setup-Scope': setupState.scope },
    body: { step: 'country', values: { country: 'AE' }, baseVersion: 0 },
    enabledStatus: 200,
    serviceCall: companySetup.saveStep,
    setupScopeArgumentIndex: 2,
  },
  {
    label: 'POST /companies/current/setup/complete',
    featureKey: 'module.company_setup',
    method: 'post',
    path: '/companies/current/setup/complete',
    auth: 'owner',
    headers: { 'X-KEMFAI-Setup-Scope': setupState.scope },
    enabledStatus: 200,
    serviceCall: companySetup.completeSetup,
    setupScopeArgumentIndex: 1,
  },
  {
    label: 'GET /companies/current/settings',
    featureKey: 'module.company_setup',
    method: 'get',
    path: '/companies/current/settings',
    auth: 'owner',
    enabledStatus: 200,
    serviceCall: companySettings.getSettings,
  },
  {
    label: 'PUT /companies/current/settings',
    featureKey: 'module.company_setup',
    method: 'put',
    path: '/companies/current/settings',
    auth: 'owner',
    body: { values: { country: 'AE' } },
    enabledStatus: 200,
    serviceCall: companySettings.updateSettings,
  },
  {
    label: 'GET /modules',
    featureKey: 'module.module_selection',
    method: 'get',
    path: '/modules',
    auth: 'owner',
    enabledStatus: 200,
    serviceCall: moduleSelection.list,
  },
  {
    label: 'PUT /modules/selection',
    featureKey: 'module.module_selection',
    method: 'put',
    path: '/modules/selection',
    auth: 'owner',
    body: { featureKeys: ['module.accounting'] },
    enabledStatus: 200,
    serviceCall: moduleSelection.replace,
  },
  {
    label: 'GET /onboarding/checklist',
    featureKey: 'module.onboarding_checklist',
    method: 'get',
    path: '/onboarding/checklist',
    auth: 'owner',
    enabledStatus: 200,
    serviceCall: checklist.get,
  },
  {
    label: 'GET /support-access/grants',
    featureKey: 'module.support_access',
    method: 'get',
    path: '/support-access/grants',
    auth: 'owner',
    enabledStatus: 200,
    serviceCall: supportAccess.list,
  },
  {
    label: 'POST /support-access/grants',
    featureKey: 'module.support_access',
    method: 'post',
    path: '/support-access/grants',
    auth: 'owner',
    body: {
      granteeRole: SupportAccessGranteeRole.SUPPORT,
      expiresAt: SUPPORT_GRANT_EXPIRES_AT,
    },
    enabledStatus: 201,
    serviceCall: supportAccess.create,
  },
  {
    label: 'POST /support-access/grants/:grantId/revoke',
    featureKey: 'module.support_access',
    method: 'post',
    path: `/support-access/grants/${GRANT_ID}/revoke`,
    auth: 'owner',
    enabledStatus: 200,
    serviceCall: supportAccess.revoke,
  },
  {
    label: 'GET /internal/support-access/workspaces/:tenantId/summary',
    featureKey: 'module.support_access',
    method: 'get',
    path: `/internal/support-access/workspaces/${TENANT_ID}/summary?grantId=${GRANT_ID}`,
    auth: 'support',
    enabledStatus: 200,
    serviceCall: supportWorkspace.summary,
  },
  {
    label: 'GET /v1/accounting/accounts',
    featureKey: 'module.accounting_foundation',
    method: 'get',
    path: '/v1/accounting/accounts',
    auth: 'owner',
    headers: { 'x-kemfai-company-id': COMPANY_ID },
    enabledStatus: 200,
    serviceCall: accountingAccounts.list,
  },
  {
    label: 'POST /v1/accounting/accounts',
    featureKey: 'module.accounting_foundation',
    method: 'post',
    path: '/v1/accounting/accounts',
    auth: 'owner',
    headers: { 'x-kemfai-company-id': COMPANY_ID },
    body: {
      code: '1000',
      name: { en: 'Cash', ar: 'النقدية' },
      accountType: 'asset_current',
      nodeKind: 'posting',
    },
    enabledStatus: 201,
    serviceCall: accountingAccounts.create,
  },
  {
    label: 'GET /v1/accounting/accounts/:accountId',
    featureKey: 'module.accounting_foundation',
    method: 'get',
    path: `/v1/accounting/accounts/${ACCOUNTING_RESOURCE_ID}`,
    auth: 'owner',
    headers: { 'x-kemfai-company-id': COMPANY_ID },
    enabledStatus: 200,
    serviceCall: accountingAccounts.get,
  },
  {
    label: 'PATCH /v1/accounting/accounts/:accountId',
    featureKey: 'module.accounting_foundation',
    method: 'patch',
    path: `/v1/accounting/accounts/${ACCOUNTING_RESOURCE_ID}`,
    auth: 'owner',
    headers: { 'x-kemfai-company-id': COMPANY_ID, 'if-match': '"1"' },
    body: { active: true },
    enabledStatus: 200,
    serviceCall: accountingAccounts.update,
  },
  {
    label: 'GET /v1/accounting/capabilities',
    featureKey: 'module.accounting_foundation',
    method: 'get',
    path: '/v1/accounting/capabilities',
    auth: 'owner',
    headers: { 'x-kemfai-company-id': COMPANY_ID },
    enabledStatus: 200,
    serviceCall: accountingContext.resolve,
  },
  {
    label: 'GET /v1/accounting/dimension-definitions',
    featureKey: 'module.accounting_foundation',
    method: 'get',
    path: '/v1/accounting/dimension-definitions',
    auth: 'owner',
    headers: { 'x-kemfai-company-id': COMPANY_ID },
    enabledStatus: 200,
    serviceCall: dimensions.listDefinitions,
  },
  {
    label: 'POST /v1/accounting/dimension-definitions',
    featureKey: 'module.accounting_foundation',
    method: 'post',
    path: '/v1/accounting/dimension-definitions',
    auth: 'owner',
    headers: { 'x-kemfai-company-id': COMPANY_ID },
    body: { key: 'cost_center' },
    enabledStatus: 201,
    serviceCall: dimensions.createDefinition,
  },
  {
    label: 'PATCH /v1/accounting/dimension-definitions/:definitionId',
    featureKey: 'module.accounting_foundation',
    method: 'patch',
    path: `/v1/accounting/dimension-definitions/${ACCOUNTING_RESOURCE_ID}`,
    auth: 'owner',
    headers: { 'x-kemfai-company-id': COMPANY_ID, 'if-match': '"1"' },
    body: { active: true },
    enabledStatus: 200,
    serviceCall: dimensions.updateDefinition,
  },
  {
    label: 'GET /v1/accounting/dimension-values',
    featureKey: 'module.accounting_foundation',
    method: 'get',
    path: '/v1/accounting/dimension-values',
    auth: 'owner',
    headers: { 'x-kemfai-company-id': COMPANY_ID },
    enabledStatus: 200,
    serviceCall: dimensions.listValues,
  },
  {
    label: 'POST /v1/accounting/dimension-values',
    featureKey: 'module.accounting_foundation',
    method: 'post',
    path: '/v1/accounting/dimension-values',
    auth: 'owner',
    headers: { 'x-kemfai-company-id': COMPANY_ID },
    body: {
      definitionId: ACCOUNTING_RESOURCE_ID,
      code: 'CC1',
      name: { en: 'Cost center', ar: 'مركز التكلفة' },
    },
    enabledStatus: 201,
    serviceCall: dimensions.createValue,
  },
  {
    label: 'PATCH /v1/accounting/dimension-values/:valueId',
    featureKey: 'module.accounting_foundation',
    method: 'patch',
    path: `/v1/accounting/dimension-values/${ACCOUNTING_RESOURCE_ID}`,
    auth: 'owner',
    headers: { 'x-kemfai-company-id': COMPANY_ID, 'if-match': '"1"' },
    body: { active: true },
    enabledStatus: 200,
    serviceCall: dimensions.updateValue,
  },
  {
    label: 'GET /v1/accounting/dimension-rules',
    featureKey: 'module.accounting_foundation',
    method: 'get',
    path: '/v1/accounting/dimension-rules',
    auth: 'owner',
    headers: { 'x-kemfai-company-id': COMPANY_ID },
    enabledStatus: 200,
    serviceCall: dimensions.listRules,
  },
  {
    label: 'POST /v1/accounting/dimension-rules',
    featureKey: 'module.accounting_foundation',
    method: 'post',
    path: '/v1/accounting/dimension-rules',
    auth: 'owner',
    headers: { 'x-kemfai-company-id': COMPANY_ID },
    body: {
      accountId: ACCOUNTING_RESOURCE_ID,
      dimensionDefinitionId: ACCOUNTING_RESOURCE_ID,
      requirement: 'required',
    },
    enabledStatus: 201,
    serviceCall: dimensions.createRule,
  },
  {
    label: 'PATCH /v1/accounting/dimension-rules/:ruleId',
    featureKey: 'module.accounting_foundation',
    method: 'patch',
    path: `/v1/accounting/dimension-rules/${ACCOUNTING_RESOURCE_ID}`,
    auth: 'owner',
    headers: { 'x-kemfai-company-id': COMPANY_ID, 'if-match': '"1"' },
    body: { active: true },
    enabledStatus: 200,
    serviceCall: dimensions.updateRule,
  },
  {
    label: 'GET /v1/accounting/journals',
    featureKey: 'module.accounting_foundation',
    method: 'get',
    path: '/v1/accounting/journals',
    auth: 'owner',
    headers: { 'x-kemfai-company-id': COMPANY_ID },
    enabledStatus: 200,
    serviceCall: journalsCurrencies.listJournals,
  },
  {
    label: 'POST /v1/accounting/journals',
    featureKey: 'module.accounting_foundation',
    method: 'post',
    path: '/v1/accounting/journals',
    auth: 'owner',
    headers: { 'x-kemfai-company-id': COMPANY_ID },
    body: {
      code: 'GJ',
      name: { en: 'General journal', ar: 'دفتر اليومية العام' },
      journalType: 'general',
    },
    enabledStatus: 201,
    serviceCall: journalsCurrencies.createJournal,
  },
  {
    label: 'PATCH /v1/accounting/journals/:journalId',
    featureKey: 'module.accounting_foundation',
    method: 'patch',
    path: `/v1/accounting/journals/${ACCOUNTING_RESOURCE_ID}`,
    auth: 'owner',
    headers: { 'x-kemfai-company-id': COMPANY_ID, 'if-match': '"1"' },
    body: { active: true },
    enabledStatus: 200,
    serviceCall: journalsCurrencies.updateJournal,
  },
  {
    label: 'GET /v1/accounting/currencies',
    featureKey: 'module.accounting_foundation',
    method: 'get',
    path: '/v1/accounting/currencies',
    auth: 'owner',
    headers: { 'x-kemfai-company-id': COMPANY_ID },
    enabledStatus: 200,
    serviceCall: journalsCurrencies.listCurrencies,
  },
  {
    label: 'PUT /v1/accounting/currencies/:currencyCode',
    featureKey: 'module.accounting_foundation',
    method: 'put',
    path: '/v1/accounting/currencies/USD',
    auth: 'owner',
    headers: { 'x-kemfai-company-id': COMPANY_ID, 'if-match': '*' },
    body: { enabled: true },
    enabledStatus: 201,
    serviceCall: journalsCurrencies.putCurrencyConfiguration,
  },
  {
    label: 'GET /v1/accounting/drafts',
    featureKey: 'module.accounting_foundation',
    method: 'get',
    path: '/v1/accounting/drafts',
    auth: 'owner',
    headers: { 'x-kemfai-company-id': COMPANY_ID },
    enabledStatus: 200,
    serviceCall: accountingDrafts.list,
  },
  {
    label: 'PUT /v1/accounting/drafts/:draftId',
    featureKey: 'module.accounting_foundation',
    method: 'put',
    path: `/v1/accounting/drafts/${DRAFT_ID}`,
    auth: 'owner',
    headers: { 'x-kemfai-company-id': COMPANY_ID, 'if-match': '"1"' },
    body: draftWriteBody,
    enabledStatus: 200,
    serviceCall: accountingDrafts.update,
  },
  {
    label: 'POST /v1/accounting/drafts',
    featureKey: 'module.accounting_foundation',
    method: 'post',
    path: '/v1/accounting/drafts',
    auth: 'owner',
    headers: { 'x-kemfai-company-id': COMPANY_ID },
    body: draftWriteBody,
    enabledStatus: 201,
    serviceCall: accountingDrafts.save,
  },
  {
    label: 'GET /v1/accounting/drafts/:draftId',
    featureKey: 'module.accounting_foundation',
    method: 'get',
    path: `/v1/accounting/drafts/${DRAFT_ID}`,
    auth: 'owner',
    headers: { 'x-kemfai-company-id': COMPANY_ID },
    enabledStatus: 200,
    serviceCall: accountingDrafts.get,
  },
  {
    label: 'POST /v1/accounting/drafts/:draftId/validate',
    featureKey: 'module.accounting_foundation',
    method: 'post',
    path: `/v1/accounting/drafts/${DRAFT_ID}/validate`,
    auth: 'owner',
    headers: { 'x-kemfai-company-id': COMPANY_ID, 'if-match': '"1"' },
    enabledStatus: 200,
    serviceCall: draftValidation.validate,
  },
];

const EXPECTED_METADATA_INVENTORY = [
  'GET /accounts/me/locale => module.accounts',
  'GET /companies/current/settings => module.company_setup',
  'GET /companies/current/setup => module.company_setup',
  'GET /internal/support-access/workspaces/:tenantId/summary => module.support_access',
  'GET /modules => module.module_selection',
  'GET /onboarding/checklist => module.onboarding_checklist',
  'GET /support-access/grants => module.support_access',
  'GET /v1/accounting/accounts => module.accounting_foundation',
  'GET /v1/accounting/accounts/:accountId => module.accounting_foundation',
  'GET /v1/accounting/capabilities => module.accounting_foundation',
  'GET /v1/accounting/dimension-definitions => module.accounting_foundation',
  'POST /v1/accounting/dimension-definitions => module.accounting_foundation',
  'PATCH /v1/accounting/dimension-definitions/:definitionId => module.accounting_foundation',
  'GET /v1/accounting/dimension-values => module.accounting_foundation',
  'POST /v1/accounting/dimension-values => module.accounting_foundation',
  'PATCH /v1/accounting/dimension-values/:valueId => module.accounting_foundation',
  'GET /v1/accounting/dimension-rules => module.accounting_foundation',
  'POST /v1/accounting/dimension-rules => module.accounting_foundation',
  'PATCH /v1/accounting/dimension-rules/:ruleId => module.accounting_foundation',
  'GET /v1/accounting/journals => module.accounting_foundation',
  'POST /v1/accounting/journals => module.accounting_foundation',
  'PATCH /v1/accounting/journals/:journalId => module.accounting_foundation',
  'GET /v1/accounting/currencies => module.accounting_foundation',
  'PUT /v1/accounting/currencies/:currencyCode => module.accounting_foundation',
  'GET /v1/accounting/drafts => module.accounting_foundation',
  'PUT /v1/accounting/drafts/:draftId => module.accounting_foundation',
  'GET /v1/accounting/drafts/:draftId => module.accounting_foundation',
  'PATCH /accounts/me/locale => module.accounts',
  'PATCH /v1/accounting/accounts/:accountId => module.accounting_foundation',
  'POST /accounts/mfa/confirm => module.accounts',
  'POST /accounts/mfa/enroll => module.accounts',
  'POST /accounts/resend-verification => module.accounts',
  'POST /accounts/signup => module.accounts',
  'POST /accounts/verify-email => module.accounts',
  'POST /companies/current/setup/complete => module.company_setup',
  'POST /support-access/grants => module.support_access',
  'POST /support-access/grants/:grantId/revoke => module.support_access',
  'POST /v1/accounting/accounts => module.accounting_foundation',
  'POST /v1/accounting/drafts => module.accounting_foundation',
  'POST /v1/accounting/drafts/:draftId/validate => module.accounting_foundation',
  'PUT /companies/current/settings => module.company_setup',
  'PUT /companies/current/setup => module.company_setup',
  'PUT /modules/selection => module.module_selection',
].sort();

describe('FeatureFlagGuard full production-route gating (T112)', () => {
  let app: INestApplication;
  let keycloak: FakeKeycloak;
  let ownerToken: string;
  let supportToken: string;
  let originalFlags: FeatureFlag[] = [];

  beforeAll(async () => {
    process.env.KEYCLOAK_ISSUER = CUSTOMER_ISSUER;
    process.env.KEYCLOAK_API_AUDIENCE = AUDIENCE;
    process.env.KEYCLOAK_INTERNAL_ISSUER = INTERNAL_ISSUER;
    process.env.KEYCLOAK_INTERNAL_API_AUDIENCE = AUDIENCE;
    process.env.SUPPORT_ACCESS_MAX_DURATION_HOURS = '24';
    process.env.KEMFAI_DISABLE_MODULE_SELECTION_RECOVERY_WORKER = '1';
    process.env.KEMFAI_DISABLE_MUTATION_RECOVERY_WORKER = '1';
    process.env.KEMFAI_DISABLE_BILLING_NOTIFICATION_RECOVERY_WORKER = '1';

    keycloak = await startFakeKeycloak({ issuer: CUSTOMER_ISSUER, audience: AUDIENCE });
    process.env.KEYCLOAK_JWKS_URI = keycloak.jwksUri;
    process.env.KEYCLOAK_INTERNAL_JWKS_URI = keycloak.jwksUri;

    if (!controlDataSource.isInitialized) await controlDataSource.initialize();
    await controlDataSource.runMigrations();
    originalFlags = await controlDataSource.getRepository(FeatureFlag).find();
    await seedPrerequisites();

    ownerToken = await keycloak.signAccessToken({
      sub: CUSTOMER_SUBJECT,
      roles: ['WorkspaceOwner'],
      tenantId: TENANT_ID,
    });
    supportToken = await keycloak.signAccessToken({
      sub: INTERNAL_SUBJECT,
      issuer: INTERNAL_ISSUER,
      roles: ['Support'],
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AccountsService)
      .useValue(accounts)
      .overrideProvider(MfaService)
      .useValue(mfa)
      .overrideProvider(CompanySetupService)
      .useValue(companySetup)
      .overrideProvider(CompanySettingsService)
      .useValue(companySettings)
      .overrideProvider(ModuleSelectionService)
      .useValue(moduleSelection)
      .overrideProvider(ChecklistService)
      .useValue(checklist)
      .overrideProvider(SupportAccessService)
      .useValue(supportAccess)
      .overrideProvider(SupportWorkspaceService)
      .useValue(supportWorkspace)
      .overrideProvider(AccountingAccountsService)
      .useValue(accountingAccounts)
      .overrideProvider(AccountingDraftsService)
      .useValue(accountingDrafts)
      .overrideProvider(DraftValidationService)
      .useValue(draftValidation)
      .overrideProvider(DimensionsService)
      .useValue(dimensions)
      .overrideProvider(JournalsCurrenciesService)
      .useValue(journalsCurrencies)
      .overrideProvider(AccountingOdooContextService)
      .useValue(accountingContext)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 60_000);

  beforeEach(async () => {
    jest.clearAllMocks();
    await setAllFlags(true);
  });

  afterAll(async () => {
    await app?.close();
    if (controlDataSource.isInitialized) {
      for (const flag of originalFlags) {
        await controlDataSource.getRepository(FeatureFlag).save(flag);
      }
      await controlDataSource.query('DELETE FROM "support_access_usage" WHERE "grant_id" = $1', [
        GRANT_ID,
      ]);
      await controlDataSource.query(
        'DELETE FROM "audit_event" WHERE "tenant_id" = $1 OR "subject_id" = $2',
        [TENANT_ID, GRANT_ID],
      );
      await controlDataSource.getRepository(SupportAccessGrant).delete({ id: GRANT_ID });
      await controlDataSource.getRepository(Subscription).delete({ id: SUBSCRIPTION_ID });
      await controlDataSource.getRepository(Tenant).delete({ id: TENANT_ID });
      await controlDataSource.getRepository(Account).delete({ id: ACCOUNT_ID });
      await controlDataSource.getRepository(PlanFeatureEntitlement).delete({ planId: PLAN_ID });
      await controlDataSource.getRepository(PlanSetting).delete({ planId: PLAN_ID });
      await controlDataSource.getRepository(Plan).delete({ id: PLAN_ID });
      await controlDataSource.destroy();
    }
    await keycloak?.close();
    delete process.env.KEYCLOAK_ISSUER;
    delete process.env.KEYCLOAK_API_AUDIENCE;
    delete process.env.KEYCLOAK_JWKS_URI;
    delete process.env.KEYCLOAK_INTERNAL_ISSUER;
    delete process.env.KEYCLOAK_INTERNAL_API_AUDIENCE;
    delete process.env.KEYCLOAK_INTERNAL_JWKS_URI;
    delete process.env.SUPPORT_ACCESS_MAX_DURATION_HOURS;
    delete process.env.KEMFAI_DISABLE_MODULE_SELECTION_RECOVERY_WORKER;
    delete process.env.KEMFAI_DISABLE_MUTATION_RECOVERY_WORKER;
    delete process.env.KEMFAI_DISABLE_BILLING_NOTIFICATION_RECOVERY_WORKER;
  }, 60_000);

  it('derives the complete gated inventory from production module/controller metadata', () => {
    const reflector = new Reflector();
    const intendedModuleRoutes = [
      ...moduleInventory(AccountsModule, 'module.accounts', reflector),
      ...moduleInventory(CompanySetupModule, 'module.company_setup', reflector),
      ...moduleInventory(ModuleSelectionModule, 'module.module_selection', reflector),
      ...moduleInventory(ChecklistModule, 'module.onboarding_checklist', reflector),
      ...moduleInventory(SupportAccessModule, 'module.support_access', reflector),
      ...moduleInventory(AccountingModule, 'module.accounting_foundation', reflector),
    ].sort();
    const actualGatedRoutes = applicationGatedInventory(app, reflector).sort();
    const exercisedRoutes = ENDPOINTS.map(
      ({ label, featureKey }) => `${label} => ${featureKey}`,
    ).sort();

    // The first comparison detects an intended module route that forgot its metadata;
    // the second detects feature metadata anywhere else in the production application;
    // the third proves every discovered route has a concrete dual-shape HTTP case below.
    expect(intendedModuleRoutes).toEqual(EXPECTED_METADATA_INVENTORY);
    expect(actualGatedRoutes).toEqual(EXPECTED_METADATA_INVENTORY);
    expect(exercisedRoutes).toEqual(EXPECTED_METADATA_INVENTORY);
  });

  it('registers exactly one production FeatureFlagGuard as an APP_GUARD', () => {
    const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AppModule) ?? []) as Array<{
      provide?: unknown;
      useClass?: unknown;
    }>;
    expect(
      providers.filter(
        (provider) => provider.provide === APP_GUARD && provider.useClass === FeatureFlagGuard,
      ),
    ).toHaveLength(1);
  });

  it.each(ENDPOINTS)(
    '$label returns identical persisted-flag denial for UI-shaped and raw replay calls',
    async (endpoint) => {
      await setFlag(endpoint.featureKey, false);
      const usageBefore = await controlDataSource.getRepository(SupportAccessUsage).count();
      const auditBefore = await controlDataSource.query(
        `SELECT count(*)::int AS count FROM "audit_event" WHERE "action" LIKE 'support_access.%'`,
      );

      const ui = await call(endpoint, 'ui');
      const raw = await call(endpoint, 'raw');

      expect(ui.status).toBe(404);
      expect(raw.status).toBe(404);
      expect(ui.body).toEqual({
        message: 'This feature is not available',
        error: 'Not Found',
        statusCode: 404,
      });
      expect(raw.body).toEqual(ui.body);
      expect(endpoint.serviceCall).not.toHaveBeenCalled();
      expect(await controlDataSource.getRepository(SupportAccessUsage).count()).toBe(usageBefore);
      const auditAfter = await controlDataSource.query(
        `SELECT count(*)::int AS count FROM "audit_event" WHERE "action" LIKE 'support_access.%'`,
      );
      expect(auditAfter[0].count).toBe(auditBefore[0].count);
    },
  );

  it.each(ENDPOINTS)(
    '$label reaches its real controller when the same persisted flag is enabled',
    async (endpoint) => {
      const response = await call(endpoint, 'ui');
      expect(response.status).toBe(endpoint.enabledStatus);
      expect(response.text).not.toContain('This feature is not available');
      expect(endpoint.serviceCall).toHaveBeenCalledTimes(1);
      if (endpoint.setupScopeArgumentIndex !== undefined) {
        expect(endpoint.serviceCall.mock.calls[0][endpoint.setupScopeArgumentIndex]).toBe(
          setupState.scope,
        );
      }
    },
  );

  it.each(ENDPOINTS)(
    '$label returns identical fail-closed denial when its required flag row is missing',
    async (endpoint) => {
      const repository = controlDataSource.getRepository(FeatureFlag);
      const requiredFlag = await repository.findOneByOrFail({ featureKey: endpoint.featureKey });
      const removed = await repository.delete({ featureKey: endpoint.featureKey });
      expect(removed.affected).toBe(1);
      try {
        const ui = await call(endpoint, 'ui');
        const raw = await call(endpoint, 'raw');

        expect(ui.status).toBe(404);
        expect(raw.status).toBe(404);
        expect(ui.body).toEqual({
          message: 'This feature is not available',
          error: 'Not Found',
          statusCode: 404,
        });
        expect(raw.body).toEqual(ui.body);
        expect(endpoint.serviceCall).not.toHaveBeenCalled();
      } finally {
        await repository.save(requiredFlag);
      }
    },
  );

  async function call(endpoint: EndpointCase, shape: CallShape): Promise<request.Response> {
    let invocation: request.Test;
    const server = app.getHttpServer();
    switch (endpoint.method) {
      case 'get':
        invocation = request(server).get(endpoint.path);
        break;
      case 'patch':
        invocation = request(server).patch(endpoint.path);
        break;
      case 'post':
        invocation = request(server).post(endpoint.path);
        break;
      case 'put':
        invocation = request(server).put(endpoint.path);
        break;
    }
    if (endpoint.auth === 'owner') invocation.set('Authorization', `Bearer ${ownerToken}`);
    if (endpoint.auth === 'support') invocation.set('Authorization', `Bearer ${supportToken}`);
    for (const [name, value] of Object.entries(endpoint.headers ?? {})) {
      invocation.set(name, value);
    }
    if (shape === 'ui') {
      invocation
        .set('Origin', 'https://app.kemfai.example.test')
        .set('Accept', 'application/json')
        .set('X-Requested-With', 'XMLHttpRequest')
        .set('Sec-Fetch-Site', 'same-origin');
      if (endpoint.body) invocation.send(endpoint.body);
    } else if (endpoint.body) {
      invocation.set('Content-Type', 'application/json').send(JSON.stringify(endpoint.body));
    }
    return invocation;
  }
});

async function seedPrerequisites(): Promise<void> {
  await controlDataSource.getRepository(Plan).save({
    id: PLAN_ID,
    name: 'T112 synthetic plan',
    nameEn: 'T112 synthetic plan',
    nameAr: 'خطة T112 الاختبارية',
    published: true,
    monthlyPrice: '10.00',
    annualPrice: '100.00',
    currency: 'USD',
  });
  await controlDataSource.getRepository(PlanSetting).save({
    planId: PLAN_ID,
    trialWindowDays: 14,
    autoRestrictUnpaid: true,
  });
  await controlDataSource.getRepository(PlanFeatureEntitlement).save(
    FLAG_KEYS.map((featureKey) => ({
      planId: PLAN_ID,
      featureKey,
      enabled: true,
      limitValue: null,
    })),
  );
  await controlDataSource.getRepository(Account).save({
    id: ACCOUNT_ID,
    keycloakUserId: CUSTOMER_SUBJECT,
    email: 't112-owner@example.invalid',
    emailVerified: true,
    mfaEnrolled: true,
    selectedPlanId: PLAN_ID,
    selectedBillingCycle: BillingCycle.MONTHLY,
    preferredLocale: null,
  });
  await controlDataSource.getRepository(Tenant).save({
    id: TENANT_ID,
    accountId: ACCOUNT_ID,
    status: TenantStatus.READY,
    odooDbName: 't112_synthetic_tenant',
    odooCompanyId: 1,
    minioBucket: null,
    provisioningAttempts: 1,
    failureReason: null,
    readyAt: new Date(),
  });
  await controlDataSource.getRepository(Subscription).save({
    id: SUBSCRIPTION_ID,
    tenantId: TENANT_ID,
    planId: PLAN_ID,
    billingCycle: SubscriptionBillingCycle.MONTHLY,
    status: SubscriptionStatus.ACTIVE,
    currentPeriodStart: '2026-10-25',
    currentPeriodEnd: '2099-01-01',
    activatedAt: new Date(),
    activatedBy: ACCOUNT_ID,
  });
  await controlDataSource.getRepository(SupportAccessGrant).save({
    id: GRANT_ID,
    tenantId: TENANT_ID,
    grantedBy: ACCOUNT_ID,
    granteeRole: SupportAccessGranteeRole.SUPPORT,
    permittedActions: [SUPPORT_WORKSPACE_SUMMARY_ACTION],
    expiresAt: new Date(SUPPORT_GRANT_EXPIRES_AT),
    revokedAt: null,
    expiredAt: null,
    status: SupportAccessGrantStatus.ACTIVE,
  });
  await setAllFlags(true);
}

async function setFlag(featureKey: FlagKey, enabled: boolean): Promise<void> {
  const result = await controlDataSource
    .getRepository(FeatureFlag)
    .update({ featureKey }, { enabled });
  expect(result.affected).toBe(1);
  expect(
    await controlDataSource.getRepository(FeatureFlag).findOneByOrFail({ featureKey }),
  ).toMatchObject({ featureKey, enabled });
}

async function setAllFlags(enabled: boolean): Promise<void> {
  for (const featureKey of FLAG_KEYS) await setFlag(featureKey, enabled);
}

function moduleInventory(
  moduleClass: Type<unknown>,
  expectedFeatureKey: FlagKey,
  reflector: Reflector,
): string[] {
  const controllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, moduleClass) ??
    []) as Type<unknown>[];
  expect(controllers.length).toBeGreaterThan(0);
  const inventory: string[] = [];
  for (const controller of controllers) {
    const controllerPath = Reflect.getMetadata(PATH_METADATA, controller) as string | undefined;
    for (const methodName of Object.getOwnPropertyNames(controller.prototype)) {
      if (methodName === 'constructor') continue;
      const handler = controller.prototype[methodName] as unknown;
      if (typeof handler !== 'function') continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (method === undefined) continue;
      const handlerPath = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      const featureKey = reflector.getAllAndOverride<string>(FEATURE_FLAG_KEY, [
        handler,
        controller,
      ]);
      expect(featureKey).toBe(expectedFeatureKey);
      inventory.push(
        `${requestMethodName(method)} ${joinRoute(controllerPath, handlerPath)} => ${featureKey}`,
      );
    }
  }
  return inventory;
}

function applicationGatedInventory(app: INestApplication, reflector: Reflector): string[] {
  const inventory: string[] = [];
  const modules = app.get(ModulesContainer, { strict: false });
  for (const moduleRef of modules.values()) {
    for (const wrapper of moduleRef.controllers.values()) {
      const controller = wrapper.metatype as Type<unknown> | undefined;
      if (!controller) continue;
      const controllerPath = Reflect.getMetadata(PATH_METADATA, controller) as string | undefined;
      for (const methodName of Object.getOwnPropertyNames(controller.prototype)) {
        if (methodName === 'constructor') continue;
        const handler = controller.prototype[methodName] as unknown;
        if (typeof handler !== 'function') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (method === undefined) continue;
        const featureKey = reflector.getAllAndOverride<string>(FEATURE_FLAG_KEY, [
          handler,
          controller,
        ]);
        if (!featureKey) continue;
        const handlerPath = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
        inventory.push(
          `${requestMethodName(method)} ${joinRoute(controllerPath, handlerPath)} => ${featureKey}`,
        );
      }
    }
  }
  return inventory;
}

function requestMethodName(method: RequestMethod): string {
  const name = RequestMethod[method];
  if (!name) throw new Error(`Unsupported request method metadata: ${method}`);
  return name;
}

function joinRoute(controllerPath = '', handlerPath = ''): string {
  const joined = [controllerPath, handlerPath]
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map((value) => String(value).replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return `/${joined}`;
}
