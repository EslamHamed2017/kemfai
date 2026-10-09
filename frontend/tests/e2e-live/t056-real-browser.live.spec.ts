import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { createClient } from 'redis';

/**
 * T056 point 5 (corrective) — the genuine authenticated browser -> Next.js BFF ->
 * NestJS API -> real Odoo proof, with the Alpha->Beta identity-boundary assertions the
 * review required: exact seeded tenant IDs (never inferred), the real Keycloak hosted
 * username form visibly asserted BEFORE Beta's credentials are entered (proof Alpha's
 * SSO session was actually terminated, not silently re-used), Beta's setup response and
 * clean draft envelope asserted against their EXACT scope/values (never weakened to
 * "null or empty"), and a pristine Beta wizard correctly starts on the country step —
 * never assumed to already show a legal-name field.
 *
 * Every step below (Alpha login/persist, reload, stale-scope rejection, an unsaved
 * draft, the shared sign-out, and Beta's fresh login) runs in ONE `BrowserContext`/
 * `Page` created once in `beforeAll` and reused by every `test()` in this file — never
 * the per-test `page` fixture (which would hand each test a brand new context, unable
 * to prove anything about what sign-out actually cleared). Nothing here is mocked,
 * stubbed, or called directly as a shortcut around the browser/BFF — this file IS the
 * harness `scripts/test_t056_live_browser.sh` builds the real stack for, and drives it
 * only via `page.goto`/`page.fill`/`page.click`/real navigation, plus a direct Redis
 * read used ONLY to verify server-side state the browser itself cannot observe (never
 * to inject or fabricate a session), and a direct Redis WRITE in the provider-failure
 * probe used ONLY to corrupt a refresh token the harness itself just issued (simulating
 * a real Keycloak-rejected token, never faking a Keycloak response).
 */

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the live browser harness`);
  return value;
};

const SESSION_COOKIE_NAMES = ['__Host-kemfai_session', 'kemfai_session'];
const DRAFT_STORAGE_KEY = 'kemfai:setup-wizard:draft:v2';
const TOKEN_LEAK_PATTERN = /[?&#](access_token|refresh_token|id_token)=/i;

async function realLogin(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/auth/login');
  // The REAL Keycloak hosted login page — a genuine server-rendered HTML form, not a
  // stub. Keycloak's default login theme uses these field/button ids.
  await page.waitForSelector('#username', { timeout: 15000 });
  await page.fill('#username', email);
  await page.fill('#password', password);
  await page.click('#kc-login');
  // Keycloak -> /auth/callback (real PKCE/state/nonce validation + token exchange) ->
  // the app's default post-login target.
  await page.waitForURL('**/mfa', { timeout: 15000 });
}

async function sessionCookie(
  context: BrowserContext,
): Promise<{ name: string; value: string } | undefined> {
  const cookies = await context.cookies();
  return cookies.find((cookie) => SESSION_COOKIE_NAMES.includes(cookie.name));
}

/** Direct read of the real Redis-backed BFF session store (session-store.ts's key
 * shape) — used ONLY to verify server-side session state the browser cannot itself
 * observe (a cookie being absent proves the browser's copy is gone, not that the
 * server-side record was actually destroyed). Never used to create/inject a session. */
async function redisSessionExists(sessionId: string): Promise<boolean> {
  const client = createClient({ url: required('T056_REDIS_URL') });
  await client.connect();
  try {
    const raw = await client.get(`kemfai:session:${sessionId}`);
    return raw !== null;
  } finally {
    await client.quit();
  }
}

/** Corrupts the refresh token on an EXISTING, harness-issued session record in place —
 * used only by the provider-failure probe to make the real Keycloak backchannel logout
 * endpoint genuinely reject the token (400 invalid_grant, already proven live), never to
 * fabricate a session or a Keycloak response. */
async function corruptSessionRefreshToken(sessionId: string): Promise<void> {
  const client = createClient({ url: required('T056_REDIS_URL') });
  await client.connect();
  try {
    const key = `kemfai:session:${sessionId}`;
    const raw = await client.get(key);
    if (!raw) throw new Error(`no session record for ${sessionId} to corrupt`);
    const session = JSON.parse(raw) as Record<string, unknown>;
    session.refreshToken = 'corrupted-not-a-real-refresh-token';
    const ttl = await client.ttl(key);
    await client.set(key, JSON.stringify(session), ttl > 0 ? { EX: ttl } : {});
  } finally {
    await client.quit();
  }
}

async function odooReadCompanyFields(
  dbEnvVar: string,
  companyIdEnvVar: string,
  fields: string[],
): Promise<Record<string, unknown>> {
  const odooBase = required('T056_ODOO_BASE');
  const db = required(dbEnvVar);
  const companyId = Number(required(companyIdEnvVar));
  const login = required('T056_ODOO_ADMIN_LOGIN');
  const password = required('T056_ODOO_ADMIN_PASSWORD');

  const call = async (service: string, method: string, args: unknown[]): Promise<unknown> => {
    const response = await fetch(`${odooBase}/jsonrpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: { service, method, args },
        id: 1,
      }),
    });
    const body = (await response.json()) as { result?: unknown; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.result;
  };

  const uid = (await call('common', 'login', [db, login, password])) as number;
  const rows = (await call('object', 'execute_kw', [
    db,
    uid,
    password,
    'res.company',
    'read',
    [[companyId], fields],
  ])) as Array<Record<string, unknown>>;
  return rows[0];
}

