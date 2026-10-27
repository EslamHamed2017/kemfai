import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { getChecklist } from '@/lib/auth/checklist-bff';
import { loadModuleCatalog } from '@/lib/auth/module-catalog';
import { isChecklistState } from '@/lib/checklist-state';
import { SESSION_COOKIE } from '@/lib/auth/cookies';
import { ChecklistScreen } from './checklist-screen';

export default async function ChecklistPage() {
  if (!(await cookies()).get(SESSION_COOKIE)?.value) redirect('/auth/login?returnTo=%2Fchecklist');
  const [response, moduleCatalog] = await Promise.all([getChecklist(), loadModuleCatalog()]);
  if (response.status === 404 || response.status === 403) notFound();
  if (response.ok) {
    const value: unknown = await response.json();
    if (!isChecklistState(value)) {
      return <ChecklistScreen moduleSelectionAvailable={moduleCatalog.status === 200} />;
    }
  }
  // The browser performs the live read so loading/error states are real and subsequent
  // source-record changes can use the same authenticated BFF path without a navigation.
  return <ChecklistScreen moduleSelectionAvailable={moduleCatalog.status === 200} />;
}
