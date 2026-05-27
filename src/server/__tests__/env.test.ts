/**
 * Environment safety tests — pure-function tests for the production
 * startup guards, plus a call-site pin on start.ts so the guard cannot
 * be silently detached from the actual startup path. Runs under the
 * integration project (by directory), but does NOT spin up the app or
 * touch the database.
 *
 * These tests lock the ADR-0013 / AC-45 promise that the server refuses
 * to start with ALLOW_INSECURE_HTTP=true in production. The check lives
 * in assertProductionSafe(); a regression that weakens it (removing the
 * throw, inverting the condition, dropping the NODE_ENV dependency) would
 * make one of these tests fail. See consolidation review C-2 and C-4.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';
import {
  assertAppServerEnv,
  assertProductionSafe,
  assertStoragePublicEndpointInProduction,
  envSchema,
  validateEnvAggregated,
} from '../config/env.js';
import type { Env } from '../config/env.js';

/** Minimal Env shape with only the fields assertProductionSafe reads. */
function makeEnv(overrides: Partial<Env>): Env {
  return {
    PORT: 3000,
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://unused',
    STORAGE_ENDPOINT: 'http://unused',
    STORAGE_PUBLIC_ENDPOINT: undefined,
    STORAGE_BUCKET: 'unused',
    STORAGE_ACCESS_KEY: 'unused',
    STORAGE_SECRET_KEY: 'unused',
    STORAGE_REGION: 'us-east-1',
    DOMAIN: 'localhost',
    SEED: 'false',
    ALLOW_INSECURE_HTTP: 'false',
    BOOTSTRAP_ADMIN_USERNAME: undefined,
    BOOTSTRAP_ADMIN_PASSWORD: undefined,
    BOOTSTRAP_ADMIN_DISPLAY_NAME: undefined,
    OPENROUTER_API_KEY: undefined,
    OPENROUTER_MODEL: 'google/gemini-2.5-flash-lite',
    SESSION_CLEANUP_INTERVAL_MINUTES: 60,
    AUDIT_RETENTION_WINDOW_DAYS: undefined,
    AUDIT_RETENTION_INTERVAL_MINUTES: 1440,
    // Layer 2 backup env — optional at the app-server level. Only the
    // fields the production-safety guards read are declared here; other
    // optionals (LOGIN_RATE_LIMIT_MAX, ATTACHMENT_*) are intentionally
    // omitted to keep the fixture focused on the guards under test.
    R2_ACCESS_KEY_ID: undefined,
    R2_SECRET_ACCESS_KEY: undefined,
    R2_ENDPOINT: undefined,
    R2_BUCKET: undefined,
    R2_REGION: 'auto',
    AGE_RECIPIENT: undefined,
    AGE_IDENTITY_PATH: '/run/drill-key/identity',
    // BINARY_AGE_RECIPIENT placeholder so happy-path fixtures pass the
    // app-server presence check (ADR-0024). Per-test arms override to
    // undefined when exercising the missing-field branch.
    BINARY_AGE_RECIPIENT: 'age1unused',
    BINARY_AGE_IDENTITY_PATH: '/run/binary-key/identity',
    VAPID_PRIVATE_KEY: undefined,
    VAPID_SUBJECT: undefined,
    SSE_HEARTBEAT_INTERVAL_MS: 25_000,
    INVOICE_OBJECT_LOCK_DAYS: 0,
    TAKEOUT_STAGING_TTL_MINUTES: 1440,
    TAKEOUT_STAGING_DIR: '/tmp/projekt-manager-takeout',
    ...overrides,
  };
}

