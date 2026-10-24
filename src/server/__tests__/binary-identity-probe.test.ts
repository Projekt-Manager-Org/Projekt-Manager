/**
 * Boot-time binary `age` keyring probe — fail-closed (AC-438).
 *
 * Pins the operator-loaded-keyring boot gate from ADR-0024:
 *   - happy path: a parseable keyring at the configured tmpfs path whose
 *     recipients equal the active one plus the listed retired ones lets
 *     the assertion resolve;
 *   - fail-closed branches: file absent / file unreadable / malformed
 *     identity that fails `age-keygen -y` round-trip / a configured key
 *     missing from the keyring / an unlisted key in it → a thrown error
 *     identifying the offending check (translated to a non-zero process
 *     exit at the boot site, parallel to the bucket-safety probe in
 *     `assertStorageBucketSafe`);
 *   - integration arm against the dev tmpfs path / a real `age-keygen`
 *     pair so the path that production runs is exercised, not just the
 *     unit-level branches.
 *
 * Mirrors the structure of `storage-safety.test.ts` (AC-236 / AC-237) —
 * a pure validator (`evaluateBinaryIdentity`) over a snapshot of {file
 * present?, file readable?, derived recipients?, configured recipients?},
 * plus an orchestrator (`assertBinaryIdentityLoaded`) that reads the
 * file + spawns `age-keygen -y` and aggregates findings into one
 * thrown error matching the same message shape.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {
  evaluateBinaryIdentity,
  assertBinaryIdentityLoaded,
  type BinaryIdentitySnapshot,
} from '../storage/binaryIdentity.js';

/**
 * Tests for the orchestrator pass `waitTimeoutMs: 0` (or a small
 * value) to opt out of the production 5-minute wait window — the
 * production behavior is exercised by the dedicated wait/timeout
 * tests further down. Tests also pass `progressLogIntervalMs: 0` to
 * suppress the "still waiting" progress log lines so test output
 * stays clean.
 */
const FAIL_FAST_OPTIONS = { waitTimeoutMs: 0, progressLogIntervalMs: 0 } as const;

// ---------------------------------------------------------------------
// evaluateBinaryIdentity — pure validator over a structured snapshot.
// Pattern mirrors `evaluateBucketSafety` in `storage/safety.ts`.
// ---------------------------------------------------------------------

