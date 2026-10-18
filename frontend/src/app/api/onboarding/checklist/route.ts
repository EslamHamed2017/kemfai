import { getChecklist } from '@/lib/auth/checklist-bff';

export const dynamic = 'force-dynamic';
export const GET = () => getChecklist();
