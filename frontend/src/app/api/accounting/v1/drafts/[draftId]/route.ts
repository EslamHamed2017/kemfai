import { forwardAccounting } from '@/lib/auth/accounting-bff';

type DraftItemContext = {
  params: Promise<{ draftId: string }>;
};

const draftPath = async ({ params }: DraftItemContext) =>
  `/drafts/${encodeURIComponent((await params).draftId)}`;

export const GET = async (request: Request, context: DraftItemContext) =>
  forwardAccounting(request, {
    method: 'GET',
    path: await draftPath(context),
  });

export const PUT = async (request: Request, context: DraftItemContext) =>
  forwardAccounting(request, {
    method: 'PUT',
    path: await draftPath(context),
    body: await request.json(),
  });
