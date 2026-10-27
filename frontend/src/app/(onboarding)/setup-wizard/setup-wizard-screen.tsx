'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { SignOutButton } from '@/components/sign-out-button';
import { ACCOUNTING_SETUP_TEMPLATE_OPTIONS, STEP_IDS, WIZARD_STEPS, type StepField } from './steps';
import { classifySetupWizardError, type SetupWizardErrorKind } from './setup-wizard-error';
import { clearDraft, makeDraft, readDraft, writeDraft } from './draft-storage';
import { createLifecycleGuard, type LifecycleGuard } from './lifecycle-guard';

interface CompanySetupState {
  currentStep: string;
  setupComplete: boolean;
  values: Record<string, unknown>;
  version: number;
  stale: boolean;
  scope: string;
}

interface DraftConflict {
  serverValues: Record<string, string>;
  dirtyValues: Record<string, string>;
  serverVersion: number;
}

/**
 * T056 / binding-review.txt point 5 — every GET/PUT/POST 2xx body is runtime-validated
 * against this shape before it is trusted. A malformed 2xx (missing/mistyped field,
 * an unrecognized `currentStep`, or a non-integer/negative `version`, including a
 * missing `scope`) is never cast and used as-is; callers treat it exactly like a
 * recoverable server error rather than silently falling back to a default.
 */
function isValidSetupState(body: unknown): body is CompanySetupState {
  if (!body || typeof body !== 'object') return false;
  const state = body as Record<string, unknown>;
  return (
    typeof state.currentStep === 'string' &&
    (STEP_IDS as readonly string[]).includes(state.currentStep) &&
    typeof state.setupComplete === 'boolean' &&
    typeof state.values === 'object' &&
    state.values !== null &&
    !Array.isArray(state.values) &&
    typeof state.version === 'number' &&
    Number.isInteger(state.version) &&
    state.version >= 0 &&
    typeof state.stale === 'boolean' &&
    typeof state.scope === 'string' &&
    state.scope.length > 0
  );
}

type Phase =
  | 'loading'
  | 'active'
  | 'paused'
  | 'complete'
  | 'sessionExpired'
  | 'featureUnavailable'
  | 'forbiddenRole'
  | 'trialExpired'
  | 'offline'
  | 'unavailable';

const ALL_FIELD_KEYS = WIZARD_STEPS.flatMap((step) => step.fields.map((field) => field.key));

function normalizeValues(raw: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ALL_FIELD_KEYS) {
    const value = raw[key];
    result[key] = value === null || value === undefined || value === false ? '' : String(value);
  }
  return result;
}

