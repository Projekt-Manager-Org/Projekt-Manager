/**
 * Layer 2 subprocess runtime bound.
 *
 * Covers verification.md §15.22 AC-345 [crit]: every external process a
 * backup or drill run starts is bounded by a wall-clock limit, so a hung
 * binary fails the run instead of parking the scheduler forever.
 *
 * Driven against `sleep` rather than the real binaries — the property is
 * "an unresponsive child is killed and reported", which is independent
 * of which binary hangs. `sleep` is in coreutils, always present, and
 * needs none of the `pg_dump` / `initdb` toolchain the suite lacks.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';

import { boundRuntime, SUBPROCESS_TIMEOUT_MS } from '../services/subprocessBound.js';

/** Resolve once the child is fully gone, with how it ended. */
function waitForClose(
  child: ReturnType<typeof spawn>,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

describe('Layer 2 subprocess runtime bound (§15.22 AC-345)', () => {
  it('kills a child that outlives its bound and reports it as a timeout', async () => {
    const child = spawn('sleep', ['30'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const bound = boundRuntime(child, 150, 500);

    const { signal } = await waitForClose(child);
    bound.release();

    // Terminated by us, not by exiting on its own — `sleep 30` cannot
    // have finished inside 150ms.
    expect(signal).not.toBeNull();
    expect(bound.expired()).toBe(true);
    expect(bound.error('pg_dump').message).toContain('pg_dump');
  });

  it('leaves a child that finishes inside its bound untouched', async () => {
    const child = spawn('sleep', ['0.05'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const bound = boundRuntime(child, 10_000, 500);

    const { code, signal } = await waitForClose(child);
    bound.release();

    expect(code).toBe(0);
    expect(signal).toBeNull();
    expect(bound.expired()).toBe(false);
  });

  it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    // `trap '' TERM` makes the shell ignore SIGTERM outright, which is
    // the case a SIGTERM-only implementation would hang on forever.
    const child = spawn('sh', ['-c', "trap '' TERM; sleep 30"], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const bound = boundRuntime(child, 150, 300);

    const { signal } = await waitForClose(child);
    bound.release();

    expect(signal).toBe('SIGKILL');
    expect(bound.expired()).toBe(true);
  });

  it('defaults to a bound that is finite', () => {
    // The value is a judgement call and deliberately not asserted; that
    // it exists at all is the AC-345 property.
    expect(Number.isFinite(SUBPROCESS_TIMEOUT_MS)).toBe(true);
    expect(SUBPROCESS_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
