/**
 * Production entry point.
 *
 * Boots the Fastify application, runs database migrations,
 * optionally seeds data, serves the static frontend, and starts listening.
 *
 * Executed via: node --import tsx src/server/start.ts
 */

import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { buildApp } from './app.js';
import { installNotFoundHandler, installSpaAwareNotFoundHandler } from './error-handler.js';
import { bootstrapAdminIfEmpty } from './bootstrap.js';
import {
  assertAppServerEnv,
  assertProductionSafe,
  assertStoragePublicEndpointInProduction,
  assertTrustedProxyInProduction,
  validateEnvRuntime,
} from './config/env.js';
import { emitFeatureManifest } from './config/features.js';
import { formatErrorChain } from './format-error-chain.js';
import { assertBaselineLedgerMatchesFile } from './db/baseline-guard.js';
import { createDatabase } from './db/connection.js';
import { probeHealth } from './health.js';
import { seed } from './seed.js';
import { pruneBucketOrphans, createBucketKeyLister } from './storage/pruneBucketOrphans.js';
import { deleteExpiredSessions } from './repositories/session.js';
import { startSessionReaper } from './session-reaper.js';
import { startAuditRetentionScheduler } from './audit-retention-scheduler.js';
import { startAttachmentOrphanReaperScheduler } from './attachment-orphan-reaper-scheduler.js';
import { startAttachmentHiddenReaperScheduler } from './attachment-hidden-reaper-scheduler.js';
import { startTakeoutStagingReaperScheduler } from './takeout-staging-reaper-scheduler.js';
import { reapAbandonedDataExchangeJobs } from './services/data-exchange-boot-reaper.js';
import { setOperationalLogger as setAuditPublisherLogger } from './services/audit-publisher.js';
import { AUDIT_RETENTION } from '../config/auditRetention.js';
import { ATTACHMENT_CONFIG } from '../config/attachmentConfig.js';
import { STATE_KEYS } from '../config/stateConfig.js';
import { assertBinaryIdentityLoaded } from './storage/binaryIdentity.js';
import { createStorageClient } from './storage/client.js';
import { assertStorageBucketSafe } from './storage/safety.js';
import { probeStagingDurability } from './config/assertStagingDurable.js';
import { registerStaticAssets } from './staticCache.js';

const HOST = '0.0.0.0';

// Takeout staging reaper cadence. The TTL it enforces is a [C] value
// (TAKEOUT_STAGING_TTL_MINUTES, default 24h); the sweep cadence is fixed
// because the action it takes is on a multi-hour window — hourly is the
// same rationale as the attachment hidden reaper's default cadence.
const TAKEOUT_STAGING_REAPER_INTERVAL_MINUTES = 60;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, 'db/migrations');
const distFolder = path.resolve(__dirname, '../../dist');

/**
 * Verify that every `status` value in the projects table is present in
 * the configured workflow states. Refuses to start if orphaned statuses
 * exist — prevents silent data loss when states are removed or renamed
 * without a data migration.
 */
async function validateWorkflowStates(db: ReturnType<typeof createDatabase>['db']): Promise<void> {
  const validSet = new Set<string>(STATE_KEYS);
  const rows = await db.execute<{ status: string }>(
    sql`SELECT DISTINCT status FROM projects WHERE deleted = false`,
  );
  const orphaned = rows.rows.filter((r) => !validSet.has(r.status)).map((r) => r.status);
  if (orphaned.length > 0) {
    throw new Error(
      `Refusing to start: ${orphaned.length} project(s) have status values not in the current ` +
        `workflow configuration: ${orphaned.join(', ')}. Run a data migration to reassign these ` +
        `projects before changing the workflow states.`,
    );
  }
}

