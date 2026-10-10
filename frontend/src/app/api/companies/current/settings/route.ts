import { getCompanySettings, putCompanySettings } from '@/lib/auth/company-settings-bff';

export const GET = () => getCompanySettings();
export const PUT = (request: Request) => putCompanySettings(request);