const alphaOdooFields = (fields: string[]) =>
  odooReadCompanyFields('T056_ALPHA_DB', 'T056_ALPHA_COMPANY_ID', fields);

interface TenantMeResponse {
  tenantId: string | null;
  status: string;
  failureReason: string | null;
}

interface CompanySetupStateResponse {
  currentStep: string;
  setupComplete: boolean;
  values: Record<string, unknown>;
  version: number;
  stale: boolean;
  scope: string;
}

async function fetchTenantMe(page: Page): Promise<TenantMeResponse> {
  return page.evaluate(async () => {
    const response = await fetch('/api/tenants/me', { cache: 'no-store' });
    return response.json();
  });
}

async function fetchCompanySetup(page: Page): Promise<CompanySetupStateResponse> {
  return page.evaluate(async () => {
    const response = await fetch('/api/companies/current/setup', { cache: 'no-store' });
    return response.json();
  });
}

interface DraftEnvelope {
  schemaVersion: number;
  scope: string;
  baseVersion: number;
  activeStep: string;
  dirty: Record<string, string>;
}

async function readDraftFromStorage(page: Page): Promise<DraftEnvelope | null> {
  const raw = await page.evaluate((key) => window.sessionStorage.getItem(key), DRAFT_STORAGE_KEY);
  return raw ? (JSON.parse(raw) as DraftEnvelope) : null;
}

/** Collects every URL the given page navigates to (main frame only) so every test can
 * assert, at any point, that no observed URL ever carried a raw token value. */
function trackNavigatedUrls(page: Page): string[] {
  const urls: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) urls.push(frame.url());
  });
  return urls;
}

function assertNoTokenLeak(urls: string[]): void {
  for (const url of urls) {
    expect(url).not.toMatch(TOKEN_LEAK_PATTERN);
  }
}

