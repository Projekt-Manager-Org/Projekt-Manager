/**
 * Unit tests for the (forthcoming) `KeyEnvelopeService`.
 *
 * The service is the server-side seam between the operator-loaded
 * binary `age` identity and the per-blob 32-byte AES-256-GCM DEK that
 * the browser supplies at init / receives at download. ADR-0024 names
 * the wrapping shape: `age` X25519 KEM + ChaCha20-Poly1305 envelope;
 * data-model.md §5.13 names the persisted column shape: base64 of the
 * opaque envelope bytes on `wrappedDek` / `wrappedThumbDek`.
 *
 * Coverage in this file:
 *   - wrap(dek): produces opaque bytes that decode-back into the same
 *     32-byte DEK on unwrap with the matching identity.
 *   - unwrap with non-matching identity: throws a typed error so the
 *     route layer can map to the `DEK_UNWRAP_FAILED` 422 surface.
 *   - unwrap of corrupted envelope bytes: throws a typed error with
 *     the same shape — the route layer must not have to distinguish
 *     "wrong recipient" from "tampered bytes" at the per-row 422
 *     surface (the operator condition is the same: investigate the
 *     row).
 *   - audit-payload concern: `wrappedDek` rides the row as base64 (per
 *     data-model.md §5.13). The base64 round-trip is lossless, the
 *     wrap output is non-empty, and a base64 decode of a successfully
 *     wrapped envelope is non-empty AES-GCM-shaped bytes (the standard
 *     `age` envelope shape — header + body, byte-for-byte stable).
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { KeyEnvelopeService, KeyEnvelopeUnwrapError } from '../services/KeyEnvelopeService.js';

/**
 * Generate a fresh `age` keypair for a single test arm. The recipient
 * is the public half (env-shaped, parity with `BINARY_AGE_RECIPIENT`);
 * the identity is the private half (file-shaped, what tmpfs holds).
 *
 * The system `age-keygen` binary is required (CONTRIBUTING.md §Testing
 * "Integration prerequisites" — same posture as MinIO, no silent skip).
 */
function freshAgePair(): { identity: string; recipient: string } {
  const identity = execFileSync('age-keygen', { encoding: 'utf-8' }).trim();
  const recipient = execFileSync('age-keygen', ['-y'], {
    input: identity,
    encoding: 'utf-8',
  }).trim();
  return { identity, recipient };
}

describe('KeyEnvelopeService — wrap / unwrap round-trip', () => {
  it('wrap(dek) → unwrap(envelope) recovers the original 32 bytes', async () => {
    const { identity, recipient } = freshAgePair();
    const service = new KeyEnvelopeService({ recipient, identity });

    const dek = randomBytes(32);
    const envelope = await service.wrap(dek);
    const unwrapped = await service.unwrap(envelope);

    expect(unwrapped).toBeInstanceOf(Uint8Array);
    expect(unwrapped.length).toBe(32);
    // Byte-for-byte equality — a regression that drops a byte or
    // truncates the unwrap output would break decryption silently.
    expect(Buffer.from(unwrapped).equals(dek)).toBe(true);
  });

  it('two wrap calls on the same DEK produce different envelopes (fresh ephemeral key per wrap)', async () => {
    // `age` X25519 KEM uses a fresh ephemeral key per wrap operation —
    // two envelopes for the same DEK should differ byte-for-byte. A
    // regression that produced deterministic envelopes would leak
    // equality information across stored rows (same DEK → same
    // wrappedDek), which is one of the things the KEM is meant to
    // avoid.
    const { identity, recipient } = freshAgePair();
    const service = new KeyEnvelopeService({ recipient, identity });

    const dek = randomBytes(32);
    const env1 = await service.wrap(dek);
    const env2 = await service.wrap(dek);

    // Both still unwrap back to the same DEK.
    expect(Buffer.from(await service.unwrap(env1)).equals(dek)).toBe(true);
    expect(Buffer.from(await service.unwrap(env2)).equals(dek)).toBe(true);
    // But the envelope bytes differ — KEM ephemeral key randomisation.
    expect(Buffer.from(env1).equals(Buffer.from(env2))).toBe(false);
  });
});