describe('assertProductionSafe', () => {
  it('throws when NODE_ENV=production and ALLOW_INSECURE_HTTP=true', () => {
    expect(() =>
      assertProductionSafe(makeEnv({ NODE_ENV: 'production', ALLOW_INSECURE_HTTP: 'true' })),
    ).toThrow(/ALLOW_INSECURE_HTTP=true in production/);
  });

  it('does not throw in production when ALLOW_INSECURE_HTTP=false', () => {
    expect(() =>
      assertProductionSafe(makeEnv({ NODE_ENV: 'production', ALLOW_INSECURE_HTTP: 'false' })),
    ).not.toThrow();
  });

  it('does not throw in development even with ALLOW_INSECURE_HTTP=true', () => {
    expect(() =>
      assertProductionSafe(makeEnv({ NODE_ENV: 'development', ALLOW_INSECURE_HTTP: 'true' })),
    ).not.toThrow();
  });

  it('does not throw in development with ALLOW_INSECURE_HTTP=false', () => {
    expect(() =>
      assertProductionSafe(makeEnv({ NODE_ENV: 'development', ALLOW_INSECURE_HTTP: 'false' })),
    ).not.toThrow();
  });

  // NODE_ENV='test' must behave like development for the guard — vitest
  // itself runs with NODE_ENV defaulting to 'test' on many setups, and the
  // guard's condition is `=== 'production'`, not `!== 'development'`. A
  // future refactor to `!== 'development'` would silently flip test runs
  // into strict mode and break every integration suite. Pin the assumption.
  it('does not throw when NODE_ENV=test and ALLOW_INSECURE_HTTP=true', () => {
    expect(() =>
      assertProductionSafe(makeEnv({ NODE_ENV: 'test', ALLOW_INSECURE_HTTP: 'true' })),
    ).not.toThrow();
  });

  it('does not throw when NODE_ENV=test and ALLOW_INSECURE_HTTP=false', () => {
    expect(() =>
      assertProductionSafe(makeEnv({ NODE_ENV: 'test', ALLOW_INSECURE_HTTP: 'false' })),
    ).not.toThrow();
  });
});

/**
 * `assertAppServerEnv` — the app-server-only presence check for the MinIO
 * storage surface. The shared schema keeps STORAGE_* optional so the
 * backup-runner CLI can share validateEnvRuntime(); this guard restores the
 * fail-fast semantic where it matters (start.ts) without forcing the
 * backup path to carry values it never reads.
 */
describe('assertAppServerEnv', () => {
  it('throws when STORAGE_ENDPOINT is missing', () => {
    expect(() => assertAppServerEnv(makeEnv({ STORAGE_ENDPOINT: undefined }))).toThrow(
      /STORAGE_ENDPOINT/,
    );
  });

  it('throws when STORAGE_ACCESS_KEY is missing', () => {
    expect(() => assertAppServerEnv(makeEnv({ STORAGE_ACCESS_KEY: undefined }))).toThrow(
      /STORAGE_ACCESS_KEY/,
    );
  });

  it('throws when STORAGE_SECRET_KEY is missing', () => {
    expect(() => assertAppServerEnv(makeEnv({ STORAGE_SECRET_KEY: undefined }))).toThrow(
      /STORAGE_SECRET_KEY/,
    );
  });

  it('throws when STORAGE_REGION is missing', () => {
    expect(() => assertAppServerEnv(makeEnv({ STORAGE_REGION: undefined }))).toThrow(
      /STORAGE_REGION/,
    );
  });

  it('throws when BINARY_AGE_RECIPIENT is missing (ADR-0024 boot probe upstream)', () => {
    // Presence check happens before the boot probe so an unset env var
    // surfaces as "BINARY_AGE_RECIPIENT not configured" rather than the
    // probe's "wrong identity loaded" diagnostic — see start.ts wiring.
    expect(() => assertAppServerEnv(makeEnv({ BINARY_AGE_RECIPIENT: undefined }))).toThrow(
      /BINARY_AGE_RECIPIENT/,
    );
  });

  it('lists every missing field in a single error', () => {
    expect(() =>
      assertAppServerEnv(
        makeEnv({
          STORAGE_ENDPOINT: undefined,
          STORAGE_ACCESS_KEY: undefined,
          STORAGE_SECRET_KEY: undefined,
          STORAGE_REGION: undefined,
        }),
      ),
    ).toThrow(/STORAGE_ENDPOINT.*STORAGE_ACCESS_KEY.*STORAGE_SECRET_KEY.*STORAGE_REGION/s);
  });

  it('passes when all STORAGE_* are set', () => {
    expect(() => assertAppServerEnv(makeEnv({}))).not.toThrow();
  });
});

