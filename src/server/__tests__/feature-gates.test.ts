/**
 * AC-230 — the feature manifest reports the state each feature runs in.
 *
 * The manifest reads `featureStatus()`. These tests pin that each
 * feature's gate agrees with it for the same configuration: push (the
 * VAPID resolver, dev defaults included) and backup (the backup runner).
 * The first-run administrator gate needs a database and is pinned in
 * bootstrap.test.ts; the email-extraction gate calls `featureStatus`
 * directly.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import webpush from 'web-push';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Env } from '../config/env.js';
import { featureStatus } from '../config/features.js';
import { resolveVapidKeyMaterial, withDevVapidDefaults } from '../config/vapid.js';
import { backupConfigFromEnv } from '../backup-runner.js';

const PUSH_KEY = webpush.generateVAPIDKeys().privateKey;
const SUBJECT = 'mailto:ops@example.test';

/** Only the fields the gates under test read; the rest stay unset. */
function makeEnv(overrides: Partial<Env>): Env {
  return { NODE_ENV: 'production', R2_REGION: 'auto', ...overrides } as Env;
}

describe('AC-230: push runs exactly when the manifest reports it enabled', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'feature-gates-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const cases: [string, Partial<Env>][] = [
    ['production, nothing set', {}],
    ['production, key only', { VAPID_PRIVATE_KEY: PUSH_KEY }],
    ['production, subject only', { VAPID_SUBJECT: SUBJECT }],
    ['production, whitespace key', { VAPID_PRIVATE_KEY: '   ', VAPID_SUBJECT: SUBJECT }],
    ['production, whitespace subject', { VAPID_PRIVATE_KEY: PUSH_KEY, VAPID_SUBJECT: '  ' }],
    ['production, both set', { VAPID_PRIVATE_KEY: PUSH_KEY, VAPID_SUBJECT: SUBJECT }],
    ['development, nothing set', { NODE_ENV: 'development' }],
    ['test, nothing set', { NODE_ENV: 'test' }],
  ];

  it.each(cases)('%s', (_label, overrides) => {
    const env = withDevVapidDefaults(makeEnv(overrides), { dataDir });
    const manifestEnabled = featureStatus(env, 'push').enabled;
    const runs = resolveVapidKeyMaterial({ env }) !== null;
    expect(runs).toBe(manifestEnabled);
  });

  it('in development without VAPID values, the manifest reports push enabled', () => {
    const env = withDevVapidDefaults(makeEnv({ NODE_ENV: 'development' }), { dataDir });
    expect(featureStatus(env, 'push')).toEqual({ enabled: true });
  });

  it('start.ts writes the manifest from the env push resolves from', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const start = readFileSync(path.resolve(here, '../start.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const defaults = /const\s+(\w+)\s*=\s*withDevVapidDefaults\s*\(/.exec(start);
    expect(defaults, 'start.ts applies withDevVapidDefaults').not.toBeNull();
    const featureEnv = defaults![1];
    expect(start).toMatch(new RegExp(`\\bemitFeatureManifest\\s*\\(\\s*${featureEnv}\\b`));
    expect(start).toMatch(
      new RegExp(`\\bresolveVapidKeyMaterial\\s*\\(\\s*\\{[^}]*\\benv\\s*:\\s*${featureEnv}\\b`),
    );
  });
});

describe('AC-230: the backup runner runs exactly when the manifest reports backup enabled', () => {
  const ALL: Partial<Env> = {
    R2_ACCESS_KEY_ID: 'ak',
    R2_SECRET_ACCESS_KEY: 'sk',
    R2_ENDPOINT: 'https://r2.example.com',
    R2_BUCKET: 'pm-backups',
    AGE_RECIPIENT: 'age1placeholder',
  };

  const cases: [string, Partial<Env>][] = [
    ['nothing set', {}],
    ['every value set', ALL],
    ['R2_ENDPOINT missing', { ...ALL, R2_ENDPOINT: undefined }],
    ['AGE_RECIPIENT missing', { ...ALL, AGE_RECIPIENT: undefined }],
    ['whitespace R2_BUCKET', { ...ALL, R2_BUCKET: '  ' }],
  ];

  it.each(cases)('%s', (_label, overrides) => {
    const env = makeEnv(overrides);
    const status = featureStatus(env, 'backup');
    if (status.enabled) {
      expect(() => backupConfigFromEnv(env)).not.toThrow();
    } else {
      expect(() => backupConfigFromEnv(env)).toThrow(status.reason);
    }
  });
});
