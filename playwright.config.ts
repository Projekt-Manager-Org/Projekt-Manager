import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This project is ESM (`"type": "module"` in package.json), so
// `__dirname` is not defined — derive it from `import.meta.url`
// before resolving paths.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Preload `.env` into this config process so the webServer command
// inherits MINIO_*, POSTGRES_PASSWORD, and any other secrets the dev
// environment relies on. The E2E-specific overrides below (PORT,
// DATABASE_URL, VITE_DEV_PORT) then beat the file values because
// `webServer.env` is merged on top of process.env.
//
// `dev:e2e:server` (see package.json) intentionally skips Node's
// `--env-file-if-exists=.env` — otherwise Node would re-read the file
// in the child process and clobber the override values (Node's
// `--env-file` semantics: file wins over environment).
try {
  process.loadEnvFile(path.resolve(__dirname, '.env'));
} catch {
  // .env missing — rely on the ambient environment.
}

// The Playwright process itself needs DATABASE_URL pointed at the
// isolated E2E database — auth.setup.ts opens a direct DB handle
// (createDatabase → process.env.DATABASE_URL) to run `migrate()` +
// `seed(force: true)`. Without this override, the setup would
// truncate-and-reseed the developer's main `projekt_manager` DB,
// defeating the whole point of the isolation.
const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ||
  `postgresql://pm:${process.env.POSTGRES_PASSWORD || 'changeme'}@localhost:5432/projekt_manager_e2e`;
process.env.DATABASE_URL = E2E_DATABASE_URL;

// Same isolation argument for the object store: the Playwright process
// also opens a direct S3 client in auth.setup.ts to wipe the bucket
// before each run, and the webServer-spawned dev:e2e backend serves
// uploads against whatever STORAGE_BUCKET it sees. Override here (and
// again in webServer.env below) so test attachments land in the
// isolated `projekt-manager-e2e` bucket — leaving the dev bucket the
// operator works against on `npm run dev` untouched. Provisioned by
// docker/init-storage.sh; see docker-compose.minio.yml.
const E2E_STORAGE_BUCKET = process.env.STORAGE_BUCKET_E2E || 'projekt-manager-e2e';
process.env.STORAGE_BUCKET = E2E_STORAGE_BUCKET;

