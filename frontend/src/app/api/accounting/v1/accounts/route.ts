import { forwardAccounting } from '@/lib/auth/accounting-bff';

export const GET = (request: Request) =>
  forwardAccounting(request, {
    method: 'GET',
    path: `/accounts${new URL(request.url).search}`,
  });

export const POST = async (request: Request) =>
  forwardAccounting(request, {
    method: 'POST',
    path: '/accounts',
    body: await request.json(),
  });