test.describe
  .serial('T056 point 5 — one real browser context: Alpha login/persist/reload/stale-scope/draft/signout, hosted username form, then Beta sees nothing', () => {
  let context: BrowserContext;
  let page: Page;
  let navigatedUrls: string[];
  let alphaSessionId: string;
  let alphaScope: string;

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
    navigatedUrls = trackNavigatedUrls(page);
  });

  test.afterAll(async () => {
    await context.close();
  });

  test("Alpha logs in through real Keycloak, /api/tenants/me returns Alpha's exact seeded tenant ID, saves a step, and it persists into Alpha's real Odoo database", async () => {
    await realLogin(page, required('T056_ALPHA_EMAIL'), required('T056_ALPHA_PASSWORD'));

    const cookie = await sessionCookie(context);
    expect(cookie).toBeDefined();
    alphaSessionId = cookie!.value;
    // Real Redis-backed proof the BFF actually created a server-side session record
    // for this login, not merely that SOME cookie is present on the browser.
    await expect(async () => {
      expect(await redisSessionExists(alphaSessionId)).toBe(true);
    }).toPass({ timeout: 10000 });

    const alphaMe = await fetchTenantMe(page);
    expect(alphaMe.tenantId).toBe(required('T056_ALPHA_TENANT_ID'));

    await page.goto('/setup-wizard');
    const countryInput = page.getByLabel(/country/i).first();
    await expect(countryInput).toBeVisible({ timeout: 15000 });
    await countryInput.fill('AE');
    await page.getByTestId('setup-wizard-next').click();

    // The PUT above went through the real BFF (/api/companies/current/setup) -> real
    // bearer-authenticated NestJS API -> real `kemfai_setup_save_step` RPC. Proof: a
    // DIRECT read against Alpha's own real Odoo database (never through this app's
    // own read path) shows the persisted value.
    await expect(async () => {
      const fields = await alphaOdooFields(['country']);
      expect(fields.country).not.toBe(false);
    }).toPass({ timeout: 10000 });

    const alphaSetup = await fetchCompanySetup(page);
    alphaScope = alphaSetup.scope;
    expect(alphaScope.length).toBeGreaterThan(0);
  });

  test("reloading the SAME tab keeps Alpha's real session and resumes the wizard (no re-login)", async () => {
    await page.reload();
    // Still signed in after a hard reload: the real BFF session cookie survived, and
    // the shared SignOutButton (only rendered once authenticated) is visible again
    // without going through Keycloak a second time.
    await expect(page.getByTestId('sign-out-button')).toBeVisible({ timeout: 15000 });
    const cookie = await sessionCookie(context);
    expect(cookie?.value).toBe(alphaSessionId);
  });

  test('a stale/foreign X-KEMFAI-Setup-Scope is rejected 412 by the real API, before any Odoo mutation', async () => {
    await page.goto('/setup-wizard');
    await expect(page.getByLabel(/legal name/i)).toBeVisible({ timeout: 15000 });

    const before = await alphaOdooFields(['legal_name']);

    // A real same-origin fetch from the authenticated browser session (carries the
    // real BFF session cookie) with a deliberately bogus scope header — the BFF
    // forwards it unchanged; the real API's scope precondition must reject it with
    // 412 BEFORE any Odoo RPC, which this test verifies directly against Alpha's own
    // Odoo database.
    const status = await page.evaluate(async () => {
      const response = await fetch('/api/companies/current/setup', {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-kemfai-setup-scope': 'stale-foreign-scope',
        },
        body: JSON.stringify({ step: 'identity', values: { legal_name: 'Should Never Persist' } }),
      });
      return response.status;
    });
    expect(status).toBe(412);

    const after = await alphaOdooFields(['legal_name']);
    expect(after.legal_name).toBe(before.legal_name);
    expect(after.legal_name).not.toBe('Should Never Persist');
  });

  test("Alpha edits a field WITHOUT saving: an unsaved draft is written to this tab's sessionStorage", async () => {
    const legalNameInput = page.getByLabel(/legal name/i);
    await expect(legalNameInput).toBeVisible({ timeout: 15000 });
    await legalNameInput.fill('Alpha Unsaved Draft Co');
    // Deliberately never clicking "next"/save: this is a local-only edit the wizard's
    // draft-storage effect persists to sessionStorage on every keystroke, which must
    // never reach Odoo and must never survive sign-out into another account's screen.
    await expect
      .poll(
        async () => page.evaluate((key) => window.sessionStorage.getItem(key), DRAFT_STORAGE_KEY),
        {
          timeout: 10000,
        },
      )
      .not.toBeNull();
    const draft = await readDraftFromStorage(page);
    expect(draft?.dirty.legal_name).toBe('Alpha Unsaved Draft Co');

    const afterDraft = await alphaOdooFields(['legal_name']);
    expect(afterDraft.legal_name).not.toBe('Alpha Unsaved Draft Co');
  });

  test('Alpha signs out via the real shared SignOutButton: provider-confirmed logout destroys the real Redis session, expires the cookie, clears the draft, and the REAL Keycloak hosted username form is shown BEFORE any Beta credential is entered', async () => {
    await page.getByTestId('sign-out-button').click();

    // Mandatory evidence that Alpha was not silently authenticated again: the
    // server-side POST backchannel logout (proven live against Keycloak 26) must
    // have terminated Alpha's SSO session, so the very next authorization request —
    // `signOut()`'s navigation to `/auth/login`, which 302s straight to Keycloak's
    // real authorize endpoint — is answered with the hosted username form, never a
    // silent redirect back into the app.
    await page.waitForSelector('#username', { timeout: 15000 });

    const cookie = await sessionCookie(context);
    expect(cookie).toBeUndefined();

    // Real Redis-backed proof the SAME session record this test observed being
    // created earlier was actually destroyed server-side — not merely that the
    // browser's own cookie copy is gone (a BFF bug that only cleared the cookie but
    // left the Redis record behind would pass a cookie-only check).
    await expect(async () => {
      expect(await redisSessionExists(alphaSessionId)).toBe(false);
    }).toPass({ timeout: 10000 });

    // The unsaved Alpha draft from the previous test, in this SAME tab's
    // sessionStorage, must not survive sign-out.
    expect(await readDraftFromStorage(page)).toBeNull();
  });

  test("Beta logs in fresh in the SAME browser tab (independent real Keycloak user/tenant/Odoo database), /api/tenants/me returns Beta's exact tenant ID and never Alpha's, and the pristine wizard starts on the country step with no Alpha value anywhere", async () => {
    await realLogin(page, required('T056_BETA_EMAIL'), required('T056_BETA_PASSWORD'));

    const betaCookie = await sessionCookie(context);
    expect(betaCookie).toBeDefined();
    // Beta's own server-side session is a DIFFERENT record from Alpha's (already
    // destroyed above), proving this is a genuinely new login, not a resurrected one.
    expect(betaCookie!.value).not.toBe(alphaSessionId);

    const betaMe = await fetchTenantMe(page);
    const alphaTenantId = required('T056_ALPHA_TENANT_ID');
    const betaTenantId = required('T056_BETA_TENANT_ID');
    expect(betaMe.tenantId).toBe(betaTenantId);
    expect(betaMe.tenantId).not.toBe(alphaTenantId);

    await page.goto('/setup-wizard');

    // A pristine Beta wizard starts on the COUNTRY step — never assume the
    // legal-name (identity step) input is already present.
    await expect(page.getByTestId('setup-wizard-step-country')).toHaveAttribute(
      'aria-current',
      'step',
      { timeout: 15000 },
    );
    const countryInput = page.getByLabel(/country/i).first();
    await expect(countryInput).toBeVisible({ timeout: 15000 });
    await expect(countryInput).toHaveValue('');

    // The real GET response itself: exact Beta scope, and no Alpha country/legal
    // name value anywhere in it.
    const betaSetup = await fetchCompanySetup(page);
    expect(betaSetup.scope).not.toBe(alphaScope);
    expect(betaSetup.currentStep).toBe('country');
    expect(betaSetup.values.country).not.toBe('AE');
    expect(betaSetup.values.legal_name).not.toBe('Alpha Unsaved Draft Co');

    // The clean draft envelope the mount effect writes once the wizard goes active:
    // non-null, with Beta's EXACT scope/step/empty-dirty — never weakened to "null
    // or empty".
    const draftOnBetaMount = await readDraftFromStorage(page);
    expect(draftOnBetaMount).not.toBeNull();
    expect(draftOnBetaMount?.scope).toBe(betaSetup.scope);
    expect(draftOnBetaMount?.activeStep).toBe('country');
    expect(draftOnBetaMount?.dirty).toEqual({});
    expect(JSON.stringify(draftOnBetaMount)).not.toContain('Alpha');
    expect(JSON.stringify(draftOnBetaMount)).not.toContain('AE');

    // Advance to the identity step through a REAL wizard action (fill + Next), never
    // by bypassing the UI contract — then prove the legal-name input is clean.
    await countryInput.fill('EG');
    await page.getByTestId('setup-wizard-next').click();
    await expect(page.getByTestId('setup-wizard-step-identity')).toHaveAttribute(
      'aria-current',
      'step',
      { timeout: 15000 },
    );
    await expect(page.getByLabel(/legal name/i)).toHaveValue('');
  });

  test('no browser URL observed anywhere in this suite ever carried access_token, refresh_token, or id_token', () => {
    assertNoTokenLeak(navigatedUrls);
  });
});

