/**
 * T056 / binding-review.txt point 2-3 — a versioned, server-scope-bound draft envelope,
 * replacing the earlier unscoped global draft that let one account/company's unsaved
 * input bleed into another's screen (the demonstrated Alpha→Beta cross-account leak).
 * Only explicitly dirty field keys/values are ever persisted here — never the full
 * normalized form — and a draft is restorable only when every envelope field parses to
 * the expected shape. Scope/version/step matching against the authoritative GET response
 * happens in setup-wizard-screen.tsx; this module only guarantees the envelope itself is
 * well-formed (fail closed: anything else is treated as absent, never restored).
 */
import { STEP_IDS } from './steps';

const STORAGE_KEY = 'kemfai:setup-wizard:draft:v2';
const SCHEMA_VERSION = 2;

export interface WizardDraft {
  schemaVersion: number;
  /** The opaque CompanySetupState.scope this draft was captured under. */
  scope: string;
  /** The CompanySetupState.version the draft's dirty values were edited on top of. */
  baseVersion: number;
  /** The wizard step id active when the draft was last written. */
  activeStep: string;
  /** Only the field keys the user has actually edited since the last successful save. */
  dirty: Record<string, string>;
}

function isWizardDraft(value: unknown): value is WizardDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Record<string, unknown>;
  if (draft.schemaVersion !== SCHEMA_VERSION) return false;
  if (typeof draft.scope !== 'string' || draft.scope.trim().length === 0) return false;
  if (
    typeof draft.baseVersion !== 'number' ||
    !Number.isInteger(draft.baseVersion) ||
    draft.baseVersion < 0
  ) {
    return false;
  }
  if (
    typeof draft.activeStep !== 'string' ||
    !(STEP_IDS as readonly string[]).includes(draft.activeStep)
  ) {
    return false;
  }
  if (!draft.dirty || typeof draft.dirty !== 'object' || Array.isArray(draft.dirty)) return false;
  return Object.values(draft.dirty as Record<string, unknown>).every((value) => typeof value === 'string');
}

export function makeDraft(
  scope: string,
  baseVersion: number,
  activeStep: string,
  dirty: Record<string, string>,
): WizardDraft {
  return { schemaVersion: SCHEMA_VERSION, scope, baseVersion, activeStep, dirty };
}

export function readDraft(): WizardDraft | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return isWizardDraft(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeDraft(draft: WizardDraft): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // Best-effort only: losing the draft means falling back to the last server save,
    // never a crash of the wizard itself.
  }
}

export function clearDraft(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Best-effort cleanup.
  }
}
