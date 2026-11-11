import { forwardAccounting } from '@/lib/auth/accounting-bff';

type AccountItemContext = {
  params: Promise<{ accountId: string }>;
};

const accountPath = async ({ params }: AccountItemContext) =>
  `/accounts/${encodeURIComponent((await params).accountId)}`;

export const GET = async (request: Request, context: AccountItemContext) =>
  forwardAccounting(request, {
    method: 'GET',
    path: await accountPath(context),
  });

export const PATCH = async (request: Request, context: AccountItemContext) =>
  forwardAccounting(request, {
    method: 'PATCH',
    path: await accountPath(context),
    body: await request.json(),
  });
