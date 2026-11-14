import { forwardAccounting } from '@/lib/auth/accounting-bff';

export const GET = (request: Request) =>
  forwardAccounting(request, {
    method: 'GET',
    path: `/dimension-definitions${new URL(request.url).search}`,
  });

export const POST = async (request: Request) =>
  forwardAccounting(request, {
    method: 'POST',
    path: '/dimension-definitions',
    body: await request.json(),
  });
