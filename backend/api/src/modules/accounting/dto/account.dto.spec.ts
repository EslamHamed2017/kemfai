import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AccountCreateDto, AccountUpdateDto } from './account.dto';

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

describe('Accounting account DTOs (T048)', () => {
  it('accepts the exact AccountCreate shape and validates nested localized names', async () => {
    const dto = plainToInstance(AccountCreateDto, {
      code: '1100',
      name: { en: 'Cash', ar: 'النقد' },
      accountType: 'asset_cash',
      nodeKind: 'posting',
      parentId: UUID,
      active: true,
    });
    expect(await messages(dto)).toEqual([]);

    const invalid = plainToInstance(AccountCreateDto, {
      code: '1100',
      name: { en: '', ar: 'النقد' },
      accountType: 'asset_cash',
      nodeKind: 'posting',
    });
    expect(await messages(invalid)).toContain('ACCOUNT_NAME_EN_INVALID');
  });

  it('rejects invalid account enums/UUIDs with stable contract errors', async () => {
    const dto = plainToInstance(AccountCreateDto, {
      code: '',
      name: { en: 'Cash', ar: 'النقد' },
      accountType: 'asset_cash',
      nodeKind: 'ledger',
      parentId: 'odoo-id-7',
    });
    expect(await messages(dto)).toEqual(
      expect.arrayContaining([
        'ACCOUNT_CODE_INVALID',
        'ACCOUNT_NODE_KIND_INVALID',
        'ACCOUNT_PARENT_ID_INVALID',
      ]),
    );
  });

  it('requires at least one AccountUpdate property while allowing explicit null parentId', async () => {
    expect(await messages(plainToInstance(AccountUpdateDto, {}))).toContain('ACCOUNT_UPDATE_EMPTY');
    expect(await messages(plainToInstance(AccountUpdateDto, { parentId: null }))).toEqual([]);
  });
});
