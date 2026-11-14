import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CurrencyConfigurationPutDto,
  JournalCreateDto,
  JournalUpdateDto,
} from './journal-currency.dto';

async function messages(value: object): Promise<string[]> {
  const errors = await validate(value, { whitelist: true });
  const collect = (items: typeof errors): string[] =>
    items.flatMap((error) => [
      ...Object.values(error.constraints ?? {}),
      ...collect(error.children ?? []),
    ]);
  return collect(errors);
}

const name = { en: 'General Journal', ar: 'دفتر اليومية العام' };

describe('Accounting journal/currency DTOs (T122)', () => {
  it('matches the canonical JournalCreate and JournalUpdate shapes', async () => {
    expect(
      await messages(
        plainToInstance(JournalCreateDto, {
          code: 'GEN',
          name,
          journalType: 'general',
          active: true,
        }),
      ),
    ).toEqual([]);
    expect(await messages(plainToInstance(JournalUpdateDto, { name }))).toEqual([]);
    expect(await messages(plainToInstance(JournalUpdateDto, {}))).toContain('JOURNAL_UPDATE_EMPTY');
  });

  it('rejects invalid journal fields and immutable journal type updates', async () => {
    expect(
      await messages(
        plainToInstance(JournalCreateDto, {
          code: 'TOO_LONG_FOR_A_JOURNAL',
          name,
          journalType: 'sale',
        }),
      ),
    ).toEqual(expect.arrayContaining(['JOURNAL_CODE_INVALID', 'JOURNAL_TYPE_INVALID']));
    expect(await messages(plainToInstance(JournalUpdateDto, { journalType: 'general' }))).toContain(
      'JOURNAL_TYPE_IMMUTABLE',
    );
  });

  it('accepts only enabled for currency configuration mutations', async () => {
    expect(await messages(plainToInstance(CurrencyConfigurationPutDto, { enabled: true }))).toEqual(
      [],
    );
  });

  it.each([
    ['currencyCode', 'AED'],
    ['nativeDecimalPlaces', 9],
    ['nativeMetadataVersion', 'forged'],
    ['isBase', false],
  ])('rejects immutable currency field %s', async (field, value) => {
    expect(
      await messages(
        plainToInstance(CurrencyConfigurationPutDto, { enabled: true, [field]: value }),
      ),
    ).toContain('CURRENCY_METADATA_IMMUTABLE');
  });
});