// Per-run binary `age` identity for the e2e webServer (ADR-0024). The
// boot probe (`assertBinaryIdentityLoaded`) refuses to start the app
// without a tmpfs-loaded identity matching `BINARY_AGE_RECIPIENT`. In
// production the operator pastes via `load-binary-key.sh`; in unit
// tests `src/test/integration-setup.ts` generates a per-PID keypair.
//
// E2E generates a throwaway pair ONCE per `npx playwright test`
// invocation, stashes the private half in `os.tmpdir()`, and passes
// both env vars to the webServer below. The `PM_E2E_BINARY_GENERATED`
// sentinel guards against regeneration in worker processes: Playwright
// re-evaluates this config in each test worker, and regenerating per
// worker leaves `auth.setup.ts`'s seed wrapping invoice DEKs against a
// keypair the webServer (spawned with the MAIN runner's keypair) cannot
// unwrap. Workers inherit `BINARY_AGE_RECIPIENT` /
// `BINARY_AGE_IDENTITY_PATH` + the sentinel from the main process and
// skip the keygen+writeFile leg.
const { execFileSync } = await import('node:child_process');
const os = await import('node:os');
if (!process.env.PM_E2E_BINARY_GENERATED) {
  const E2E_BINARY_IDENTITY_PATH = path.join(
    os.tmpdir(),
    `pm-e2e-binary-identity-${process.pid}.txt`,
  );
  const E2E_BINARY_IDENTITY = execFileSync('age-keygen', {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const E2E_BINARY_RECIPIENT = execFileSync('age-keygen', ['-y'], {
    input: E2E_BINARY_IDENTITY,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'ignore'],
  }).trim();
  fs.writeFileSync(E2E_BINARY_IDENTITY_PATH, E2E_BINARY_IDENTITY + '\n', { mode: 0o600 });
  process.on('exit', () => {
    try {
      fs.unlinkSync(E2E_BINARY_IDENTITY_PATH);
    } catch {
      // Already gone or never written — nothing to clean.
    }
  });

  // Mirror the DATABASE_URL / STORAGE_BUCKET pattern above: the Playwright
  // runner itself opens a direct backend handle in `auth.setup.ts` to run
  // `seed({ force: true })`, which constructs InvoiceService and calls
  // `getEnv()` — so the runner process needs these too, not just the
  // spawned webServer. Locally `.env` supplies them globally; in CI no
  // `.env` exists, and the seed throws "STORAGE_* and BINARY_AGE_RECIPIENT
  // / BINARY_AGE_IDENTITY_PATH are required" without this assignment.
  process.env.BINARY_AGE_RECIPIENT = E2E_BINARY_RECIPIENT;
  process.env.BINARY_AGE_IDENTITY_PATH = E2E_BINARY_IDENTITY_PATH;
  process.env.PM_E2E_BINARY_GENERATED = '1';
}
const E2E_BINARY_RECIPIENT = process.env.BINARY_AGE_RECIPIENT!;
const E2E_BINARY_IDENTITY_PATH = process.env.BINARY_AGE_IDENTITY_PATH!;

// Ubuntu 24.04's `kernel.apparmor_restrict_unprivileged_userns=1` blocks
// Chromium's namespace sandbox. Without this, Playwright injects
// `--no-sandbox` as a fallback and Chromium renders an "unsupported flag"
// infobar on every headed run. Pointing at Google Chrome's SUID helper
// (installed via the google-chrome-stable .deb) restores the sandbox —
// Chromium's docs rank this as the safest of the three workarounds
// (https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md).
//
// Skipped under CI: the ubuntu-latest runner image ships the
// `/opt/google/chrome/chrome-sandbox` binary but without the required
// `chown root && chmod 4755`, so Chromium aborts on launch ("SUID
// sandbox helper binary was found, but is not configured correctly").
// CI runs headless where the infobar is irrelevant anyway, so falling
// through to Playwright's default `--no-sandbox` launch is correct.
const SUID_SANDBOX = '/opt/google/chrome/chrome-sandbox';
const USE_SUID_SANDBOX = !process.env.CI && fs.existsSync(SUID_SANDBOX);
if (USE_SUID_SANDBOX) {
  process.env.CHROME_DEVEL_SANDBOX = SUID_SANDBOX;
}

/**
 * Default auth storage path — owner role. Must match
 * `STORAGE_STATES.owner` in e2e/auth.setup.ts. Declared here as a
 * literal (not imported from the setup file) so projects can reference
 * it without pulling a .ts source file into the config's resolution.
 * Specs that need a different role import `STORAGE_STATES` from
 * auth.setup.ts and set `test.use({ storageState: STORAGE_STATES.<role> })`.
 */
const STORAGE_STATE = path.resolve(__dirname, 'e2e/.auth/owner.json');

/**
 * Tests that create persistent data in the shared database.
 *
 * These must run serially (single worker) to prevent cross-test
 * contamination: management-flows creates customers/projects/users,
 * import-export-flows imports records, kanban-flows asserts on
 * aggregate counts that break if another test inserts rows mid-run.
 *
 * Read-only tests (failure-paths, insecure-banner, startup,
 * permission-visibility, theming) run in parallel in a separate project
 * that completes before this one starts.
 */
const MUTATING_TESTS =
  // `activity-dock\.spec` is anchored to the file extension so it matches
  // only the mutating AC-317/AC-318 spec — NOT `activity-dock-visibility`
  // (AC-319), which is read-only and must stay in the `chromium` project.
  /kanban-flows|management-flows|import-export-flows|theme-preference|data-exchange|archive-flows|activity-feed|notification-rules|activity-recipient-scope|activity-dock\.spec|push-permission|attachment-upload|papierkorb|daten-jobs|storage-usage-multi-user|project-lifecycle-multi-user|attachment-lifecycle-multi-user|realtime-after-fresh-login|invoices|company-profile/;
const DEMO_TESTS = /demo-.*\.spec\.ts/;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:5174',
    // Design ACs are verified by running Playwright in UI mode and reviewing
    // by eye (see CONTRIBUTING.md § Testing) — stored-screenshot baselines
    // were dropped as brittle friction. `retain-on-failure` captures a
    // full trace on any failing run so the failure can be inspected via
    // `npx playwright show-trace <zip>` without needing a retry to trigger.
    trace: 'retain-on-failure',
    // Re-enable Chromium's sandbox only when the SUID helper is available
    // (Playwright disables it by default). See the CHROME_DEVEL_SANDBOX
    // block above for the Ubuntu 24.04 AppArmor context.
    launchOptions: { chromiumSandbox: USE_SUID_SANDBOX },
  },
  projects: [
    // 1. Setup — reseed database, authenticate once per role, save four
    //    storage-state files. `fullyParallel: false` + `workers: 1` keep
    //    the reseed → per-role logins order — otherwise the logins race
    //    the TRUNCATE CASCADE and hit `Ein interner Fehler` from the
    //    dev server mid-truncate.
    {
      name: 'setup',
      testMatch: /.*\.setup\.ts/,
      fullyParallel: false,
      workers: 1,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
      },
    },

    // 2. Read-only tests — safe to parallelize. These never INSERT
    //    rows, so they can't interfere with each other's assertions.
    {
      name: 'chromium',
      dependencies: ['setup'],
      testIgnore: [/smoke\.spec\.ts/, /.*\.setup\.ts/, MUTATING_TESTS, DEMO_TESTS],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
        storageState: STORAGE_STATE,
      },
    },

    // 3. Mutating tests — serial, single worker. Depends on chromium so
    //    read-only specs finish before mutations begin; prevents race
    //    conditions where a mutating test changes DB state while a
    //    read-only assertion is still evaluating.
    {
      name: 'chromium-mutating',
      dependencies: ['chromium'],
      testMatch: MUTATING_TESTS,
      fullyParallel: false,
      workers: 1,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
        storageState: STORAGE_STATE,
      },
    },

    // 4. Smoke test — unauthenticated login round-trip. Runs after
    //    mutating tests so user deactivation/reactivation has settled.
    {
      name: 'smoke',
      dependencies: ['chromium-mutating'],
      testMatch: /smoke\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
      },
    },

    // 5. Demo recordings — opt-in only. The projects are omitted from
    //    the config entirely unless PLAYWRIGHT_RUN_DEMO is set, so a
    //    bare `npx playwright test` (locally or in CI) does not pick
    //    them up. They depend on `setup` so the e2e DB/bucket is seeded
    //    with the realistic snapshot before recording. Run with:
    //      npm run demo
    //    or directly:
    //      PLAYWRIGHT_RUN_DEMO=1 npx playwright test --project=demo --project=demo-mobile
    //
    //    `demo` records the desktop layout; `demo-mobile` emulates a real
    //    phone (Pixel 7, 412×839 — below the 768 px md breakpoint, so the
    //    genuine mobile shell renders, not a squished desktop). Both match
    //    every `demo-*.spec.ts`, so each scenario yields a desktop + a
    //    mobile clip from one authored spec.
    ...(process.env.PLAYWRIGHT_RUN_DEMO
      ? [
          {
            name: 'demo',
            dependencies: ['setup'],
            testMatch: DEMO_TESTS,
            use: {
              ...devices['Desktop Chrome'],
              viewport: { width: 1400, height: 1200 },
              video: { mode: 'on' as const, size: { width: 1400, height: 1200 } },
            },
          },
          {
            name: 'demo-mobile',
            dependencies: ['setup'],
            testMatch: DEMO_TESTS,
            use: {
              ...devices['Pixel 7'],
              video: { mode: 'on' as const, size: { width: 412, height: 839 } },
            },
          },
        ]
      : []),
  ],
  /**
   * Playwright spawns its own dev server + backend on ports separate
   * from the developer's local `npm run dev`, and points the backend
   * at a dedicated `projekt_manager_e2e` database. This prevents the
   * long-standing flakiness that arose when the developer was browsing
   * live data while Playwright's setup spec issued `TRUNCATE CASCADE`
   * against the same database — race conditions there surfaced as
   * sporadic visible-data drift and login failures.
   *
   * The E2E database must exist ahead of time. The auth.setup reseed
   * creates the schema via `migrate(db, …)` before the first login.
   *
   * `reuseExistingServer: false` means the devex cost is one vite +
   * one fastify per run; the gain is a reliable, deterministic suite.
   */
  webServer: {
    command: 'npm run dev:e2e',
    // Probe the backend via vite's /api proxy so readiness covers BOTH
    // processes started by `concurrently` — vite on 5174 and fastify on
    // 3100. Polling just `http://localhost:5174` only waits for vite:
    // the proxy answers with a 502 while fastify is still migrating +
    // seeding, and Playwright has happily started firing tests against a
    // backend that is not yet listening. That raced the first login in
    // auth.setup.ts (the others passed because fastify finished while
    // owner's 15 s timeout was still running). `/api/health` returns
    // 2xx only when the DB, MinIO, and fastify are all up, which is
    // exactly the pre-test invariant the setup tests assume.
    url: 'http://localhost:5174/api/health',
    reuseExistingServer: false,
    // 2-minute budget covers vite's first-time dep prebundle on a
    // cold node_modules/.vite cache; the default 60 s was tight enough
    // that a slow disk + canvas install could push us past it.
    timeout: 120_000,
    env: {
      // Fastify listens on 3100 (defaults to 3000); vite on 5174
      // (defaults to 5173). Both are overridden via env so the
      // long-standing `npm run dev` on 3000/5173 can keep running
      // alongside `npx playwright test` without port or DB collisions.
      PORT: '3100',
      VITE_DEV_PORT: '5174',
      VITE_API_PROXY_TARGET: 'http://localhost:3100',
      DATABASE_URL: E2E_DATABASE_URL,
      STORAGE_BUCKET: E2E_STORAGE_BUCKET,
      BINARY_AGE_RECIPIENT: E2E_BINARY_RECIPIENT,
      BINARY_AGE_IDENTITY_PATH: E2E_BINARY_IDENTITY_PATH,
    },
  },
});
