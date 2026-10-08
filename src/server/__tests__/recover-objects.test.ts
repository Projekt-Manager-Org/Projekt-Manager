/**
 * AC-373 — the binary recovery tool (architecture.md §11.4, ADR-0024
 * § Self-describing objects).
 *
 * The tool decrypts object versions written since a cutoff using only the
 * binary identity and each object's own metadata — no database. It is the
 * Layer 2 disaster-recovery path for objects whose rows a restore dropped
 * (AC-368) and the monthly binary-key drill.
 *
 * Fixtures are written with raw S3 calls, not the app's storage client,
 * so the bucket state is fully controlled: valid objects with no row, an
 * invoice PDF, a version behind a delete marker, and one object per
 * failure mode. Everything lives under this file's own
 * `STORAGE_KEY_PREFIX` (one per test file); the cutoff excludes the
 * `beforeCutoff` fixture.
 *
 * Tool surface pinned here:
 *   - `recoverObjects({ storage, identityPath, since, key?, outDir })` →
 *     `{ entries, failedCount }`, also written to `<outDir>/index.json`.
 *   - Index entry: `{ key, versionId, lastModified, outcome, file?,
 *     invoiceNumber?, error? }` — `file` relative to `outDir`, present
 *     only on `recovered`.
 *   - CLI `scripts/binary-key/recover-objects.ts --identity <path>
 *     --since <ISO> --out <dir> [--key <key>]`, storage from `STORAGE_*`
 *     env; exit 0 when every version recovered, non-zero otherwise.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getEnv } from '../config/env.js';
import { storageConfigFromEnv } from '../storage/fromEnv.js';
import { KeyEnvelopeService } from '../services/KeyEnvelopeService.js';
import {
  META_INVOICE_NUMBER,
  META_WRAPPED_DEK,
  META_WRAPPED_DEK_VERSION,
} from '../../test/storageObjectMetadata.js';
import { recoverObjects, type RecoveryIndexEntry } from '../storage/recoverObjects.js';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cliPath = path.join(repoRoot, 'scripts/binary-key/recover-objects.ts');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function encrypt(plaintext: Buffer, dek: Buffer): Buffer {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, nonce);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

async function wrap(dek: Buffer, recipient: string, identity: string): Promise<string> {
  const svc = new KeyEnvelopeService({ recipient, identity });
  try {
    return Buffer.from(await svc.wrap(dek)).toString('base64');
  } finally {
    svc.close();
  }
}

async function ageKeypair(): Promise<{ identity: string; recipient: string }> {
  const { stdout } = await execFileAsync('age-keygen');
  const identity = stdout.split('\n').find((line) => line.startsWith('AGE-SECRET-KEY-'))!;
  const recipient = stdout.match(/public key: (age1\S+)/)![1]!;
  return { identity, recipient };
}

describe('AC-373: binary recovery tool', () => {
  const env = getEnv();
  const storage = storageConfigFromEnv(env);
  const prefix = storage.keyPrefix ?? '';
  const s3 = new S3Client({
    endpoint: storage.endpoint,
    region: storage.region ?? 'us-east-1',
    credentials: { accessKeyId: storage.accessKey, secretAccessKey: storage.secretKey },
    forcePathStyle: true,
  });
  const identityPath = env.BINARY_AGE_IDENTITY_PATH!;
  const recipient = env.BINARY_AGE_RECIPIENT!;
  const identity = readFileSync(identityPath, 'utf8').trim();
  const ns = `attachments/recover-${crypto.randomUUID()}`;
  const outDirs: string[] = [];

  const plaintexts = new Map<string, Buffer>();
  let cutoff: Date;
  let orphanFirstPlaintext: Buffer;

  async function put(key: string, body: Buffer, metadata: Record<string, string>) {
    await s3.send(
      new PutObjectCommand({
        Bucket: storage.bucket,
        Key: prefix + key,
        Body: body,
        ContentType: 'application/octet-stream',
        Metadata: metadata,
      }),
    );
  }

  /** Valid object: fresh DEK, real envelope; remembers its plaintext. */
  async function putValid(key: string, extra: Record<string, string> = {}) {
    const plaintext = crypto.randomBytes(64);
    const dek = crypto.randomBytes(32);
    await put(key, encrypt(plaintext, dek), {
      [META_WRAPPED_DEK]: await wrap(dek, recipient, identity),
      [META_WRAPPED_DEK_VERSION]: '1',
      ...extra,
    });
    plaintexts.set(key, plaintext);
  }

  function outDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'recover-objects-'));
    outDirs.push(dir);
    return dir;
  }

  const keys = {
    beforeCutoff: `${ns}/before.orig`,
    orphan: `${ns}/orphan.orig`,
    invoice: `invoices/recover-${crypto.randomUUID()}/inv.orig`,
    hidden: `${ns}/hidden.orig`,
    noMetadata: `${ns}/no-metadata.orig`,
    unknownVersion: `${ns}/unknown-version.orig`,
    wrongRecipient: `${ns}/wrong-recipient.orig`,
    tampered: `${ns}/tampered.orig`,
    invoiceBadEnvelope: `invoices/recover-${crypto.randomUUID()}/bad.orig`,
    probe: '__probe/upload',
  };

  beforeAll(async () => {
    await putValid(keys.beforeCutoff);
    await sleep(1100);
    cutoff = new Date();
    await sleep(1100);

    await putValid(keys.orphan);
    orphanFirstPlaintext = plaintexts.get(keys.orphan)!;
    await putValid(keys.orphan); // second version of the same key
    await putValid(keys.invoice, { [META_INVOICE_NUMBER]: 'RE-2026-0042' });
    await putValid(keys.hidden);
    await s3.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: prefix + keys.hidden }));

    await put(keys.noMetadata, encrypt(crypto.randomBytes(64), crypto.randomBytes(32)), {});

    const dekV = crypto.randomBytes(32);
    await put(keys.unknownVersion, encrypt(crypto.randomBytes(64), dekV), {
      [META_WRAPPED_DEK]: await wrap(dekV, recipient, identity),
      [META_WRAPPED_DEK_VERSION]: '2',
    });

    const other = await ageKeypair();
    const dekW = crypto.randomBytes(32);
    await put(keys.wrongRecipient, encrypt(crypto.randomBytes(64), dekW), {
      [META_WRAPPED_DEK]: await wrap(dekW, other.recipient, other.identity),
      [META_WRAPPED_DEK_VERSION]: '1',
    });

    const dekT = crypto.randomBytes(32);
    const tampered = encrypt(crypto.randomBytes(64), dekT);
    tampered[20] ^= 0xff;
    await put(keys.tampered, tampered, {
      [META_WRAPPED_DEK]: await wrap(dekT, recipient, identity),
      [META_WRAPPED_DEK_VERSION]: '1',
    });

    await put(keys.invoiceBadEnvelope, encrypt(crypto.randomBytes(64), crypto.randomBytes(32)), {
      [META_WRAPPED_DEK]: crypto.randomBytes(240).toString('base64'),
      [META_WRAPPED_DEK_VERSION]: '1',
      [META_INVOICE_NUMBER]: 'ST-2026-0007',
    });

    await put(keys.probe, Buffer.from('x'), {});
  });

  afterAll(() => {
    s3.destroy();
    for (const dir of outDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('recovers every version since the cutoff from metadata alone and lists failures', async () => {
    const dir = outDir();
    const result = await recoverObjects({ storage, identityPath, since: cutoff, outDir: dir });

    // One entry per version: 4 recovered (two versions of `orphan`) + 5 failed.
    expect(result.entries).toHaveLength(9);
    const byKey = new Map<string, RecoveryIndexEntry[]>();
    for (const e of result.entries) byKey.set(e.key, [...(byKey.get(e.key) ?? []), e]);
    const only = (key: string) => {
      const entries = byKey.get(key) ?? [];
      expect(entries, key).toHaveLength(1);
      return entries[0]!;
    };
    const plaintextOf = (entry: RecoveryIndexEntry) => readFileSync(path.join(dir, entry.file!));

    // Recovered: no row behind any of them; the hidden one sits behind a
    // delete marker. Plaintext must round-trip byte-equal.
    const orphanVersions = byKey.get(keys.orphan) ?? [];
    expect(orphanVersions.map((e) => e.outcome)).toEqual(['recovered', 'recovered']);
    expect(new Set(orphanVersions.map((e) => e.versionId)).size).toBe(2);
    const orphanPlaintexts = orphanVersions.map(plaintextOf);
    expect(orphanPlaintexts).toContainEqual(orphanFirstPlaintext);
    expect(orphanPlaintexts).toContainEqual(plaintexts.get(keys.orphan));

    for (const key of [keys.invoice, keys.hidden]) {
      const entry = only(key);
      expect(entry).toMatchObject({ outcome: 'recovered' });
      expect(entry.versionId).toMatch(/.+/);
      expect(Buffer.compare(plaintextOf(entry), plaintexts.get(key)!)).toBe(0);
    }
    for (const entry of result.entries) {
      expect(new Date(entry.lastModified).getTime(), entry.key).toBeGreaterThanOrEqual(
        cutoff.getTime(),
      );
    }
    expect(only(keys.invoice).invoiceNumber).toBe('RE-2026-0042');

    // Failed: listed with an error, no plaintext; the invoice number of a
    // failed version still reaches the index (AC-368 bumps from it).
    for (const key of [
      keys.noMetadata,
      keys.unknownVersion,
      keys.wrongRecipient,
      keys.tampered,
      keys.invoiceBadEnvelope,
    ]) {
      const entry = only(key);
      expect(entry, key).toMatchObject({ outcome: 'failed' });
      expect(entry.error, key).toMatch(/.+/);
      expect(entry.file, key).toBeUndefined();
    }
    expect(only(keys.invoiceBadEnvelope).invoiceNumber).toBe('ST-2026-0007');
    expect(result.failedCount).toBe(5);

    // Nothing but the index and the recovered plaintexts lands on disk —
    // a failed version leaves no partial or unauthenticated output.
    const written = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => path.relative(dir, path.join(d.parentPath, d.name)))
      .sort();
    const expected = [
      'index.json',
      ...result.entries.filter((e) => e.outcome === 'recovered').map((e) => e.file!),
    ].sort();
    expect(written).toEqual(expected);

    // Not read: before the cutoff, and the reserved deploy-probe namespace.
    expect(byKey.has(keys.beforeCutoff)).toBe(false);
    expect(byKey.has(keys.probe)).toBe(false);

    // The index on disk is the same list.
    const onDisk = JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8'));
    expect(onDisk).toEqual(result.entries);
  });

  it('with a key, reads only that key and still applies the cutoff', async () => {
    const recent = await recoverObjects({
      storage,
      identityPath,
      since: cutoff,
      key: keys.orphan,
      outDir: outDir(),
    });
    expect(recent.entries.map((e) => [e.key, e.outcome])).toEqual([
      [keys.orphan, 'recovered'],
      [keys.orphan, 'recovered'],
    ]);

    const old = await recoverObjects({
      storage,
      identityPath,
      since: cutoff,
      key: keys.beforeCutoff,
      outDir: outDir(),
    });
    expect(old.entries).toEqual([]);
  });

  it('CLI exits 0 when every version recovered and non-zero when any failed', async () => {
    const run = async (key: string, since = cutoff.toISOString()) => {
      const dir = outDir();
      const args = ['tsx', cliPath, '--identity', identityPath, '--since', since];
      args.push('--out', dir, '--key', key);
      // No database reachable: the tool must not need one. Pointing
      // DATABASE_URL at a dead port (rather than only unsetting it) keeps a
      // `.env` loader from filling it back in.
      const env = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([name]) => !name.startsWith('POSTGRES_')),
        ),
        DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none',
      };
      const exitCode = await execFileAsync('npx', args, { cwd: repoRoot, env }).then(
        () => 0,
        (err: { code?: number }) => err.code ?? -1,
      );
      const indexPath = path.join(dir, 'index.json');
      const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : null;
      return { exitCode, index: index as RecoveryIndexEntry[] | null };
    };

    const ok = await run(keys.invoice);
    expect(ok.exitCode).toBe(0);
    expect(ok.index!.map((e) => e.outcome)).toEqual(['recovered']);

    const failed = await run(keys.tampered);
    expect(failed.exitCode).not.toBe(0);
    expect(failed.index!.map((e) => e.outcome)).toEqual(['failed']);

    // A cutoff without an explicit offset would be read as local time and
    // shift the window — refused as a usage error, nothing read.
    const offsetless = await run(keys.invoice, cutoff.toISOString().replace('Z', ''));
    expect(offsetless.exitCode).toBe(2);
    expect(offsetless.index).toBeNull();
  }, 30_000);
});
