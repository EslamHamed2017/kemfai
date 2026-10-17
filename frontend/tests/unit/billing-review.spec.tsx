import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BillingReviewScreen } from '../../src/app/(internal)/billing-review/billing-review-screen';
import en from '../../src/locales/en/common.json';

let locale = 'en';
jest.mock('next-intl', () => ({
  useLocale: () => locale,
  useTranslations: () => {
    const t = ((key: string, values?: Record<string, string>) => {
      const message = key.startsWith('messages.')
        ? en.billingReview.messages[key.slice('messages.'.length) as keyof typeof en.billingReview.messages]
        : undefined;
      return `${message ?? key}${values ? ` ${Object.values(values).join(' ')}` : ''}`;
    }) as ((
      key: string,
      values?: Record<string, string>,
    ) => string) & { has: (key: string) => boolean };
    t.has = () => true;
    return t;
  },
}));
jest.mock('../../src/components/locale-switcher', () => ({
  LocaleSwitcher: () => <button>locale</button>,
}));
const row = (status = 'PendingReview') => ({
  id: '11111111-1111-4111-8111-111111111111',
  status,
  submittedAt: '2026-10-16T10:00:00.000Z',
  statusHistory: [{ status: 'PendingReview', changedAt: '2026-10-16T10:00:00.000Z' }],
  customerEmail: 'customer@example.test',
  tenantId: '22222222-2222-4222-8222-222222222222',
  planName: 'Growth',
  billingPeriodStart: '2026-10-01',
  billingPeriodEnd: '2026-10-31',
  amount: 250,
  currency: 'AED',
  bankReference: 'BANK-REF',
  proofDownloadUrl: 'https://storage.test/proof?signature=private',
});
const response = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