/**
 * `assertStoragePublicEndpointInProduction` — closes the infrastructure
 * footgun where `STORAGE_ENDPOINT=http://storage:9000` (Docker-internal
 * hostname) reaches the browser via presigned URLs the browser cannot
 * resolve, silently breaking every upload until the orphan reaper
 * sweeps it.
 */
describe('assertStoragePublicEndpointInProduction', () => {
  it('throws in production when STORAGE_ENDPOINT is a container-only host and no public override is set', () => {
    expect(() =>
      assertStoragePublicEndpointInProduction(
        makeEnv({
          NODE_ENV: 'production',
          STORAGE_ENDPOINT: 'http://storage:9000',
          STORAGE_PUBLIC_ENDPOINT: undefined,
        }),
      ),
    ).toThrow(/STORAGE_PUBLIC_ENDPOINT/);
  });

  it('passes in production when STORAGE_PUBLIC_ENDPOINT is set', () => {
    expect(() =>
      assertStoragePublicEndpointInProduction(
        makeEnv({
          NODE_ENV: 'production',
          STORAGE_ENDPOINT: 'http://storage:9000',
          STORAGE_PUBLIC_ENDPOINT: 'https://storage.example.com',
        }),
      ),
    ).not.toThrow();
  });

  it('passes in production when STORAGE_ENDPOINT is a public hostname', () => {
    expect(() =>
      assertStoragePublicEndpointInProduction(
        makeEnv({
          NODE_ENV: 'production',
          STORAGE_ENDPOINT: 'https://storage.example.com',
          STORAGE_PUBLIC_ENDPOINT: undefined,
        }),
      ),
    ).not.toThrow();
  });

  it('passes in production when STORAGE_ENDPOINT is an IP literal', () => {
    expect(() =>
      assertStoragePublicEndpointInProduction(
        makeEnv({
          NODE_ENV: 'production',
          STORAGE_ENDPOINT: 'http://10.0.0.5:9000',
          STORAGE_PUBLIC_ENDPOINT: undefined,
        }),
      ),
    ).not.toThrow();
  });

  it('does not throw in development regardless of endpoint shape', () => {
    expect(() =>
      assertStoragePublicEndpointInProduction(
        makeEnv({
          NODE_ENV: 'development',
          STORAGE_ENDPOINT: 'http://storage:9000',
          STORAGE_PUBLIC_ENDPOINT: undefined,
        }),
      ),
    ).not.toThrow();
  });
});

/**
 * Schema-level regression pin for the `${VAR:-}` compose pattern. Docker
 * Compose substitutes an empty string for an unset variable referenced
 * with `:-`, so the container sees `AUDIT_RETENTION_WINDOW_DAYS=""`.
 * Without the preprocess wrapper, `z.coerce.number()` turns "" into 0
 * and `.positive()` rejects — crashing the app at startup. CI caught
 * this after the smoke-test container started failing to boot; this
 * test freezes the fix.
 */
/**
 * AGE_RECIPIENT — public recipient for Layer 2 backup encryption.
 * Schema enforces the `age1…` prefix so a private identity pasted by
 * mistake (`AGE-SECRET-KEY-1…`) is rejected at boot. Compose forwards
 * `${AGE_RECIPIENT:-}` which materialises as `""` when the operator
 * hasn't sourced secrets.env.age (dev workflows, app-only deploys),
 * so the schema MUST treat the empty string as "not set" — otherwise
 * any non-backup deploy fails env validation and the app won't boot.
 */
describe('envSchema AGE_RECIPIENT handling (#199)', () => {
  const minimal = { DATABASE_URL: 'postgres://unused' };

  it('coerces "" to undefined so app-only deploys (no backup secrets) boot', () => {
    const parsed = envSchema.parse({ ...minimal, AGE_RECIPIENT: '' });
    expect(parsed.AGE_RECIPIENT).toBeUndefined();
  });

  it('accepts a valid age1… public recipient', () => {
    const valid = 'age15nf2qq4znfwup9khgjk0rdgp5wg9vx33fngc727m3zdkctq29djqyr9su6';
    const parsed = envSchema.parse({ ...minimal, AGE_RECIPIENT: valid });
    expect(parsed.AGE_RECIPIENT).toBe(valid);
  });

  it('rejects a private identity pasted by mistake', () => {
    expect(() =>
      envSchema.parse({
        ...minimal,
        AGE_RECIPIENT:
          'AGE-SECRET-KEY-1QQPQQS4M3Q4HMNAWPV4TXMFQ8YUL9G6X5RKTZ8KLZ9TYUZZTJVHWQRYR9SU',
      }),
    ).toThrow(/public recipient.*age1/);
  });
});

