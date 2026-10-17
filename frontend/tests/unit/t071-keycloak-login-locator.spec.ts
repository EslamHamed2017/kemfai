import {
  isOwnedKeycloakLoginUrl,
  KEYCLOAK_PASSWORD_SELECTOR,
} from '../e2e-live/t071-keycloak-login-locators';

describe('T071 real Keycloak password locator', () => {
  it('selects only the proven password input when the toggle and decorated label are present', () => {
    document.body.innerHTML = `
      <label for="password">
        Password
        <span aria-hidden="true"> *</span>
      </label>
      <div class="password-control">
        <input id="password" name="password" type="password" autocomplete="current-password">
        <button type="button" aria-label="Show password" aria-controls="password">Show</button>
      </div>
    `;

    const matches = document.querySelectorAll(KEYCLOAK_PASSWORD_SELECTOR);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBeInstanceOf(HTMLInputElement);
    expect(matches[0]).toMatchObject({ id: 'password', name: 'password', type: 'password' });
    expect(matches[0]).not.toBe(document.querySelector('[aria-label="Show password"]'));
  });

  it('accepts only the exact owned authorization endpoint and callback contract', () => {
    const issuer = 'http://127.0.0.1:5100/realms/kemfai-internal-owned';
    const callback = 'http://127.0.0.1:3100/internal-auth/callback';
    const valid = new URL(`${issuer}/protocol/openid-connect/auth`);
    valid.search = new URLSearchParams({
      client_id: 'kemfai-internal-ui',
      redirect_uri: callback,
      response_type: 'code',
      scope: 'openid',
      state: 'state-value',
      nonce: 'nonce-value',
      code_challenge: 'challenge-value',
      code_challenge_method: 'S256',
    }).toString();

    expect(isOwnedKeycloakLoginUrl(valid.toString(), issuer, callback)).toBe(true);
    expect(isOwnedKeycloakLoginUrl(valid.toString().replace('5100', '5101'), issuer, callback)).toBe(false);
    valid.searchParams.set('redirect_uri', 'http://127.0.0.1:9999/internal-auth/callback');
    expect(isOwnedKeycloakLoginUrl(valid.toString(), issuer, callback)).toBe(false);
  });
});
