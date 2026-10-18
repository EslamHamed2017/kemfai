export interface ChecklistState {
  customerAdded: boolean;
  bankAdded: boolean;
  productAdded: boolean;
  firstInvoiceReady: boolean;
  gatedOnSubscriptionActivation: boolean;
}

export function isChecklistState(value: unknown): value is ChecklistState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const keys = [
    'customerAdded',
    'bankAdded',
    'productAdded',
    'firstInvoiceReady',
    'gatedOnSubscriptionActivation',
  ];
  return (
    Object.keys(row).length === keys.length && keys.every((key) => typeof row[key] === 'boolean')
  );
}
