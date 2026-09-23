/**
 * @jest-environment node
 *
 * Route handlers use the Web Fetch API's Request/Response directly (Node's global
 * implementation), not jsdom's — jsdom does not implement them.
 */
import { GET as loginGET } from '../../src/app/login/route';
import { GET as resetPasswordGET } from '../../src/app/reset-password/route';
import { localeCookieName } from '../../src/lib/i18n/config';
import en from '../../src/locales/en/common.json';
import ar from '../../src/locales/ar/common.json';

function requestWithLocale(locale?: string): Request {
  const headers = new Headers();
  if (locale) {
    headers.set('cookie', `${localeCookieName}=${locale}`);
  }
  return new Request('https://app.kemfai.example/login', { headers });
}

describe('/login and /reset-password route handlers (T037 duplicate-email recovery actions)', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.KEYCLOAK_CUSTOMERS_LOGIN_URL;
    delete process.env.KEYCLOAK_CUSTOMERS_RESET_PASSWORD_URL;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('/login redirects to the deployment-configured Keycloak login URL when set', async () => {
    process.env.KEYCLOAK_CUSTOMERS_LOGIN_URL = 'https://auth.kemfai.example/realms/kemfai-customers/login';

    const response = await loginGET(requestWithLocale());

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://auth.kemfai.example/realms/kemfai-customers/login',
    );
  });

  it('/reset-password redirects to the deployment-configured Keycloak reset URL when set', async () => {
    process.env.KEYCLOAK_CUSTOMERS_RESET_PASSWORD_URL =
      'https://auth.kemfai.example/realms/kemfai-customers/reset-password';

    const response = await resetPasswordGET(requestWithLocale());

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://auth.kemfai.example/realms/kemfai-customers/reset-password',
    );
  });

  it('/login shows a localized temporarily-unavailable message (EN) instead of a dead link when unconfigured', async () => {
    const response = await loginGET(requestWithLocale('en'));

    expect(response.status).toBe(503);
    expect(response.headers.get('location')).toBeNull();
    const body = await response.text();
    expect(body).toContain(en.signup.duplicateEmail.recoveryUnavailable);
  });

  it('/reset-password shows a localized temporarily-unavailable message (AR) instead of a dead link when unconfigured', async () => {
    const response = await resetPasswordGET(requestWithLocale('ar'));

    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain(ar.signup.duplicateEmail.recoveryUnavailable);
    expect(body).toContain('dir="rtl"');
  });

  it('defaults to EN when no locale cookie is present', async () => {
    const response = await loginGET(requestWithLocale());

    const body = await response.text();
    expect(body).toContain(en.signup.duplicateEmail.recoveryUnavailable);
    expect(body).toContain('dir="ltr"');
  });
});
