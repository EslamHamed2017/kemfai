import { forwardAccounting } from '@/lib/auth/accounting-bff';

type CurrencyItemContext = {
  params: Promise<{ currencyCode: string }>;
};

export const PUT = async (request: Request, { params }: CurrencyItemContext) =>
  forwardAccounting(request, {
    method: 'PUT',
    path: '/currencies/' + encodeURIComponent((await params).currencyCode),
    body: await request.json(),
  });
