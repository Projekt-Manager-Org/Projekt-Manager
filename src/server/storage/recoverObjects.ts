/**
 * Binary recovery tool (AC-373, architecture.md §11.4, ADR-0024
 * § Self-describing objects).
 *
 * Decrypts every object version written at or after a cutoff using only
 * the binary `age` identity and each object's own metadata — no database.
 * It recovers what a Layer 2 restore orphans (AC-368) and is what the
 * monthly binary-key drill runs (AC-374). The CLI wrapper is
 * `scripts/binary-key/recover-objects.ts`.
 *
 * Versions are listed (`ListObjectVersions`), not current objects, so a
 * version behind a delete marker — e.g. one the bucket-orphan sweep hid
 * after the restore — is still recovered. Each version is decrypted fully
 * in memory and its AES-GCM tag verified before anything is written, so a
 * failed version leaves no partial or unauthenticated output.
 */

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { isKnownWrappedDekVersion } from '../../domain/attachments.js';
import { decryptInvoicePayload } from '../services/invoice/payloadCrypto.js';
import { KeyEnvelopeService } from '../services/KeyEnvelopeService.js';
import { AGE_KEYGEN_BIN } from './binaryIdentity.js';
import { fromObjectMetadata } from './objectMetadata.js';
import { isReservedKey } from './keyNamespaces.js';

const execFileAsync = promisify(execFile);

export const INDEX_FILE = 'index.json';
/** Recovered plaintexts land under this subdirectory of `outDir`. */
const FILES_DIR = 'files';
/** Plaintext customer data: owner-only on the operator workstation. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export interface RecoverObjectsOptions {
  storage: {
    endpoint: string;
    bucket: string;
    accessKey: string;
    secretKey: string;
    region?: string;
    /** Per-process key namespace, as `StorageConfig.keyPrefix`. */
    keyPrefix?: string;
  };
  identityPath: string;
  since: Date;
  /** Restrict to this one logical key's versions (the drill). */
  key?: string;
  outDir: string;
}

export interface RecoveryIndexEntry {
  key: string;
  versionId: string;
  /** ISO 8601 write time of the version. */
  lastModified: string;
  outcome: 'recovered' | 'failed';
  /** Plaintext path relative to `outDir`; only on `recovered`. */
  file?: string;
  invoiceNumber?: string;
  error?: string;
}

export interface RecoverObjectsResult {
  entries: RecoveryIndexEntry[];
  failedCount: number;
}

interface ListedVersion {
  key: string;
  versionId: string;
  lastModified: Date;
}

export async function recoverObjects(opts: RecoverObjectsOptions): Promise<RecoverObjectsResult> {
  const { storage } = opts;
  const keyPrefix = storage.keyPrefix ?? '';
  const s3 = new S3Client({
    endpoint: storage.endpoint,
    region: storage.region ?? 'us-east-1',
    credentials: { accessKeyId: storage.accessKey, secretAccessKey: storage.secretKey },
    forcePathStyle: true,
  });
  const outRoot = path.resolve(opts.outDir);
  let envelopes: KeyEnvelopeService | undefined;
  try {
    // `unwrap` ignores the recipient, but the service requires one; derive
    // it from the identity rather than asking the operator for it.
    const { stdout } = await execFileAsync(AGE_KEYGEN_BIN, ['-y', opts.identityPath]);
    envelopes = new KeyEnvelopeService({
      recipient: stdout.trim(),
      identityPath: opts.identityPath,
    });
    const versions = await listVersions(s3, storage.bucket, keyPrefix, opts);
    const entries: RecoveryIndexEntry[] = [];
    for (const version of versions) {
      entries.push(
        await recoverVersion(s3, envelopes, storage.bucket, keyPrefix, outRoot, version),
      );
    }
    await mkdir(outRoot, { recursive: true, mode: DIR_MODE });
    await writeFile(path.join(outRoot, INDEX_FILE), JSON.stringify(entries, null, 2), {
      mode: FILE_MODE,
    });
    return { entries, failedCount: entries.filter((e) => e.outcome === 'failed').length };
  } finally {
    envelopes?.close();
    s3.destroy();
  }
}

/** Every data version (no delete markers) in scope, oldest first per key. */
async function listVersions(
  s3: S3Client,
  bucket: string,
  keyPrefix: string,
  opts: RecoverObjectsOptions,
): Promise<ListedVersion[]> {
  const listed: ListedVersion[] = [];
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: keyPrefix + (opts.key ?? ''),
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
      }),
    );
    for (const v of page.Versions ?? []) {
      if (!v.Key || !v.VersionId || !v.LastModified) continue;
      const key = v.Key.startsWith(keyPrefix) ? v.Key.slice(keyPrefix.length) : v.Key;
      if (opts.key !== undefined && key !== opts.key) continue;
      if (isReservedKey(key)) continue;
      if (v.LastModified < opts.since) continue;
      listed.push({ key, versionId: v.VersionId, lastModified: v.LastModified });
    }
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
  } while (keyMarker);
  return listed.sort(
    (a, b) =>
      a.key.localeCompare(b.key) ||
      a.lastModified.getTime() - b.lastModified.getTime() ||
      a.versionId.localeCompare(b.versionId),
  );
}

async function recoverVersion(
  s3: S3Client,
  envelopes: KeyEnvelopeService,
  bucket: string,
  keyPrefix: string,
  outRoot: string,
  version: ListedVersion,
): Promise<RecoveryIndexEntry> {
  const base = {
    key: version.key,
    versionId: version.versionId,
    lastModified: version.lastModified.toISOString(),
  };
  const objectRef = { Bucket: bucket, Key: keyPrefix + version.key, VersionId: version.versionId };
  let invoiceNumber: string | undefined;
  try {
    const head = await s3.send(new HeadObjectCommand(objectRef));
    const meta = fromObjectMetadata(head.Metadata);
    invoiceNumber = meta.invoiceNumber;
    if (!meta.envelope) throw new Error('object metadata carries no wrapped envelope');
    if (!isKnownWrappedDekVersion(meta.envelope.wrappedDekVersion)) {
      throw new Error(`envelope format unknown: ${meta.envelope.wrappedDekVersion}`);
    }
    // The key comes from the bucket listing — untrusted. Refuse any key
    // that would resolve outside the output directory.
    const file = path.join(FILES_DIR, version.key, sanitizeSegment(version.versionId));
    const target = path.resolve(outRoot, file);
    if (!target.startsWith(path.join(outRoot, FILES_DIR) + path.sep)) {
      throw new Error('object key escapes the output directory');
    }

    const dek = await envelopes.unwrap(Buffer.from(meta.envelope.wrappedDek, 'base64'));
    const body = await s3.send(new GetObjectCommand(objectRef));
    const ciphertext = await body.Body!.transformToByteArray();
    const plaintext = decryptInvoicePayload(ciphertext, dek);

    await mkdir(path.dirname(target), { recursive: true, mode: DIR_MODE });
    await writeFile(target, plaintext, { mode: FILE_MODE });
    return { ...base, outcome: 'recovered', file, ...numberField(invoiceNumber) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ...base, outcome: 'failed', error, ...numberField(invoiceNumber) };
  }
}

function numberField(invoiceNumber: string | undefined): { invoiceNumber?: string } {
  return invoiceNumber !== undefined ? { invoiceNumber } : {};
}

/** A provider version id as one safe path segment. */
function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}
