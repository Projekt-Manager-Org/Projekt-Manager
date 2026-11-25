/**
 * VAPID key-material resolver tests — ADR-0023 / src/server/config/vapid.ts.
 *
 * Pins the four branches of `withDevVapidDefaults` + `resolveVapidKeyMaterial`
 * (start.ts runs them in that order):
 *   - explicit env: key set → derive public, return material.
 *   - dev auto-bootstrap: unset in NODE_ENV=development → generate and
 *     persist to the data dir; second call reads the persisted file.
 *   - production unset → `null` (no-op dispatcher downstream).
 *   - malformed key → throw (fail-fast, not silent degradation).
 *
 * Also pins the derivation itself against the `web-push` library's
 * generator so a future drift in either side is caught.
 */

import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import webpush from 'web-push';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { derivePublicKey, resolveVapidKeyMaterial, withDevVapidDefaults } from '../config/vapid.js';
import type { Env } from '../config/env.js';

function envFor(
  overrides: Partial<Env> = {},
): Pick<Env, 'NODE_ENV' | 'VAPID_PRIVATE_KEY' | 'VAPID_SUBJECT'> {
  return {
    NODE_ENV: 'production',
    VAPID_PRIVATE_KEY: undefined,
    VAPID_SUBJECT: undefined,
    ...overrides,
  };
}

describe('derivePublicKey', () => {
  it('matches web-push.generateVAPIDKeys for the same private key', () => {
    // Round-trip: take a freshly generated key pair from web-push and
    // confirm our derivation reproduces the same public half. The
    // dispatcher consumes both, so any drift between the two derivation
    // paths would show up as silent signature failures at dispatch.
    const pair = webpush.generateVAPIDKeys();
    expect(derivePublicKey(pair.privateKey)).toBe(pair.publicKey);
  });

  it('throws on a malformed private key', () => {
    expect(() => derivePublicKey('not-a-valid-key')).toThrow();
  });
});

describe('resolveVapidKeyMaterial', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'vapid-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** start.ts's order: dev defaults first, then the resolver. */
  function resolve(env: Parameters<typeof withDevVapidDefaults>[0]) {
    return resolveVapidKeyMaterial({ env: withDevVapidDefaults(env, { dataDir: tmpDir }) });
  }

  it('derives public key from private and returns material when env is set', () => {
    const pair = webpush.generateVAPIDKeys();
    const material = resolve(
      envFor({
        NODE_ENV: 'production',
        VAPID_PRIVATE_KEY: pair.privateKey,
        VAPID_SUBJECT: 'mailto:admin@example.test',
      }),
    );

    expect(material).toEqual({
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      subject: 'mailto:admin@example.test',
    });
  });

  it('returns null in production when VAPID_PRIVATE_KEY is missing (no dev bootstrap)', () => {
    const material = resolve(
      envFor({ NODE_ENV: 'production', VAPID_SUBJECT: 'mailto:admin@example.test' }),
    );

    expect(material).toBeNull();
    // Explicitly assert no file was generated — production must never
    // auto-create key material, regardless of the configured dataDir.
    expect(existsSync(path.join(tmpDir, 'private-key'))).toBe(false);
  });

  it('returns null when subject is missing outside dev (no fallback)', () => {
    const pair = webpush.generateVAPIDKeys();
    const material = resolve(
      envFor({ NODE_ENV: 'production', VAPID_PRIVATE_KEY: pair.privateKey }),
    );

    expect(material).toBeNull();
  });

  it('auto-generates and persists a private key in development', () => {
    const material = resolve(envFor({ NODE_ENV: 'development' }));

    expect(material).not.toBeNull();
    expect(material!.privateKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(material!.publicKey).toBe(derivePublicKey(material!.privateKey));
    // Dev default when subject is also unset — makes npm run dev work
    // zero-config, which is the whole point of the dev bootstrap.
    expect(material!.subject).toBe('mailto:admin@localhost');

    const persisted = readFileSync(path.join(tmpDir, 'private-key'), 'utf8');
    expect(persisted).toBe(material!.privateKey);
  });

  it('reads the persisted key on subsequent dev boots', () => {
    const first = resolve(envFor({ NODE_ENV: 'development' }));
    const second = resolve(envFor({ NODE_ENV: 'development' }));

    expect(second?.privateKey).toBe(first?.privateKey);
    expect(second?.publicKey).toBe(first?.publicKey);
  });

  it('prefers env over persisted dev key when both are present', () => {
    // First boot: generates a dev key.
    resolve(envFor({ NODE_ENV: 'development' }));
    // Operator then sets an explicit VAPID_PRIVATE_KEY — that must win.
    const pair = webpush.generateVAPIDKeys();
    const material = resolve(
      envFor({
        NODE_ENV: 'development',
        VAPID_PRIVATE_KEY: pair.privateKey,
        VAPID_SUBJECT: 'mailto:override@example.test',
      }),
    );

    expect(material?.privateKey).toBe(pair.privateKey);
    expect(material?.subject).toBe('mailto:override@example.test');
  });

  it('throws on a malformed VAPID_PRIVATE_KEY', () => {
    expect(() =>
      resolve(
        envFor({
          NODE_ENV: 'production',
          VAPID_PRIVATE_KEY: 'not-a-valid-key',
          VAPID_SUBJECT: 'mailto:admin@example.test',
        }),
      ),
    ).toThrow(/VAPID_PRIVATE_KEY is malformed/);
  });
});