describe('AC-438: binary-identity boot probe — pure validator', () => {
  const ACTIVE = 'age1abcde1234567890abcdef1234567890abcdef1234567890abcde1234abcd';
  const RETIRED_1 = 'age1rrrrr1111111111111111111111111111111111111111111111111111111';
  const RETIRED_2 = 'age1rrrrr2222222222222222222222222222222222222222222222222222222';
  const STRANGER = 'age1zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
  const CANONICAL: BinaryIdentitySnapshot = {
    fileExists: true,
    fileReadable: true,
    derivedRecipients: [ACTIVE],
    configuredRecipient: ACTIVE,
    retiredRecipients: [],
  };

  it('passes on the canonical snapshot (file present, readable, recipient match)', () => {
    expect(evaluateBinaryIdentity(CANONICAL)).toEqual({ ok: true });
  });

  it('passes on a keyring holding exactly the active and the listed retired keys, in any order', () => {
    expect(
      evaluateBinaryIdentity({
        ...CANONICAL,
        derivedRecipients: [RETIRED_2, ACTIVE, RETIRED_1],
        retiredRecipients: [RETIRED_1, RETIRED_2],
      }),
    ).toEqual({ ok: true });
  });

  it('fails when the active key is missing from the keyring', () => {
    const verdict = evaluateBinaryIdentity({
      ...CANONICAL,
      derivedRecipients: [RETIRED_1],
      retiredRecipients: [RETIRED_1],
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.failures.join(' ')).toMatch(/missing.*BINARY_AGE_RECIPIENT/);
      expect(verdict.failures.join(' ')).toContain(ACTIVE);
    }
  });

  it('fails when a listed retired key is missing from the keyring', () => {
    // Without it, everything written under that key is unreadable in the
    // app (AC-515) — the probe must not let the deploy serve.
    const verdict = evaluateBinaryIdentity({ ...CANONICAL, retiredRecipients: [RETIRED_1] });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.failures.join(' ')).toMatch(/missing.*BINARY_AGE_RETIRED_RECIPIENTS/);
      expect(verdict.failures.join(' ')).toContain(RETIRED_1);
    }
  });

  it('fails when the keyring holds a key that is configured neither as active nor as retired', () => {
    // The backup drill identity pasted alongside the binary keyring.
    const verdict = evaluateBinaryIdentity({
      ...CANONICAL,
      derivedRecipients: [ACTIVE, STRANGER],
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.failures.join(' ')).toMatch(/unlisted/);
      expect(verdict.failures.join(' ')).toContain(STRANGER);
    }
  });

  it('ignores a retired entry listed twice and the active key listed as retired', () => {
    expect(
      evaluateBinaryIdentity({
        ...CANONICAL,
        derivedRecipients: [ACTIVE, RETIRED_1],
        retiredRecipients: [RETIRED_1, RETIRED_1, ACTIVE],
      }),
    ).toEqual({ ok: true });
  });

  it('reports a missing and an unlisted key together', () => {
    const verdict = evaluateBinaryIdentity({
      ...CANONICAL,
      derivedRecipients: [ACTIVE, STRANGER],
      retiredRecipients: [RETIRED_1],
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.failures).toHaveLength(2);
      expect(verdict.failures.join(' ')).toContain(RETIRED_1);
      expect(verdict.failures.join(' ')).toContain(STRANGER);
    }
  });

  it('fails when the identity file is absent', () => {
    const verdict = evaluateBinaryIdentity({ ...CANONICAL, fileExists: false });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      // Error message names the offending check so an operator log
      // line points at the next action (paste the identity).
      expect(verdict.failures.join(' ')).toMatch(/identity.*not.*loaded|identity.*absent/i);
    }
  });

  it('fails when the identity file is present but unreadable', () => {
    // Perms drift on the tmpfs mount — root-only tmpfs containing a file
    // not readable by the running uid. Failure must be distinct from
    // "file absent" so the operator can diagnose perms.
    const verdict = evaluateBinaryIdentity({ ...CANONICAL, fileReadable: false });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.failures.join(' ')).toMatch(/unreadable|permission/i);
    }
  });

  it('fails when the identity is present but malformed (age-keygen -y rejected it)', () => {
    // The orchestrator captures `derivedRecipients = null` when the
    // round-trip via `age-keygen -y` exits non-zero. The validator
    // must surface that as a failure naming `age-keygen` so the
    // operator knows the paste was corrupt or the wrong format.
    const verdict = evaluateBinaryIdentity({ ...CANONICAL, derivedRecipients: null });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.failures.join(' ')).toMatch(/age-keygen|malformed|round-trip/i);
    }
  });

  it('fails when the derived recipient does not match BINARY_AGE_RECIPIENT (wrong identity loaded)', () => {
    // The most common operator error per `docs/ops/binary-key/load.md`:
    // pasting the backup drill identity into the binary loader (or
    // vice versa). The probe rejects before any wrap takes place.
    const verdict = evaluateBinaryIdentity({ ...CANONICAL, derivedRecipients: [STRANGER] });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.failures.join(' ')).toMatch(/missing.*BINARY_AGE_RECIPIENT/);
      expect(verdict.failures.join(' ')).toMatch(/unlisted/);
    }
  });

  it('aggregates multiple offences into one verdict (no fail-fast)', () => {
    // Same shape as `assertStorageBucketSafe` aggregation: an operator
    // fielding the failure should see every defect at once, not iterate
    // through fix-and-redeploy cycles. Seed two independently-observable
    // arms — `fileReadable: false` (perms drift) AND derived/configured
    // recipient mismatch — so the validator must surface both, not just
    // the first one it hits. (`>= 1` would be tautological with
    // `verdict.ok === false`; `>= 2` is the actual aggregation contract.)
    const verdict = evaluateBinaryIdentity({
      fileExists: true,
      fileReadable: false,
      derivedRecipients: ['age1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      configuredRecipient: 'age1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      retiredRecipients: [],
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      // Two independent defects → at least two failure entries.
      expect(verdict.failures.length).toBeGreaterThanOrEqual(2);
    }
  });
});

