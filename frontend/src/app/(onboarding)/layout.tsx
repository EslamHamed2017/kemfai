import type { ReactNode } from 'react';

import { loadModuleCatalog } from '@/lib/auth/module-catalog';
import { getChecklist } from '@/lib/auth/checklist-bff';
import { ChecklistNavigation } from './checklist/checklist-navigation';
import { WorkspaceModuleState } from './modules/workspace-module-state';
import { getSupportGrants } from '@/lib/auth/support-access-bff';
import { SupportAccessNavigation } from './support-access/support-access-navigation';

export default async function OnboardingLayout({ children }: { children: ReactNode }) {
  const catalog = await loadModuleCatalog();
  const checklist = await getChecklist();
  const supportAccess = await getSupportGrants();
  return <>{checklist.status === 200 ? <ChecklistNavigation /> : null}{supportAccess.status === 200 ? <SupportAccessNavigation /> : null}{catalog.status === 200 && catalog.options ? <WorkspaceModuleState options={catalog.options} /> : null}{children}</>;
}
