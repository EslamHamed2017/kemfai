import { forwardAccounting } from '@/lib/auth/accounting-bff';

type RuleItemContext = {
  params: Promise<{ ruleId: string }>;
};

const itemPath = async ({ params }: RuleItemContext) =>
  `/dimension-rules/${encodeURIComponent((await params).ruleId)}`;

export const PATCH = async (request: Request, context: RuleItemContext) =>
  forwardAccounting(request, {
    method: 'PATCH',
    path: await itemPath(context),
    body: await request.json(),
  });
