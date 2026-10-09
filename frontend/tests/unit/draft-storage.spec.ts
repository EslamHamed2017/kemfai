import { clearDraft, makeDraft, readDraft, writeDraft } from '../../src/app/(onboarding)/setup-wizard/draft-storage';

/**
 * T056 binding-review point 4 — draft-storage.ts must require `baseVersion` to be a
 * non-negative integer, `activeStep` to be a recognized wizard step, and `scope` to be
 * non-whitespace — a malformed envelope (corrupted sessionStorage, a hand-crafted value,
 * a future/renamed step id) is quarantined (treated as absent), never restored.
 */
describe('draft-storage (T056)', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('round-trips a well-formed draft', () => {
    writeDraft(makeDraft('scope-alpha', 1, 'identity', { legal_name: 'Acme' }));
    expect(readDraft()).toEqual({
      schemaVersion: 2,
      scope: 'scope-alpha',
      baseVersion: 1,
      activeStep: 'identity',
      dirty: { legal_name: 'Acme' },
    });
  });

  it('rejects a negative baseVersion', () => {
    window.sessionStorage.setItem(
      'kemfai:setup-wizard:draft:v2',
      JSON.stringify({ schemaVersion: 2, scope: 'scope-alpha', baseVersion: -1, activeStep: 'identity', dirty: {} }),
    );
    expect(readDraft()).toBeNull();
  });

  it('rejects a non-integer baseVersion', () => {
    window.sessionStorage.setItem(
      'kemfai:setup-wizard:draft:v2',
      JSON.stringify({ schemaVersion: 2, scope: 'scope-alpha', baseVersion: 1.5, activeStep: 'identity', dirty: {} }),
    );
    expect(readDraft()).toBeNull();
  });

  it('rejects an unrecognized activeStep', () => {
    window.sessionStorage.setItem(
      'kemfai:setup-wizard:draft:v2',
      JSON.stringify({ schemaVersion: 2, scope: 'scope-alpha', baseVersion: 1, activeStep: 'not_a_real_step', dirty: {} }),
    );
    expect(readDraft()).toBeNull();
  });

  it('rejects a whitespace-only scope', () => {
    window.sessionStorage.setItem(
      'kemfai:setup-wizard:draft:v2',
      JSON.stringify({ schemaVersion: 2, scope: '   ', baseVersion: 1, activeStep: 'identity', dirty: {} }),
    );
    expect(readDraft()).toBeNull();
  });

  it('clearDraft removes a stored draft', () => {
    writeDraft(makeDraft('scope-alpha', 1, 'identity', { legal_name: 'Acme' }));
    clearDraft();
    expect(readDraft()).toBeNull();
  });
});
