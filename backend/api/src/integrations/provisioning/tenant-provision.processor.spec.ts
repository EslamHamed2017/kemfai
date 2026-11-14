import { TenantProvisionProcessor } from './tenant-provision.processor';
import { OdooRpcService } from '../odoo-rpc/odoo-rpc.service';

const REQUIRED_ADDONS = [
  'kemfai_tenant_core',
  'kemfai_company_setup',
  'kemfai_module_selection',
  'kemfai_onboarding_checklist',
  'kemfai_dimensions',
  'kemfai_accounting',
];

const STORY_2_MODELS = [
  'kemfai.dimension.definition',
  'kemfai.dimension.value',
  'kemfai.dimension.rule',
  'kemfai.account.draft.dimension',
];

const STORY_3_MODELS = [
  'account.journal',
  'kemfai.account.currency.config',
  'kemfai.account.draft.validation',
];

const ACCOUNTING_MODELS = [
  'account.account',
  'kemfai.account.audit.event',
  'kemfai.account.mutation.receipt',
  'kemfai.account.draft',
  'kemfai.account.draft.line',
];

describe('TenantProvisionProcessor accounting addon readiness (T045/T088/T120)', () => {
  beforeAll(() => {
    process.env.KEMFAI_ODOO_MASTER_PASSWORD = 'test-master';
    process.env.KEMFAI_TENANT_ADMIN_LOGIN = 'test-admin';
    process.env.KEMFAI_TENANT_ADMIN_PASSWORD = 'test-password';
  });

  it.each([
    ['uninstalled', 'uninstalled', 'button_immediate_install'],
    ['installed', 'installed', 'button_immediate_upgrade'],
  ] as const)(
    '%s dimensions and accounting addons are installed/upgraded in dependency order and every Story 1–3 model is callable before readiness returns',
    async (dimensionsState, accountingState, expectedAction) => {
      const calls: Array<{ model: string; method: string; args: unknown[] }> = [];
      let moduleRead = 0;
      const odoo = {
        authenticate: jest.fn(async () => 7),
        executeKw: jest.fn(
          async (
            _db: string,
            _uid: number,
            _password: string,
            model: string,
            method: string,
            args: unknown[] = [],
          ) => {
            calls.push({ model, method, args });
            if (model === 'ir.module.module' && method === 'update_list') return true;
            if (model === 'ir.module.module' && method === 'search_read') {
              moduleRead += 1;
              return REQUIRED_ADDONS.map((name, index) => ({
                id: index + 1,
                name,
                state:
                  moduleRead > 1
                    ? 'installed'
                    : name === 'kemfai_dimensions'
                      ? dimensionsState
                      : name === 'kemfai_accounting'
                        ? accountingState
                        : 'installed',
              }));
            }
            if (model === 'ir.module.module' && method.startsWith('button_immediate_')) return true;
            if (
              [...ACCOUNTING_MODELS, ...STORY_2_MODELS, ...STORY_3_MODELS].includes(model) &&
              method === 'fields_get'
            )
              return { id: {} };
            throw new Error(`Unexpected RPC ${model}.${method}`);
          },
        ),
      };
      const processor = new TenantProvisionProcessor(
        {} as never,
        {} as never,
        odoo as unknown as OdooRpcService,
        {} as never,
      );

      await (
        processor as unknown as { installModules(database: string): Promise<void> }
      ).installModules('tenant_db');

      const addonActions = calls.filter(
        (call) => call.model === 'ir.module.module' && call.method === expectedAction,
      );
      expect(addonActions.map((call) => call.args)).toEqual([[[5]], [[6]]]);
      expect(
        calls
          .filter(
            (call) =>
              [...ACCOUNTING_MODELS, ...STORY_2_MODELS, ...STORY_3_MODELS].includes(call.model) &&
              call.method === 'fields_get',
          )
          .map((call) => call.model),
      ).toEqual([...ACCOUNTING_MODELS, ...STORY_2_MODELS, ...STORY_3_MODELS]);
      const finalModuleVerificationIndex = calls.reduce(
        (latest, call, index) =>
          call.model === 'ir.module.module' && call.method === 'search_read' ? index : latest,
        -1,
      );
      const firstModelProbeIndex = calls.findIndex(
        (call) =>
          [...ACCOUNTING_MODELS, ...STORY_2_MODELS, ...STORY_3_MODELS].includes(call.model) &&
          call.method === 'fields_get',
      );
      expect(firstModelProbeIndex).toBeGreaterThan(finalModuleVerificationIndex);
    },
  );
});
