import { completeCompanySetup } from '@/lib/auth/company-setup-bff';
export const POST = (request: Request) => completeCompanySetup(request);