// ---------------------------------------------------------------------
// assertBinaryIdentityLoaded — IO orchestrator.
// Reads the file, runs `age-keygen -y`, builds the snapshot, calls the
// validator. Throws the aggregated error at the boot site.
// ---------------------------------------------------------------------

describe('AC-438: binary-identity boot probe — orchestration', () => {
  function withTempIdentity<T>(body: (filePath: string) => Promise<T> | T): Promise<T> {
    // Each arm gets its own tmp dir so parallel runs don't trample
    // each other's fixture. `os.tmpdir()` is always writable in the
    // dev container.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'binary-identity-probe-'));
    const filePath = path.join(dir, 'identity');
    return Promise.resolve(body(filePath)).finally(() => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup; the OS will GC tmp on reboot.
      }
    });
  }

  /**
   * Generate a real age identity via `age-keygen` and return both halves.
   * Used to drive the orchestrator with a known-good fixture.
   */
  function freshAgeIdentity(): { identity: string; recipient: string } {
    const identity = execFileSync('age-keygen', { encoding: 'utf-8' }).trim();
    const recipient = execFileSync('age-keygen', ['-y'], {
      input: identity,
      encoding: 'utf-8',
    }).trim();
    return { identity, recipient };
  }

  it('throws when the identity file does not exist (refusing to start)', async () => {
    await withTempIdentity(async (filePath) => {
      // Path under tmp but never created — the probe must throw.
      await expect(
        assertBinaryIdentityLoaded({
          identityPath: filePath,
          configuredRecipient: 'age1xyz',
          ...FAIL_FAST_OPTIONS,
        }),
      ).rejects.toThrow(/Refusing to start/);
    });
  });

  it('throws when the file is present but unreadable by the process', async () => {
    await withTempIdentity(async (filePath) => {
      writeFileSync(filePath, 'AGE-SECRET-KEY-1...\n', { mode: 0o000 });
      try {
        // Mode 0 hides the file from this uid; the probe must fail.
        // (When the test runs as root and `chmod 0` is bypassed, this
        // arm degrades to "file present + age-keygen rejects" — see
        // the next test. The split is the right shape: a perms drift
        // on a non-root operator account is the production-realistic
        // case the probe targets.)
        //
        // No FAIL_FAST_OPTIONS needed — `fileExists=true` triggers
        // the orchestrator's hard-failure-no-wait branch.
        await expect(
          assertBinaryIdentityLoaded({
            identityPath: filePath,
            configuredRecipient: 'age1xyz',
          }),
        ).rejects.toThrow(/Refusing to start/);
      } finally {
        chmodSync(filePath, 0o600); // restore so the cleanup can rm
      }
    });
  });

  it('throws when the file content fails the `age-keygen -y` round-trip (malformed identity)', async () => {
    await withTempIdentity(async (filePath) => {
      writeFileSync(filePath, 'this-is-not-an-age-identity\n', { mode: 0o400 });
      // Hard failure → no wait needed.
      await expect(
        assertBinaryIdentityLoaded({
          identityPath: filePath,
          configuredRecipient: 'age1xyz',
        }),
      ).rejects.toThrow(/Refusing to start.*age-keygen|Refusing to start.*malformed/s);
    });
  });

  it('throws when the derived recipient does not match the configured one (wrong identity loaded)', async () => {
    await withTempIdentity(async (filePath) => {
      const { identity } = freshAgeIdentity();
      writeFileSync(filePath, identity + '\n', { mode: 0o400 });
      // Configure with a *different* recipient so the round-trip output
      // mismatches. This is the "operator pasted the backup identity into
      // the binary loader" path documented in load.md / troubleshooting.md.
      // Hard failure → no wait needed.
      const wrongRecipient = 'age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
      await expect(
        assertBinaryIdentityLoaded({
          identityPath: filePath,
          configuredRecipient: wrongRecipient,
        }),
      ).rejects.toThrow(/Refusing to start.*missing the active key/);
    });
  });

  it('accepts a real multi-key keyring matching the active and retired recipients', async () => {
    await withTempIdentity(async (filePath) => {
      const active = freshAgeIdentity();
      const retired = freshAgeIdentity();
      writeFileSync(filePath, `${retired.identity}\n${active.identity}\n`, { mode: 0o400 });
      await assertBinaryIdentityLoaded({
        identityPath: filePath,
        configuredRecipient: active.recipient,
        retiredRecipients: [retired.recipient],
        ...FAIL_FAST_OPTIONS,
      });
    });
  });

  it('throws when a real keyring holds a key the deploy does not list as retired', async () => {
    await withTempIdentity(async (filePath) => {
      const active = freshAgeIdentity();
      const unlisted = freshAgeIdentity();
      writeFileSync(filePath, `${active.identity}\n${unlisted.identity}\n`, { mode: 0o400 });
      await expect(
        assertBinaryIdentityLoaded({
          identityPath: filePath,
          configuredRecipient: active.recipient,
          retiredRecipients: [],
          ...FAIL_FAST_OPTIONS,
        }),
      ).rejects.toThrow(new RegExp(`Refusing to start.*unlisted.*${unlisted.recipient}`));
    });
  });

  it('emits a structured error log line on failure (event identifier present in error)', async () => {
    // The boot site translates the thrown error into a non-zero exit;
    // the structured log line emitted right before the throw is the
    // operator's only diagnostic. Pin its shape — `event` field naming
    // the offending check — by asserting on the thrown error message
    // (the orchestrator's contract is "throw with a message containing
    // the event identifier so the boot site can log+exit with one
    // payload"). Same character as the storage-safety probe's
    // aggregated message.
    await withTempIdentity(async (filePath) => {
      // No file written — the absent-file arm is the simplest trigger.
      try {
        await assertBinaryIdentityLoaded({
          identityPath: filePath,
          configuredRecipient: 'age1xyz',
          ...FAIL_FAST_OPTIONS,
        });
        throw new Error('expected throw');
      } catch (err) {
        const msg = (err as Error).message;
        // Discriminator: identifies this probe in a log surface that
        // also carries `bucket-safety` and `capability-self-test`
        // failures. A regression that drops the identifier into a
        // generic message would mask which probe failed at boot.
        expect(msg).toMatch(/binary-identity/i);
      }
    });
  });
});

