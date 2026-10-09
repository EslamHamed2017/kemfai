import { getCompanySetup, putCompanySetup } from '@/lib/auth/company-setup-bff';
export const GET = () => getCompanySetup();
export const PUT = (request: Request) => putCompanySetup(request);
