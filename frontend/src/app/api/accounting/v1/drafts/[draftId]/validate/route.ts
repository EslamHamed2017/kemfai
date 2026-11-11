import { forwardAccounting } from '@/lib/auth/accounting-bff';

type DraftValidationContext = {
  params: Promise<{ draftId: string }>;
};

export const POST = async (request: Request, { params }: DraftValidationContext) => {
  const bodyText = await request.text();
  const body = bodyText ? JSON.parse(bodyText) : undefined;

  return forwardAccounting(request, {
    method: 'POST',
    path: `/drafts/${encodeURIComponent((await params).draftId)}/validate`,
    ...(body === undefined ? {} : { body }),
  });
};