describe('envSchema AUDIT_RETENTION_WINDOW_DAYS empty-string handling', () => {
  const minimal = { DATABASE_URL: 'postgres://unused' };

  it('coerces "" to undefined so the build-time default applies', () => {
    const parsed = envSchema.parse({ ...minimal, AUDIT_RETENTION_WINDOW_DAYS: '' });
    expect(parsed.AUDIT_RETENTION_WINDOW_DAYS).toBeUndefined();
  });

  it('parses a positive integer string', () => {
    const parsed = envSchema.parse({ ...minimal, AUDIT_RETENTION_WINDOW_DAYS: '30' });
    expect(parsed.AUDIT_RETENTION_WINDOW_DAYS).toBe(30);
  });

  it('still rejects 0 and negatives', () => {
    expect(() => envSchema.parse({ ...minimal, AUDIT_RETENTION_WINDOW_DAYS: '0' })).toThrow();
    expect(() => envSchema.parse({ ...minimal, AUDIT_RETENTION_WINDOW_DAYS: '-5' })).toThrow();
  });
});

/**
 * SSE_HEARTBEAT_INTERVAL_MS — bounded heartbeat cadence per
 * architecture.md §12.2 (default 25 s; 1 s … 600 s). Bounds reject
 * pathological values (1 ms heartbeat flood, 23-day silence) at boot
 * rather than at runtime when the proxy starts dropping connections
 * the operator did not realise were misconfigured.
 */
describe('envSchema SSE_HEARTBEAT_INTERVAL_MS handling', () => {
  const minimal = { DATABASE_URL: 'postgres://unused' };

  it('applies the 25 000 ms default when absent', () => {
    const parsed = envSchema.parse({ ...minimal });
    expect(parsed.SSE_HEARTBEAT_INTERVAL_MS).toBe(25_000);
  });

  it('coerces "" to undefined so the default applies', () => {
    const parsed = envSchema.parse({ ...minimal, SSE_HEARTBEAT_INTERVAL_MS: '' });
    expect(parsed.SSE_HEARTBEAT_INTERVAL_MS).toBe(25_000);
  });

  it('parses an integer string within bounds', () => {
    const parsed = envSchema.parse({ ...minimal, SSE_HEARTBEAT_INTERVAL_MS: '5000' });
    expect(parsed.SSE_HEARTBEAT_INTERVAL_MS).toBe(5_000);
  });

  it('accepts the inclusive lower bound (1 s)', () => {
    const parsed = envSchema.parse({ ...minimal, SSE_HEARTBEAT_INTERVAL_MS: '1000' });
    expect(parsed.SSE_HEARTBEAT_INTERVAL_MS).toBe(1_000);
  });

  it('accepts the inclusive upper bound (600 s)', () => {
    const parsed = envSchema.parse({ ...minimal, SSE_HEARTBEAT_INTERVAL_MS: '600000' });
    expect(parsed.SSE_HEARTBEAT_INTERVAL_MS).toBe(600_000);
  });

  it('rejects values below the lower bound', () => {
    expect(() => envSchema.parse({ ...minimal, SSE_HEARTBEAT_INTERVAL_MS: '999' })).toThrow();
  });

  it('rejects values above the upper bound', () => {
    expect(() => envSchema.parse({ ...minimal, SSE_HEARTBEAT_INTERVAL_MS: '600001' })).toThrow();
  });

  it('rejects 0, negatives, fractions, and non-numeric input', () => {
    expect(() => envSchema.parse({ ...minimal, SSE_HEARTBEAT_INTERVAL_MS: '0' })).toThrow();
    expect(() => envSchema.parse({ ...minimal, SSE_HEARTBEAT_INTERVAL_MS: '-1' })).toThrow();
    expect(() => envSchema.parse({ ...minimal, SSE_HEARTBEAT_INTERVAL_MS: '3.5' })).toThrow();
    expect(() => envSchema.parse({ ...minimal, SSE_HEARTBEAT_INTERVAL_MS: 'abc' })).toThrow();
  });
});

