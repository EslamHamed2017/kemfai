import { createSupportGrant, getSupportGrants } from '@/lib/auth/support-access-bff';
export const dynamic = 'force-dynamic';
export const GET = () => getSupportGrants();
export const POST = (request: Request) => createSupportGrant(request);
