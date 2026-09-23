import { postMfa } from '@/lib/auth/mfa-bff';
export const POST = (request: Request) => postMfa(request, 'confirm');
