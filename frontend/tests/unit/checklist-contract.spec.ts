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
    expect(screen).toContain('/modules#module.sales');
    expect(screen).toContain('/modules#module.accounting');
    expect(screen).toContain('/modules#module.inventory');
    expect(screen).toContain('/billing');
    expect(screen).toContain("fetch('/api/onboarding/checklist'");
    expect(Object.keys(messages.onboardingChecklist.items)).toEqual([
      'customer',
      'bank',
      'product',
      'firstInvoice',
    ]);
    expect(messages.onboardingChecklist.items.customer.action).toBe('Set up Sales module');
    expect(messages.onboardingChecklist.items.bank.action).toBe('Set up Accounting module');
    expect(messages.onboardingChecklist.items.product.action).toBe('Set up Inventory module');
    expect(JSON.stringify(messages.onboardingChecklist.items)).not.toMatch(/create|record creation/i);
  });
});