/**
 * Call-site pin — the pure-function tests above exercise the guard, but
 * they do not exercise the *wiring* in start.ts. A regression that deletes
 * the `assertProductionSafe(env)` line from start.ts would still leave
 * every assertProductionSafe() unit test green, because the function
 * itself is unchanged. This suite reads start.ts as a source file and
 * asserts the import + call site are present, so the refuse-to-start
 * promise from ADR-0013 / AC-45 cannot silently detach from the binary.
 *
 * Option (c) from the consolidation residuals task: a stronger pin would
 * dynamic-import start.ts after stubbing process.env, but start.ts
 * self-invokes on import (it performs DB migrations, seeds, listens).
 * Gating the self-invoke behind an "is-main-module" check would be a
 * behavior change for the production entry point, which the scope of this
 * task forbids. Source-string pinning is the minimum-invasive way to make
 * this regression loud.
 */
describe('start.ts call-site pin for assertProductionSafe', () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const startTsPath = path.resolve(__dirname, '../start.ts');
  const startSource = readFileSync(startTsPath, 'utf8');

  /**
   * Strip // line comments and block comments before matching so a
   * comment mentioning assertProductionSafe() does not satisfy the pin.
   * This is a deliberate simple regex-strip, not a full TS parser — the
   * start.ts file is small and does not contain comment-like literals in
   * strings that would confuse it.
   */
  const stripped = startSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('imports assertProductionSafe from ./config/env.js', () => {
    // Match a named import of assertProductionSafe from the env module.
    // Tolerates other named imports on the same line and either quote style.
    // Source is formatted multi-line by prettier, so `.` alone skips newlines —
    // use the `s` flag so `.` matches across lines inside the braces.
    const importPattern =
      /import\s*\{[^}]*\bassertProductionSafe\b[^}]*\}\s*from\s*['"]\.\/config\/env\.js['"]/s;
    expect(stripped).toMatch(importPattern);
  });

  it('calls assertProductionSafe with a non-empty argument', () => {
    // Match any `assertProductionSafe(...)` call with at least one char
    // of argument content. Flexible on argument form (identifier,
    // function call, expression) but strict that the guard is actually
    // invoked, not merely imported or referenced.
    const callPattern = /\bassertProductionSafe\s*\(\s*\S[^)]*\)/;
    expect(stripped).toMatch(callPattern);
  });

  it('calls assertStoragePublicEndpointInProduction with a non-empty argument', () => {
    // Parallel pin for the storage-endpoint guard. A regression that
    // drops the call from start.ts would let a misconfigured deploy boot
    // — uploads would silently fail against an unreachable presigned
    // URL (the exact defect this guard exists to prevent).
    const callPattern = /\bassertStoragePublicEndpointInProduction\s*\(\s*\S[^)]*\)/;
    expect(stripped).toMatch(callPattern);
  });

  // Same technique as the guard above: the reaper module owns the sweep
  // logic (unit-tested in session-reaper.test.ts), but the wiring in
  // start.ts is what actually schedules it in the running binary. A
  // regression that drops the call or feeds a literal 60 instead of the
  // validated env value would leave the unit tests green. This pin catches
  // the detachment.
  it('passes env.SESSION_CLEANUP_INTERVAL_MINUTES to startSessionReaper', () => {
    expect(stripped).toMatch(/\bstartSessionReaper\s*\(/);
    expect(stripped).toMatch(/intervalMinutes\s*:\s*env\.SESSION_CLEANUP_INTERVAL_MINUTES\b/);
  });

  it('start.ts wires startAuditRetentionScheduler to the retention env vars', () => {
    expect(stripped).toMatch(/\bstartAuditRetentionScheduler\s*\(/);
    expect(stripped).toMatch(/\benv\.AUDIT_RETENTION_INTERVAL_MINUTES\b/);
    expect(stripped).toMatch(/\benv\.AUDIT_RETENTION_WINDOW_DAYS\b/);
  });
});

