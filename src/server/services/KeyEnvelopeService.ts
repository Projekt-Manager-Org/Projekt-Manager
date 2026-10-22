/**
 * Key envelope service — the server-side seam between the operator-loaded
 * binary `age` identity and the per-blob 32-byte AES-256-GCM DEK that the
 * browser supplies at init / receives at download (ADR-0024).
 *
 * Wraps the DEK once at init under the operator's binary `age` X25519
 * recipient and persists the opaque envelope on the attachment row as
 * `wrappedDek` (and, for photos, `wrappedThumbDek`); unwraps on demand
 * during `download-url` / `bulk-fetch` so the SW can decrypt B2 ciphertext.
 * The unwrapped DEK is never persisted server-side — its lifetime is
 * bounded by the request scope.
 *
 * Wraps the standard `age` binary (verified present at /usr/bin/age) via
 * `execFile` with explicit args; never constructs a shell string with
 * user input. The recipient is a public string and is safe to log; the
 * identity path resolves to a tmpfs-loaded private file the operator
 * paste's during boot (mirroring `scripts/backup/load-drill-key.sh`).
 *
 * Failure shape: `KeyEnvelopeUnwrapError` is thrown for every
 * unwrap-side fault — wrong recipient (partial rotation), corrupted
 * envelope bytes (AEAD verify), structurally-invalid input (header
 * parse). The caller need not distinguish these — the route layer
 * surfaces `DEK_UNWRAP_FAILED` 422 on download-url and the SW renders the AC-244 "Schlüssel
 * nicht verfügbar" placeholder. `wrap` failures throw the underlying
 * error (operator-side condition: missing recipient, broken `age`
 * binary, malformed identity file); they're not part of the per-row
 * 422 surface.
 */

import { execFile } from 'node:child_process';

/**
 * Typed unwrap failure. Thrown for every failure mode of `unwrap()` so
 * the route layer maps to a single error code without distinguishing
 * "wrong recipient" vs "tampered bytes" vs "structurally invalid" —
 * the operator condition is the same (the row is broken; surface the
 * placeholder, investigate the row).
 */
export class KeyEnvelopeUnwrapError extends Error {
  /**
   * Underlying cause of the unwrap failure (Error or pg-style code-bearing
   * object). Assigned via the field rather than the `Error(message,
   * { cause })` 2-arg constructor because the project's tsconfig targets
   * ES2020 (the cause-aware Error constructor is ES2022). Same observable
   * shape — `err.cause` survives — without bumping the target.
   */
  readonly cause?: unknown;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'KeyEnvelopeUnwrapError';
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/**
 * Constructor input. Both fields are required; tests instantiate the
 * service with a per-arm fresh keypair, production wires
 * `BINARY_AGE_RECIPIENT` (env) and `BINARY_AGE_IDENTITY_PATH` (env, with
 * the file resident on tmpfs).
 *
 * `recipient` is the public X25519 recipient string (e.g.
 * `age1abc...`). Not used by `unwrap` — `age --decrypt` derives the
 * recipient from the identity at decode time — but stored on the
 * service so a future "verify-recipient-matches" assertion has the
 * value handy without a re-read of env.
 *
 * `identity` is the private identity material itself (the
 * `AGE-SECRET-KEY-1...` line). The service writes this to a
 * per-instance temp file at construction time so `age --decrypt -i
 * <path>` can read it; the file is mode 0600 and removed on `close()`.
 * Callers must invoke `close()` (typically via try/finally) — a thrown
 * arm before close leaves the tempfile in `os.tmpdir()` until the OS
 * tmpfs reaper sweeps it. The alternative — accepting the file path
 * directly — is offered via the static factory below for the production
 * wire-up where the operator already loaded the identity onto tmpfs.
 *
 * The two construction shapes share an internal representation: an
 * absolute filesystem path that `age --decrypt -i` consumes. Tests use
 * the inline-identity shape (so each arm can mint a fresh keypair
 * without going through tmpfs); production uses the path shape.
 */
export interface KeyEnvelopeServiceInputInline {
  recipient: string;
  identity: string;
}

export interface KeyEnvelopeServiceInputPath {
  recipient: string;
  identityPath: string;
}

export type KeyEnvelopeServiceInput = KeyEnvelopeServiceInputInline | KeyEnvelopeServiceInputPath;

import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const AGE_BINARY = '/usr/bin/age';

export class KeyEnvelopeService {
  private readonly recipient: string;
  /**
   * Absolute path to the identity file `age --decrypt -i` reads. For
   * the inline-identity construction shape this is a per-instance
   * tempfile owned by this service; for the path shape it points at
   * the operator-loaded tmpfs file. Owned-vs-borrowed is tracked by
   * `ownsIdentityFile` so `close()` only removes files this service
   * created.
   */
  private readonly identityPath: string;
  private readonly identityTempDir: string | null;
  private readonly ownsIdentityFile: boolean;

