/**
 * Producer/consumer pin for the per-fork test isolation.
 *
 * `src/test/integration-setup.ts` provisions four per-fork resources (DB,
 * binary `age` identity, storage key prefix, takeout staging dir) and
 * `src/test/integration-globalsetup.ts` reaps them by dead PID. They run in
 * different processes, so the names are duplicated literals — drift between
 * the two silently disables cleanup, with no failing test and no visible
 * symptom, only a temp dir that grows forever.
 *
 * Not hypothetical. The `process.on('exit')` unlink in setup §2 never fires
 * under the forks pool (tinypool terminates workers by signal), and it had
 * been trusted in place of a sweep long enough to strand 1788 `age` identity
 * files in `/tmp`. Nothing failed; nothing pointed at it.
 *
 * These tests assert that what the setup file WRITES is exactly what the
 * sweeper MATCHES. They read `process.env` as the running fork left it — no
 * app, no database.
 *
 * The Playwright config carries a fifth copy of the staging convention (it
 * must not import project `.ts` files, by its own stated convention), so that
 * one is pinned by reading the source — the same idiom as the `start.ts`
 * call-site pin in `env.test.ts`.
 */

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import { getEnv } from '../config/env.js';
import {
  TEST_BINARY_IDENTITY_PATTERN,
  TEST_DB_PREFIX,
  TEST_KEY_PREFIX_PATTERN,
  TEST_TAKEOUT_DIR_PATTERN,
} from '../../test/integration-globalsetup.js';

const PID = String(process.pid);

describe('per-fork isolation — setup writes what globalsetup reaps', () => {
  it('DATABASE_URL names a per-PID database the DB sweep matches', () => {
    const dbName = new URL(process.env.DATABASE_URL!).pathname.slice(1);
    expect(dbName).toBe(`${TEST_DB_PREFIX}${PID}`);
    expect(dbName.slice(TEST_DB_PREFIX.length)).toBe(PID);
  });

  it('BINARY_AGE_IDENTITY_PATH matches the identity sweep pattern', () => {
    const identityPath = process.env.BINARY_AGE_IDENTITY_PATH!;
    expect(path.dirname(identityPath)).toBe(os.tmpdir());
    const match = TEST_BINARY_IDENTITY_PATTERN.exec(path.basename(identityPath));
    expect(match?.[1]).toBe(PID);
  });

  it('STORAGE_KEY_PREFIX matches the bucket sweep pattern', () => {
    const match = TEST_KEY_PREFIX_PATTERN.exec(process.env.STORAGE_KEY_PREFIX!);
    expect(match?.[1]).toBe(PID);
  });

  it('TAKEOUT_STAGING_DIR matches the staging sweep pattern', () => {
    const stagingDir = process.env.TAKEOUT_STAGING_DIR!;
    expect(path.dirname(stagingDir)).toBe(os.tmpdir());
    const match = TEST_TAKEOUT_DIR_PATTERN.exec(path.basename(stagingDir));
    expect(match?.[1]).toBe(PID);
  });

  it('the RESOLVED staging dir is never the shared env default', () => {
    // Asserted through the schema, not `process.env`: the shared default
    // (`<tmpdir>/projekt-manager-takeout`, what `npm run dev` uses) is a zod
    // default, so dropping the setup override would leave `process.env`
    // merely unset while every app boot still resolved to the shared path —
    // an assertion on `process.env` alone would pass through the defect it
    // exists to catch. Staging there leaks full-account plaintext archives
    // into a directory no sweep owns.
    const resolved = getEnv().TAKEOUT_STAGING_DIR;
    expect(resolved).not.toBe(path.join(os.tmpdir(), 'projekt-manager-takeout'));
    expect(resolved).toBe(process.env.TAKEOUT_STAGING_DIR);
    expect(TEST_TAKEOUT_DIR_PATTERN.test(path.basename(resolved))).toBe(true);
  });
});

describe('playwright.config.ts staging pin', () => {
  it('stages e2e takeouts under a name the sweeper reaps', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.resolve(here, '../../../playwright.config.ts'), 'utf8');

    // The config builds `<tmpdir>/projekt-manager-takeout-test-<pid>` and
    // hands it to the webServer. Pin the literal it interpolates into, the
    // assignment, and the hand-off — a drift in any one of the three breaks
    // the sweep or the isolation.
    expect(source).toContain('projekt-manager-takeout-test-${process.pid}');
    expect(source).toMatch(/process\.env\.TAKEOUT_STAGING_DIR\s*=\s*stagingDir/);
    expect(source).toMatch(/TAKEOUT_STAGING_DIR:\s*E2E_TAKEOUT_STAGING_DIR/);

    // The interpolated form the config uses must be what the sweeper matches.
    expect(TEST_TAKEOUT_DIR_PATTERN.test(`projekt-manager-takeout-test-${process.pid}`)).toBe(true);
  });
});