// ---------------------------------------------------------------------
// Schema bypass cleanups (issue #139, AC-228 family) — pin the typed-
// schema home of two reads that previously lived as raw `process.env`
// access:
//
//   1. `LOGIN_RATE_LIMIT_MAX` — now a positive-int schema field with no
//      default. `src/server/config/index.ts:getRateLimit()` resolves it
//      via `getEnv()`. Missing values keep the build-time env-aware
//      default in place.
//
//   2. POSTGRES_PASSWORD / MINIO_ROOT_USER / MINIO_ROOT_PASSWORD — the
//      dev-defaults guard moved from `start.ts:rejectDevCredentials()`
//      into `env.ts` (`assertNoDevCredentials`), folded into the
//      aggregated `validateEnvAggregated()` error from AC-231 so every entry
//      point (start.ts and backup-runner.ts) shares one guard.
// ---------------------------------------------------------------------

describe('LOGIN_RATE_LIMIT_MAX in schema', () => {
  const minimal = { DATABASE_URL: 'postgres://unused' };

  it('accepts a positive integer string', () => {
    // Arrange — same fixture as the AUDIT_RETENTION_WINDOW_DAYS block;
    // a single required-without-default field plus the candidate.
    // Act — parse with a positive-int override.
    const parsed = envSchema.parse({ ...minimal, LOGIN_RATE_LIMIT_MAX: '15' });
    // Assert — the schema coerces to number and surfaces it on the
    // typed `Env`. Using `as` here because the impl phase decides
    // whether the field is `number | undefined` or has a default.
    expect((parsed as unknown as { LOGIN_RATE_LIMIT_MAX?: number }).LOGIN_RATE_LIMIT_MAX).toBe(15);
  });

  it('rejects zero', () => {
    expect(() => envSchema.parse({ ...minimal, LOGIN_RATE_LIMIT_MAX: '0' })).toThrow();
  });

  it('rejects negative integers', () => {
    expect(() => envSchema.parse({ ...minimal, LOGIN_RATE_LIMIT_MAX: '-5' })).toThrow();
  });

  it('rejects non-numeric strings', () => {
    expect(() => envSchema.parse({ ...minimal, LOGIN_RATE_LIMIT_MAX: 'lots' })).toThrow();
  });

  it('rejects fractional numbers (must be int)', () => {
    // `z.coerce.number()` alone accepts "3.5"; the schema must apply
    // `.int()` so the rate-limit ceiling is a count, not a rate.
    expect(() => envSchema.parse({ ...minimal, LOGIN_RATE_LIMIT_MAX: '3.5' })).toThrow();
  });

  it('treats absence as undefined so the build-time default applies', () => {
    const parsed = envSchema.parse(minimal);
    expect(
      (parsed as unknown as { LOGIN_RATE_LIMIT_MAX?: number }).LOGIN_RATE_LIMIT_MAX,
    ).toBeUndefined();
  });

  it('coerces "" to undefined (compose `${VAR:-}` pattern)', () => {
    // Same edge case as AUDIT_RETENTION_WINDOW_DAYS — docker compose
    // forwards an unset var as the empty string; the preprocess wrapper
    // must collapse "" to undefined so the build-time default still
    // applies. Without the wrapper, z.coerce.number() turns "" into 0
    // and .positive() rejects, crashing the deploy.
    const parsed = envSchema.parse({ ...minimal, LOGIN_RATE_LIMIT_MAX: '' });
    expect(
      (parsed as unknown as { LOGIN_RATE_LIMIT_MAX?: number }).LOGIN_RATE_LIMIT_MAX,
    ).toBeUndefined();
  });
});

