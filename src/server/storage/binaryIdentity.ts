/**
 * Boot-time binary `age` keyring probe (ADR-0024 § Boot probe, § Key
 * rotation).
 *
 * The app refuses to start when the operator-loaded binary `age` keyring
 * is not available, or holds other keys than the configured ones — the
 * active recipient plus every retired one. Same character as `assertStorageBucketSafe`
 * for ADR-0022. Degraded modes ("uploads-yes-downloads-no", "fall back to
 * plaintext") are explicitly rejected: they would create a misleading-state
 * defect class (ADR-0014) and are unnecessary in a single-operator topology
 * where the boot gate aligns "identity loaded?" with "user can see
 * attachments?".
 *
 * Mirrors `storage/safety.ts`:
 *   - `evaluateBinaryIdentity` is a pure validator over a structured
 *     snapshot of {file present?, readable?, derived recipients?,
 *     configured recipients?}. Each fail-path can be unit-tested without
 *     touching the filesystem or spawning age-keygen.
 *   - `assertBinaryIdentityLoaded` is the orchestrator: it checks the
 *     file, runs `age-keygen -y` (system binary at `/usr/bin/age-keygen`,
 *     verified present in the dev image and the prod app image), builds
 *     the snapshot, calls the validator, and throws an aggregated error
 *     at the boot site.
 *
 * Aggregation contract: every defect detectable from the snapshot
 * surfaces in the verdict's `failures` list — no fail-fast. An operator
 * fielding a failed boot sees every offending arm in one structured
 * message and fixes them in one round, not one redeploy per defect.
 * Mirrors the storage-safety probe's aggregation shape.
 */

import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

/**
 * Path to the system `age-keygen` binary. Pinned absolute so a
 * compromised `$PATH` cannot redirect the round-trip — the boot probe is
 * a security-critical surface.
 */
export const AGE_KEYGEN_BIN = '/usr/bin/age-keygen';

/**
 * Spawn `age-keygen -y` and pipe `input` to its stdin. Resolves to the
 * derived recipients — one stdout line per identity in the keyring — on
 * success, or `null` on any non-zero exit / spawn error / empty output
 * (the validator's "round-trip rejected" arm). We use `spawn`
 * rather than `execFile + promisify` because Node's promisified
 * `execFile` does not surface the `input` option from the callback API,
 * and writing the secret material to a temp file just to feed argv would
 * defeat the tmpfs-only invariant for no benefit.
 */
