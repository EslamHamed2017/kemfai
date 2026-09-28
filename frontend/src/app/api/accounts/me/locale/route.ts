import { getLocaleFromApi, patchLocale } from '@/lib/auth/locale-bff';
export const GET = () => getLocaleFromApi();
export const PATCH = (request: Request) => patchLocale(request);
