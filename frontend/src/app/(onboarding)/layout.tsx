import type { ReactNode } from 'react';

import { loadModuleCatalog } from '@/lib/auth/module-catalog';
import { WorkspaceModuleState } from './modules/workspace-module-state';

export default async function OnboardingLayout({ children }: { children: ReactNode }) {
  const catalog = await loadModuleCatalog();
  return <>{catalog.status === 200 && catalog.options ? <WorkspaceModuleState options={catalog.options} /> : null}{children}</>;
}
