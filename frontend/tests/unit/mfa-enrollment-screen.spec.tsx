import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MfaEnrollmentScreen } from '../../src/app/(auth)/mfa/mfa-enrollment-screen';
import en from '../../src/locales/en/common.json';
import ar from '../../src/locales/ar/common.json';

const push = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
jest.mock('next-intl', () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`.split('.')
    .reduce<unknown>((value, part) => (value as Record<string, unknown>)[part], en),
}));

describe('MFA enrollment screen (T039)', () => {
  beforeEach(() => { push.mockReset(); global.fetch = jest.fn(); });

  it('is optional, semantic, and keyboard-operable', () => {
    render(<MfaEnrollmentScreen />);
    expect(screen.getByRole('heading', { name: en.mfa.title })).toBeInTheDocument();
    expect(screen.getByText(en.mfa.optional)).toBeInTheDocument();
    const skip = screen.getByRole('button', { name: en.mfa.skip });
    skip.focus();
    fireEvent.keyDown(skip, { key: 'Enter' });
    fireEvent.click(skip);
    expect(push).toHaveBeenCalledWith('/provisioning');
  });

  it('shows hosted setup and confirms active MFA through the authenticated BFF', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    render(<MfaEnrollmentScreen />);
    fireEvent.click(screen.getByRole('button', { name: en.mfa.enable }));
    await screen.findByRole('heading', { name: en.mfa.setup.title });
    fireEvent.click(screen.getByRole('button', { name: en.mfa.confirm }));
    await screen.findByRole('heading', { name: en.mfa.complete.title });
    expect(global.fetch).toHaveBeenNthCalledWith(1, '/api/accounts/mfa/enroll', { method: 'POST' });
    expect(global.fetch).toHaveBeenNthCalledWith(2, '/api/accounts/mfa/confirm', { method: 'POST' });
  });

  it('renders an actionable non-blocking error state', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 503 });
    render(<MfaEnrollmentScreen />);
    fireEvent.click(screen.getByRole('button', { name: en.mfa.enable }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(en.mfa.error));
    expect(screen.getByRole('button', { name: en.mfa.skip })).toBeEnabled();
  });

  it('restores the confirm step after returning from hosted Keycloak setup', () => {
    render(<MfaEnrollmentScreen returnedFromSetup />);
    expect(screen.getByRole('heading', { name: en.mfa.setup.title })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.mfa.confirm })).toBeEnabled();
  });

  it('has a complete Arabic catalog for the RTL screen', () => {
    expect(ar.mfa.title).toBeTruthy();
    expect(ar.mfa.optional).toBeTruthy();
    expect(ar.mfa.setup.open).toBeTruthy();
    expect(ar.mfa.complete.title).toBeTruthy();
  });
});