  constructor(input: KeyEnvelopeServiceInput) {
    if (!input.recipient || input.recipient.length === 0) {
      throw new Error('KeyEnvelopeService: recipient is required');
    }
    this.recipient = input.recipient;

    if ('identity' in input) {
      // Inline-identity shape — write to a per-instance temp dir so
      // concurrent service instances do not collide on a shared file
      // path. The directory is mode-0700 by mkdtemp default; the
      // identity file inside is mode-0600. This service owns both and
      // removes them on `close()`.
      if (!input.identity || input.identity.length === 0) {
        throw new Error('KeyEnvelopeService: identity is required');
      }
      this.identityTempDir = mkdtempSync(path.join(os.tmpdir(), 'projekt-manager-key-envelope-'));
      this.identityPath = path.join(this.identityTempDir, 'identity');
      // Trailing newline: the `age` parser is forgiving but the
      // canonical identity files emitted by `age-keygen` end in `\n`.
      // Match that convention so a regex-based future audit cannot
      // claim the service writes a malformed file.
      const payload = input.identity.endsWith('\n') ? input.identity : input.identity + '\n';
      writeFileSync(this.identityPath, payload, { mode: 0o600 });
      this.ownsIdentityFile = true;
    } else {
      if (!input.identityPath || input.identityPath.length === 0) {
        throw new Error('KeyEnvelopeService: identityPath is required');
      }
      this.identityPath = input.identityPath;
      this.identityTempDir = null;
      this.ownsIdentityFile = false;
    }
  }

  /**
   * Wrap a 32-byte DEK under the configured recipient. Returns the
   * opaque envelope bytes (`age` header + ChaCha20-Poly1305 body — the
   * standard `age` envelope shape). Bytes are written to stdin; the
   * subprocess's stdout is collected and returned verbatim.
   *
   * Throws on subprocess error (non-zero exit, missing binary, etc.).
   * The wrap path is NOT user-tampered input — failures are operator
   * conditions, not per-row 422.
   */
  async wrap(dek: Uint8Array): Promise<Uint8Array> {
    if (dek.length !== 32) {
      throw new Error(`KeyEnvelopeService.wrap: expected 32-byte DEK, got ${dek.length}`);
    }
    return runAge(['--recipient', this.recipient], dek);
  }

