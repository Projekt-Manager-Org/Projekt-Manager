import { useCallback, useSyncExternalStore } from 'react';
import type { CollapseTier } from '@/config/stateConfig';

/*
 * Breakpoints derived from layout dimensions:
 *   column min-width: 185px, collapsed: 44px, gap: 8px, board padding: 2×12px
 *   9 expanded:           9×185 + 8×8 + 24 = 1753px → breakpoint 1780
 *   6 expanded + 3 coll:  6×185 + 3×44 + 8×8 + 24 = 1330px → breakpoint 1350
 *   3 expanded + 6 coll:  3×185 + 6×44 + 8×8 + 24 =  907px → breakpoint  940
 *   ~30px buffer biases toward early collapse (free space > horizontal scroll).
 */
const BREAKPOINTS: { maxWidth: number; tier: CollapseTier }[] = [
  { maxWidth: 940, tier: 1 },
  { maxWidth: 1350, tier: 2 },
  { maxWidth: 1780, tier: 3 },
];

const queryFor = (maxWidth: number): string => `(max-width: ${maxWidth}px)`;

/**
 * Collapse tier for the current viewport, re-derived on every breakpoint
 * transition. `0` = nothing collapsed.
 *
 * `useSyncExternalStore` re-reads the snapshot immediately after subscribing,
 * so a transition landing between the render-time read and the subscription
 * is not dropped (issue #327). It also supplies the SSR branch that the bare
 * `window.matchMedia` reads below would otherwise crash on.
 *
 * Not built on `useMediaQuery`: that would mean one hook call per breakpoint,
 * and hooks cannot be mapped over `BREAKPOINTS`. Hard-coding three calls
 * would leave a fourth entry silently unsubscribed. Subscribing to the table
 * keeps it the single source of truth.
 */
export function useCollapseTier(): number {
  // Empty deps: `BREAKPOINTS` is module-level, so the subscription set is
  // fixed. An unstable `subscribe` would resubscribe on every commit.
  const subscribe = useCallback((onStoreChange: () => void) => {
    const queries = BREAKPOINTS.map(({ maxWidth }) => window.matchMedia(queryFor(maxWidth)));
    queries.forEach((mq) => mq.addEventListener('change', onStoreChange));
    return () => queries.forEach((mq) => mq.removeEventListener('change', onStoreChange));
  }, []);

  // `computeTier` returns a number — a stable identity across reads, so no
  // snapshot caching is needed.
  return useSyncExternalStore(subscribe, computeTier, () => 0);
}

function computeTier(): number {
  for (const { maxWidth, tier } of BREAKPOINTS) {
    if (window.matchMedia(queryFor(maxWidth)).matches) {
      return tier;
    }
  }
  return 0;
}
