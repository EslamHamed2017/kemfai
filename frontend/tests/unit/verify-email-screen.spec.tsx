import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { VerifyEmailScreen } from '../../src/app/(auth)/verify/verify-email-screen';
import en from '../../src/locales/en/common.json';

const pushMock = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

const postMock = jest.fn();
jest.mock('../../src/lib/api-client/browser', () => ({
  getBrowserApiClient: () => ({ POST: postMock }),
}));

// next-intl's client entrypoint is ESM-only and drags in a long chain of
// ESM-only formatjs dependencies that next/jest cannot transform out of the
// box (see jest.config.js discussion in T038's PR). Standing up SWC/babel
// transforms for that whole chain is out of scope here, so this exercises the
// real EN message catalog through a minimal stand-in for `useTranslations`.
jest.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations:
    (namespace: string) =>
    (key: string): string => {
      const value = `${namespace}.${key}`
        .split('.')
        .reduce<unknown>((acc, segment) => (acc as Record<string, unknown>)[segment], en);

      if (typeof value !== 'string') {
        throw new Error(`Missing translation for ${namespace}.${key}`);
      }
      return value;
    },
}));

function renderScreen(token?: string) {
  return render(<VerifyEmailScreen token={token} />);
}

async function submitResend(email: string) {
  fireEvent.change(screen.getByLabelText(en.verifyEmail.resend.emailLabel), {
    target: { value: email },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: en.verifyEmail.resend.submit }));
  });
}

describe('VerifyEmailScreen (T038)', () => {
  beforeEach(() => {
    pushMock.mockReset();
    postMock.mockReset();
  });

  it('shows the actionable resend form immediately when the link has no token', () => {
    renderScreen(undefined);

    expect(screen.getByRole('heading', { name: en.verifyEmail.invalid.title })).toBeInTheDocument();
    expect(screen.getByLabelText(en.verifyEmail.resend.emailLabel)).toBeInTheDocument();
  });

  it('consumes a valid token and lets the user continue onboarding (Acceptance Scenario 1.3)', async () => {
    postMock.mockResolvedValueOnce({ error: undefined });

    renderScreen('valid-token');

    expect(screen.getByText(en.verifyEmail.verifying)).toBeInTheDocument();

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: en.verifyEmail.success.title }),
      ).toBeInTheDocument();
    });

    expect(postMock).toHaveBeenCalledWith('/accounts/verify-email', {
      body: { token: 'valid-token' },
    });

    expect(screen.getByRole('link', { name: en.verifyEmail.success.continue })).toHaveAttribute(
      'href',
      '/auth/login?returnTo=%2Fmfa',
    );
  });

  it.each([
    ['invalid', en.verifyEmail.invalid.title, en.verifyEmail.invalid.body],
    ['expired', en.verifyEmail.expired.title, en.verifyEmail.expired.body],
    ['used', en.verifyEmail.used.title, en.verifyEmail.used.body],
  ] as const)(
    'shows a distinct actionable %s-link error from the backend 410 reason',
    async (reason, title, body) => {
      postMock.mockResolvedValueOnce({ error: { reason, message: 'Gone' } });

      renderScreen(`${reason}-token`);

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
      });
      expect(screen.getByText(body)).toBeInTheDocument();
      expect(screen.getByTestId('verify-invalid-message')).toHaveAttribute(
        'data-verification-error',
        reason,
      );
      expect(screen.getByLabelText(en.verifyEmail.resend.emailLabel)).toBeInTheDocument();
    },
  );

  it('treats a superseded or unclassified failure as invalid with the same safe resend action', async () => {
    postMock.mockResolvedValueOnce({ error: { reason: 'superseded', message: 'Gone' } });

    renderScreen('superseded-token');

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: en.verifyEmail.invalid.title }),
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId('verify-invalid-message')).toHaveAttribute(
      'data-verification-error',
      'invalid',
    );
  });

  it('does not stay stuck on "verifying" when the verify request itself throws (network error)', async () => {
    postMock.mockRejectedValueOnce(new Error('network down'));

    renderScreen('any-token');

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: en.verifyEmail.invalid.title }),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText(en.verifyEmail.verifying)).not.toBeInTheDocument();
  });

  it('confirms resend only after the API accepts the request (Acceptance Scenario 1.5)', async () => {
    postMock.mockResolvedValueOnce({ error: undefined });

    renderScreen(undefined);
    await submitResend('owner@example.com');

    await waitFor(() => {
      expect(screen.getByText(en.verifyEmail.resend.confirmation)).toBeInTheDocument();
    });

    expect(postMock).toHaveBeenCalledWith('/accounts/resend-verification', {
      body: { email: 'owner@example.com' },
    });
  });

  it('never claims a resend succeeded when the API responds with an error', async () => {
    postMock.mockResolvedValueOnce({ error: { message: 'boom' } });

    renderScreen(undefined);
    await submitResend('owner@example.com');

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(en.verifyEmail.resend.error);
    });

    expect(screen.queryByText(en.verifyEmail.resend.confirmation)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.verifyEmail.resend.submit })).toBeEnabled();
  });

  it('never claims a resend succeeded when the resend request throws (network error)', async () => {
    postMock.mockRejectedValueOnce(new Error('network down'));

    renderScreen(undefined);
    await submitResend('owner@example.com');

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(en.verifyEmail.resend.error);
    });

    expect(screen.queryByText(en.verifyEmail.resend.confirmation)).not.toBeInTheDocument();
  });
});
