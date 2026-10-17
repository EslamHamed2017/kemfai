import { postBillingDecision } from '@/lib/auth/billing-admin-bff';
export const POST = (
  request: Request,
  { params }: { params: Promise<{ submissionId: string; action: string }> },
) =>
  params.then(({ submissionId, action }) => {
    if (!['approve', 'reject', 'request-more-info'].includes(action))
      return new Response(null, { status: 404 });
    return postBillingDecision(
      request,
      submissionId,
      action as 'approve' | 'reject' | 'request-more-info',
    );
  });
