import type { ReactNode } from 'react';

import { loadModuleCatalog } from '@/lib/auth/module-catalog';
import { getChecklist } from '@/lib/auth/checklist-bff';
import { ChecklistNavigation } from './checklist/checklist-navigation';
import { WorkspaceModuleState } from './modules/workspace-module-state';

export default async function OnboardingLayout({ children }: { children: ReactNode }) {
  const catalog = await loadModuleCatalog();
  const checklist = await getChecklist();
  return <>{checklist.status === 200 ? <ChecklistNavigation /> : null}{catalog.status === 200 && catalog.options ? <WorkspaceModuleState options={catalog.options} /> : null}{children}</>;
}
