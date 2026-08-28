/**
 * `useCollapseTier` — pins the tier derivation and the subscription
 * contract across all three breakpoints.
 *
 * Same defect as `useMediaQuery` before it (issue #327): the tier is computed
 * during render and the breakpoints are subscribed in a passive effect, so a
 * transition landing in between is dropped and the board keeps the tier it
 * mounted with until the next one.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { useLayoutEffect } from 'react';
import { render, screen, cleanup, act } from '@testing-library/react';
import { useCollapseTier } from '../useCollapseTier';
import { installMatchMedia, type MatchMediaStub } from '@/test/matchMediaStub';

// Mirrors the BREAKPOINTS table in the hook. Duplicated deliberately: a test
// deriving its expectations from the same constant it verifies would follow
// any edit to that constant instead of catching it.
const TIER_1 = '(max-width: 940px)';
const TIER_2 = '(max-width: 1350px)';
const TIER_3 = '(max-width: 1780px)';

const NONE = { [TIER_1]: false, [TIER_2]: false, [TIER_3]: false };

let stub: MatchMediaStub | undefined;

function Probe({ onLayout }: { onLayout?: () => void } = {}) {
  const tier = useCollapseTier();
  // Runs after the render-time read, before passive effects — the window in
  // which no breakpoint is subscribed yet.
  useLayoutEffect(() => {
    onLayout?.();
  }, [onLayout]);
  return <span data-testid="tier">{tier}</span>;
}

afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

describe('useCollapseTier', () => {
  it.each([
    { label: 'narrowest — all three match', state: { ...NONE, [TIER_1]: true, [TIER_2]: true, [TIER_3]: true }, expected: '1' }, // prettier-ignore
    { label: 'below 1350 only', state: { ...NONE, [TIER_2]: true, [TIER_3]: true }, expected: '2' },
    { label: 'below 1780 only', state: { ...NONE, [TIER_3]: true }, expected: '3' },
    { label: 'wide desktop — none match', state: NONE, expected: '0' },
  ])('derives tier $expected ($label)', ({ state, expected }) => {
    stub = installMatchMedia(state);
    render(<Probe />);
    expect(screen.getByTestId('tier')).toHaveTextContent(expected);
  });

  it('re-renders when a breakpoint transition fires', () => {
    stub = installMatchMedia(NONE);
    render(<Probe />);
    expect(screen.getByTestId('tier')).toHaveTextContent('0');

    act(() => stub?.changeQuery(TIER_3, true));
    expect(screen.getByTestId('tier')).toHaveTextContent('3');
  });

  it('picks up a transition that lands before the subscription is live', () => {
    stub = installMatchMedia(NONE);
    render(<Probe onLayout={() => stub?.changeQuery(TIER_3, true)} />);

    expect(screen.getByTestId('tier')).toHaveTextContent('3');
  });

  it('unsubscribes every breakpoint on unmount', () => {
    // One handler across three MediaQueryLists is three subscriptions, and
    // three leaks if cleanup misses them.
    stub = installMatchMedia(NONE);
    const { unmount } = render(<Probe />);
    expect(stub.listenerCount()).toBe(3);

    unmount();
    expect(stub.listenerCount()).toBe(0);
  });
});
