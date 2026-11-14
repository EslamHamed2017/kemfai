import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  DimensionDefinitionCreateDto,
  DimensionDefinitionUpdateDto,
  DimensionRuleCreateDto,
  DimensionRuleUpdateDto,
  DimensionValueCreateDto,
  DimensionValueUpdateDto,
} from './dimension.dto';

const UUID = '11111111-1111-4111-8111-111111111111';

async function messages(value: object): Promise<string[]> {
  const errors = await validate(value, { whitelist: true });
  const collect = (items: typeof errors): string[] =>
    items.flatMap((error) => [
      ...Object.values(error.constraints ?? {}),
      ...collect(error.children ?? []),
    ]);
  return collect(errors);
}

const name = { en: 'Project', ar: 'المشروع' };

describe('Accounting dimension DTOs (T091)', () => {
  it('matches definition create/update contract and stable codes', async () => {
    expect(
      await messages(
        plainToInstance(DimensionDefinitionCreateDto, {
          key: 'project_code',
          name,
          kind: 'custom',
          active: true,
        }),
      ),
    ).toEqual([]);
    expect(
      await messages(
        plainToInstance(DimensionDefinitionCreateDto, {
          key: 'Project-Code',
          name,
          kind: 'built_in',
        }),
      ),
    ).toEqual(expect.arrayContaining(['DIMENSION_KEY_INVALID', 'DIMENSION_KIND_INVALID']));
    expect(await messages(plainToInstance(DimensionDefinitionUpdateDto, {}))).toContain(
      'DIMENSION_DEFINITION_UPDATE_EMPTY',
    );
  });

  it('matches value create/update contract and stable codes', async () => {
    expect(
      await messages(
        plainToInstance(DimensionValueCreateDto, {
          definitionId: UUID,
          code: 'PROJ-01',
          name,
          active: true,
        }),
      ),
    ).toEqual([]);
    expect(
      await messages(
        plainToInstance(DimensionValueCreateDto, {
          definitionId: 'odoo-7',
          code: '',
          name,
        }),
      ),
    ).toEqual(
      expect.arrayContaining(['DIMENSION_DEFINITION_ID_INVALID', 'DIMENSION_VALUE_CODE_INVALID']),
    );
    expect(await messages(plainToInstance(DimensionValueUpdateDto, {}))).toContain(
      'DIMENSION_VALUE_UPDATE_EMPTY',
    );
  });

  it('requires an account or transaction type scope for rule creation', async () => {
    expect(
      await messages(
        plainToInstance(DimensionRuleCreateDto, {
          accountId: UUID,
          transactionType: null,
          dimensionDefinitionId: UUID,
          requirement: 'required',
          effectiveFrom: '2026-11-07',
          effectiveTo: null,
          active: true,
        }),
      ),
    ).toEqual([]);
    expect(
      await messages(
        plainToInstance(DimensionRuleCreateDto, {
          accountId: null,
          transactionType: null,
          dimensionDefinitionId: UUID,
          requirement: 'mandatory',
        }),
      ),
    ).toEqual(
      expect.arrayContaining(['DIMENSION_RULE_SCOPE_REQUIRED', 'DIMENSION_REQUIREMENT_INVALID']),
    );
  });

  it('validates rule dates and rejects empty updates with stable codes', async () => {
    expect(
      await messages(
        plainToInstance(DimensionRuleCreateDto, {
          transactionType: 'manual_journal',
          dimensionDefinitionId: UUID,
          requirement: 'optional',
          effectiveFrom: '07/11/2026',
        }),
      ),
    ).toContain('DIMENSION_EFFECTIVE_FROM_INVALID');
    expect(await messages(plainToInstance(DimensionRuleUpdateDto, {}))).toContain(
      'DIMENSION_RULE_UPDATE_EMPTY',
    );
  });
});
