import { forwardAccounting } from '@/lib/auth/accounting-bff';

type JournalItemContext = {
  params: Promise<{ journalId: string }>;
};

export const PATCH = async (request: Request, { params }: JournalItemContext) =>
  forwardAccounting(request, {
    method: 'PATCH',
    path: '/journals/' + encodeURIComponent((await params).journalId),
    body: await request.json(),
  });
