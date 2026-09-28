import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LocaleUpdateRequestDto } from './locale-update.request.dto';

/** T104 — the PATCH body accepts exactly the two supported locales (422 otherwise). */
describe('LocaleUpdateRequestDto (T104, unit)', () => {
  async function errors(body: Record<string, unknown>): Promise<number> {
    const dto = plainToInstance(LocaleUpdateRequestDto, body);
    return (await validate(dto)).length;
  }

  it('accepts en and ar', async () => {
    expect(await errors({ locale: 'en' })).toBe(0);
    expect(await errors({ locale: 'ar' })).toBe(0);
  });

  it('rejects unsupported or missing locale values', async () => {
    expect(await errors({ locale: 'fr' })).toBeGreaterThan(0);
    expect(await errors({ locale: 'EN' })).toBeGreaterThan(0);
    expect(await errors({})).toBeGreaterThan(0);
  });
});
