import { fireEvent, render, screen } from '@testing-library/react';

import { SignupForm } from '../../src/app/(auth)/signup/signup-form';
import { PLAN_NO_LONGER_AVAILABLE_MESSAGE } from '../../src/app/(auth)/signup/signup-error';
import en from '../../src/locales/en/common.json';
import ar from '../../src/locales/ar/common.json';

let locale = 'en';
const postMock = jest.fn();

jest.mock('../../src/lib/api-client', () => ({
  getBrowserApiClient: () => ({ POST: postMock }),
}));

jest.mock('next-intl', () => ({
  useLocale: () => locale,
  useTranslations:
    (namespace: 'signup') =>
    (key: string, values?: Record<string, string>): string => {
      const messages = locale === 'ar' ? ar : en;
      const raw = `${namespace}.${key}`
        .split('.')
        .reduce<unknown>((acc, segment) => (acc as Record<string, unknown>)[segment], messages);

      if (typeof raw !== 'string') {
        throw new Error(`Missing translation for ${namespace}.${key}`);
      }

      return Object.entries(values ?? {}).reduce(
        (copy, [name, value]) => copy.replace(`{${name}}`, value),
        raw,
      );
    },
}));

function fillAndSubmit(overrides: { email?: string; password?: string } = {}) {
  fireEvent.change(screen.getByLabelText(en.signup.emailLabel), {
    target: { value: overrides.email ?? 'owner@example.com' },
  });
  fireEvent.change(screen.getByLabelText(en.signup.passwordLabel), {
    target: { value: overrides.password ?? 'a-strong-password' },
  });
  fireEvent.click(screen.getByLabelText(en.signup.acceptedTermsLabel));
  fireEvent.click(screen.getByRole('button', { name: en.signup.submit }));
}

describe('SignupForm (T037)', () => {
  beforeEach(() => {
    locale = 'en';
    postMock.mockReset();
  });

  it('creates the account and shows the check-your-email confirmation (Acceptance Scenario 1.2)', async () => {
    postMock.mockResolvedValueOnce({ error: undefined, response: { status: 201 } });

    render(<SignupForm planId="11111111-1111-1111-1111-111111111111" billingCycle="monthly" />);
    fillAndSubmit({ email: 'owner@example.com' });

    expect(
      await screen.findByRole('heading', { name: en.signup.success.title }),
    ).toBeInTheDocument();
    expect(screen.getByText('We sent a verification link to owner@example.com. Verify your email to continue setting up your workspace.')).toBeInTheDocument();
    expect(postMock).toHaveBeenCalledWith('/accounts/signup', {
      body: {
        email: 'owner@example.com',
        password: 'a-strong-password',
        planId: '11111111-1111-1111-1111-111111111111',
        billingCycle: 'monthly',
        acceptedTerms: true,
      },
    });
  });

  it('shows a distinct, localized error for a server-returned malformed email (422)', async () => {
    postMock.mockResolvedValueOnce({
      error: { statusCode: 422, message: ['email must be a well-formed email address'] },
      response: { status: 422 },
    });

    render(<SignupForm planId="plan-1" billingCycle="monthly" />);
    fillAndSubmit();

    expect(await screen.findByRole('alert')).toHaveTextContent(en.signup.errors.malformedEmail);
  });

  it('shows a distinct, localized error for a server-returned weak password (422)', async () => {
    postMock.mockResolvedValueOnce({
      error: { statusCode: 422, message: ['password must be at least 10 characters'] },
      response: { status: 422 },
    });

    render(<SignupForm planId="plan-1" billingCycle="monthly" />);
    fillAndSubmit();

    expect(await screen.findByRole('alert')).toHaveTextContent(en.signup.errors.weakPassword);
  });

  it('shows a distinct, localized plan-unavailable error with a /plans link for a stale-plan 422', async () => {
    postMock.mockResolvedValueOnce({
      error: { statusCode: 422, message: PLAN_NO_LONGER_AVAILABLE_MESSAGE },
      response: { status: 422 },
    });

    render(<SignupForm planId="plan-1" billingCycle="monthly" />);
    fillAndSubmit();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(en.signup.planUnavailable.message);
    expect(screen.getByRole('link', { name: en.signup.planUnavailable.link })).toHaveAttribute(
      'href',
      '/plans',
    );
  });

  it('shows the generic validation error — never plan-unavailable — for an unmatched 422', async () => {
    postMock.mockResolvedValueOnce({
      error: { statusCode: 422, message: ['acceptedTerms must be true'] },
      response: { status: 422 },
    });

    render(<SignupForm planId="plan-1" billingCycle="monthly" />);
    fillAndSubmit();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(en.signup.errors.validation);
    expect(screen.queryByText(en.signup.planUnavailable.message)).not.toBeInTheDocument();
  });

  it('shows the duplicate-email recovery state with two keyboard-accessible actions for a 409', async () => {
    postMock.mockResolvedValueOnce({
      error: { statusCode: 409, message: 'duplicate' },
      response: { status: 409 },
    });

    render(<SignupForm planId="plan-1" billingCycle="monthly" />);
    fillAndSubmit();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(en.signup.duplicateEmail.message);

    const signIn = screen.getByRole('link', { name: en.signup.duplicateEmail.signIn });
    const resetPassword = screen.getByRole('link', {
      name: en.signup.duplicateEmail.resetPassword,
    });
    expect(signIn).toHaveAttribute('href', '/login');
    expect(resetPassword).toHaveAttribute('href', '/reset-password');

    signIn.focus();
    expect(signIn).toHaveFocus();
    resetPassword.focus();
    expect(resetPassword).toHaveFocus();
  });

  it('renders the Arabic duplicate-email recovery state with the same two actions', async () => {
    locale = 'ar';
    postMock.mockResolvedValueOnce({
      error: { statusCode: 409, message: 'duplicate' },
      response: { status: 409 },
    });

    render(<SignupForm planId="plan-1" billingCycle="monthly" />);
    fireEvent.change(screen.getByLabelText(ar.signup.emailLabel), {
      target: { value: 'owner@example.com' },
    });
    fireEvent.change(screen.getByLabelText(ar.signup.passwordLabel), {
      target: { value: 'a-strong-password' },
    });
    fireEvent.click(screen.getByLabelText(ar.signup.acceptedTermsLabel));
    fireEvent.click(screen.getByRole('button', { name: ar.signup.submit }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(ar.signup.duplicateEmail.message);
    expect(screen.getByRole('link', { name: ar.signup.duplicateEmail.signIn })).toHaveAttribute(
      'href',
      '/login',
    );
    expect(
      screen.getByRole('link', { name: ar.signup.duplicateEmail.resetPassword }),
    ).toHaveAttribute('href', '/reset-password');
  });

  it('shows planUnavailable without calling the API when no plan was carried into the form', async () => {
    render(<SignupForm billingCycle="monthly" />);
    fillAndSubmit();

    expect(await screen.findByRole('alert')).toHaveTextContent(en.signup.planUnavailable.message);
    expect(postMock).not.toHaveBeenCalled();
  });
});
