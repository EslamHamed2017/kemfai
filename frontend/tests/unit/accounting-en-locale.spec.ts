import en from '../../src/locales/en/common.json';

function message(path: string): unknown {
  return path.split('.').reduce<unknown>((value, segment) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return (value as Record<string, unknown>)[segment];
  }, en);
}

const storyOneKeys = [
  'accountingCoa.title',
  'accountingCoa.treeLabel',
  'accountingCoa.loading',
  'accountingCoa.empty',
  'accountingCoa.saved',
  'accountingCoa.formLabel',
  'accountingCoa.createTitle',
  'accountingCoa.editTitle',
  'accountingCoa.noParent',
  'accountingCoa.actions.create',
  'accountingCoa.actions.edit',
  'accountingCoa.actions.deactivate',
  'accountingCoa.actions.retry',
  'accountingCoa.actions.save',
  'accountingCoa.actions.saving',
  'accountingCoa.actions.cancel',
  'accountingCoa.fields.code',
  'accountingCoa.fields.nameEn',
  'accountingCoa.fields.nameAr',
  'accountingCoa.fields.accountType',
  'accountingCoa.fields.nodeKind',
  'accountingCoa.fields.parent',
  'accountingCoa.nodeKind.parent',
  'accountingCoa.nodeKind.posting',
  'accountingCoa.errors.load',
  'accountingCoa.errors.conflict',
  'accountingCoa.errors.general',
  'accountingDraft.title',
  'accountingDraft.loading',
  'accountingDraft.saved',
  'accountingDraft.nonPostingNotice',
  'accountingDraft.actions.addLine',
  'accountingDraft.actions.save',
  'accountingDraft.actions.validate',
  'accountingDraft.fields.account',
  'accountingDraft.fields.journalId',
  'accountingDraft.fields.accountingDate',
  'accountingDraft.fields.description',
  'accountingDraft.fields.moneyMetadata',
  'accountingDraft.fields.transactionCurrencyCode',
  'accountingDraft.fields.transactionPrecision',
  'accountingDraft.fields.transactionMetadataVersion',
  'accountingDraft.fields.baseCurrencyCode',
  'accountingDraft.fields.basePrecision',
  'accountingDraft.fields.baseMetadataVersion',
  'accountingDraft.fields.currencyConfigurationVersion',
  'accountingDraft.fields.transactionDebit',
  'accountingDraft.fields.transactionCredit',
  'accountingDraft.fields.baseDebit',
  'accountingDraft.fields.baseCredit',
  'accountingDraft.accounts.selectPlaceholder',
  'accountingDraft.accounts.postingEligible',
  'accountingDraft.accounts.notPostingEligible',
  'accountingDraft.lines.label',
  'accountingDraft.errors.load',
  'accountingDraft.errors.accountNotPosting',
  'accountingDraft.errors.mutation',
] as const;

const storyTwoKeys = [
  'accountingDimensions.title',
  'accountingDimensions.loading',
  'accountingDimensions.empty',
  'accountingDimensions.tableLabel',
  'accountingDimensions.valuesLabel',
  'accountingDimensions.rulesLabel',
  'accountingDimensions.inactive',
  'accountingDimensions.actions.createValue',
  'accountingDimensions.actions.createRule',
  'accountingDimensions.actions.retry',
  'accountingDimensions.actions.save',
  'accountingDimensions.actions.saving',
  'accountingDimensions.actions.cancel',
  'accountingDimensions.columns.dimension',
  'accountingDimensions.columns.kind',
  'accountingDimensions.columns.values',
  'accountingDimensions.columns.rules',
  'accountingDimensions.kind.built_in',
  'accountingDimensions.kind.tag',
  'accountingDimensions.kind.custom',
  'accountingDimensions.valueEditor.title',
  'accountingDimensions.ruleEditor.title',
  'accountingDimensions.fields.dimension',
  'accountingDimensions.fields.code',
  'accountingDimensions.fields.nameEn',
  'accountingDimensions.fields.nameAr',
  'accountingDimensions.fields.account',
  'accountingDimensions.fields.noAccount',
  'accountingDimensions.fields.transactionType',
  'accountingDimensions.fields.requirement',
  'accountingDimensions.fields.effectiveFrom',
  'accountingDimensions.fields.effectiveTo',
  'accountingDimensions.requirement.optional',
  'accountingDimensions.requirement.required',
  'accountingDimensions.requirement.prohibited',
  'accountingDimensions.errors.load',
  'accountingDimensions.errors.conflict',
  'accountingDimensions.errors.validation',
  'accountingDimensions.errors.general',
  'accountingDraft.dimensions.selectPlaceholder',
  'accountingDraft.dimensions.errorsLabel',
  'accountingDraft.dimensions.errorsSummary',
  'accountingDraft.dimensions.unknown',
  'accountingDraft.errors.DIMENSION_REQUIRED',
  'accountingDraft.errors.DIMENSION_PROHIBITED',
  'accountingDraft.errors.DIMENSION_VALUE_INACTIVE',
  'accountingDraft.errors.DIMENSION_VALUE_SCOPE',
] as const;