function toPayloadValue(field: StepField, raw: string): string | number {
  const trimmed = raw.trim();
  if (field.kind === 'integer') {
    if (trimmed === '') return '';
    const parsed = Number(trimmed);
    return Number.isNaN(parsed) ? trimmed : parsed;
  }
  return trimmed;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export interface SetupWizardScreenProps {
  /**
   * T056 round-5 (item 3) — the lifecycle-guard factory is injectable ONLY for tests that
   * need to observe gated (attempted-but-not-applied) post-unmount work directly, rather
   * than inferring it from a React console warning. Production never passes this; the
   * default is the real guard.
   */
  createGuard?: () => LifecycleGuard;
}

export function SetupWizardScreen({ createGuard = createLifecycleGuard }: SetupWizardScreenProps = {}) {
  const t = useTranslations('setupWizard');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';

  const [phase, setPhase] = useState<Phase>('loading');
  const [activeIndex, setActiveIndex] = useState(0);
  const [unlockedIndex, setUnlockedIndex] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [version, setVersion] = useState<number | null>(null);
  const [scope, setScope] = useState<string | null>(null);
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(new Set());
  const [conflict, setConflict] = useState<DraftConflict | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [configGap, setConfigGap] = useState(false);
  const [incompleteSteps, setIncompleteSteps] = useState(false);
  const [staleNotice, setStaleNotice] = useState(false);
  const [generalError, setGeneralError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [completing, setCompleting] = useState(false);
  const busy = useRef(false);
  // T056 binding-review point 1 — every request that will apply a server response to
  // state stamps itself with the current generation first. If a newer request (another
  // load(), save, or completion) has started by the time this one's response arrives,
  // this one is stale and its response must never be applied — whichever scope/version/
  // phase is in state at that point belongs to the newer request, not this one.
  const requestGeneration = useRef(0);
  // T056 binding-review point 2 — every outstanding GET/PUT/POST is tracked here so
  // unmount can actually abort it, not merely have its (still in-flight) response
  // ignored by the generation check once it lands.
  const activeControllers = useRef<Set<AbortController>>(new Set());
  // Mirrors `scope` state synchronously: a mutation captures the scope it started with
  // (via this ref, never the possibly-stale `scope` closure variable after an `await`)
  // so a response can be checked against the scope that was actually active when the
  // request was SENT, not whatever scope state happens to hold once control returns.
  const scopeRef = useRef<string | null>(null);
  const loadRef = useRef<() => Promise<void>>(async () => undefined);
  // T056 round-3 binding resolution point 3 — outer handlers (handleNext/handlePause/
  // handleFinish) must not flip `saving`/`completing` state in their OWN `finally` block
  // after this component has unmounted mid-await: `saveStep`/the completion fetch
  // already guard their own response-application state via the generation check, but
  // the outer handler's bookkeeping state was previously left unguarded.
  // T056 round-5 (item 3) — a plain boolean ref here was previously initialized `true`
  // and only ever set back to `false` (in the unmount cleanup), never re-set to `true` on
  // (re)setup. React Strict Mode's development mount -> cleanup -> remount replay would
  // therefore leave it stuck at `false` after the FIRST cleanup ran, even though the
  // component is still genuinely mounted — silently suppressing every post-await state
  // update for the rest of this mount's lifetime. `createGuard()` fixes this: the
  // lifecycle effect below calls `setMounted(true)` on setup too, and the guard is an
  // independently testable seam (lifecycle-guard.ts) rather than an inline ref.
  const guardRef = useRef<LifecycleGuard | undefined>(undefined);
  if (!guardRef.current) guardRef.current = createGuard();

  function updateScope(next: string | null): void {
    scopeRef.current = next;
    setScope(next);
  }

  function beginRequest(): { controller: AbortController; generation: number } {
    const controller = new AbortController();
    activeControllers.current.add(controller);
    return { controller, generation: ++requestGeneration.current };
  }

  function endRequest(controller: AbortController): void {
    activeControllers.current.delete(controller);
  }

  useEffect(() => {
    // T056 round-5 (item 3) — the Strict-Mode fix: setup re-arms the guard as mounted,
    // so a development mount -> cleanup -> remount replay leaves `guardRef.current`
    // mounted==true for the remount, not stuck at the first cleanup's `false`.
    guardRef.current!.setMounted(true);
    return () => {
      // T056 binding-review point 2 — unmount both bumps the generation (so any response
      // that still manages to land is recognized as stale) AND actually aborts every
      // outstanding request, instead of only the GET. Intentionally reads `.current` at
      // cleanup time (not a snapshot taken at effect-setup time): these are plain
      // mutable refs, not DOM node refs, so the generic react-hooks/exhaustive-deps
      // "ref may have changed by cleanup time" warning does not apply here.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      requestGeneration.current++;
      // eslint-disable-next-line react-hooks/exhaustive-deps
      for (const controller of activeControllers.current) controller.abort();
      activeControllers.current.clear();
      guardRef.current!.setMounted(false);
    };
  }, []);

  const applyErrorKind = useCallback((kind: SetupWizardErrorKind): void => {
    setConfigGap(kind.kind === 'configGap');
    setIncompleteSteps(kind.kind === 'incompleteSteps');
    setFieldError(kind.kind === 'field' ? kind.field : null);
    setGeneralError(kind.kind === 'unexpected');
    if (kind.kind === 'sessionExpired') {
      // T056 binding-review point 3 — a logout/session-expiry transition must never leave
      // a restorable draft behind for whichever account signs in next on this browser.
      clearDraft();
      setPhase('sessionExpired');
    } else if (kind.kind === 'scopeMismatch') {
      // T056 binding-review point 1 — the server rejected a stale scope (or, on PUT/POST,
      // the authenticated tenant/account/company actually changed under this session).
      // Never retry the mutation that triggered this and never keep a draft captured
      // under the old scope; reload authoritative state for whoever is authenticated now.
      clearDraft();
      void loadRef.current?.();
    } else if (kind.kind === 'featureUnavailable') setPhase('featureUnavailable');
    else if (kind.kind === 'forbiddenRole') setPhase('forbiddenRole');
    else if (kind.kind === 'trialExpired') setPhase('trialExpired');
  }, []);

  const load = useCallback(async () => {
    // T056 binding-review point 1/2 — a new load() supersedes any in-flight load AND any
    // in-flight mutation's eventual response application; every previously outstanding
    // GET/PUT/POST is actually aborted here, not merely ignored once its response lands.
    for (const controller of activeControllers.current) controller.abort();
    activeControllers.current.clear();
    const { controller, generation: myGeneration } = beginRequest();
    setPhase('loading');
    setGeneralError(false);
    setConflict(null);
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      endRequest(controller);
      setPhase('offline');
      return;
    }
    try {
      const response = await fetch('/api/companies/current/setup', {
        cache: 'no-store',
        signal: controller.signal,
      });
      const body = await readJson(response);
      endRequest(controller);
      if (requestGeneration.current !== myGeneration) return;
      if (!response.ok) {
        const message = body && typeof body === 'object' ? (body as { message?: unknown }).message : undefined;
        applyErrorKind(classifySetupWizardError(response.status, message));
        if (
          response.status !== 401 &&
          response.status !== 404 &&
          response.status !== 403 &&
          response.status !== 412
        ) {
          setPhase('unavailable');
        }
        return;
      }
      // T056 binding-review point 5 — a malformed 2xx body (including one missing the
      // opaque `scope`) is never cast and trusted; it is a recoverable server error.
      if (!isValidSetupState(body)) {
        setPhase('unavailable');
        return;
      }
      const state = body;
      const serverValues = normalizeValues(state.values ?? {});
      const resumeIndex = Math.max(0, STEP_IDS.indexOf(state.currentStep));
      // T056 binding-review points 1-4 — the sessionStorage draft only carries unsaved,
      // explicitly-dirty edits for the step the user was ON when it was written (the
      // language-switch-mid-step edge case). It is restored only when its opaque scope
      // matches THIS authoritative response's scope (never across an account/company
      // transition) and its step matches the server's current resume point. If the
      // draft's baseVersion no longer matches the server's version (another session
      // advanced it), the dirty values are kept separate behind an explicit conflict
      // notice instead of silently overlaying or silently discarding either side. A
      // draft for a different scope, or one that fails to parse at all, is quarantined
      // (dropped) rather than ever considered for restore.
      const draft = readDraft();
      let mergedValues = serverValues;
      let nextDirtyKeys = new Set<string>();
      if (draft && draft.scope === state.scope && draft.activeStep === state.currentStep) {
        if (draft.baseVersion === state.version) {
          mergedValues = { ...serverValues, ...draft.dirty };
          nextDirtyKeys = new Set(Object.keys(draft.dirty));
        } else {
          setConflict({ serverValues, dirtyValues: draft.dirty, serverVersion: state.version });
        }
      } else if (draft) {
        clearDraft();
      }
      setValues(mergedValues);
      setDirtyKeys(nextDirtyKeys);
      updateScope(state.scope);
      setVersion(state.version);
      setUnlockedIndex(resumeIndex);
      setActiveIndex(state.setupComplete ? STEP_IDS.length - 1 : resumeIndex);
      setConfigGap(false);
      setIncompleteSteps(false);
      setFieldError(null);
      setPhase(state.setupComplete ? 'complete' : 'active');
    } catch {
      endRequest(controller);
      if (controller.signal.aborted || requestGeneration.current !== myGeneration) return;
      setPhase(typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'unavailable');
    }
  }, [applyErrorKind]);

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    // T056 binding-review point 3 — while a conflict is unresolved, the stored draft IS
    // the conflicting dirty values the user has not yet chosen to keep or discard. This
    // effect must never overwrite that draft with an empty/merged envelope before
    // `resolveConflict` runs, or the only record of the conflicting edits is lost.
    if (phase !== 'active' || scope === null || version === null || conflict !== null) return;
    const activeStep = WIZARD_STEPS[activeIndex]?.id ?? STEP_IDS[0];
    const dirty: Record<string, string> = {};
    for (const key of dirtyKeys) dirty[key] = values[key] ?? '';
    writeDraft(makeDraft(scope, version, activeStep, dirty));
  }, [activeIndex, values, dirtyKeys, phase, scope, version, conflict]);

  const saveStep = useCallback(
    async (stepIndex: number): Promise<boolean> => {
      // T056 binding-review point 1/2 — stamp this mutation with the generation active
      // when it started AND register its abort controller; if a load() or another
      // mutation supersedes it before the response arrives, this response is stale and
      // must never overwrite newer state, and unmount actually cancels the request
      // instead of merely letting its eventual response be ignored. The scope captured
      // here (via the ref, not the `scope` closure variable) is what THIS request was
      // sent under — a later account/company transition must not change what this
      // specific response is checked against.
      const { controller, generation: myGeneration } = beginRequest();
      const initiatingScope = scopeRef.current;
      const step = WIZARD_STEPS[stepIndex];
      const payload: Record<string, string | number> = {};
      for (const field of step.fields) {
        payload[field.key] = toPayloadValue(field, values[field.key] ?? '');
      }
      setFieldError(null);
      setConfigGap(false);
      setIncompleteSteps(false);
      setStaleNotice(false);
      setGeneralError(false);
      try {
        const response = await fetch('/api/companies/current/setup', {
          method: 'PUT',
          headers: {
            'content-type': 'application/json',
            ...(initiatingScope ? { 'x-kemfai-setup-scope': initiatingScope } : {}),
          },
          body: JSON.stringify({ step: step.id, values: payload, baseVersion: version }),
          signal: controller.signal,
        });
        const body = await readJson(response);
        endRequest(controller);
        if (requestGeneration.current !== myGeneration) return false;
        if (!response.ok) {
          const message = body && typeof body === 'object' ? (body as { message?: unknown }).message : undefined;
          applyErrorKind(classifySetupWizardError(response.status, message));
          return false;
        }
        // T056 binding-review point 5 — same runtime validation as GET: an unclassified
        // malformed 2xx PUT body becomes a localized, retryable general mutation error,
        // never a crash and never a silent accept of a bad response.
        if (!isValidSetupState(body)) {
          setGeneralError(true);
          return false;
        }
        const state = body;
        // T056 binding-review point 1 — defense in depth: even a 2xx is rejected if the
        // scope it reports differs from the scope this request was sent under. The
        // server-side precondition should already prevent this; this is the client
        // refusing to ever apply such a response regardless.
        if (initiatingScope !== null && state.scope !== initiatingScope) {
          clearDraft();
          void loadRef.current?.();
          return false;
        }
        setValues(normalizeValues(state.values ?? {}));
        setVersion(state.version);
        updateScope(state.scope);
        setStaleNotice(Boolean(state.stale));
        setDirtyKeys((previous) => {
          const next = new Set(previous);
          for (const field of step.fields) next.delete(field.key);
          return next;
        });
        const newIndex = Math.max(0, STEP_IDS.indexOf(state.currentStep));
        setUnlockedIndex((previous) => Math.max(previous, newIndex, stepIndex));
        return true;
      } catch {
        endRequest(controller);
        if (controller.signal.aborted || requestGeneration.current !== myGeneration) return false;
        // T056 binding-review point 6 — a network/offline failure while saving is a
        // general mutation error with a safe retry, not a full-page takeover that would
        // hide the form and make "preserving edits" invisible to the user.
        setGeneralError(true);
        return false;
      }
    },
    [applyErrorKind, values, version],
  );

  async function handleNext(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    // T056 binding-review point 3 — no save/navigation is allowed while a draft conflict
    // is unresolved; the user must explicitly pick "Keep mine" or "Use latest" first.
    if (busy.current || conflict !== null) return;
    busy.current = true;
    setSaving(true);
    try {
      const ok = await saveStep(activeIndex);
      if (ok) {
        guardRef.current!.runIfMounted(() =>
          setActiveIndex((index) => Math.min(index + 1, STEP_IDS.length - 1)),
        );
      }
    } finally {
      // T056 round-3 point 3 — never flip `saving`/`busy` state on behalf of a request
      // this component is no longer mounted to observe the outcome of.
      guardRef.current!.runIfMounted(() => setSaving(false));
      busy.current = false;
    }
  }

  async function handlePause(): Promise<void> {
    if (busy.current || conflict !== null) return;
    busy.current = true;
    setSaving(true);
    try {
      const ok = await saveStep(activeIndex);
      if (ok) guardRef.current!.runIfMounted(() => setPhase('paused'));
    } finally {
      guardRef.current!.runIfMounted(() => setSaving(false));
      busy.current = false;
    }
  }

  async function handleResume(): Promise<void> {
    await load();
  }

  async function handleFinish(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy.current || conflict !== null) return;
    busy.current = true;
    setCompleting(true);
    setGeneralError(false);
    // T056 binding-review point 1/2 — captured AFTER saveStep (which stamps/tracks its
    // own generation+controller internally) so this reflects whether a competing request
    // started during THIS fetch, not saveStep's already-resolved one; and so the scope
    // this completion call is checked against is the one actually active once saveStep's
    // own response (and any resulting account/company transition) has settled.
    let controller: AbortController | undefined;
    let myGeneration: number | undefined;
    try {
      const saved = await saveStep(activeIndex);
      if (!saved) return;
      const beginning = beginRequest();
      controller = beginning.controller;
      myGeneration = beginning.generation;
      const initiatingScope = scopeRef.current;
      const response = await fetch('/api/companies/current/setup/complete', {
        method: 'POST',
        headers: initiatingScope ? { 'x-kemfai-setup-scope': initiatingScope } : undefined,
        signal: controller.signal,
      });
      const body = await readJson(response);
      endRequest(controller);
      if (requestGeneration.current !== myGeneration) return;
      if (!response.ok) {
        const message = body && typeof body === 'object' ? (body as { message?: unknown }).message : undefined;
        applyErrorKind(classifySetupWizardError(response.status, message));
        return;
      }
      // T056 binding-review point 5 — a 2xx is not, by itself, completion: the body must
      // validate AND explicitly say `setupComplete === true`. Anything else (malformed,
      // or a successful-status response that actually reports incomplete) is a
      // recoverable general mutation error that leaves the draft and the active wizard
      // intact — never a false "complete" screen and never a cleared draft before that
      // validation passes.
      if (!isValidSetupState(body) || body.setupComplete !== true) {
        setGeneralError(true);
        return;
      }
      const state = body;
      // T056 binding-review point 1 — defense in depth, same as saveStep: never apply a
      // completion response whose scope differs from the scope this call was sent under.
      if (initiatingScope !== null && state.scope !== initiatingScope) {
        clearDraft();
        void loadRef.current?.();
        return;
      }
      clearDraft();
      setValues(normalizeValues(state.values ?? {}));
      setDirtyKeys(new Set());
      setVersion(state.version);
      updateScope(state.scope);
      setPhase('complete');
    } catch {
      if (controller) endRequest(controller);
      if (controller?.signal.aborted || (myGeneration !== undefined && requestGeneration.current !== myGeneration)) {
        return;
      }
      guardRef.current!.runIfMounted(() => setGeneralError(true));
    } finally {
      // T056 round-3 point 3 — same guard as handleNext/handlePause: never flip
      // `completing`/`busy` state on behalf of a request this component is no longer
      // mounted to observe the outcome of.
      guardRef.current!.runIfMounted(() => setCompleting(false));
      busy.current = false;
    }
  }

  function setFieldValue(key: string, value: string): void {
    setValues((previous) => ({ ...previous, [key]: value }));
    setDirtyKeys((previous) => {
      const next = new Set(previous);
      next.add(key);
      return next;
    });
  }

  /**
   * T056 binding-review point 4 — the explicit retry/review path for a version conflict:
   * the user picks either the dirty values they had locally or the fresher server
   * values, never an automatic silent merge either direction.
   */
  function resolveConflict(choice: 'keepMine' | 'useLatest'): void {
    if (!conflict) return;
    if (choice === 'keepMine') {
      setValues((previous) => ({ ...previous, ...conflict.dirtyValues }));
      setDirtyKeys(new Set(Object.keys(conflict.dirtyValues)));
    } else {
      setValues(conflict.serverValues);
      setDirtyKeys(new Set());
      clearDraft();
    }
    setVersion(conflict.serverVersion);
    setConflict(null);
  }

  if (phase === 'loading') {
    return (
      <main dir={locale === 'ar' ? 'rtl' : 'ltr'} aria-labelledby="setup-wizard-title">
        <LocaleSwitcher />
        <h1 id="setup-wizard-title">{t('title')}</h1>
        <section role="status" aria-live="polite" aria-busy="true" data-testid="setup-wizard-loading">
          {t('loading')}
        </section>
      </main>
    );
  }

  if (phase === 'sessionExpired') {
    return (
      <main dir={locale === 'ar' ? 'rtl' : 'ltr'}>
        <LocaleSwitcher />
        <section role="alert" data-testid="setup-wizard-session-expired">
          <h1>{t('errors.sessionExpired')}</h1>
          <Link href="/auth/login?returnTo=%2Fsetup-wizard">{t('actions.signIn')}</Link>
        </section>
      </main>
    );
  }

  if (phase === 'featureUnavailable' || phase === 'forbiddenRole' || phase === 'trialExpired') {
    const key = phase === 'featureUnavailable' ? 'featureUnavailable' : phase === 'forbiddenRole' ? 'forbiddenRole' : 'trialExpired';
    return (
      <main dir={locale === 'ar' ? 'rtl' : 'ltr'}>
        <LocaleSwitcher />
        <section role="alert" data-testid={`setup-wizard-${phase}`}>
          <h1>{t(`errors.${key}`)}</h1>
        </section>
      </main>
    );
  }

  if (phase === 'offline' || phase === 'unavailable') {
    return (
      <main dir={locale === 'ar' ? 'rtl' : 'ltr'}>
        <LocaleSwitcher />
        <section role="alert" data-testid="setup-wizard-recoverable">
          <h1>{t(phase === 'offline' ? 'errors.offline' : 'errors.unavailable')}</h1>
          <button type="button" onClick={() => void load()} data-testid="setup-wizard-retry">
            {t('actions.retry')}
          </button>
        </section>
      </main>
    );
  }

  if (phase === 'paused') {
    return (
      <main dir={locale === 'ar' ? 'rtl' : 'ltr'}>
        <LocaleSwitcher />
        <SignOutButton />
        <section role="status" data-testid="setup-wizard-paused">
          <h1>{t('paused.title')}</h1>
          <p>{t('paused.body')}</p>
          <button type="button" onClick={() => void handleResume()} data-testid="setup-wizard-resume">
            {t('actions.resume')}
          </button>
        </section>
      </main>
    );
  }

  if (phase === 'complete') {
    return (
      <main dir={locale === 'ar' ? 'rtl' : 'ltr'}>
        <LocaleSwitcher />
        <SignOutButton />
        <section role="status" data-testid="setup-wizard-complete">
          <h1>{t('complete.title')}</h1>
          <p>{t('complete.body')}</p>
          <Link href="/">{t('actions.continue')}</Link>
        </section>
      </main>
    );
  }

  const step = WIZARD_STEPS[activeIndex];
  const isLastStep = activeIndex === WIZARD_STEPS.length - 1;
  // T056 binding-review point 3 — an unresolved draft conflict locks every save/navigation
  // control, not just the mutation handlers, so there is no UI path to submit or move on
  // without an explicit "Keep mine"/"Use latest" choice first.
  const conflictLocked = conflict !== null;
  const busyNow = saving || completing || conflictLocked;

  return (
    <main dir={locale === 'ar' ? 'rtl' : 'ltr'} aria-labelledby="setup-wizard-title">
      <LocaleSwitcher />
      <SignOutButton />
      <h1 id="setup-wizard-title">{t('title')}</h1>
      <nav aria-label={t('progressLabel')}>
        <ol data-testid="setup-wizard-progress">
          {WIZARD_STEPS.map((candidate, index) => (
            <li key={candidate.id}>
              <button
                type="button"
                aria-current={index === activeIndex ? 'step' : undefined}
                disabled={index > unlockedIndex || conflictLocked}
                onClick={() => setActiveIndex(index)}
                data-testid={`setup-wizard-step-${candidate.id}`}
              >
                {t(`steps.${candidate.id}`)}
              </button>
            </li>
          ))}
        </ol>
      </nav>

      {staleNotice && (
        <p role="status" data-testid="setup-wizard-stale">
          {t('staleNotice')}
        </p>
      )}
      {conflict && (
        <section role="alert" data-testid="setup-wizard-conflict">
          <p>{t('conflict.body')}</p>
          <button type="button" onClick={() => resolveConflict('keepMine')} data-testid="setup-wizard-conflict-keep-mine">
            {t('conflict.keepMine')}
          </button>
          <button type="button" onClick={() => resolveConflict('useLatest')} data-testid="setup-wizard-conflict-use-latest">
            {t('conflict.useLatest')}
          </button>
        </section>
      )}
      {generalError && (
        <p role="alert" data-testid="setup-wizard-general-error">
          {t('errors.general')}
        </p>
      )}
      {configGap && (
        <p role="alert" data-testid="setup-wizard-config-gap">
          {t('errors.configGap')}
        </p>
      )}
      {incompleteSteps && (
        <p role="alert" data-testid="setup-wizard-incomplete-steps">
          {t('errors.incompleteSteps')}
        </p>
      )}
      {(saving || completing) && (
        <p role="status" aria-live="polite" aria-busy="true" data-testid="setup-wizard-submitting">
          {t('actions.saving')}
        </p>
      )}

      <form onSubmit={isLastStep ? handleFinish : handleNext} noValidate>
        <h2>{t(`steps.${step.id}`)}</h2>
        {/* T056 binding-review point 4 — a native <fieldset disabled> locks every input/
            select inside it while a draft conflict is unresolved, not just the
            nav/submit buttons below (which remain outside this fieldset and keep their
            own `busyNow` disabling). */}
        <fieldset disabled={conflictLocked} data-testid="setup-wizard-fieldset">
        {step.fields.map((field) => {
          const fieldId = `setup-wizard-${field.key}`;
          const hasError = fieldError === field.key;
          return (
            <div key={field.key}>
              <label htmlFor={fieldId} style={{ display: 'block' }}>
                {t(`fields.${field.key}.label`)}
              </label>
              {field.kind === 'month-select' && (
                <select
                  id={fieldId}
                  value={values[field.key] ?? ''}
                  aria-invalid={hasError}
                  aria-describedby={hasError ? `${fieldId}-error` : undefined}
                  onChange={(event) => setFieldValue(field.key, event.target.value)}
                >
                  <option value="">{t('fields.selectPlaceholder')}</option>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((month) => (
                    <option key={month} value={String(month)}>
                      {month}
                    </option>
                  ))}
                </select>
              )}
              {field.kind === 'template-select' && (
                <select
                  id={fieldId}
                  value={values[field.key] ?? ''}
                  aria-invalid={hasError}
                  aria-describedby={hasError ? `${fieldId}-error` : undefined}
                  onChange={(event) => setFieldValue(field.key, event.target.value)}
                >
                  <option value="">{t('fields.selectPlaceholder')}</option>
                  {ACCOUNTING_SETUP_TEMPLATE_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {t(`fields.accounting_setup_template.options.${option}`)}
                    </option>
                  ))}
                </select>
              )}
              {(field.kind === 'text' || field.kind === 'integer') && (
                <input
                  id={fieldId}
                  type={field.kind === 'integer' ? 'number' : 'text'}
                  value={values[field.key] ?? ''}
                  aria-invalid={hasError}
                  aria-describedby={hasError ? `${fieldId}-error` : undefined}
                  onChange={(event) => setFieldValue(field.key, event.target.value)}
                />
              )}
              {hasError && (
                <p role="alert" id={`${fieldId}-error`} data-testid="setup-wizard-field-error">
                  {t(`fields.${field.key}.error`)}
                </p>
              )}
            </div>
          );
        })}
        </fieldset>

        <button
          type="button"
          disabled={activeIndex === 0 || busyNow}
          onClick={() => setActiveIndex((index) => Math.max(index - 1, 0))}
          data-testid="setup-wizard-back"
        >
          {t('actions.back')}
        </button>
        <button type="button" disabled={busyNow} onClick={() => void handlePause()} data-testid="setup-wizard-pause">
          {t('actions.pauseAndSave')}
        </button>
        <button type="submit" disabled={busyNow} data-testid="setup-wizard-next">
          {t(saving || completing ? 'actions.saving' : isLastStep ? 'actions.finish' : 'actions.next')}
        </button>
      </form>
    </main>
  );
}
