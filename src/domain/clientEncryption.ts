/**
 * Browser-side AES-256-GCM helpers for binary attachment e2e encryption
 * (ADR-0024 §Encryption, §DEK provenance).
 *
 * Contract pinned by `__tests__/clientEncryption.test.ts`:
 *   - DEK is 32 bytes from `crypto.getRandomValues`, fresh per attachment.
 *   - `encryptBlob` returns `nonce(12) || ciphertext || authTag(16)` —
 *     standard AES-GCM-with-prefixed-nonce; the nonce is NOT a separate
 *     field on the row (ADR-0024 §Encryption).
 *   - `decryptBlob` round-trips and verifies the auth tag; any tampering
 *     (nonce, body, tag, or wrong DEK) throws.
 *   - `encodeDekMaterial` / `decodeDekMaterial` are the base64 wire-format
 *     helpers used by `init` and `download-url`. The
 *     decoder rejects anything that does not decode to exactly 32 bytes
 *     so the AES-256 invariant fails close to the source.
 *
 * Pure crypto only — MD5 of the ciphertext (the `Content-MD5` body-match
 * guarantee on the presigned PUT) is computed by the upload pipeline in
 * `state/attachmentStore.ts` over the bytes returned by `encryptBlob`.
 */

const NONCE_BYTES = 12;
const DEK_BYTES = 32;
const AES_GCM_ALGORITHM = 'AES-GCM';

function getCrypto(): Crypto {
  const c = globalThis.crypto;
  if (!c || !c.subtle) {
    throw new Error('clientEncryption: WebCrypto subtle is not available in this environment');
  }
  return c;
}

/**
 * Copy `bytes` into a fresh `Uint8Array` backed by a plain `ArrayBuffer`.
 * Since TS 5.x, `SubtleCrypto` overloads refuse `SharedArrayBuffer`-backed
 * views (and the wider `Uint8Array<ArrayBufferLike>` default); the
 * explicit `Uint8Array<ArrayBuffer>` return narrows the buffer flavor.
 * Runtime semantics are identical.
 */
function toArrayBufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  buf.set(bytes);
  return buf;
}

async function importDekKey(dek: Uint8Array): Promise<CryptoKey> {
  if (dek.byteLength !== DEK_BYTES) {
    throw new Error(`clientEncryption: DEK must be ${DEK_BYTES} bytes, got ${dek.byteLength}`);
  }
  return getCrypto().subtle.importKey('raw', toArrayBufferView(dek), AES_GCM_ALGORITHM, false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Generate a fresh 32-byte AES-256-GCM data-encryption key.
 *
 * `crypto.getRandomValues` is a W3C-mandated CSPRNG sourced from the OS
 * entropy pool on every browser in scope and on Node ≥ 19 (ADR-0024
 * §DEK provenance). One DEK per attachment, single-use.
 */
export function generateDek(): Uint8Array {
  const dek = new Uint8Array(DEK_BYTES);
  getCrypto().getRandomValues(dek);
  return dek;
}

/**
 * Encrypt `plaintext` under `dek` with AES-256-GCM and a fresh 12-byte
 * nonce. The nonce is prefixed to the ciphertext (and the 16-byte auth
 * tag is appended by WebCrypto), producing `nonce || ct || tag`.
 *
 * Nonce reuse with the same DEK is a catastrophic AES-GCM failure;
 * generating fresh per call is the only safe discipline.
 */
export async function encryptBlob(plaintext: Uint8Array, dek: Uint8Array): Promise<Uint8Array> {
  const c = getCrypto();
  const key = await importDekKey(dek);
  const nonce = new Uint8Array(NONCE_BYTES);
  c.getRandomValues(nonce);

  const ctWithTag = new Uint8Array(
    await c.subtle.encrypt(
      { name: AES_GCM_ALGORITHM, iv: nonce },
      key,
      toArrayBufferView(plaintext),
    ),
  );

  const out = new Uint8Array(NONCE_BYTES + ctWithTag.byteLength);
  out.set(nonce, 0);
  out.set(ctWithTag, NONCE_BYTES);
  return out;
}

/**
 * Decrypt `nonce || ct || tag` under `dek`. The 16-byte auth tag is
 * the cryptographic-integrity guarantee on the bytes — any tampering
 * (nonce, ct body, tag) or a wrong DEK fails the WebCrypto verify and
 * throws. The thrown error is the platform's `OperationError`; consumers
 * (SW decrypt handler, attachment-store fetch) wrap it before showing
 * the German placeholder so the underlying reason (which varies across
 * engines) does not leak into the UI.
 */
export async function decryptBlob(ciphertext: Uint8Array, dek: Uint8Array): Promise<Uint8Array> {
  if (ciphertext.byteLength <= NONCE_BYTES) {
    throw new Error('clientEncryption: ciphertext shorter than the 12-byte nonce prefix');
  }
  const c = getCrypto();
  const key = await importDekKey(dek);
  const nonce = toArrayBufferView(ciphertext.subarray(0, NONCE_BYTES));
  const body = toArrayBufferView(ciphertext.subarray(NONCE_BYTES));
  const plaintext = await c.subtle.decrypt({ name: AES_GCM_ALGORITHM, iv: nonce }, key, body);
  return new Uint8Array(plaintext);
}

/**
 * Base64-encode a 32-byte DEK for the `dekMaterial` wire field.
 * Standard base64 (with `+`, `/`, padding) — the
 * server's init validator and the SW's decrypt path expect the same
 * alphabet.
 */
export function encodeDekMaterial(dek: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < dek.byteLength; i += 1) {
    bin += String.fromCharCode(dek[i] as number);
  }
  return btoa(bin);
}

/**
 * Decode the `dekMaterial` wire field back to a 32-byte DEK. Throws on
 * anything that does not decode to exactly 32 bytes — AES-256 has a
 * fixed key length and a structural mismatch must fail loudly at the
 * decoder rather than as a `subtle.importKey` error several frames
 * later.
 */
export function decodeDekMaterial(b64: string): Uint8Array {
  let bin: string;
  try {
    bin = atob(b64);
  } catch (err) {
    throw new Error(
      `clientEncryption: dekMaterial is not valid base64: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (bin.length !== DEK_BYTES) {
    throw new Error(
      `clientEncryption: dekMaterial must decode to ${DEK_BYTES} bytes, got ${bin.length}`,
    );
  }
  const out = new Uint8Array(DEK_BYTES);
  for (let i = 0; i < DEK_BYTES; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}
