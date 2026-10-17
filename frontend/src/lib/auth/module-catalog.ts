import { getModules } from './module-selection-bff';

export interface ModuleOptionView {
  key: string;
  name: string;
  nameAr: string | null;
  includedInCurrentPlan: boolean;
  selected: boolean;
  requiredPlanTier: string | null;
  requiredPlanTierAr?: string | null;
}

export function findAvailableWorkspaceModule(options: ModuleOptionView[], key: string) {
  return options.find(
    (option) => option.key === key && option.selected && option.includedInCurrentPlan,
  );
}

function validOption(value: unknown): value is ModuleOptionView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const option = value as Record<string, unknown>;
  return typeof option.key === 'string' && typeof option.name === 'string' &&
    (typeof option.nameAr === 'string' || option.nameAr === null) &&
    typeof option.includedInCurrentPlan === 'boolean' && typeof option.selected === 'boolean' &&
    (typeof option.requiredPlanTier === 'string' || option.requiredPlanTier === null) &&
    (typeof option.requiredPlanTierAr === 'string' || option.requiredPlanTierAr === null || option.requiredPlanTierAr === undefined);
}

export async function loadModuleCatalog() {
  const response = await getModules();
  if (!response.ok) return { status: response.status, options: null as ModuleOptionView[] | null };
  try {
    const body: unknown = await response.json();
    return Array.isArray(body) && body.every(validOption)
      ? { status: 200, options: body }
      : { status: 502, options: null };
  } catch {
    return { status: 502, options: null };
  }
}
