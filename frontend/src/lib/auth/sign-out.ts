'use client';

const SETUP_WIZARD_STORAGE_PREFIX = 'kemfai:setup-wizard:';

export type SignOutOutcome = 'confirmed' | 'unconfirmed';

interface LogoutResponseBody {
  outcome?: unknown;
}

function clearSetupWizardNamespace(): void {
  if (typeof window === 'undefined') return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const key = window.sessionStorage.key(i);
      if (key?.startsWith(SETUP_WIZARD_STORAGE_PREFIX)) keys.push(key);
    }
    for (const key of keys) window.sessionStorage.removeItem(key);
  } catch {
    // Best-effort only: a storage failure must never block signing out.
  }
}

/** Reads `{ outcome }` from the logout BFF's response, returning null for anything that
 * is not our own structured body (a same-origin-rejection error body, a malformed
 * response, or any other shape) — null is intentionally never treated as success. */
async function readOutcome(response: Response): Promise<SignOutOutcome | null> {
  try {
    const body = (await response.json()) as LogoutResponseBody;
    return body.outcome === 'confirmed' || body.outcome === 'unconfirmed' ? body.outcome : null;
  } catch {
    return null;
  }
}

/**
 * T056 point 3 (corrective) — the ONE shared sign-out entry point every authenticated
 * screen calls (wired via `SignOutButton`). Calls only the same-origin logout BFF route
 * (`/api/auth/logout`) — never receives or constructs a provider token/endpoint itself.
 *
 * The `kemfai:setup-wizard:` sessionStorage namespace is cleared ONLY once the BFF's
 * response proves local cleanup was actually attempted (a structured `{ outcome }` body —
 * present whether the provider call was confirmed or not, since the BFF always attempts
 * local session destruction and cookie expiry for any same-origin call it accepts).
 *
 * Navigation to `/auth/login` happens ONLY on a provider-CONFIRMED outcome — the live
 * Keycloak 26 proof backing this is that a confirmed server-side logout terminates the
 * SSO session, so the hosted username form is what the browser sees next, never a silent
 * Alpha re-authentication. On a non-2xx, network failure, or provider-unconfirmed
 * response, this never navigates and never claims the account switch is safe; the caller
 * (`SignOutButton`) is responsible for surfacing the generic recovery message.
 *
 * `navigate` is an injectable seam (defaults to `window.location.assign`, the real
 * browser navigation) purely so tests can assert the hard-navigation call without
 * fighting jsdom's non-configurable `window.location` — production call sites never pass it.
 */
export async function signOut(
  navigate: (url: string) => void = (url) => window.location.assign(url),
): Promise<SignOutOutcome> {
  let response: Response;
  try {
    response = await fetch('/api/auth/logout', { method: 'POST' });
  } catch {
    return 'unconfirmed';
  }

  const outcome = await readOutcome(response);
  if (outcome !== null) clearSetupWizardNamespace();
  if (outcome === 'confirmed') {
    navigate('/auth/login');
    return 'confirmed';
  }
  return 'unconfirmed';
}
