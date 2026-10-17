/** @jest-environment node */
import { findAvailableWorkspaceModule } from '@/lib/auth/module-catalog';

test('workspace routing rejects persisted selected state when current entitlement is revoked', () => {
  expect(findAvailableWorkspaceModule([{
    key: 'module.inventory', name: 'Inventory', nameAr: 'المخزون', selected: true,
    includedInCurrentPlan: false, requiredPlanTier: 'Growth', requiredPlanTierAr: 'النمو',
  }], 'module.inventory')).toBeUndefined();
});
