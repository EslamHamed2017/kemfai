import { QueryRunner } from 'typeorm';
import { AddBilingualCatalogNames1789837200000 } from './migrations/1789837200000-AddBilingualCatalogNames';

describe('AddBilingualCatalogNames1789837200000', () => {
  it('has a genuinely unique migration identity and converges a partially applied rejected migration', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new AddBilingualCatalogNames1789837200000();

    expect(migration.name).toBe('AddBilingualCatalogNames1789837200000');
    await migration.up({ query } as unknown as QueryRunner);

    const sql = query.mock.calls.map(([statement]) => statement as string).join('\n');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "name"');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "display_name"');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "name_en"');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "name_ar"');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "display_name_en"');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "display_name_ar"');
    expect(sql).toContain('SET "published" = false');
  });
});