const storyThreeKeys = [
  'accounting.title',
  'accounting.loading',
  'accounting.saved',
  'accounting.journalDialogLabel',
  'accounting.journalCreateTitle',
  'accounting.journalEditTitle',
  'accounting.actions.createJournal',
  'accounting.actions.enableCurrency',
  'accounting.actions.disableCurrency',
  'accounting.actions.retry',
  'accounting.actions.edit',
  'accounting.actions.save',
  'accounting.actions.cancel',
  'accounting.journals.title',
  'accounting.journals.empty',
  'accounting.journals.tableLabel',
  'accounting.currencies.title',
  'accounting.currencies.empty',
  'accounting.currencies.tableLabel',
  'accounting.fields.code',
  'accounting.fields.name',
  'accounting.fields.nameEn',
  'accounting.fields.nameAr',
  'accounting.fields.type',
  'accounting.fields.status',
  'accounting.fields.actions',
  'accounting.fields.currency',
  'accounting.fields.enabled',
  'accounting.fields.base',
  'accounting.fields.nativeDecimalPlaces',
  'accounting.fields.nativeMetadataVersion',
  'accounting.fields.active',
  'accounting.status.active',
  'accounting.status.inactive',
  'accounting.status.enabled',
  'accounting.status.disabled',
  'accounting.status.base',
  'accounting.status.nonBase',
  'accounting.errors.load',
  'accounting.errors.invalidRequest',
  'accounting.errors.forbidden',
  'accounting.errors.notFound',
  'accounting.errors.conflict',
  'accounting.errors.staleConflict',
  'accounting.errors.validation',
  'accounting.errors.rateLimited',
  'accounting.errors.mutation',
  'accountingDraft.journals.selectPlaceholder',
  'accountingDraft.currencies.selectPlaceholder',
  'accountingDraft.fields.rateReference',
  'accountingDraft.fields.rateEffectiveDate',
  'accountingDraft.errors.rateReferenceEffectiveRequired',
  'accountingDraft.errors.configurationStale',
  'accountingDraft.preview.title',
  'accountingDraft.preview.nonPosting',
  'accountingDraft.preview.companyBaseCurrency',
  'accountingDraft.preview.basePrecision',
  'accountingDraft.preview.baseDebitTotal',
  'accountingDraft.preview.baseCreditTotal',
  'accountingDraft.preview.configurationSnapshot',
  'accountingDraft.preview.errors',
  'accountingDraft.preview.warnings',
  'accountingDraft.preview.policyBlockers',
] as const;

describe('Story 1 English accounting catalog (T065)', () => {
  it.each(storyOneKeys)('%s resolves to a user-facing message instead of a raw/fallback key', (key) => {
    const value = message(key);
    expect(typeof value).toBe('string');
    expect((value as string).trim()).not.toBe('');
    expect(value).not.toBe(key);
    expect(value).not.toBe(key.split('.').at(-1));
  });
});


describe('Story 2 English accounting catalog (T100)', () => {
  it.each(storyTwoKeys)('%s resolves to a user-facing message instead of a raw/fallback key', (key) => {
    const value = message(key);
    expect(typeof value).toBe('string');
    expect((value as string).trim()).not.toBe('');
    expect(value).not.toBe(key);
    expect(value).not.toBe(key.split('.').at(-1));
  });
});

describe('Story 3 English accounting catalog (T137)', () => {
  it.each(storyThreeKeys)(
    '%s resolves to a user-facing message instead of a raw/fallback key',
    (key) => {
      const value = message(key);
      expect(typeof value).toBe('string');
      expect((value as string).trim()).not.toBe('');
      expect(value).not.toBe(key);
      expect(value).not.toBe(key.split('.').at(-1));
    },
  );
});