function runAgeKeygenY(input: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    const child = spawn(AGE_KEYGEN_BIN, ['-y'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    let settled = false;
    const settle = (value: string[] | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', () => settle(null));
    child.on('close', (code) => {
      if (code === 0) {
        const recipients = stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        settle(recipients.length === 0 ? null : recipients);
      } else {
        settle(null);
      }
    });
    child.stdin.on('error', () => settle(null));
    child.stdin.end(input);
  });
}

/**
 * Discriminator embedded in the thrown error so a multi-probe boot log
 * surface (this probe + bucket-safety + capability self-test) can route
 * the failure to the right operator runbook entry. Asserted by the
 * orchestrator's "structured error log line" test.
 */
export const PROBE_EVENT_ID = 'binary-identity';

/**
 * Snapshot of the inputs the validator needs. Decoupled from the IO
 * orchestrator so each branch is unit-testable as a pure function. The
 * snapshot mirrors the {versioning, objectLock, lifecycleRules} shape
 * `evaluateBucketSafety` consumes.
 *
 * `derivedRecipients: null` encodes "the file content failed the
 * `age-keygen -y` round-trip" — distinct from "keyring mismatch", so
 * the validator can produce a failure message naming `age-keygen` for
 * the malformed-paste path and a different message for the
 * wrong-identity-loaded path.
 */
export interface BinaryIdentitySnapshot {
  /** Did `fs.access(F_OK)` on the configured path succeed? */
  fileExists: boolean;
  /** Did `fs.access(R_OK)` on the configured path succeed? */
  fileReadable: boolean;
  /**
   * The public recipients derived by round-tripping the file's content
   * through `age-keygen -y`, one per identity in the keyring. `null` when:
   *   - the file could not be read (orchestrator skipped the round-trip), OR
   *   - `age-keygen -y` exited non-zero (malformed identity content).
   * The validator uses the null state to name the offending check
   * ("age-keygen rejected the round-trip") rather than blurring it into
   * a generic "keyring mismatch".
   */
  derivedRecipients: string[] | null;
  /** The active public recipient from `BINARY_AGE_RECIPIENT`. */
  configuredRecipient: string;
  /** The retired public recipients from `BINARY_AGE_RETIRED_RECIPIENTS`. */
  retiredRecipients: readonly string[];
}

export type BinaryIdentityVerdict = { ok: true } | { ok: false; failures: string[] };

/**
 * Pure validator. Returns the canonical pass / fail verdict — every
 * defect is a hard failure (ADR-0024 prescribes a single canonical boot
 * gate; degraded modes are rejected up front).
 *
 * Aggregation rule: every detectable defect is appended; the function
 * does NOT short-circuit on the first failure. Same character as
 * `evaluateBucketSafety` — operators see every offending arm at once.
 */
export function evaluateBinaryIdentity(snapshot: BinaryIdentitySnapshot): BinaryIdentityVerdict {
  const failures: string[] = [];

  if (!snapshot.fileExists) {
    failures.push(
      'binary `age` identity not loaded: file at BINARY_AGE_IDENTITY_PATH is absent. ' +
        'Run scripts/binary-key/load-binary-key.sh on the VPS to paste the binary keyring into tmpfs.',
    );
  } else if (!snapshot.fileReadable) {
    // Distinct from "absent" so the operator log points at perms drift,
    // not at a missing paste — the diagnostic actions diverge.
    failures.push(
      'binary `age` identity unreadable: file exists at BINARY_AGE_IDENTITY_PATH but the running ' +
        'process lacks read permission. Check the tmpfs mount mode and the running uid.',
    );
  }

  // Round-trip / recipient checks only make sense when the file was
  // actually read; we still surface them when applicable so the
  // aggregation contract holds even in the file-readable + everything-
  // else-broken case.
  if (snapshot.derivedRecipients === null && snapshot.fileExists && snapshot.fileReadable) {
    failures.push(
      'binary `age` identity malformed: the file content failed the `age-keygen -y` round-trip. ' +
        'The pasted material is not a valid age private identity (expected an `AGE-SECRET-KEY-1...` line).',
    );
  }

  // Set equality, checked both ways: a configured key missing from the
  // keyring leaves everything wrapped to it unreadable; an unlisted key
  // is a mispaste (most often the backup drill identity).
  if (snapshot.derivedRecipients !== null) {
    const derived = new Set(snapshot.derivedRecipients);
    const configured = new Set([snapshot.configuredRecipient, ...snapshot.retiredRecipients]);
    if (!derived.has(snapshot.configuredRecipient)) {
      failures.push(
        `binary \`age\` keyring mismatch: missing the active key — BINARY_AGE_RECIPIENT ` +
          `"${snapshot.configuredRecipient}" is not in the keyring. The wrong identity was ` +
          `pasted into the binary loader.`,
      );
    }
    for (const retired of new Set(snapshot.retiredRecipients)) {
      if (retired !== snapshot.configuredRecipient && !derived.has(retired)) {
        failures.push(
          `binary \`age\` keyring mismatch: missing a retired key — ` +
            `BINARY_AGE_RETIRED_RECIPIENTS lists "${retired}", the keyring lacks it. Everything ` +
            `wrapped to it would be unreadable — paste the full keyring.`,
        );
      }
    }
    for (const recipient of derived) {
      if (!configured.has(recipient)) {
        failures.push(
          `binary \`age\` keyring mismatch: unlisted key "${recipient}" — neither ` +
            `BINARY_AGE_RECIPIENT nor BINARY_AGE_RETIRED_RECIPIENTS names it ` +
            `(common operator error: pasting the backup drill identity).`,
        );
      }
    }
  }

  return failures.length === 0 ? { ok: true } : { ok: false, failures };
}

/**
 * Default upper bound on how long `assertBinaryIdentityLoaded` waits
 * for the absent identity file to appear before treating its absence
 * as a hard failure. 5 minutes — well within ADR-0024's "operator
 * reachable within minutes" assumption, and far longer than the
 * crash-restart cadence (~10-15s/iteration) the immediate-throw
 * version produced when paired with `restart: unless-stopped`. The
 * loop+restart combo killed the deploy script's `docker exec`'d
 * `load-binary-key` mid-`read` (regression observed 2026-05-03 in
 * the 148-binary-e2e deploy).
 */
export const DEFAULT_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Default poll cadence while waiting. `fs.access` on a tmpfs is
 * cheap; 2s is fast enough that the app boots promptly after the
 * operator paste lands and slow enough to keep noise out of strace.
 */
export const DEFAULT_POLL_INTERVAL_MS = 2_000;

/**
 * Default cadence for "still waiting" progress log lines. Operators
 * see steady progress in `docker logs` without flooding the log
 * surface; 30s strikes the balance.
 */
export const DEFAULT_PROGRESS_LOG_INTERVAL_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build a fresh `BinaryIdentitySnapshot` by inspecting the
 * filesystem. Extracted from the orchestrator so the wait loop can
 * re-run it cheaply per tick without re-reading the constant
 * configured recipients from anywhere.
 */
async function captureSnapshot(
  identityPath: string,
  configuredRecipient: string,
  retiredRecipients: readonly string[],
): Promise<BinaryIdentitySnapshot> {
  // Two separate probes (F_OK then R_OK) so the snapshot can
  // distinguish "missing" from "perms drift" — the operator
  // diagnostics differ.
  let fileExists = false;
  let fileReadable = false;
  try {
    await access(identityPath, fsConstants.F_OK);
    fileExists = true;
  } catch {
    // Fall through with fileExists=false; the validator reports
    // the absent-file failure.
  }

  if (fileExists) {
    try {
      await access(identityPath, fsConstants.R_OK);
      fileReadable = true;
    } catch {
      // Fall through with fileReadable=false.
    }
  }

  // Round-trip via age-keygen -y is only attempted when the file is
  // actually readable — otherwise derivedRecipients stays null and the
  // validator surfaces the file-level failure instead of a noisy
  // "age-keygen rejected: ENOENT" stack.
  let derivedRecipients: string[] | null = null;
  if (fileExists && fileReadable) {
    try {
      const content = await readFile(identityPath, 'utf-8');
      // Pipe content via stdin. The drill-key loader passes the file
      // path as argv to `age-keygen -y`; piping via stdin keeps the
      // secret material out of `ps`/argv surface and matches what
      // integration-setup.ts already uses for its keypair derivation.
      derivedRecipients = await runAgeKeygenY(content);
    } catch {
      // readFile failed despite R_OK passing earlier — treat as a
      // round-trip failure so the validator surfaces a recognizable
      // arm.
      derivedRecipients = null;
    }
  }

  return { fileExists, fileReadable, derivedRecipients, configuredRecipient, retiredRecipients };
}

export interface AssertBinaryIdentityOptions {
  identityPath: string;
  configuredRecipient: string;
  /** `BINARY_AGE_RETIRED_RECIPIENTS`. Default: none. */
  retiredRecipients?: readonly string[];
  /**
   * Maximum time to wait for the identity file to appear when its
   * absence is the *only* outstanding failure. Default:
   * {@link DEFAULT_WAIT_TIMEOUT_MS} (5 minutes). Set to `0` for the
   * original fail-fast behavior — used by tests to exercise the
   * absent-file arm without paying for the wait window.
   *
   * Hard failures — perms drift, malformed identity, keyring
   * mismatch — throw immediately regardless of this value: those
   * arms cannot fix themselves with time, and waiting just delays
   * the operator's diagnostic.
   */
  waitTimeoutMs?: number;
  /**
   * Interval between filesystem polls while waiting. Default:
   * {@link DEFAULT_POLL_INTERVAL_MS} (2 seconds).
   */
  pollIntervalMs?: number;
  /**
   * Interval between "still waiting" progress log lines. Default:
   * {@link DEFAULT_PROGRESS_LOG_INTERVAL_MS} (30 seconds). Set to
   * `0` to disable progress logs entirely (used by tests to keep
   * test output clean).
   */
  progressLogIntervalMs?: number;
  /**
   * Logger sink for progress lines. Defaults to bare `console.log`.
   * Tests pass a no-op or capturing logger.
   */
  logger?: { info: (msg: string) => void };
}

/**
 * Orchestrator. Polls the identity file at `identityPath` for up to
 * `waitTimeoutMs`; on each tick, builds a `BinaryIdentitySnapshot`
 * and delegates to `evaluateBinaryIdentity`. Returns silently on the
 * first ok verdict. Throws an aggregated error when:
 *   - the snapshot reports any HARD failure (file present but
 *     unreadable, malformed, or keyring mismatch) — those throw
 *     immediately, no wait, since they need operator action not
 *     time;
 *   - the wait window elapses with the file still absent — the
 *     timeout case carries the elapsed-seconds in the message tail
 *     so the operator log distinguishes "you didn't paste" from
 *     "the identity was wrong".
 *
 * The error message includes the `binary-identity` event identifier
 * so the boot site's catch handler can log+exit with one payload.
 * Mirrors the "Refusing to start: ..." message shape from
 * `assertStorageBucketSafe`.
 */
export async function assertBinaryIdentityLoaded(
  options: AssertBinaryIdentityOptions,
): Promise<void> {
  const {
    identityPath,
    configuredRecipient,
    retiredRecipients = [],
    waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    progressLogIntervalMs = DEFAULT_PROGRESS_LOG_INTERVAL_MS,
    logger = { info: (msg: string): void => console.log(msg) },
  } = options;

  const startTime = Date.now();
  const waitDeadline = startTime + waitTimeoutMs;
  let nextProgressLogAt = startTime + progressLogIntervalMs;
  let initialWaitLogEmitted = false;
  let timedOut = false;
  // Definite-assignment: every non-`return` exit from the loop below
  // assigns `lastNonOkVerdict` before breaking, so the post-loop read
  // at the throw site is reached only after at least one iteration.
  let lastNonOkVerdict!: { ok: false; failures: string[] };

  while (true) {
    const snapshot = await captureSnapshot(identityPath, configuredRecipient, retiredRecipients);
    const verdict = evaluateBinaryIdentity(snapshot);
    if (verdict.ok) {
      return;
    }
    lastNonOkVerdict = verdict;

    // Hard failures don't fix themselves with time — surface
    // immediately so the operator sees the diagnostic now, not after
    // a five-minute wait. Only the absent-file arm benefits from
    // the wait window.
    if (snapshot.fileExists) {
      break;
    }

    if (Date.now() >= waitDeadline) {
      timedOut = true;
      break;
    }

    if (!initialWaitLogEmitted) {
      const timeoutSec = Math.floor(waitTimeoutMs / 1000);
      logger.info(
        `${PROBE_EVENT_ID} probe: waiting up to ${timeoutSec}s for ${identityPath} ` +
          `(paste via load-binary-key)`,
      );
      initialWaitLogEmitted = true;
    } else if (progressLogIntervalMs > 0 && Date.now() >= nextProgressLogAt) {
      const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
      const remainingSec = Math.max(0, Math.floor((waitDeadline - Date.now()) / 1000));
      logger.info(
        `${PROBE_EVENT_ID} probe: still waiting for ${identityPath} ` +
          `(${elapsedSec}s elapsed, ${remainingSec}s remaining)`,
      );
      nextProgressLogAt = Date.now() + progressLogIntervalMs;
    }

    await sleep(pollIntervalMs);
  }

  // Aggregated throw — same character as `assertStorageBucketSafe`'s
  // message. The first failure is inlined into the header so the
  // primary diagnostic ("keyring mismatch", "file absent", etc.)
  // sits on the same line as "Refusing to start" — operator-grep
  // ergonomics, and it lets dotall-less regex assertions in callers
  // / tests still match. Subsequent failures (when present) are
  // bulleted below. The `binary-identity` event token is
  // load-bearing: tests pin it, and it routes the failure in a
  // multi-probe boot log surface.
  const failures = lastNonOkVerdict.failures.slice();
  if (timedOut) {
    const waitedSec = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
    if (waitedSec > 0 && failures.length > 0) {
      failures[0] = `${failures[0]} (probe waited ${waitedSec}s for the file to appear)`;
    }
  }
  const [first, ...rest] = failures;
  const tail = rest.length === 0 ? '' : `\n${rest.map((f) => `  - ${f}`).join('\n')}`;
  throw new Error(
    `Refusing to start: ${PROBE_EVENT_ID} probe failed (ADR-0024) — ${first}${tail}\n` +
      `See docs/ops/binary-key/load.md.`,
  );
}
