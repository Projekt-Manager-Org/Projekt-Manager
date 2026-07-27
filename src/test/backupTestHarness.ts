/**
 * Shared fixtures for Layer 2 backup integration tests.
 *
 * Consumed by:
 *   - src/server/__tests__/backup.test.ts       (AC-165/166/167)
 *   - src/server/__tests__/backup-status.test.ts (AC-169/174)
 *
 * Kept separate from the tests so both files import the same fake
 * encrypt + stub uploader and cannot drift on behaviors like upload
 * recording or the encryption envelope shape.
 */

/**
 * Minimal re-declaration of the upload contract. Keep in sync with
 * `src/server/services/backup.ts::BackupUploader` — a drift surfaces
 * as a type error at the tests' `runBackup` call sites, not here.
 */
export interface BackupUploader {
  upload(key: string, data: Uint8Array, contentType: string): Promise<void>;
  putStatusMirror(status: unknown): Promise<void>;
}

/**
 * Shape of the per-table manifest the backup service emits and the
 * tests perturb for Tier 1 mismatch scenarios. Mirrors the contract
 * documented in
 * [ADR-0020 §Decision](../../docs/adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md#decision):
 * one entry per table keyed by table name, carrying the row count and
 * the deterministic content checksum. `services/backup.ts` owns the
 * authoritative type; this copy lets the tests annotate callback params
 * without falling back to implicit `any`.
 */
export type Manifest = Record<string, { rowCount: number; checksum: string }>;

export const PG_DUMP_MAGIC = 'PGDMP';
export const AGE_ARMOR_PREFIX = 'age-encryption.org/';

/**
 * Stub uploader that records every call. No network, no R2.
 * Tests assert on the recorded call lists and spies.
 */
export function makeStubUploader(overrides: Partial<BackupUploader> = {}): {
  uploader: BackupUploader;
  uploads: Array<{ key: string; data: Uint8Array; contentType: string }>;
  mirrorCalls: unknown[];
} {
  const uploads: Array<{ key: string; data: Uint8Array; contentType: string }> = [];
  const mirrorCalls: unknown[] = [];
  const uploader: BackupUploader = {
    upload: overrides.upload
      ? overrides.upload
      : async (key, data, contentType) => {
          uploads.push({ key, data, contentType });
        },
    putStatusMirror: overrides.putStatusMirror
      ? overrides.putStatusMirror
      : async (status) => {
          mirrorCalls.push(status);
        },
  };
  return { uploader, uploads, mirrorCalls };
}

/**
 * Test-side encryption stub. Produces an "age-like" envelope —
 * enough for AC-167 to assert "not plaintext pg_dump" and "not
 * plaintext JSON" without coupling the test to age's exact header
 * bytes. Production encrypts with real age (`ageEncrypt`); this stub
 * exists so the suite needs no key material.
 */
export async function fakeEncrypt(plaintext: Uint8Array): Promise<Uint8Array> {
  const header = new TextEncoder().encode(`${AGE_ARMOR_PREFIX}v1\n`);
  const out = new Uint8Array(header.byteLength + plaintext.byteLength);
  out.set(header, 0);
  // Flip every byte so the payload is not readable even without a key —
  // the important property is "not the original bytes", not "semantically
  // secure". Real age replaces this.
  for (let i = 0; i < plaintext.byteLength; i += 1) {
    out[header.byteLength + i] = plaintext[i] ^ 0xff;
  }
  return out;
}

/** True iff `data` starts with the ASCII bytes of `magic`. */
export function startsWith(data: Uint8Array, magic: string): boolean {
  const bytes = new TextEncoder().encode(magic);
  if (data.byteLength < bytes.byteLength) return false;
  for (let i = 0; i < bytes.byteLength; i += 1) {
    if (data[i] !== bytes[i]) return false;
  }
  return true;
}