describe('dev-default credentials guard in env.ts', () => {
  /**
   * Minimal valid prod-shaped env. Each test in this block layers a
   * dev-default credential on top to assert that single fault trips
   * the guard.
   */
  function prodInput(extra: Record<string, string>): Record<string, string | undefined> {
    return {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://prod',
      STORAGE_ENDPOINT: 'https://storage.example.com',
      STORAGE_PUBLIC_ENDPOINT: 'https://storage.example.com',
      STORAGE_ACCESS_KEY: 'ak',
      STORAGE_SECRET_KEY: 'sk',
      STORAGE_BUCKET: 'pm',
      STORAGE_REGION: 'us-east-1',
      // App-server presence requirement (ADR-0024). Tests in this block
      // exercise the dev-default credentials guard, not the binary-age
      // wiring; a placeholder keeps the unrelated guard from tripping.
      BINARY_AGE_RECIPIENT: 'age1unused',
      ALLOW_INSECURE_HTTP: 'false',
      ...extra,
    };
  }

  it('throws in production when POSTGRES_PASSWORD is the dev default "postgres"', () => {
    expect(() => validateEnvAggregated(prodInput({ POSTGRES_PASSWORD: 'postgres' }))).toThrow(
      /POSTGRES_PASSWORD/,
    );
  });

  it('throws in production when POSTGRES_PASSWORD is the dev default "devpassword"', () => {
    expect(() => validateEnvAggregated(prodInput({ POSTGRES_PASSWORD: 'devpassword' }))).toThrow(
      /POSTGRES_PASSWORD/,
    );
  });

  it('throws in production when MINIO_ROOT_USER is the dev default "minioadmin"', () => {
    expect(() => validateEnvAggregated(prodInput({ MINIO_ROOT_USER: 'minioadmin' }))).toThrow(
      /MINIO_ROOT_USER/,
    );
  });

  it('throws in production when MINIO_ROOT_PASSWORD is the dev default "minioadmin"', () => {
    expect(() => validateEnvAggregated(prodInput({ MINIO_ROOT_PASSWORD: 'minioadmin' }))).toThrow(
      /MINIO_ROOT_PASSWORD/,
    );
  });

  it('aggregates the dev-credentials offence with other validation issues', () => {
    // Arrange — a prod input with a dev-default password AND a separate
    // safety-guard offence (ALLOW_INSECURE_HTTP=true). A non-aggregated
    // validator would throw on whichever is checked first; the contract
    // requires both names in the same error.

    const input = prodInput({
      POSTGRES_PASSWORD: 'postgres',
      ALLOW_INSECURE_HTTP: 'true',
    });

    // Act + Assert.
    let captured: unknown = null;
    try {
      validateEnvAggregated(input);
    } catch (err) {
      captured = err;
    }
    expect(
      captured,
      'expected validateEnv to throw on combined dev-default + insecure-HTTP',
    ).toBeTruthy();
    const message = captured instanceof Error ? captured.message : String(captured ?? '');
    expect(message).toContain('POSTGRES_PASSWORD');
    expect(message).toContain('ALLOW_INSECURE_HTTP');
  });

  it('does NOT throw outside production when POSTGRES_PASSWORD is the dev default', () => {
    const input = prodInput({ POSTGRES_PASSWORD: 'postgres' });
    input.NODE_ENV = 'development';
    expect(() => validateEnvAggregated(input)).not.toThrow();
  });

  it('does NOT throw outside production when MINIO_ROOT_USER is the dev default', () => {
    const input = prodInput({ MINIO_ROOT_USER: 'minioadmin' });
    input.NODE_ENV = 'test';
    expect(() => validateEnvAggregated(input)).not.toThrow();
  });
});

// ---------------------------------------------------------------------
// Guard agreement (#143 follow-up A-3) — for any input that trips a
// single guard, the typed-Env throw helper and the aggregated validator
// MUST surface the same canonical message text. The guards now share a
// single predicate body per check; these tests pin that contract so a
// regression that splits the implementations again (re-introducing the
// drift mode flagged in #143) fails loud.
//
// Each test isolates one guard (other guards must not also trip) and
// captures the throw helper's message, then asserts the aggregator's
// message contains it verbatim. Containment (not equality) is required
// because the aggregator wraps with "Environment validation failed:\n
// - <message>" — so the message body must appear inside the
// aggregated error.
// ---------------------------------------------------------------------

