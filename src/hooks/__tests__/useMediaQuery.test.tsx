/**
 * `useMediaQuery` — pins the subscription contract, including the window
 * between the render-time read and the post-mount subscription.
 *
 * That window is why this suite exists (issue #327 — unrelated to AC-327). A
 * hook that reads the query during render and subscribes in a passive effect
 * drops any `change` landing in between: the subscription does come up, one
 * beat late, so the value stays wrong until the NEXT transition. For a dialog
 * opened during a rotation, that is its whole visible lifetime.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { useLayoutEffect } from 'react';
import { render, screen, cleanup, act } from '@testing-library/react';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { installMatchMedia, type MatchMediaStub } from '@/test/matchMediaStub';

const QUERY = '(max-width: 480px)';
const OTHER_QUERY = '(max-width: 940px)';

let stub: MatchMediaStub | undefined;

function Probe({ query = QUERY, onLayout }: { query?: string; onLayout?: () => void } = {}) {
  const matches = useMediaQuery(query);
  // Layout effects run after the render read and BEFORE passive effects —
  // precisely the window in which the subscription does not exist yet. This
  // makes an otherwise timing-dependent race deterministic.
  useLayoutEffect(() => {
    onLayout?.();
  }, [onLayout]);
  return <span data-testid="matches">{String(matches)}</span>;
}

afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

describe('useMediaQuery', () => {
  it('returns the match state at mount', () => {
    stub = installMatchMedia(true);
    render(<Probe />);
    expect(screen.getByTestId('matches')).toHaveTextContent('true');
  });

  it('re-renders when the query starts matching', () => {
    stub = installMatchMedia(false);
    render(<Probe />);
    expect(screen.getByTestId('matches')).toHaveTextContent('false');

    act(() => stub?.change(true));
    expect(screen.getByTestId('matches')).toHaveTextContent('true');
  });

  it('picks up a change that lands before the subscription is live', () => {
    // The issue #327 defect: a rotation landing while the component mounts.
    // The render read says "no match", the `change` fires with nobody
    // listening, and the subscription starts one beat too late. Without a
    // re-read after subscribing, the component stays on the desktop branch
    // until some later transition happens to correct it.
    stub = installMatchMedia(false);
    render(<Probe onLayout={() => stub?.changeQuery(QUERY, true)} />);

    expect(screen.getByTestId('matches')).toHaveTextContent('true');
  });

  it('unsubscribes on unmount', () => {
    stub = installMatchMedia(false);
    const { unmount } = render(<Probe />);
    expect(stub.listenerCount()).toBe(1);

    unmount();
    expect(stub.listenerCount()).toBe(0);
  });

  it('moves its subscription when the query changes', () => {
    stub = installMatchMedia({ [QUERY]: false, [OTHER_QUERY]: true });
    const { rerender } = render(<Probe query={QUERY} />);
    expect(screen.getByTestId('matches')).toHaveTextContent('false');

    rerender(<Probe query={OTHER_QUERY} />);

    expect(screen.getByTestId('matches')).toHaveTextContent('true');
    expect(stub.listenerCount(QUERY)).toBe(0);
    expect(stub.listenerCount(OTHER_QUERY)).toBe(1);
  });

  it('does not re-subscribe on an unrelated re-render', () => {
    // Guards the `useSyncExternalStore` footgun: an unmemoized `subscribe`
    // is a new function identity every render, so React tears the
    // subscription down and rebuilds it on every commit.
    stub = installMatchMedia(false);
    const { rerender } = render(<Probe />);
    expect(stub.listenerCount()).toBe(1);

    rerender(<Probe />);
    rerender(<Probe />);

    expect(stub.listenerCount()).toBe(1);
  });
});