// ---------------------------------------------------------------------
// assertBinaryIdentityLoaded — bounded wait for absent-file arm.
//
// The production probe waits up to 5 minutes for the operator paste
// to land before declaring boot failure (see binaryIdentity.ts
// DEFAULT_WAIT_TIMEOUT_MS for rationale). Crash-restart loop the
// immediate-throw version produced under `restart: unless-stopped`
// killed the deploy script's docker-exec'd `load-binary-key`
// mid-`read` — regression observed 2026-05-03.
// ---------------------------------------------------------------------

describe('binary-identity boot probe — bounded wait for absent file', () => {
  function withTempDir<T>(body: (dirPath: string) => Promise<T> | T): Promise<T> {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'binary-identity-wait-'));
    return Promise.resolve(body(dir)).finally(() => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    });
  }

  function freshAgeIdentity(): { identity: string; recipient: string } {
    const identity = execFileSync('age-keygen', { encoding: 'utf-8' }).trim();
    const recipient = execFileSync('age-keygen', ['-y'], {
      input: identity,
      encoding: 'utf-8',
    }).trim();
    return { identity, recipient };
  }

  it('returns once the identity file appears mid-wait', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'identity');
      const { identity, recipient } = freshAgeIdentity();

      // Land the file 100ms in — well inside the 2s timeout.
      const writeAfterMs = 100;
      const writeTimer = setTimeout(() => {
        // Fire-and-forget; if the write fails, the probe times out
        // and the test fails with a clear timeout error.
        void writeFile(filePath, identity + '\n', { mode: 0o400 });
      }, writeAfterMs);

      try {
        await assertBinaryIdentityLoaded({
          identityPath: filePath,
          configuredRecipient: recipient,
          waitTimeoutMs: 2_000,
          pollIntervalMs: 25,
          progressLogIntervalMs: 0,
        });
      } finally {
        clearTimeout(writeTimer);
      }
    });
  });

  it('throws after the timeout when the file never appears', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'identity'); // never created
      const start = Date.now();
      await expect(
        assertBinaryIdentityLoaded({
          identityPath: filePath,
          configuredRecipient: 'age1xyz',
          waitTimeoutMs: 200,
          pollIntervalMs: 25,
          progressLogIntervalMs: 0,
        }),
      ).rejects.toThrow(/Refusing to start.*absent/s);
      const elapsed = Date.now() - start;
      // Asserts we actually waited (≥ timeout) and didn't loop
      // pathologically beyond it. Generous upper bound to absorb
      // CI scheduling jitter without flaking.
      expect(elapsed).toBeGreaterThanOrEqual(200);
      expect(elapsed).toBeLessThan(2_000);
    });
  });

  it('does not wait when the file is present but malformed', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'identity');
      writeFileSync(filePath, 'not-an-age-identity\n', { mode: 0o400 });

      const start = Date.now();
      await expect(
        assertBinaryIdentityLoaded({
          identityPath: filePath,
          configuredRecipient: 'age1xyz',
          // Even with a generous timeout, fileExists=true should short-
          // circuit straight to throw — perms / malformed / mismatch
          // never benefit from the wait window.
          waitTimeoutMs: 30_000,
          pollIntervalMs: 25,
          progressLogIntervalMs: 0,
        }),
      ).rejects.toThrow(/Refusing to start/);
      const elapsed = Date.now() - start;
      // Should be near-instant — well under any meaningful fraction
      // of the timeout. Tolerance picked to absorb CPU jitter on CI.
      expect(elapsed).toBeLessThan(500);
    });
  });

  it('does not wait when the file is present but recipient mismatches', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'identity');
      const { identity } = freshAgeIdentity();
      writeFileSync(filePath, identity + '\n', { mode: 0o400 });

      const start = Date.now();
      await expect(
        assertBinaryIdentityLoaded({
          identityPath: filePath,
          configuredRecipient: 'age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
          waitTimeoutMs: 30_000,
          pollIntervalMs: 25,
          progressLogIntervalMs: 0,
        }),
      ).rejects.toThrow(/Refusing to start.*missing the active key/);
      expect(Date.now() - start).toBeLessThan(500);
    });
  });

  it('emits an initial "waiting" log line and timeout suffix on failure', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'identity'); // never created
      const captured: string[] = [];

      try {
        await assertBinaryIdentityLoaded({
          identityPath: filePath,
          configuredRecipient: 'age1xyz',
          waitTimeoutMs: 1_500,
          pollIntervalMs: 50,
          // Force a progress log within the test window so we can
          // assert both the initial "waiting" line and at least one
          // periodic "still waiting" follow-up.
          progressLogIntervalMs: 500,
          logger: { info: (msg): void => void captured.push(msg) },
        });
      } catch (err) {
        // Expected — the file never appeared. Assert the message
        // names the probe + the elapsed wait so an operator log can
        // distinguish "probe never started" from "operator didn't
        // paste in time".
        const msg = (err as Error).message;
        expect(msg).toMatch(/binary-identity/);
        expect(msg).toMatch(/probe waited \d+s/);
      }

      // Initial "waiting up to N s" line + at least one periodic
      // "still waiting" follow-up.
      expect(captured.some((m) => /waiting up to \d+s/.test(m))).toBe(true);
      expect(captured.some((m) => /still waiting/.test(m))).toBe(true);
    });
  });
});
