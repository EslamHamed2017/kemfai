/**
 * T056 round-5 binding resolution (item 3) — extracted so the "is this component still
 * mounted" gate is an independently testable seam, not an inline boolean ref whose
 * correctness can only be inferred from a React console warning (which modern React does
 * not reliably emit for a post-unmount `setState`). `setMounted` is called from BOTH the
 * effect's setup AND its cleanup: React Strict Mode's development mount -> cleanup ->
 * remount replay must leave the guard mounted==true once the second setup has run, never
 * stuck at the cleanup's `false` (the exact defect this round fixes — see
 * setup-wizard-screen.tsx's lifecycle effect).
 */
export interface LifecycleGuard {
  isMounted(): boolean;
  setMounted(value: boolean): void;
  /** Runs `fn` only while mounted; returns `fn`'s result, or `undefined` if gated. */
  runIfMounted<T>(fn: () => T): T | undefined;
}

export function createLifecycleGuard(): LifecycleGuard {
  let mounted = true;
  return {
    isMounted: () => mounted,
    setMounted: (value: boolean) => {
      mounted = value;
    },
    runIfMounted: <T,>(fn: () => T): T | undefined => (mounted ? fn() : undefined),
  };
}
