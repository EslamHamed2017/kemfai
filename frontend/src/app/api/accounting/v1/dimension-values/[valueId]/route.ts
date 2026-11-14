import { forwardAccounting } from '@/lib/auth/accounting-bff';

type ValueItemContext = {
  params: Promise<{ valueId: string }>;
};

const itemPath = async ({ params }: ValueItemContext) =>
  `/dimension-values/${encodeURIComponent((await params).valueId)}`;

export const PATCH = async (request: Request, context: ValueItemContext) =>
  forwardAccounting(request, {
    method: 'PATCH',
    path: await itemPath(context),
    body: await request.json(),
  });