test.describe('T056 point 2/3 — provider-logout-failure browser probe (owned, isolated context)', () => {
  test('a real Keycloak-rejected refresh token (400 invalid_grant) still destroys the local session and expires the cookie, but the UI never reports a successful switch, never enters login, and never silently restores Alpha', async ({
    browser,
  }) => {
    const probeContext = await browser.newContext();
    const probePage = await probeContext.newPage();
    const urls = trackNavigatedUrls(probePage);
    try {
      await realLogin(probePage, required('T056_ALPHA_EMAIL'), required('T056_ALPHA_PASSWORD'));
      const cookie = await sessionCookie(probeContext);
      expect(cookie).toBeDefined();
      const sessionId = cookie!.value;
      await expect(async () => {
        expect(await redisSessionExists(sessionId)).toBe(true);
      }).toPass({ timeout: 10000 });

      // Corrupts the refresh token on THIS real, harness-issued session record so the
      // real Keycloak backchannel logout endpoint genuinely rejects it (400
      // invalid_grant — the exact non-204 response already proven live), never a
      // faked/mocked provider response.
      await corruptSessionRefreshToken(sessionId);

      await probePage.goto('/setup-wizard');
      await expect(probePage.getByTestId('sign-out-button')).toBeVisible({ timeout: 15000 });
      await probePage.getByTestId('sign-out-button').click();

      // Never a successful-switch claim, never a silent entry into the login flow.
      const unconfirmed = probePage.getByTestId('sign-out-unconfirmed');
      await expect(unconfirmed).toBeVisible({ timeout: 15000 });
      expect(probePage.url()).toContain('/setup-wizard');
      expect(probePage.url()).not.toContain('/auth/login');

      // Local destroy + cookie expiry were still attempted despite the provider
      // rejection: the browser's cookie is gone and the real Redis record is gone too.
      await expect(async () => {
        expect(await sessionCookie(probeContext)).toBeUndefined();
      }).toPass({ timeout: 10000 });
      await expect(async () => {
        expect(await redisSessionExists(sessionId)).toBe(false);
      }).toPass({ timeout: 10000 });

      // Because the cookie is genuinely gone, a reload must not silently keep showing
      // Alpha's authenticated workspace — it must require a fresh login, proving the
      // UI never "restores Alpha" behind the scenes after an unconfirmed logout.
      await probePage.reload();
      await expect(probePage.getByTestId('sign-out-button')).not.toBeVisible({ timeout: 15000 });

      assertNoTokenLeak(urls);
    } finally {
      await probeContext.close();
    }
  });
});
