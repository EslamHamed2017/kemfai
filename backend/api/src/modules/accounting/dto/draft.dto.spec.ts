import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DraftWriteDto } from './draft.dto';

const UUIDS = Array.from(
  { length: 7 },
  (_, index) => `${index + 1}1111111-1111-4111-8111-111111111111`,
);

function line(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: UUIDS[1],
    sequence: 1,
    accountId: UUIDS[2],
    transactionCurrencyCode: 'AED',
    transactionPrecision: 2,
    transactionCurrencyMetadataVersion: 'iso-4217:2026-01',
    companyBaseCurrencyCode: 'AED',
    basePrecision: 2,
    baseCurrencyMetadataVersion: 'iso-4217:2026-01',
    currencyConfigurationVersion: 1,
    transactionDebit: '1.2300',
    transactionCredit: '0',
    baseDebit: '1.2300',
    baseCredit: '0',
    rateReference: null,
    rateEffectiveDate: null,
    dimensions: [{ definitionId: UUIDS[3], valueId: UUIDS[4] }],
    ...overrides,
  };
}

function draft(lineOverrides: Record<string, unknown> = {}): DraftWriteDto {
  return plainToInstance(DraftWriteDto, {
    journalId: UUIDS[0],
    accountingDate: '2026-11-03',
    description: 'Safe draft only',
    transactionType: 'manual_journal',
    source: { type: 'manual', id: UUIDS[5] },
    lines: [line(lineOverrides)],
  });
}

async function messages(value: object): Promise<string[]> {
  const errors = await validate(value, { whitelist: true });
  const collect = (items: typeof errors): string[] =>
    items.flatMap((error) => [
      ...Object.values(error.constraints ?? {}),
      ...collect(error.children ?? []),
    ]);
  return collect(errors);
}

describe('Accounting minimal draft DTOs (T048)', () => {
  it('accepts a draft-only base-currency line and preserves exact decimal lexemes byte-for-value', async () => {
    const dto = draft();
    expect(await messages(dto)).toEqual([]);
    expect(dto.lines[0].transactionDebit).toBe('1.2300');
    expect(dto.lines[0].baseDebit).toBe('1.2300');
    expect(dto).not.toHaveProperty('post');
    expect(dto).not.toHaveProperty('state');
  });

  it('accepts explicit foreign-currency provenance without calculating or transforming amounts', async () => {
    const dto = draft({
      transactionCurrencyCode: 'USD',
      transactionDebit: '100.000000',
      baseDebit: '367.250000',
      rateReference: 'owner-supplied-rate:42',
      rateEffectiveDate: '2026-11-03',
    });
    expect(await messages(dto)).toEqual([]);
    expect(dto.lines[0].transactionDebit).toBe('100.000000');
    expect(dto.lines[0].baseDebit).toBe('367.250000');
  });

  it.each([
    [
      { transactionCurrencyCode: 'USD', rateReference: null, rateEffectiveDate: '2026-11-03' },
      'FX_RATE_REFERENCE_REQUIRED',
    ],
    [
      { transactionCurrencyCode: 'USD', rateReference: 'rate:42', rateEffectiveDate: null },
      'FX_RATE_EFFECTIVE_DATE_REQUIRED',
    ],
    [
      { rateReference: 'not-allowed', rateEffectiveDate: '2026-11-03' },
      'FX_METADATA_NOT_ALLOWED_FOR_BASE',
    ],
    [{ transactionDebit: '1e3' }, 'DRAFT_DECIMAL_INVALID'],
    [{ accountId: '7' }, 'DRAFT_ACCOUNT_ID_INVALID'],
  ])('returns stable errors for invalid draft input %#', async (override, code) => {
    expect(await messages(draft(override))).toContain(code);
  });

  it('rejects duplicate assignments for the same normalized dimension definition', async () => {
    const dto = draft({
      dimensions: [
        { definitionId: UUIDS[3], valueId: UUIDS[4] },
        { definitionId: UUIDS[3], valueId: UUIDS[6] },
      ],
    });
    expect(await messages(dto)).toContain('DRAFT_DIMENSION_DEFINITION_DUPLICATE');
  });

  it('validates nested dimensions and rejects non-manual transaction types', async () => {
    const dto = draft({ dimensions: [{ definitionId: '7', valueId: UUIDS[4] }] });
    (dto as unknown as { transactionType: string }).transactionType = 'posting';
    expect(await messages(dto)).toEqual(
      expect.arrayContaining([
        'DRAFT_DIMENSION_DEFINITION_ID_INVALID',
        'DRAFT_TRANSACTION_TYPE_INVALID',
      ]),
    );
  });
});
