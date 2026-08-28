import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { availableParallelism } from 'node:os';

// Worker cap for the `integration` project only — see the rationale on
// `maxWorkers` below. `- 1` leaves a core for the main vitest process
// (vitest's own default heuristic); the ceiling of 8 is where the wall
// clock stops improving (8 → 16 workers measured flat) so everything
// above it is pure contention. The floor is 1, not 2: the whole point of
// the cap is that workers outnumbering cores is what breaks this suite,
// so forcing a second worker onto a single-core box would invert it.
// Resolves to 8 on a 28-core dev box, 3 on a 4-vCPU runner.
const INTEGRATION_MAX_WORKERS = Math.max(1, Math.min(8, availableParallelism() - 1));

// Load all .env vars (empty prefix = no filter) so process.env
// has POSTGRES_PASSWORD etc. for server integration tests.
const env = loadEnv('test', process.cwd(), '');

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    globals: true,
    exclude: ['e2e/**', 'node_modules/**', '.claude/**'],
    env,
    css: {
      modules: {
        classNameStrategy: 'non-scoped',
      },
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/__tests__/**', 'src/test/**', 'src/main.tsx', 'src/vite-env.d.ts'],
    },
    projects: [
      {
        // Unit tests: pure domain functions, config validation, and
        // state-store tests that don't touch browser globals.
        // No database, no Fastify — safe to run files in parallel.
        //
        // The browser-API state-store tests live under the `unit-dom`
        // project below; node Blob / Stream identity diverges from
        // jsdom's, which breaks client-zip-driven assertions inside
        // attachmentStore — so those stores stay on node here while
        // the DOM-dependent stores get their own jsdom project.
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: [
            'src/config/__tests__/**/*.test.ts',
            'src/domain/__tests__/**/*.test.ts',
            'src/state/__tests__/**/*.test.ts',
          ],
          exclude: ['src/state/__tests__/storageUsageStore.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'unit-dom',
          environment: 'jsdom',
          include: ['src/state/__tests__/storageUsageStore.test.ts'],
        },
      },
      {
        // Component tests: React components and hooks with React Testing
        // Library, under jsdom. No network, no database — stores and
        // API client are stubbed per-file.
        extends: true,
        test: {
          name: 'component',
          environment: 'jsdom',
          include: [
            'src/ui/**/__tests__/**/*.test.{ts,tsx}',
            'src/hooks/**/__tests__/**/*.test.{ts,tsx}',
            'src/sw/__tests__/**/*.test.ts',
            // The shared test doubles themselves (`src/test/matchMediaStub.ts`).
            // A stub that silently misbehaves turns real failures green, so it
            // gets the same coverage as the code it stands in for.
            'src/test/__tests__/**/*.test.{ts,tsx}',
          ],
          setupFiles: ['src/test/component-setup.ts'],
        },
      },
      {
        // Integration tests: per-process PostgreSQL database, Fastify
        // server. The setupFile creates `projekt_manager_test_<pid>` and
        // overrides DATABASE_URL before any test imports — so two
        // parallel runs (different worktrees, different agents) cannot
        // race each other's seed TRUNCATE.
        //
        // Files run in parallel. `isolate` defaults to true, so vitest
        // gives every test file a freshly forked process — its own PID,
        // therefore its own database, its own `test-<pid>/` storage
        // prefix (integration-setup.ts §3) and its own binary `age`
        // identity (§2). Two files never share any of the three,
        // whether they run concurrently or back to back.
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          // Bounded, not unbounded, and scoped to this project — the
          // unit/component projects want every core (586 tests in 6.6s)
          // and must not inherit this cap. At vitest's default on a
          // 28-core box the integration suite is genuinely broken, not
          // merely slow: 24 of 112 files fail on `Hook timed out in
          // 10000ms`, because `startApp()` — CREATE DATABASE, migrate,
          // seed, buildApp — is a ~1s beforeAll that stops fitting its
          // budget once workers outnumber cores. The binding resource is
          // CPU, not Postgres connections: measured peak was 50 of
          // `max_connections=100` unbounded, and 25 at this cap.
          //
          // `maxWorkers`, not `poolOptions.forks.maxForks` — vitest 4
          // removed `poolOptions`.
          maxWorkers: INTEGRATION_MAX_WORKERS,
          // Forced by the cap above: vitest 4 refuses to start when two
          // projects carry different `maxWorkers` under the same
          // `groupOrder`, which is the case wherever the cap actually
          // binds (8 vs 27 on a 28-core box; on a 4-vCPU runner both
          // resolve to 3 and the conflict would not arise).
          //
          // It does NOT change the ordering. `fileParallelism: false`
          // resolved `maxWorkers` to 1, and vitest routes an isolated
          // single-worker project at the default `groupOrder` into a
          // trailing group of its own — so integration already ran last
          // and the unit/component slice already reported first.
          sequence: { groupOrder: 1 },
          // Headroom over that same ~1s beforeAll for a loaded CI runner
          // or a dev box with a build running alongside. Only bounds a
          // pathological hang; `testTimeout` keeps its default, so a
          // genuinely stuck test still fails fast.
          //
          // The trade is real: at the 10s default a `startApp()` that
          // regressed to ~8s would fail the suite, and now it passes
          // silently. Accepted because the parallel scheduler makes hook
          // wall-clock a function of runner load, not of `startApp()`
          // alone — so the 10s bound was measuring the wrong thing. A
          // startup-cost regression needs its own measurement, not a
          // timeout that fires on a busy runner instead.
          hookTimeout: 30_000,
          setupFiles: ['src/test/integration-setup.ts'],
          globalSetup: ['src/test/integration-globalsetup.ts'],
          include: ['src/server/__tests__/**/*.test.ts'],
        },
      },
    ],
  },
});
