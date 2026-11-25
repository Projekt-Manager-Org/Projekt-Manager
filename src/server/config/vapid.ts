/**
 * VAPID key-material resolution for the Web Push transport (ADR-0023).
 *
 * Single env surface: the operator maintains `VAPID_PRIVATE_KEY` and
 * `VAPID_SUBJECT`. The public half is derived from the private key at
 * startup (P-256 ECDSA, `crypto.createECDH('prime256v1')`) and served
 * to the client via `GET /api/push/vapid-public-key`.
 *
 * Two steps, both run once at boot by start.ts:
 *   - `withDevVapidDefaults` — in `NODE_ENV=development` only, fills a
 *     missing private key (generated once, persisted to
 *     `data/.vapid/private-key`, gitignored) and subject. The feature
 *     manifest reads the env it returns, so it reports what runs (AC-230).
 *   - `resolveVapidKeyMaterial` — push runs iff `featureStatus(env,
 *     'push')` is enabled; otherwise `null` → `noopPushDispatcher` +
 *     startup warn. Set but malformed → throw: corrupt config is
 *     fail-fast, not silent degradation.
 */

import { createECDH, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Env } from './env.js';
import { featureStatus, isConfigured } from './features.js';

export interface VapidKeyMaterial {
  privateKey: string;
  publicKey: string;
  subject: string;
}

export interface VapidResolverLogger {
  info?: (msg: string) => void;
  warn: (msg: string) => void;
}

type VapidEnv = Pick<Env, 'NODE_ENV' | 'VAPID_PRIVATE_KEY' | 'VAPID_SUBJECT'>;

export interface VapidResolverOptions {
  env: VapidEnv;
  logger?: VapidResolverLogger;
}

export interface DevVapidDefaultsOptions {
  logger?: VapidResolverLogger;
  /** Override for tests. Defaults to `<cwd>/data/.vapid`. */
  dataDir?: string;
}

const DEV_DEFAULT_SUBJECT = 'mailto:admin@localhost';
const KEY_FILE_NAME = 'private-key';
const P256_PRIVATE_KEY_BYTES = 32;

/**
 * Derive the P-256 public key (urlsafe base64) from a VAPID private
 * key. Separate export so tests can pin the derivation surface without
 * going through the full resolver.
 *
 * Node's `ECDH.setPrivateKey` does not validate the scalar — an input
 * of any length is silently accepted and yields a plausible-looking
 * public key. The length check here turns a silently-wrong config
 * into a fail-fast startup error.
 */
export function derivePublicKey(privateKeyBase64Url: string): string {
  const buf = Buffer.from(privateKeyBase64Url, 'base64url');
  if (buf.length !== P256_PRIVATE_KEY_BYTES) {
    throw new Error(
      `expected ${P256_PRIVATE_KEY_BYTES}-byte P-256 scalar, got ${buf.length} bytes`,
    );
  }
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(buf);
  return ecdh.getPublicKey().toString('base64url');
}

function generatePrivateKey(): string {
  return randomBytes(P256_PRIVATE_KEY_BYTES).toString('base64url');
}

function persistDevKey(dir: string, key: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, KEY_FILE_NAME), key, { mode: 0o600 });
}

function loadOrGenerateDevKey(dataDir: string, logger: VapidResolverLogger | undefined): string {
  const keyPath = path.join(dataDir, KEY_FILE_NAME);
  if (existsSync(keyPath)) {
    const persisted = readFileSync(keyPath, 'utf8').trim();
    logger?.info?.(`VAPID: loaded persisted dev private key from ${keyPath}.`);
    return persisted;
  }
  const fresh = generatePrivateKey();
  persistDevKey(dataDir, fresh);
  logger?.info?.(`VAPID: generated dev private key at ${keyPath}.`);
  return fresh;
}

/**
 * In development, fill a missing VAPID key (generated once, then read
 * from `dataDir`) and subject, so `npm run dev` runs push zero-config.
 * Any other `NODE_ENV` returns `env` unchanged: production never
 * auto-creates key material, and tests opt in by setting the vars.
 */
export function withDevVapidDefaults<E extends VapidEnv>(
  env: E,
  opts: DevVapidDefaultsOptions = {},
): E {
  if (env.NODE_ENV !== 'development') return env;
  const dataDir = opts.dataDir ?? path.resolve(process.cwd(), 'data', '.vapid');
  return {
    ...env,
    VAPID_PRIVATE_KEY: isConfigured(env.VAPID_PRIVATE_KEY)
      ? env.VAPID_PRIVATE_KEY
      : loadOrGenerateDevKey(dataDir, opts.logger),
    VAPID_SUBJECT: isConfigured(env.VAPID_SUBJECT) ? env.VAPID_SUBJECT : DEV_DEFAULT_SUBJECT,
  };
}

/**
 * Resolve the VAPID material that `WebPushDispatcher` needs. Returns
 * `null` when the push feature is disabled (the manifest's decision,
 * AC-230). Throws on malformed input.
 */
export function resolveVapidKeyMaterial(opts: VapidResolverOptions): VapidKeyMaterial | null {
  const { env, logger } = opts;
  const status = featureStatus(env, 'push');
  if (!status.enabled) {
    logger?.warn(`${status.reason} — Web Push delivery disabled (no-op dispatcher).`);
    return null;
  }
  const privateKey = (env.VAPID_PRIVATE_KEY ?? '').trim();
  const subject = (env.VAPID_SUBJECT ?? '').trim();

  let publicKey: string;
  try {
    publicKey = derivePublicKey(privateKey);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `VAPID_PRIVATE_KEY is malformed (expected urlsafe-base64 32-byte P-256 scalar): ${reason}`,
      { cause: err },
    );
  }

  logger?.info?.(`VAPID: dispatcher active, subject=${subject}.`);
  return { privateKey, publicKey, subject };
}
