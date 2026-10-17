import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('T083 checklist surface', () => {
  it('has a real localized route, BFF, and four honest setup links', () => {
    const root = path.resolve(__dirname, '../..');
    const page = readFileSync(path.join(root, 'src/app/(onboarding)/checklist/page.tsx'), 'utf8');
    const screen = readFileSync(
      path.join(root, 'src/app/(onboarding)/checklist/checklist-screen.tsx'),
      'utf8',
    );
    const messages = JSON.parse(
      readFileSync(path.join(root, 'src/locales/en/common.json'), 'utf8'),
    );
    expect(page).toContain('ChecklistScreen');
    expect(screen).toContain('/company-settings');
    expect(screen).toContain('/modules');
    expect(screen).toContain('/billing');
    expect(screen).toContain("fetch('/api/onboarding/checklist'");
    expect(Object.keys(messages.onboardingChecklist.items)).toEqual([
      'customer',
      'bank',
      'product',
      'firstInvoice',
    ]);
  });
});
