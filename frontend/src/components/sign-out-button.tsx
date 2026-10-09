'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { signOut } from '@/lib/auth/sign-out';

export interface SignOutButtonProps {
  /** Test-only seam: lets unit tests assert the real handler ran without fighting
   * jsdom's non-configurable `window.location` navigation. Production call sites never
   * pass this — `signOut()` defaults to the real `window.location.assign`. */
  navigate?: (url: string) => void;
}

/**
 * T056 point 3 (corrective) — the ONE shared sign-out control, used from every
 * authenticated screen (setup wizard, provisioning). A provider-unconfirmed outcome
 * (Keycloak unreachable, timed out, or the server couldn't confirm termination) never
 * navigates to login and never implies the account switch is safe — it surfaces a
 * generic, accessible recovery message instead, and re-enables the button so the user
 * can retry the same control.
 */
export function SignOutButton({ navigate }: SignOutButtonProps = {}) {
  const t = useTranslations('app');
  const [pending, setPending] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);

  async function handleClick(): Promise<void> {
    setPending(true);
    setUnconfirmed(false);
    try {
      const outcome = navigate ? await signOut(navigate) : await signOut();
      setUnconfirmed(outcome !== 'confirmed');
    } catch {
      // signOut() already contains its own failure handling and should never throw; this
      // is a last-resort guard so a click can never produce an unhandled rejection.
      setUnconfirmed(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        data-testid="sign-out-button"
        disabled={pending}
        onClick={() => void handleClick()}
      >
        {t('actions.signOut')}
      </button>
      {unconfirmed && (
        <p role="alert" data-testid="sign-out-unconfirmed">
          {t('signOutUnconfirmed')}
        </p>
      )}
    </>
  );
}