describe('guard predicates: throw helper and aggregator agree', () => {
  /** Capture an Error message from a throwing call; null if it didn't throw. */
  function captureMessage(fn: () => unknown): string | null {
    try {
      fn();
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  it('checkProductionSafe: same message in throw and aggregated paths', () => {
    // Input that ONLY trips production-safety. Storage is configured
    // correctly so app-server / public-endpoint guards stay quiet.
    const env = makeEnv({
      NODE_ENV: 'production',
      ALLOW_INSECURE_HTTP: 'true',
      STORAGE_ENDPOINT: 'https://storage.example.com',
      STORAGE_PUBLIC_ENDPOINT: 'https://storage.example.com',
      STORAGE_ACCESS_KEY: 'ak',
      STORAGE_SECRET_KEY: 'sk',
    });
    const throwMsg = captureMessage(() => assertProductionSafe(env));
    expect(throwMsg, 'expected assertProductionSafe to throw').not.toBeNull();

    const aggregatedMsg = captureMessage(() =>
      validateEnvAggregated({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://prod',
        STORAGE_ENDPOINT: 'https://storage.example.com',
        STORAGE_PUBLIC_ENDPOINT: 'https://storage.example.com',
        STORAGE_ACCESS_KEY: 'ak',
        STORAGE_SECRET_KEY: 'sk',
        STORAGE_BUCKET: 'pm',
        ALLOW_INSECURE_HTTP: 'true',
      }),
    );
    expect(aggregatedMsg, 'expected validateEnvAggregated to throw').not.toBeNull();
    expect(aggregatedMsg).toContain(throwMsg!);
  });

  it('checkAppServerEnv: same message in throw and aggregated paths', () => {
    // Input that ONLY trips app-server presence. NODE_ENV=test so the
    // production-safety + container-host guards stay quiet. Every
    // app-server-required var the guard inspects is undefined so the
    // message lists the full set in both paths.
    const env = makeEnv({
      NODE_ENV: 'test',
      STORAGE_ENDPOINT: undefined,
      STORAGE_ACCESS_KEY: undefined,
      STORAGE_SECRET_KEY: undefined,
      STORAGE_REGION: undefined,
      BINARY_AGE_RECIPIENT: undefined,
    });
    const throwMsg = captureMessage(() => assertAppServerEnv(env));
    expect(throwMsg, 'expected assertAppServerEnv to throw').not.toBeNull();

    const aggregatedMsg = captureMessage(() =>
      validateEnvAggregated({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgres://test',
      }),
    );
    expect(aggregatedMsg, 'expected validateEnvAggregated to throw').not.toBeNull();
    expect(aggregatedMsg).toContain(throwMsg!);
  });

  it('checkStoragePublicEndpointInProduction: same message in throw and aggregated paths', () => {
    // Input that ONLY trips the container-host guard. App-server vars
    // are set; ALLOW_INSECURE_HTTP=false; STORAGE_ENDPOINT is a
    // container-only host without a public override.
    const env = makeEnv({
      NODE_ENV: 'production',
      STORAGE_ENDPOINT: 'http://storage:9000',
      STORAGE_PUBLIC_ENDPOINT: undefined,
      STORAGE_ACCESS_KEY: 'ak',
      STORAGE_SECRET_KEY: 'sk',
      ALLOW_INSECURE_HTTP: 'false',
    });
    const throwMsg = captureMessage(() => assertStoragePublicEndpointInProduction(env));
    expect(throwMsg, 'expected assertStoragePublicEndpointInProduction to throw').not.toBeNull();

    const aggregatedMsg = captureMessage(() =>
      validateEnvAggregated({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://prod',
        STORAGE_ENDPOINT: 'http://storage:9000',
        STORAGE_ACCESS_KEY: 'ak',
        STORAGE_SECRET_KEY: 'sk',
        STORAGE_BUCKET: 'pm',
        ALLOW_INSECURE_HTTP: 'false',
      }),
    );
    expect(aggregatedMsg, 'expected validateEnvAggregated to throw').not.toBeNull();
    expect(aggregatedMsg).toContain(throwMsg!);
  });
});