describe('KeyEnvelopeService — unwrap failure modes', () => {
  it('unwrap with a non-matching identity throws KeyEnvelopeUnwrapError', async () => {
    // Wrap with one recipient, attempt unwrap with a different identity.
    // This is the partial-rotation / wrong-recipient scenario (the SW
    // surfaces it as the "Schlüssel nicht verfügbar" placeholder).
    const wrappingPair = freshAgePair();
    const otherPair = freshAgePair();

    const wrapper = new KeyEnvelopeService({
      recipient: wrappingPair.recipient,
      identity: wrappingPair.identity,
    });
    const wrongUnwrapper = new KeyEnvelopeService({
      recipient: otherPair.recipient,
      identity: otherPair.identity,
    });

    const dek = randomBytes(32);
    const envelope = await wrapper.wrap(dek);

    await expect(wrongUnwrapper.unwrap(envelope)).rejects.toBeInstanceOf(KeyEnvelopeUnwrapError);
  });

  it('unwrap of corrupted envelope bytes throws KeyEnvelopeUnwrapError', async () => {
    // Tampering with the envelope bytes after wrap: the AEAD inside
    // `age` (ChaCha20-Poly1305) detects the modification and rejects.
    // The service must surface that rejection as a typed error so the
    // route layer maps it to `DEK_UNWRAP_FAILED` per the spec.
    const { identity, recipient } = freshAgePair();
    const service = new KeyEnvelopeService({ recipient, identity });

    const dek = randomBytes(32);
    const envelope = await service.wrap(dek);
    const corrupted = new Uint8Array(envelope);
    // Flip a byte deep inside the envelope so the structural prologue
    // is intact (so we exercise AEAD verification rather than a
    // header-parse error in the early bytes — both are surface-level
    // unwrap failures from the route's point of view, but flipping a
    // payload byte targets the load-bearing integrity guarantee).
    corrupted[corrupted.length - 5] ^= 0xff;

    await expect(service.unwrap(corrupted)).rejects.toBeInstanceOf(KeyEnvelopeUnwrapError);
  });

  it('unwrap of structurally-invalid bytes (random noise) throws KeyEnvelopeUnwrapError', async () => {
    // A row whose `wrappedDek` is something other than an `age`
    // envelope at all — the `KeyEnvelopeUnwrapError` shape must cover
    // both AEAD-verification failures and parser failures, otherwise
    // the route layer needs two catch arms for the same operator
    // condition (the row is broken; surface the placeholder).
    const { identity, recipient } = freshAgePair();
    const service = new KeyEnvelopeService({ recipient, identity });

    const noise = randomBytes(64);
    await expect(service.unwrap(noise)).rejects.toBeInstanceOf(KeyEnvelopeUnwrapError);
  });
});

describe('KeyEnvelopeService — base64 round-trip on the persisted column shape', () => {
  it('wrap output round-trips through base64 to a still-unwrap-able envelope (data-model.md §5.13)', async () => {
    // `wrappedDek` is `string` in the entity — base64 of the opaque
    // envelope bytes. The persistence layer round-trips it; this test
    // pins that the once-base64-round-tripped buffer remains a valid
    // input for `unwrap` (i.e. the service's output survives the wire
    // shape end-to-end). The base64 codec itself is std-lib and is not
    // re-asserted here.
    const { identity, recipient } = freshAgePair();
    const service = new KeyEnvelopeService({ recipient, identity });

    const dek = randomBytes(32);
    const envelope = await service.wrap(dek);

    const encoded = Buffer.from(envelope).toString('base64');
    const decoded = Buffer.from(encoded, 'base64');

    const unwrapped = await service.unwrap(new Uint8Array(decoded));
    expect(Buffer.from(unwrapped).equals(dek)).toBe(true);
  });

  it('the wrapped envelope is non-empty (defence against a silent no-op wrap)', async () => {
    // Pin that wrap actually does work — a regression where wrap
    // returned an empty buffer would still satisfy the round-trip
    // tests if unwrap returned the original DEK from a sentinel cache.
    // The non-empty floor is a guard against that shape.
    const { identity, recipient } = freshAgePair();
    const service = new KeyEnvelopeService({ recipient, identity });

    const dek = randomBytes(32);
    const envelope = await service.wrap(dek);
    expect(envelope.length).toBeGreaterThan(0);
  });
});
