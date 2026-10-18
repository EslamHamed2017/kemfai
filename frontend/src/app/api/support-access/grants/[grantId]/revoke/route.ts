import { revokeSupportGrant } from '@/lib/auth/support-access-bff';
export const POST = async (request: Request, context: { params: Promise<{ grantId: string }> }) =>
  revokeSupportGrant(request, (await context.params).grantId);
