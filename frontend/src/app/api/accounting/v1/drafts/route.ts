import { forwardAccounting } from '@/lib/auth/accounting-bff';

export const POST = async (request: Request) =>
  forwardAccounting(request, {
    method: 'POST',
    path: '/drafts',
    body: await request.json(),
  });
