import { Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../app.module';
import { AccountingRecoveryModule } from './accounting-recovery.module';
import { AccountingModule } from './accounting.module';
import { AccountingCapabilitiesController } from './capabilities.controller';
import { AccountsController } from './accounts/accounts.controller';
import { AccountsService } from './accounts/accounts.service';
import { AccountingMutationHandoffService } from './accounting-mutation-handoff.service';
import { AccountingOdooContextService } from './accounting-odoo-context.service';
import { AccountingPlatformAuditService } from './accounting-platform-audit.service';
import { DraftsController } from './drafts/drafts.controller';
import { DraftValidationService } from './drafts/draft-validation.service';
import { DraftsService } from './drafts/drafts.service';
import {
  DimensionDefinitionsController,
  DimensionRulesController,
  DimensionValuesController,
} from './dimensions/dimensions.controller';
import { DimensionsService } from './dimensions/dimensions.service';
import { JournalsCurrenciesController } from './journals-currencies/journals-currencies.controller';
import { JournalsCurrenciesService } from './journals-currencies/journals-currencies.service';

const SAFE_CONTROLLERS = [
  AccountingCapabilitiesController,
  AccountsController,
  DraftsController,
  DimensionDefinitionsController,
  DimensionValuesController,
  DimensionRulesController,
  JournalsCurrenciesController,
];

const SAFE_PROVIDERS = [
  AccountingMutationHandoffService,
  AccountingOdooContextService,
  AccountingPlatformAuditService,
  AccountsService,
  DraftsService,
  DimensionsService,
  JournalsCurrenciesService,
  DraftValidationService,
];

describe('AppModule accounting production graph (T055)', () => {
  it('imports both the safe request module and request-independent recovery module', () => {
    const imports = Reflect.getMetadata('imports', AppModule) as unknown[];

    expect(imports).toEqual(expect.arrayContaining([AccountingModule, AccountingRecoveryModule]));
  });
});

describe('AccountingModule safe-foundation wiring (T129)', () => {
  it('boots with every Story 1-3 safe controller and provider registered', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AccountingModule] }).compile();

    for (const controller of SAFE_CONTROLLERS) {
      expect(moduleRef.get(controller, { strict: false })).toBeInstanceOf(controller);
    }
    expect(moduleRef.get(DraftsController, { strict: false })).toMatchObject({
      drafts: expect.any(DraftsService),
      draftValidation: expect.any(DraftValidationService),
    });
    for (const provider of SAFE_PROVIDERS) {
      expect(moduleRef.get(provider, { strict: false })).toBeInstanceOf(provider);
    }

    await moduleRef.close();
  });

  it('contains only the safe controllers/providers and no policy or posting provider', () => {
    const controllers = Reflect.getMetadata('controllers', AccountingModule) as Type<unknown>[];
    const providers = Reflect.getMetadata('providers', AccountingModule) as Type<unknown>[];

    expect(controllers).toEqual(SAFE_CONTROLLERS);
    expect(providers).toEqual(SAFE_PROVIDERS);
    expect([...controllers, ...providers].map((item) => item.name).join(' ')).not.toMatch(
      /posting|policy|reversal|opening|period/i,
    );
  });
});