async function start(): Promise<void> {
  // --- Validate environment (fail fast before any I/O) ---
  // validateEnvRuntime() returns the typed Env and folds in dev-default
  // credential rejection; the cross-field guards below remain external
  // so start.ts keeps control of their order and the backup-runner
  // (which shares validateEnvRuntime) does not get the app-server-only
  // narrowing.
  const env = validateEnvRuntime();
  const isProduction = env.NODE_ENV === 'production';

  // --- Production safety checks ---
  // assertProductionSafe() lives in env.ts so it can be unit-tested directly
  // (see env.test.ts) — see ADR-0013 and consolidation review C-2/C-4.
  assertProductionSafe(env);
  // STORAGE_* are optional at schema level (the backup-runner CLI shares
  // the same validator but doesn't use MinIO); the app server cannot run
  // without them, so enforce here.
  assertAppServerEnv(env);
  // Refuse to start in production without a reverse-proxy trust boundary.
  // Unset behind Caddy, `request.ip` silently becomes the proxy's container
  // IP, collapsing the login rate limiter into one global bucket.
  assertTrustedProxyInProduction(env);
  // Refuse to start in production when the storage client would sign
  // presigned URLs against a container-only hostname — the browser
  // cannot resolve those, so every upload fails silently.
  assertStoragePublicEndpointInProduction(env);
  // Refuse to start in production when TAKEOUT_STAGING_DIR resolves to a
  // RAM-backed filesystem (tmpfs/ramfs). A multi-GB archive on a tmpfs
  // staging path exhausts container RAM and OOM-kills the VPS. In
  // docker-compose.yml the `app` service mounts /tmp as tmpfs, so the
  // env.ts default (os.tmpdir()) lands in RAM; the compose named volume
  // `takeout-staging` at /var/lib/projekt-manager/takeout is disk-backed.
  // mkdir -p is idempotent — creates the dir when the volume is fresh.
  probeStagingDurability(env.TAKEOUT_STAGING_DIR, env.NODE_ENV);

  // Emit the boot-time feature manifest (AC-230) immediately after env
  // validation — operators see a single structured line listing every
  // optional feature's enabled/disabled state with reason. Order is
  // significant: the test pins emission AFTER validateEnvRuntime() so
  // the manifest never reports on an unverified env.
  emitFeatureManifest(env, {
    info: (ctx) => console.log(JSON.stringify(ctx)),
  });

  if (env.ALLOW_INSECURE_HTTP === 'true') {
    console.warn(
      'WARNING: ALLOW_INSECURE_HTTP=true — cookie Secure flag is OFF. ' +
        'Do not use with real users or real data. See docs/ops/http-only-evaluation.md.',
    );
  }

  const { db, pool } = createDatabase();

  // Recurrence guard for the drizzle baseline-hash trap (see
  // db/baseline-guard.ts and docs/ops/recover-from-schema-change.md).
  // Drizzle's `migrate()` records each migration by sha256 hash and
  // skips re-applying anything whose hash is already in the ledger —
  // so an edit to 0000_baseline.sql against an existing volume silently
  // no-ops, leaving the live schema diverged from schema.ts. Surface
  // the mismatch BEFORE migrate() pretends success and the app starts
  // taking traffic against a stale schema. Mirrors the pre-flight check
  // in scripts/deploy.sh.
  await assertBaselineLedgerMatchesFile(db, migrationsFolder);

  // Run database migrations (idempotent — drizzle tracks applied
  // migrations by hash; the guard above ensures the hash matches what
  // is on disk before we trust the idempotency).
  await migrate(db, { migrationsFolder });

  // Wire the post-commit audit publisher's failure-surface logger
  // (AC-183) BEFORE any mutate() call can dispatch. Bootstrap below
  // calls mutate(), which invokes the publisher; without a logger, a
  // throwing subscriber would be silently swallowed. No subscribers are
  // registered yet — #112 adds them — but the logger must already be
  // wired when the first dispatch happens.
  setAuditPublisherLogger({
    error: (payload) => console.error(payload),
  });

  // Seed data — never in production.
  // SEED=true  → seed only if database is empty (safe default for dev)
  // SEED=force → wipe and re-seed (when seed data structure changes)
  if (env.SEED === 'true' || env.SEED === 'force') {
    if (isProduction) {
      console.warn(
        'WARNING: SEED is set but NODE_ENV=production — skipping seed to protect production data.',
      );
    } else {
      await seed(db, { force: env.SEED === 'force' });

      // SEED=force truncates `attachments` (via CASCADE from `projects`)
      // but does not touch the bucket. Without this, a forced re-seed
      // leaves orphan blobs that grow each run and would mirror onto B2
      // via scripts/sync-dev-to-vps.sh if its pollution guard didn't
      // refuse. Prune here so "force" actually means full reset.
      if (env.SEED === 'force') {
        const prunerConfig = {
          endpoint: env.STORAGE_ENDPOINT,
          bucket: env.STORAGE_BUCKET,
          accessKey: env.STORAGE_ACCESS_KEY,
          secretKey: env.STORAGE_SECRET_KEY,
          region: env.STORAGE_REGION,
          keyPrefix: env.STORAGE_KEY_PREFIX,
        };
        const prunerStorage = createStorageClient({
          ...prunerConfig,
          publicEndpoint: env.STORAGE_PUBLIC_ENDPOINT,
        });
        await pruneBucketOrphans(
          db,
          prunerStorage,
          createBucketKeyLister(prunerConfig),
          { info: (m) => console.log(m), warn: (m) => console.warn(m) },
          env.STORAGE_BUCKET,
          env.NODE_ENV,
        );
      }
    }
  }

  // First-run admin bootstrap (ADR-0010 / issue #57). Runs AFTER migrate
  // and BEFORE app.listen — see AC-B7. Any thrown error propagates to the
  // start().catch(…) handler below, which exits non-zero.
  await bootstrapAdminIfEmpty(
    db,
    {
      username: env.BOOTSTRAP_ADMIN_USERNAME,
      password: env.BOOTSTRAP_ADMIN_PASSWORD,
      displayName: env.BOOTSTRAP_ADMIN_DISPLAY_NAME,
    },
    { warn: (m) => console.warn(m), error: (m) => console.error(m) },
  );

  // Verify all project status values in the DB are known to the current
  // configuration. If a state was removed or renamed without migrating
  // existing projects, those projects become invisible and untransitionable.
  // Refuse to start rather than silently hiding data.
  await validateWorkflowStates(db);

  // Clean up expired sessions on startup
  const deleted = await deleteExpiredSessions(db);
  if (deleted > 0) {
    console.log(`Cleaned up ${deleted} expired sessions.`);
  }

  // Reconcile abandoned data-exchange jobs on boot (data-model.md §5.18).
  // A restart leaves any in-flight export/import job stuck pending/running,
  // permanently occupying the one-active-per-kind slot (every later create
  // would 409); reap them to failed and delete their partial staged
  // archives. One-shot, like the expired-session cleanup above.
  const reapedJobs = await reapAbandonedDataExchangeJobs({
    db,
    stagingDir: env.TAKEOUT_STAGING_DIR,
    logger: {
      info: (ctx, event) => console.log(event, ctx),
      error: (ctx, event) => console.error(event, ctx),
    },
  });
  if (reapedJobs > 0) {
    console.log(`Reaped ${reapedJobs} abandoned data-exchange job(s) on boot.`);
  }

  // Schedule periodic cleanup so long-running deployments don't accumulate
  // expired rows between restarts. Handle is captured for the graceful
  // shutdown hook below.
  const reaper = startSessionReaper({
    db,
    intervalMinutes: env.SESSION_CLEANUP_INTERVAL_MINUTES,
    logger: {
      info: (msg) => console.log(msg),
      error: (err, msg) => console.error(msg, err),
    },
  });

  // Schedule audit-log retention cleanup (AC-184). Default cadence is
  // daily (1440 min) — retention is a cleanup, not a latency-sensitive
  // sweep, and the DELETE rides the `audit_log_created_at_idx` so cost
  // stays flat. Window is the [C] default unless
  // `AUDIT_RETENTION_WINDOW_DAYS` is set.
  const auditRetention = startAuditRetentionScheduler({
    db,
    intervalMinutes: env.AUDIT_RETENTION_INTERVAL_MINUTES,
    windowDays: env.AUDIT_RETENTION_WINDOW_DAYS ?? AUDIT_RETENTION.windowDays,
    logger: {
      info: (ctx, event) => console.log(event, ctx),
      error: (ctx, event) => console.error(event, ctx),
    },
  });

  // Attachment orphan reaper (AC-213). Sweeps pending rows past the
  // TTL together with their backing storage objects. Default cadence
  // 5 min — tighter than audit retention because a stuck pending row
  // has a correlated storage object that needs cleanup before it
  // accretes.
  const attachmentStorageForReaper = createStorageClient({
    endpoint: env.STORAGE_ENDPOINT,
    publicEndpoint: env.STORAGE_PUBLIC_ENDPOINT,
    bucket: env.STORAGE_BUCKET,
    accessKey: env.STORAGE_ACCESS_KEY,
    secretKey: env.STORAGE_SECRET_KEY,
    region: env.STORAGE_REGION,
    keyPrefix: env.STORAGE_KEY_PREFIX,
  });

  // Boot-time bucket-safety probe (ADR-0022 / docs/ops/object-storage-provisioning.md).
  // Refuses to start on data-corruption-class drift (versioning off,
  // Object Lock not Compliance, lifecycle missing or with disallowed
  // actions, R > L). The retention envelope passed here also asserts
  // the deployed bucket covers the configured invoice retention
  // (ADR-0026 / AC-296); a 0 value disables that assertion (dev).
  // Runs before reapers so a misconfigured bucket cannot accumulate
  // side-effects.
  await assertStorageBucketSafe(attachmentStorageForReaper, {
    invoiceObjectLockDays: env.INVOICE_OBJECT_LOCK_DAYS,
  });

  // Boot-time binary `age` identity probe (ADR-0024 §"Boot probe").
  // Refuses to start when the operator-loaded binary private identity is
  // missing, unreadable, malformed, or for the wrong recipient. Same
  // fail-closed character as the bucket-safety probe above; ADR-0024
  // explicitly rejects degraded modes (uploads-yes-downloads-no, fall
  // back to plaintext). Presence of BINARY_AGE_RECIPIENT is enforced by
  // checkAppServerEnv before this runs, so the recipient is non-empty.
  // Blocking startup here keeps every binary-decryption surface (export
  // jobs, attachment downloads) from ever serving in a degraded mode.
  await assertBinaryIdentityLoaded({
    identityPath: env.BINARY_AGE_IDENTITY_PATH,
    configuredRecipient: env.BINARY_AGE_RECIPIENT ?? '',
  });

  const attachmentReaper = startAttachmentOrphanReaperScheduler({
    db,
    storage: attachmentStorageForReaper,
    intervalMinutes: env.ATTACHMENT_ORPHAN_REAPER_INTERVAL_MINUTES ?? 5,
    ttlMinutes:
      env.ATTACHMENT_ORPHAN_REAPER_TTL_MINUTES ?? ATTACHMENT_CONFIG.orphanReaperTtlMinutes,
    logger: {
      info: (ctx, event) => console.log(event, ctx),
      error: (ctx, event) => console.error(event, ctx),
    },
  });

  // Attachment hidden reaper (AC-246 / data-model.md §6.12). Hard-deletes
  // hidden rows past the TTL together with their audit row via mutate().
  // No storage dependency — bytes are the bucket lifecycle's concern
  // (ADR-0022). Default cadence is hourly because the action it takes
  // is on a 2-day window; sub-hourly sweeps would be wasted.
  const hiddenReaper = startAttachmentHiddenReaperScheduler({
    db,
    intervalMinutes:
      env.ATTACHMENT_HIDDEN_REAPER_INTERVAL_MINUTES ??
      ATTACHMENT_CONFIG.hiddenReaperIntervalMinutes,
    ttlMinutes:
      env.ATTACHMENT_HIDDEN_REAPER_TTL_MINUTES ?? ATTACHMENT_CONFIG.hiddenReaperTtlMinutes,
    logger: {
      info: (ctx, event) => console.log(event, ctx),
      error: (ctx, event) => console.error(event, ctx),
    },
  });

  // Takeout staging reaper (AC-334 / data-model.md §6.15). Sweeps `ready`
  // export-job archives off the VPS-local staging path once they age past
  // TAKEOUT_STAGING_TTL_MINUTES, nulling `archive_ref` so the download
  // 404s. Reuses the attachment reaper's storage client (the staged
  // artifact is a filesystem path, so storage is a contract-surface dep).
  const takeoutStagingReaper = startTakeoutStagingReaperScheduler({
    db,
    storage: attachmentStorageForReaper,
    intervalMinutes: TAKEOUT_STAGING_REAPER_INTERVAL_MINUTES,
    ttlMinutes: env.TAKEOUT_STAGING_TTL_MINUTES,
    logger: {
      info: (ctx, event) => console.log(event, ctx),
      error: (ctx, event) => console.error(event, ctx),
    },
  });

  const app = buildApp({ logger: true, db });

  // Storage client for the health probe. Instantiated once at startup and
  // reused across health requests. The existing routes do not use storage
  // yet (walking skeleton), but #48 still wants MinIO liveness surfaced by
  // /api/health so operational outages show up before they cascade.
  const storageClient = createStorageClient({
    endpoint: env.STORAGE_ENDPOINT,
    publicEndpoint: env.STORAGE_PUBLIC_ENDPOINT,
    bucket: env.STORAGE_BUCKET,
    accessKey: env.STORAGE_ACCESS_KEY,
    secretKey: env.STORAGE_SECRET_KEY,
    region: env.STORAGE_REGION,
    keyPrefix: env.STORAGE_KEY_PREFIX,
  });

  // Health-check endpoint (outside auth-guarded routes). Real probe — runs
  // a trivial DB query and a HeadBucket against MinIO. Returns 503 if
  // either check fails, so the Docker healthcheck, smoke-test scripts, and
  // any future load balancer all see the actual state of the app's
  // dependencies instead of a hard-coded `ok`. See #48.
  app.get('/api/health', async (_request, reply) => {
    const health = await probeHealth(pool, storageClient);
    const code = health.status === 'ok' ? 200 : 503;
    return reply.code(code).send(health);
  });

  // Serve the Vite-built frontend from dist/ — production only. Gate on
  // isProduction, not just existsSync: a stray dist/ left over from an
  // earlier `npm run build` (typecheck, CI, Docker build context) must
  // never get silently served in dev. Vite's dev server on :5173 is always
  // the source of truth there; :3000 should only ever answer /api.
  if (isProduction) {
    if (!existsSync(distFolder)) {
      throw new Error(
        `dist/ not found at ${distFolder}. Run 'npm run build' before starting in production.`,
      );
    }
    await registerStaticAssets(app, distFolder);

    installSpaAwareNotFoundHandler(app);
  } else {
    installNotFoundHandler(app);
  }

  // Graceful shutdown — registered before listen to avoid a window
  // where SIGTERM during startup causes an unclean exit.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, async () => {
      // Wait for any in-flight sweep so pool.end() isn't called under its feet.
      await Promise.all([
        reaper.stop(),
        auditRetention.stop(),
        attachmentReaper.stop(),
        hiddenReaper.stop(),
        takeoutStagingReaper.stop(),
      ]);
      await app.close();
      await pool.end();
      process.exit(0);
    });
  }

  await app.listen({ port: env.PORT, host: HOST });
}

// Global error supervision (canonical Node.js production pattern;
// see https://nodejs.org/api/process.html#event-uncaughtexception and
// #event-unhandledrejection). The pool error handler in
// db/connection.ts covers the most common crash vector (idle clients
// from `pg_terminate_backend`); these two are the safety net for
// everything that escapes module-level handlers — a typo'd `await`,
// an event-emitter error in a third-party lib, a setTimeout callback
// that throws. Logging both as structured single lines gives operators
// a parseable failure marker instead of a multi-page stack dump from
// the default V8 printer. Exit non-zero so the container's restart
// policy treats this as a real failure; "log and continue" is the
// wrong choice — the process state is undefined after an uncaught
// exception per the Node.js docs.
process.on('uncaughtException', (err) => {
  console.error(
    JSON.stringify({
      event: 'uncaught-exception',
      message: err instanceof Error ? formatErrorChain(err) : String(err),
    }),
  );
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error(
    JSON.stringify({
      event: 'unhandled-rejection',
      message: reason instanceof Error ? formatErrorChain(reason) : String(reason),
    }),
  );
  process.exit(1);
});

start().catch((err) => {
  console.error('Failed to start server:', formatErrorChain(err));
  process.exit(1);
});
