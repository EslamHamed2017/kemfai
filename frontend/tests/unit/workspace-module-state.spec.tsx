import { render, screen } from '@testing-library/react';
import { WorkspaceModuleState } from '@/app/(onboarding)/modules/workspace-module-state';

jest.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string, values?: { count?: number }) =>
    key === 'checklistReflection' ? `${values?.count} enabled modules` : key === 'enabledStatus' ? 'Enabled' : key,
}));
jest.mock('next/link', () => ({ __esModule: true, default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));

test('a persisted but currently unentitled module is absent from navigation and checklist', () => {
  render(
      <WorkspaceModuleState options={[{
        key: 'module.inventory', name: 'Inventory', nameAr: 'المخزون',
        selected: true, includedInCurrentPlan: false,
        requiredPlanTier: 'Growth', requiredPlanTierAr: 'النمو',
      }]} />,
  );
  expect(screen.queryByRole('link', { name: 'Inventory' })).not.toBeInTheDocument();
  expect(screen.queryByText(/Inventory — Enabled/)).not.toBeInTheDocument();
});
