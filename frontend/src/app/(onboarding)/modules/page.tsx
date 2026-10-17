import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';

import { SESSION_COOKIE } from '@/lib/auth/cookies';
import { loadModuleCatalog } from '@/lib/auth/module-catalog';
import { ModuleSelectionScreen } from './module-selection-screen';

export default async function ModulesPage() {
  if (!(await cookies()).get(SESSION_COOKIE)?.value) {
    redirect('/auth/login?returnTo=%2Fmodules');
  }
  const catalog = await loadModuleCatalog();
  if (catalog.status === 404) notFound();
  return <ModuleSelectionScreen initialOptions={catalog.options ?? undefined} />;
}
