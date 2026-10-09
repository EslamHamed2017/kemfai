import { postLogout } from '@/lib/auth/logout-bff';
export const POST = (request: Request) => postLogout(request);