beforeEach(() => {
  locale = 'en';
  process.env.NEXT_PUBLIC_PAYMENT_PROOF_ORIGINS = 'https://storage.test';
  jest.restoreAllMocks();
});
test('renders all contracted fields, safe proof semantics and text status', async () => {
  global.fetch = jest.fn(async () => response([row()])) as jest.Mock;
  render(<BillingReviewScreen />);
  expect(await screen.findAllByText('customer@example.test')).toHaveLength(2);
  for (const value of ['22222222-2222-4222-8222-222222222222', 'Growth', 'BANK-REF'])
    expect(screen.getByText(value)).toBeInTheDocument();
  const proof = screen.getByRole('link', { name: 'actions.proof' });
  expect(proof).toHaveAttribute('target', '_blank');
  expect(proof).toHaveAttribute('rel', 'noopener noreferrer');
  expect(proof).toHaveAttribute('referrerpolicy', 'no-referrer');
  expect(screen.getAllByText('status.PendingReview').length).toBeGreaterThan(0);
});
test('MoreInfoRequested is visible but non-actionable until customer resubmission', async () => {
  global.fetch = jest.fn(async () => response([row('MoreInfoRequested')])) as jest.Mock;
  render(<BillingReviewScreen />);
  expect(await screen.findByText(en.billingReview.messages.awaitingCustomer)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'actions.approve' })).not.toBeInTheDocument();
});
test('reject requires a reason and sends one exact request even on repeated confirmation', async () => {
  const fetcher = jest
    .fn()
    .mockResolvedValueOnce(response([row()]))
    .mockResolvedValueOnce(response({ status: 'Rejected' }))
    .mockResolvedValueOnce(response([]));
  global.fetch = fetcher;
  render(<BillingReviewScreen />);
  fireEvent.click(await screen.findByRole('button', { name: 'actions.reject' }));
  fireEvent.click(screen.getByRole('button', { name: 'actions.confirm' }));
  expect(screen.getByRole('alert')).toHaveTextContent('dialog.required');
  fireEvent.change(screen.getByLabelText('dialog.reject.label'), {
    target: { value: '  mismatch  ' },
  });
  const confirm = screen.getByRole('button', { name: 'actions.confirm' });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
  expect(fetcher.mock.calls[1][1]).toMatchObject({
    method: 'POST',
    body: JSON.stringify({ reason: 'mismatch' }),
  });
});
test('unknown outcome never replays and reconciles with a fresh GET', async () => {
  const fetcher = jest
    .fn()
    .mockResolvedValueOnce(response([row()]))
    .mockRejectedValueOnce(new Error('timeout'))
    .mockResolvedValueOnce(response([row()]));
  global.fetch = fetcher;
  render(<BillingReviewScreen />);
  fireEvent.click(await screen.findByRole('button', { name: 'actions.approve' }));
  fireEvent.click(screen.getByRole('button', { name: 'actions.confirm' }));
  expect(await screen.findByText(en.billingReview.messages.unknown)).toBeInTheDocument();
  expect(fetcher.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
});
test('successful decision replaces the queue asynchronously before the next selection', async () => {
  let releaseReplacement!: (value: Response) => void;
  const replacement = new Promise<Response>((resolve) => {
    releaseReplacement = resolve;
  });
  const next = {
    ...row(),
    id: '33333333-3333-4333-8333-333333333333',
    bankReference: 'NEXT-REF',
  };
  const fetcher = jest
    .fn()
    .mockResolvedValueOnce(response([row()]))
    .mockResolvedValueOnce(response({ status: 'Active' }))
    .mockReturnValueOnce(replacement);
  global.fetch = fetcher;
  render(<BillingReviewScreen />);
  fireEvent.click(await screen.findByRole('button', { name: 'actions.approve' }));
  fireEvent.click(screen.getByRole('button', { name: 'actions.confirm' }));
  expect(await screen.findByText(en.billingReview.messages.approved)).toBeInTheDocument();
  expect(screen.getByText('BANK-REF')).toBeInTheDocument();
  releaseReplacement(response([next]));
  await waitFor(() => expect(screen.queryByText('BANK-REF')).not.toBeInTheDocument());
  expect(screen.getByText('NEXT-REF')).toBeInTheDocument();
});
test('malformed-success response is never announced and is reconciled without replay', async () => {
  const fetcher = jest
    .fn()
    .mockResolvedValueOnce(response([row()]))
    .mockResolvedValueOnce(response({ code: 'UNKNOWN_OUTCOME' }, 502))
    .mockResolvedValueOnce(response([row()]));
  global.fetch = fetcher;
  render(<BillingReviewScreen />);
  fireEvent.click(await screen.findByRole('button', { name: 'actions.approve' }));
  fireEvent.click(screen.getByRole('button', { name: 'actions.confirm' }));
  expect(await screen.findByText(en.billingReview.messages.unknown)).toBeInTheDocument();
  expect(screen.queryByText(en.billingReview.messages.approved)).not.toBeInTheDocument();
  expect(fetcher.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
});
test('dialog traps forward/backward focus, makes background inert, Escape restores trigger focus', async () => {
  global.fetch = jest.fn(async () => response([row()])) as jest.Mock;
  render(<BillingReviewScreen />);
  const trigger = await screen.findByRole('button', { name: 'actions.reject' });
  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog');
  const note = screen.getByLabelText('dialog.reject.label');
  const confirm = screen.getByRole('button', { name: 'actions.confirm' });
  const cancel = screen.getByRole('button', { name: 'actions.cancel' });
  const background = screen.getByTestId('billing-review-background');
  expect(background).toHaveAttribute('inert');
  expect(background.querySelector('button')).toBeInstanceOf(HTMLButtonElement);
  expect(within(background).queryByRole('button')).not.toBeInTheDocument();
  cancel.focus();
  fireEvent.keyDown(dialog, { key: 'Tab' });
  expect(note).toHaveFocus();
  note.focus();
  fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
  expect(cancel).toHaveFocus();
  fireEvent.keyDown(dialog, { key: 'Escape' });
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(confirm).not.toBeInTheDocument();
});
test('approve dialog cycles between its two controls in both directions', async () => {
  global.fetch = jest.fn(async () => response([row()])) as jest.Mock;
  render(<BillingReviewScreen />);
  fireEvent.click(await screen.findByRole('button', { name: 'actions.approve' }));
  const dialog = screen.getByRole('dialog');
  const confirm = screen.getByRole('button', { name: 'actions.confirm' });
  const cancel = screen.getByRole('button', { name: 'actions.cancel' });
  cancel.focus();
  fireEvent.keyDown(dialog, { key: 'Tab' });
  expect(confirm).toHaveFocus();
  fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
  expect(cancel).toHaveFocus();
});
test('Arabic surface sets RTL direction', async () => {
  locale = 'ar';
  global.fetch = jest.fn(async () => response([])) as jest.Mock;
  render(<BillingReviewScreen />);
  expect(await screen.findByText('states.empty')).toBeInTheDocument();
  expect(screen.getByTestId('billing-review')).toHaveAttribute('dir', 'rtl');
});
