import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProvisioningScreen } from '../../src/app/(onboarding)/provisioning/provisioning-screen';
import { parseRetryStatus } from '../../src/lib/auth/provisioning-status';
import en from '../../src/locales/en/common.json';

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

const jsonResponse = (body: unknown, status: number) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/**
 * T056 point 4 (corrective, round 10) — the production BFF (provisioning-bff.ts)
 * deletes the upstream 202 body unless it runs the raw body through the real
 * `parseRetryStatus` validator and forwards only the safe, narrowed result. These
 * tests drive the screen through that EXACT validator with a raw, upstream-shaped
 * body (not the already-correct final shape the screen expects) — mirroring what
 * `forward()` in provisioning-bff.ts does for a POST 202 — so a regression in the
 * shared validator (e.g. forwarding Failed, or dropping the body again) fails here
 * too, not just in provisioning-bff.spec.ts. jsdom has no global Request/Response,
 * so NextResponse itself can't run in this file; that plumbing (CSRF, redaction,
 * status codes, headers) is covered separately by the node-environment
 * provisioning-bff.spec.ts.
 */
describe('ProvisioningScreen retry 202 body handling (T056 point 4)', () => {
  /** Mirrors forward()'s POST branch exactly: validate the raw upstream body with
   * the real parseRetryStatus, 202+safe-body on success, 502+generic message on
   * anything malformed or disallowed — never hand-fabricate the final shape. */
  function retryResponseFromRawUpstream(rawUpstreamBody: unknown) {
    const safe = parseRetryStatus(rawUpstreamBody);
    return safe
      ? jsonResponse(safe, 202)
      : jsonResponse({ message: 'Provisioning unavailable' }, 502);
  }

  function mockMeThenRetry(rawUpstreamRetryBody: unknown, meStatusAfterRetry: string | null = null) {
    let meStatus = 'Failed';
    (global.fetch as unknown) = jest.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/provisioning-retry')) {
        if (meStatusAfterRetry) meStatus = meStatusAfterRetry;
        return retryResponseFromRawUpstream(rawUpstreamRetryBody);
      }
      if (String(url).includes('/tenants/me')) {
        return jsonResponse(
          {
            tenantId: 't-1',
            status: meStatus,
            failureReason: meStatus === 'Failed' ? 'boom' : null,
          },
          200,
        );
      }
      throw new Error(`unexpected fetch ${url} ${init?.method ?? 'GET'}`);
    });
  }

  it('applies Ready (not Pending) when the raw upstream body says Ready — the exceptional repair case', async () => {
    mockMeThenRetry({ tenantId: 't-1', status: 'Ready', failureReason: null }, 'Ready');
    render(<ProvisioningScreen supportEmail={null} />);
    await waitFor(() => expect(screen.getByTestId('provisioning-retry')).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByTestId('provisioning-retry'));
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByTestId('provisioning-ready')).toBeInTheDocument());
  });

  it('applies Pending when the raw upstream body says Pending — the ordinary Failed-retry case', async () => {
    mockMeThenRetry({ tenantId: 't-1', status: 'Pending', failureReason: null }, 'Pending');
    render(<ProvisioningScreen supportEmail={null} />);
    await waitFor(() => expect(screen.getByTestId('provisioning-retry')).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByTestId('provisioning-retry'));
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByTestId('provisioning-loading')).toBeInTheDocument());
  });

  it('falls back to the existing service-error state when the raw upstream body is missing status', async () => {
    mockMeThenRetry({ tenantId: 't-1' }); // missing `status`
    render(<ProvisioningScreen supportEmail={null} />);
    await waitFor(() => expect(screen.getByTestId('provisioning-retry')).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByTestId('provisioning-retry'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('provisioning-failure')).toBeInTheDocument();
    expect(screen.queryByTestId('provisioning-loading')).not.toBeInTheDocument();
    expect(screen.queryByTestId('provisioning-ready')).not.toBeInTheDocument();
  });

  it('falls back to the existing service-error state when the raw upstream body says Failed (disallowed for a retry 202)', async () => {
    mockMeThenRetry({ tenantId: 't-1', status: 'Failed', failureReason: 'private diagnostic' });
    render(<ProvisioningScreen supportEmail={null} />);
    await waitFor(() => expect(screen.getByTestId('provisioning-retry')).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByTestId('provisioning-retry'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('provisioning-failure')).toBeInTheDocument();
    expect(screen.queryByTestId('provisioning-loading')).not.toBeInTheDocument();
    expect(screen.queryByTestId('provisioning-ready')).not.toBeInTheDocument();
  });

  it('falls back to the service-error state when the 202 body is not JSON-parseable', async () => {
    // Not reachable from a conforming production BFF (its own upstream.json() parse
    // failure is caught into a 502 before this ever reaches the screen) — this directly
    // stubs the browser-fetch response to cover the screen's own defensive catch around
    // response.json(), a concern distinct from the shared validator exercised above.
    let meStatus = 'Failed';
    (global.fetch as unknown) = jest.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/provisioning-retry')) {
        return {
          ok: true,
          status: 202,
          json: async () => {
            throw new SyntaxError('bad json');
          },
        };
      }
      if (String(url).includes('/tenants/me')) {
        return jsonResponse(
          { tenantId: 't-1', status: meStatus, failureReason: meStatus === 'Failed' ? 'boom' : null },
          200,
        );
      }
      throw new Error(`unexpected fetch ${url} ${init?.method ?? 'GET'}`);
    });
    render(<ProvisioningScreen supportEmail={null} />);
    await waitFor(() => expect(screen.getByTestId('provisioning-retry')).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByTestId('provisioning-retry'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('provisioning-failure')).toBeInTheDocument();
  });
});
