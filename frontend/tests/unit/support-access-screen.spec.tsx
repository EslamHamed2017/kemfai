import { render, screen } from '@testing-library/react';
import { SupportAccessScreen } from '../../src/app/(onboarding)/support-access/support-access-screen';

let mockLocale = 'en';
jest.mock('next-intl', () => ({
  useLocale: () => mockLocale,
  useTranslations: () => (key: string, values?: Record<string, string>) => {
    const translated =
      (
        {
          en: {
            title: 'Temporary support access',
            expiry: 'Access expires',
            empty: 'No support access history yet.',
            role: 'Internal role',
            'roles.support': 'Support',
            action: 'Action',
            'usageActions.workspaceSummaryRead': 'Read workspace summary',
            result: 'Result',
            denied: 'Denied',
            'denialReasons.wrong_tenant': 'wrong tenant',
            history: 'Access history',
            usageHistory: 'Usage and denial history',
            revoke: 'Revoke now',
          },
          ar: {
            title: 'وصول مؤقت للدعم',
            expiry: 'ينتهي الوصول في',
            empty: 'لا يوجد سجل لوصول الدعم بعد.',
            role: 'الدور الداخلي',
            'roles.support': 'الدعم',
            action: 'الإجراء',
            'usageActions.workspaceSummaryRead': 'قراءة ملخص مساحة العمل',
            result: 'النتيجة',
            denied: 'مرفوض',
            'denialReasons.wrong_tenant': 'مساحة عمل غير مطابقة',
            history: 'سجل الوصول',
            usageHistory: 'سجل الاستخدام والرفض',
            revoke: 'إلغاء الآن',
          },
        }[mockLocale] as Record<string, string>
      )[key] ?? key;
    return key === 'denied' ? `${translated}: ${values?.reason ?? ''}` : translated;
  },
}));
jest.mock('@carbon/react', () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
  InlineLoading: ({ description }: { description: string }) => <p>{description}</p>,
  InlineNotification: ({ title }: { title: string }) => <p>{title}</p>,
  Tag: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Tile: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
}));
jest.mock('../../src/components/locale-switcher', () => ({
  LocaleSwitcher: () => <button>locale</button>,
}));
jest.mock('../../src/components/sign-out-button', () => ({
  SignOutButton: () => <button>sign out</button>,
}));

describe('Support access owner UI (T087/T091 RED)', () => {
  beforeEach(() => {
    mockLocale = 'en';
  });

  it('renders mandatory expiry, empty history and revoke-capable history semantics', async () => {
    global.fetch = jest.fn(
      async () => ({ ok: true, status: 200, json: async () => [] }) as Response,
    ) as jest.Mock;
    render(<SupportAccessScreen initialGrants={[]} />);
    expect(screen.getByRole('heading', { name: /temporary support access/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/expires/i)).toBeRequired();
    expect(await screen.findByText(/no support access history/i)).toBeInTheDocument();
  });

  it('localizes support role and usage enums instead of leaking backend English in Arabic', async () => {
    mockLocale = 'ar';
    const grant = {
      id: '95000000-0000-4000-8000-000000000087',
      granteeRole: 'Support' as const,
      grantedBy: 'owner@example.test',
      grantedAt: '2026-10-20T10:00:00.000Z',
      expiresAt: '2026-10-25T10:00:00.000Z',
      revokedAt: null,
      expiredAt: null,
      status: 'active' as const,
      permittedActions: ['workspace.summary.read'] as ['workspace.summary.read'],
      usage: [
        {
          id: '95000000-0000-4000-8000-000000000088',
          usedBy: 'supporter@example.test',
          usedAt: '2026-10-21T10:00:00.000Z',
          actionSummary: 'workspace.summary.read' as const,
          wasDenied: true,
          denialReason: 'wrong_tenant' as const,
        },
      ],
    };
    global.fetch = jest.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => [grant],
        }) as Response,
    ) as jest.Mock;

    render(<SupportAccessScreen initialGrants={[grant]} />);

    expect(await screen.findByText('الدعم')).toBeInTheDocument();
    expect(screen.getByText('قراءة ملخص مساحة العمل')).toBeInTheDocument();
    expect(screen.getByText(/مساحة عمل غير مطابقة/)).toBeInTheDocument();
    expect(screen.queryByText('Support')).not.toBeInTheDocument();
    expect(screen.queryByText('workspace.summary.read')).not.toBeInTheDocument();
    expect(screen.queryByText('wrong_tenant')).not.toBeInTheDocument();
  });
});
