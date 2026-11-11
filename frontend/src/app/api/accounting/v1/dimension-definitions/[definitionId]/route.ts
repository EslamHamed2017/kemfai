import { forwardAccounting } from '@/lib/auth/accounting-bff';

type DefinitionItemContext = {
  params: Promise<{ definitionId: string }>;
};

const itemPath = async ({ params }: DefinitionItemContext) =>
  `/dimension-definitions/${encodeURIComponent((await params).definitionId)}`;

export const PATCH = async (request: Request, context: DefinitionItemContext) =>
  forwardAccounting(request, {
    method: 'PATCH',
    path: await itemPath(context),
    body: await request.json(),
  });
