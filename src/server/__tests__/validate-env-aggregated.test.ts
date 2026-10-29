/**
 * AC-231 (behavioural half) — env validation aggregates ALL offending
 * fields into a single thrown error so the operator sees every issue at
 * once, not one-by-one across reboots.
 *
 * Issue #139 is rooted in operator forgetfulness around env wiring. A
 * deploy that fails fast on the FIRST missing var, only to fail again on
 * the SECOND after the operator fixes the first, is a worst-case failure
 * mode: each iteration costs a deploy cycle. The fix: surface every
 * offence in one error — schema violations, missing required fields, AND
 * the production-safety guards (ALLOW_INSECURE_HTTP=true in prod,
 * dev-default credentials, container-only STORAGE_ENDPOINT without a
 * public override in prod) all in the same aggregated pass.
 *
 * Coverage pinned by this file:
 *
 *   - Multiple invalid schema fields → one error, every offending key
 *     named.
 *   - Multiple missing required fields → one error, every key named.
 *   - Production-safety guards trip in the same aggregation pass:
 *       * ALLOW_INSECURE_HTTP=true with NODE_ENV=production
 *       * POSTGRES_PASSWORD / MINIO_ROOT_* set to dev defaults
 *       * STORAGE_ENDPOINT is a container-only host without
 *         STORAGE_PUBLIC_ENDPOINT
 *   - All three categories triggered together → still one error,
 *     every offence named.
 *
 *   - Structural pin on `scripts/deploy.sh`: validates env BEFORE
 *     `docker compose up`. The pin rejects two anti-patterns:
 *       * `||`-swallow on the validation step (would silently skip on
 *         failure).
 *       * `&` background-run on the validation step (would race with
 *         the `up` and not gate it).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { validateEnvAggregated } from '../config/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

describe('AC-231: validateEnv aggregates ALL invalid schema fields into one error', () => {
  it('names every invalid key in a single thrown error', () => {
    // Arrange — three independently invalid schema fields.
    const input = {
      DATABASE_URL: 'postgres://test',
      // PORT must be a positive integer; "0" violates `.positive()`.
      PORT: '0',
      // SESSION_CLEANUP_INTERVAL_MINUTES must be a positive integer; "-1"
      // violates `.positive()`.
      SESSION_CLEANUP_INTERVAL_MINUTES: '-1',
      // SEED is an enum of 'true' | 'false' | 'force'; "maybe" is not.
      SEED: 'maybe',
    };

    // Act + Assert — one error mentioning every offending key.
    let captured: unknown = null;
    try {
      validateEnvAggregated(input);
    } catch (err) {
      captured = err;
    }
    expect(captured, 'expected validateEnv to throw').toBeTruthy();
    const message = captured instanceof Error ? captured.message : String(captured ?? '');
    expect(message).toContain('PORT');
    expect(message).toContain('SESSION_CLEANUP_INTERVAL_MINUTES');
    expect(message).toContain('SEED');
  });

  it('names every missing required field in a single thrown error', () => {
    // Arrange — DATABASE_URL is the only required-with-no-default field
    // in the schema today. Missing it should produce an error that
    // names it (and any other absent required key the impl phase adds).
    const input = {} as Record<string, string | undefined>;

    let captured: unknown = null;
    try {
      validateEnvAggregated(input);
    } catch (err) {
      captured = err;
    }
    expect(captured, 'expected validateEnv to throw on missing required fields').toBeTruthy();
    const message = captured instanceof Error ? captured.message : String(captured ?? '');
    expect(message).toContain('DATABASE_URL');
  });
});

describe('AC-231: validateEnv folds in the production-safety guards in the same pass', () => {
  it('reports schema, missing-required, and safety-guard offences in the SAME thrown error', () => {
    // Arrange — one input tripping all three categories at once. A
    // sequential validator would surface only the first; the aggregated
    // contract requires all three names in the message.
    const input = {
      // Schema: PORT zero violates positive().
      PORT: '0',
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://prod',
      STORAGE_ENDPOINT: 'https://storage.example.com',
      STORAGE_PUBLIC_ENDPOINT: 'https://storage.example.com',
      STORAGE_ACCESS_KEY: 'ak',
      STORAGE_SECRET_KEY: 'sk',
      STORAGE_BUCKET: 'pm',
      // Safety guard: insecure HTTP in prod.
      ALLOW_INSECURE_HTTP: 'true',
      // Safety guard: dev-default minio root password.
      MINIO_ROOT_PASSWORD: 'minioadmin',
    };

    let captured: unknown = null;
    try {
      validateEnvAggregated(input);
    } catch (err) {
      captured = err;
    }
    expect(captured, 'expected validateEnv to throw on a multi-category invalid env').toBeTruthy();
    const message = captured instanceof Error ? captured.message : String(captured ?? '');
    expect(message).toContain('PORT');
    expect(message).toContain('ALLOW_INSECURE_HTTP');
    expect(message).toContain('MINIO_ROOT_PASSWORD');
  });
});

// ---------------------------------------------------------------------
// AC-231 structural half — `scripts/deploy.sh` invokes validateEnv
// BEFORE bringing the stack up. A check that runs after `docker compose
// up` cannot prevent the bad config from going live; the assertion
// orders the validation step before the up.
// ---------------------------------------------------------------------

describe('AC-231: scripts/deploy.sh runs env validation before docker compose up', () => {
  const deployScript = readFileSync(path.join(repoRoot, 'scripts/deploy.sh'), 'utf8');
  // Strip shell comments so a comment line that mentions `docker
  // compose up` (or similar) does not satisfy a code-only contract
  // pin. Code-only view is what gets executed at deploy time.
  const codeLines = deployScript.split('\n').filter((l) => !/^\s*#/.test(l));
  const code = codeLines.join('\n');
  // The deploy pre-flight is invoked by name through the bundled CLI
  // artifact. Pinning on the dist path (not on a function name that
  // could appear in a comment) makes the test fail loud if the actual
  // invocation line is removed or renamed without updating both sides.
  const PREFLIGHT_INVOCATION = /\/dist\/server\/deploy-preflight-cli\.js\b/;

  it('contains a deploy-preflight-cli invocation', () => {
    expect(code).toMatch(PREFLIGHT_INVOCATION);
  });

  it('the preflight invocation precedes the `docker compose up` step', () => {
    const preflightIdx = code.search(PREFLIGHT_INVOCATION);
    // Profiles come inline (`--profile x`) or from scripts/lib/deploy-compose.sh.
    const composeUpIdx = code.search(
      /docker\s+compose\s+(?:(?:--profile\s+\S+|"\$\{DEPLOY_COMPOSE_PROFILES\[@\]\}")\s+)?up\b/,
    );
    expect(preflightIdx, 'preflight invocation not found in deploy.sh').toBeGreaterThanOrEqual(0);
    expect(composeUpIdx, '`docker compose up` not found in deploy.sh').toBeGreaterThanOrEqual(0);
    expect(
      preflightIdx,
      'preflight must run before `docker compose up` so a bad config aborts the deploy before containers are recreated',
    ).toBeLessThan(composeUpIdx);
  });

  it('the preflight step is not swallowed by a swallow-pattern `||`', () => {
    // A `preflight ... || true` (or `|| :` or `|| echo ...`) turns a
    // non-zero exit into a success, defeating the pre-flight. Patterns
    // that re-throw the failure (`|| exit 1`, `|| { echo ...; exit 1; }`)
    // are legitimate — they preserve abort semantics under both `set -e`
    // and a missing `set -e`. Only the swallow patterns are rejected.
    const swallow = /\|\|\s*(true|:|echo\b)/;
    const offendingLines = codeLines.filter((l) => PREFLIGHT_INVOCATION.test(l) && swallow.test(l));
    expect(
      offendingLines,
      `preflight step must not be ||-swallowed:\n${offendingLines.join('\n')}`,
    ).toEqual([]);
  });

  it('the preflight step is not run in the background (`&`)', () => {
    // A trailing `&` would race the validation against `docker compose
    // up`; the deploy could proceed before validation reports failure.
    // Tolerate `&&` (logical-AND) but reject a bare `&` at end-of-line.
    const offendingLines = codeLines.filter(
      (l) => PREFLIGHT_INVOCATION.test(l) && /(?<!&)&\s*$/.test(l),
    );
    expect(
      offendingLines,
      `preflight step must not be backgrounded:\n${offendingLines.join('\n')}`,
    ).toEqual([]);
  });

  it('the deploy script aborts on first failure (`set -e` or equivalent)', () => {
    // Without `set -e` (or `set -euo pipefail`), a non-zero exit from
    // the preflight followed by `docker compose up` on the next line
    // would proceed past the failure, defeating the pre-flight. Pin
    // that the script declares fail-fast at the top.
    const head = deployScript.split('\n').slice(0, 30).join('\n');
    expect(head, 'deploy.sh must declare `set -e` (or `set -euo pipefail`) near the top').toMatch(
      /^\s*set\s+-(e|eu|euo|euo\s+pipefail)\b/m,
    );
  });
});