  /**
   * Unwrap an opaque envelope back to the original 32-byte DEK using
   * the configured identity. Wraps every failure mode in
   * `KeyEnvelopeUnwrapError` so the route layer maps to one error
   * code regardless of underlying cause (recipient mismatch / AEAD
   * verify failure / parser failure all reduce to "row is broken;
   * surface the placeholder").
   *
   * The output length is asserted to be 32 — `age` itself does not
   * promise the wrapped payload was exactly the DEK we passed in (the
   * wrap surface would have rejected non-32-byte input upstream), but
   * a regression that passed unwrap a foreign envelope holding a
   * different-length payload would otherwise return that payload
   * verbatim and break crypto downstream silently. Keep the assertion
   * as a defence-in-depth tripwire.
   */
  async unwrap(envelope: Uint8Array): Promise<Uint8Array> {
    let result: Uint8Array;
    try {
      result = await runAge(['--decrypt', '-i', this.identityPath], envelope);
    } catch (err) {
      throw new KeyEnvelopeUnwrapError(`failed to unwrap age envelope: ${errorMessage(err)}`, {
        cause: err,
      });
    }
    if (result.length !== 32) {
      throw new KeyEnvelopeUnwrapError(
        `unwrap produced unexpected payload length: ${result.length} (expected 32)`,
      );
    }
    return result;
  }

  /**
   * Release any temp-file resources owned by this service. Idempotent;
   * safe to call multiple times. Production wires the per-request
   * service to a request-scoped lifecycle (no temp file involved); the
   * inline-identity shape used by tests creates a per-instance
   * tempfile that this method removes.
   */
  close(): void {
    if (!this.ownsIdentityFile) return;
    try {
      unlinkSync(this.identityPath);
    } catch {
      // Already gone — fine.
    }
    if (this.identityTempDir) {
      try {
        rmdirSync(this.identityTempDir);
      } catch {
        // Already gone or non-empty — fine; tmpfs / OS reaper handles
        // the leftover.
      }
    }
  }
}

/**
 * Run `/usr/bin/age` with the supplied args, piping `stdin` in and
 * collecting stdout. Resolves to the stdout bytes; rejects with an
 * Error carrying the captured stderr on non-zero exit (or the spawn
 * error when the binary is missing).
 *
 * Implementation detail: `execFile` is the right primitive here —
 * args are passed as a discrete array (no shell), stdin/stdout are
 * binary buffers, and the whole call is awaitable. The default
 * `maxBuffer` (1 MB) is plenty for an `age` envelope wrapping a
 * 32-byte DEK — the envelope is ~200 bytes — and this code path
 * never sees larger payloads (bulk content travels browser-to-B2
 * directly per ADR-0024).
 */
function runAge(args: string[], stdin: Uint8Array): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    // The Buffer-encoding overload of `execFile` types `stdout`/`stderr`
    // as `Buffer`. Passing the options object inline trips a TS-2554
    // overload-resolution miss (it picks the string-encoding signature
    // and types the data params as `string`). The cleanest fix is to
    // type the callback explicitly.
    const child = execFile(
      AGE_BINARY,
      args,
      {
        // 4 MB is overkill for a key envelope but free; protects against
        // a future caller that streams something larger through (e.g.
        // an unwrap of a row that was tampered to expand past 1 MB).
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'buffer',
      } as const,
      (err: Error | null, stdout: Buffer | string, stderr: Buffer | string) => {
        if (err) {
          // Surface stderr cue alongside the spawn error — `age`
          // prints "no identity matched" / "header parse failed" /
          // similar to stderr, and the unwrap path's caller catches
          // and re-wraps as KeyEnvelopeUnwrapError so the cue lands
          // in the cause chain.
          const stderrText = Buffer.isBuffer(stderr)
            ? stderr.toString('utf-8').trim()
            : String(stderr ?? '').trim();
          const wrapped = new Error(stderrText ? `${err.message}: ${stderrText}` : err.message);
          // `cause` field assignment mirrors KeyEnvelopeUnwrapError above —
          // ES2020 target predates the 2-arg Error constructor. Same
          // observable behaviour without raising the target.
          (wrapped as { cause?: unknown }).cause = err;
          reject(wrapped);
          return;
        }
        const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
        resolve(new Uint8Array(buf));
      },
    );
    if (child.stdin) {
      child.stdin.end(Buffer.from(stdin));
    }
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : typeof err === 'string' ? err : 'unknown';
}
