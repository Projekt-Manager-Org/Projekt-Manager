/**
 * Environment variable validation.
 * Fails fast at startup if required variables are missing or malformed.
 *
 * Two entry points (issue #139, split per #143 follow-up A-1):
 *   - `validateEnvRuntime()` — boot path; reads `process.env`, re-parses
 *     on every call. Used by start.ts, backup-runner.ts, db/connection.ts,
 *     api-helpers.ts. Runs the schema + the dev-default credential guard.
 *     The other safety guards (`assertProductionSafe`,
 *     `assertAppServerEnv`, `assertStoragePublicEndpointInProduction`)
 *     stay external so each entry point keeps control of their order
 *     and the backup-runner does not get the app-server-only narrowing.
 *     The cache that previously memoised the first parse was removed
 *     because `getRateLimit()` and other call-time consumers must reflect
 *     env mutations performed during a process's lifetime (notably
 *     vitest tests that mutate `process.env.NODE_ENV` between cases).
 *     Re-parsing is cheap; the perf cost is irrelevant against the
 *     staleness footgun the cache introduced.
 *   - `validateEnvAggregated(input)` — pure function over the supplied
 *     record. Runs the schema AND every cross-field guard in one pass,
 *     aggregating every offence into ONE thrown error so an operator
 *     sees every fault in a single failed deploy, not one-per-reboot.
 *     Used by the deploy pre-flight CLI and by tests.
 */
import { z } from 'zod';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { checkBootstrapCredentialPair } from './bootstrap-credentials.js';
import { derivePublicKey } from './vapid.js';

/**
 * Splits and validates a `TRUSTED_PROXY_CIDRS` value.
 *
 * Accepts a comma-separated list of IPv4/IPv6 addresses or CIDR blocks —
 * the subset of `proxy-addr` syntax that names a concrete peer. proxy-addr's
 * presets (`loopback`, `linklocal`, `uniquelocal`) are deliberately rejected:
 * `uniquelocal` trusts every RFC1918 address, which would let a VPN peer
 * (`10.213.17.0/24`, ADR-0008) forge X-Forwarded-For and shift `request.ip`
 * off itself. Only an explicit address or block that names the reverse proxy
 * is a trust boundary.
 *
 * Returns null when the value is malformed so the schema rejects it at boot,
 * rather than letting proxy-addr throw on the first request.
 */
function parseTrustedProxyCidrs(raw: string): string[] | null {
  const entries = raw.split(',').map((e) => e.trim());
  if (entries.some((e) => e.length === 0)) return null;
  for (const entry of entries) {
    const slash = entry.indexOf('/');
    const addr = slash === -1 ? entry : entry.slice(0, slash);
    const family = net.isIP(addr);
    if (family === 0) return null;
    if (slash !== -1) {
      const prefix = entry.slice(slash + 1);
      if (!/^\d{1,3}$/.test(prefix)) return null;
      if (Number(prefix) > (family === 4 ? 32 : 128)) return null;
    }
  }
  return entries;
}

export const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  // Default to 'production' so the production-safety checks (see
  // assertProductionSafe below) fire when NODE_ENV is unset. The previous
  // default ('development') once let the binary start with
  // ALLOW_INSECURE_HTTP=true when NODE_ENV was not explicitly set —
  // closing that hole is the whole point of this default. Dev workflows
  // must set NODE_ENV=development explicitly (docker-compose.dev.yml,
  // .env.example). 'test' is accepted because vitest sets it by default;
  // it is treated the same as 'development' by assertProductionSafe and
  // getCookieSecure (neither considers it 'production'). See ADR-0013 and
  // iteration 5 consolidation review C-2.
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // STORAGE_* is the app server's MinIO surface (attachments). The backup
  // service (ADR-0020) doesn't touch it — it uses R2_* instead. Optional
  // here so the shared validateEnvRuntime() call in backup-runner.ts doesn't
  // reject for vars the backup path never reads; `assertAppServerEnv()`
  // below (called only from start.ts) enforces presence for the app path.
  STORAGE_ENDPOINT: z.string().optional(),
  // Optional public hostname the browser uses to reach MinIO. The app
  // signs presigned PUT / GET URLs against this endpoint (not
  // STORAGE_ENDPOINT, which points at the Docker-internal hostname).
  // Required in production when STORAGE_ENDPOINT is a container-only
  // host — enforced by `assertStoragePublicEndpointInProduction()`.
  // Compose forwards `${STORAGE_PUBLIC_ENDPOINT:-}` so an unset operator
  // value arrives as the empty string, not undefined. Coerce "" →
  // undefined so the truthy / `??` checks downstream (CSP origin
  // extraction in app.ts, the publicEndpoint passthrough in
  // createStorageClient) treat empty as "fall back to STORAGE_ENDPOINT".
  STORAGE_PUBLIC_ENDPOINT: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  STORAGE_BUCKET: z.string().min(1).default('projekt-manager'),
  // Optional per-process key prefix. When set, every storage operation
  // (put / get / head / hide / list / copy / presign) transparently
  // prepends this string; production passes none (callers see and store
  // bare keys). The vitest integration suite sets `test-<pid>/` so each
  // fork's writes land in its own keyspace inside the shared test bucket
  // — mirroring the per-PID DB isolation in `integration-setup.ts`.
  // Must be empty or match `^[a-z0-9][a-z0-9_-]*\/$` (lowercase + digits
  // + `_-`, trailing `/`); collapsing the empty string to undefined keeps
  // the downstream `?? undefined` checks clean.
  STORAGE_KEY_PREFIX: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .regex(
        /^[a-z0-9][a-z0-9_-]*\/$/,
        'STORAGE_KEY_PREFIX must match [a-z0-9][a-z0-9_-]*/ (trailing slash required)',
      )
      .optional(),
  ),
  // MinIO SigV4 credentials. Optional in the shared schema so the
  // backup-runner path (which never reads them) isn't rejected; mandatory
  // for the app server — presence enforced by `assertAppServerEnv()` /
  // `checkAppServerEnv()`.
  STORAGE_ACCESS_KEY: z.string().optional(),
  STORAGE_SECRET_KEY: z.string().optional(),
  // S3 region used for SigV4 signing. MinIO accepts any value (`us-east-1`
  // is fine in dev); B2's S3-compat surface verifies the bucket-bound
  // region (`us-west-002`, `eu-central-003`, …) and rejects mismatches
  // with `SignatureDoesNotMatch`. Optional in the shared schema so the
  // backup-runner doesn't need it; `assertAppServerEnv()` enforces
  // presence on the app-server path.
  STORAGE_REGION: z.string().optional(),
  DOMAIN: z.string().default('localhost'),
  SEED: z.enum(['true', 'false', 'force']).default('false'),
  // First-run admin bootstrap — see ADR-0010 and issue #57. All three are
  // optional; the "both or neither" pairing and the password policy are
  // enforced by `checkBootstrapCredentialPair` (config/bootstrap-credentials.ts)
  // at two points: the boot path (src/server/bootstrap.ts, DB-empty insert)
  // and the deploy-preflight cross-field guard below.
  // When true, disables the Secure flag on session cookies so login works
  // over plain HTTP. Intended for evaluation deployments without a domain/TLS.
  // See docs/ops/http-only-evaluation.md.
  ALLOW_INSECURE_HTTP: z.enum(['true', 'false']).default('false'),
  // Reverse proxies whose `X-Forwarded-For` the app is willing to believe.
  // Comma-separated IPs / CIDR blocks; must match the pinned
  // `networks.default` subnet in docker-compose.yml, which is the only
  // address Caddy can reach the app from (ADR-0008 topology).
  //
  // Unset ⇒ trust nothing, so `request.ip` is the socket peer — correct for
  // local dev, which bypasses Caddy and hits the app directly.
  // `checkTrustedProxyInProduction()` requires it in production: behind a
  // proxy an unset value silently pins every request to Caddy's container
  // IP, which collapses the login rate limiter into one global bucket and
  // records the proxy instead of the client in the login audit trail.
  //
  // Fastify 5.12.1 removed the numeric hop-count form this used to be set
  // to (`trustProxy: 1`) — see GHSA-3m5p-2c4r-xxw2: a hop count never
  // validated *which* peer connected, so anything reaching the app directly
  // could spoof X-Forwarded-*. An address/CIDR is the documented migration.
  TRUSTED_PROXY_CIDRS: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .refine((v) => parseTrustedProxyCidrs(v) !== null, {
        message:
          'TRUSTED_PROXY_CIDRS must be a comma-separated list of IP addresses or CIDR ' +
          'blocks (e.g. "172.16.0.0/16"). proxy-addr presets such as "uniquelocal" are ' +
          'rejected — they trust every private address, not just the reverse proxy.',
      })
      .optional(),
  ),
  BOOTSTRAP_ADMIN_USERNAME: z.string().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().optional(),
  BOOTSTRAP_ADMIN_DISPLAY_NAME: z.string().optional(),
  // OpenRouter LLM extraction (ADR-0016). Optional — feature is disabled
  // when the key is absent.
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default('google/gemini-2.5-flash-lite'),
  // How often the periodic session reaper sweeps expired sessions.
  // Default 60 min is the same cadence the startup-only cleanup used to
  // provide implicitly via server restarts; lower values are fine for
  // environments that want tighter revocation latency.
  SESSION_CLEANUP_INTERVAL_MINUTES: z.coerce.number().int().positive().default(60),
  // Audit-log retention window in days — [C] per architecture.md §12.2
  // and data-model.md §6.10. When unset, the build-time default in
  // `src/config/auditRetention.ts` (90 d) applies. Coerced to integer
  // because a fractional day window makes no sense for a rolling
  // cleanup and the AC-184 log line types `window_days` as integer.
  // preprocess: compose forwards this as `${AUDIT_RETENTION_WINDOW_DAYS:-}`,
  // so an unset var arrives as "" — which `z.coerce.number()` turns into 0
  // and `.positive()` then rejects. Map "" → undefined so .optional() takes
  // over and start.ts falls back to the build-time default.
  AUDIT_RETENTION_WINDOW_DAYS: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  // How often the audit-retention cleanup runs. One run is a single
  // indexed DELETE against the `audit_log_created_at_idx`; daily (1440
  // min) is the production default because retention is a cleanup, not
  // a latency-sensitive sweep. Overridable per deployment — tests leave
  // the scheduler untouched and call the service directly.
  AUDIT_RETENTION_INTERVAL_MINUTES: z.coerce.number().int().positive().default(1440),
  // Login-rate-limit ceiling — moved into the schema in #139 to close the
  // last raw-`process.env` read inside the configuration boundary
  // (AC-228). The build-time default in `getRateLimit()` is environment-
  // aware (5/min in production, 30/min elsewhere); this override applies
  // when the operator sets a numeric value. Same `${VAR:-}` empty-string
  // preprocess as AUDIT_RETENTION_WINDOW_DAYS.
  LOGIN_RATE_LIMIT_MAX: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  // ---------------------------------------------------------------
  // Layer 2 backup (ADR-0020). Consumed by the `backup-runner` CLI,
  // not by the main app server — but declared here so the schema
  // remains the single source of truth. Optional at the app-server
  // level; the CLI enforces presence at dispatch time.
  // ---------------------------------------------------------------
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_ENDPOINT: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  R2_REGION: z.string().default('auto'),
  /** Public age recipient (asymmetric). Encryption fails fast if empty
   * to preserve the "no plaintext at rest" invariant (AC-167).
   *
   * Shape-check enforced here so a private identity pasted by mistake
   * (`AGE-SECRET-KEY-1…`) is rejected at boot instead of silently
   * producing undecryptable backups for the first cycle. The former
   * `scripts/backup/entrypoint.sh` did this check in bash; it now
   * lives at the schema layer (#199 removed the shell entrypoint).
   *
   * `preprocess('' → undefined)` mirrors the pattern used by
   * STORAGE_PUBLIC_ENDPOINT and other compose-forwarded keys:
   * docker-compose.yml writes `${AGE_RECIPIENT:-}`, which materialises
   * as the empty string when the operator has not sourced
   * secrets.env.age (dev workflows; backup profile gated off). Without
   * the preprocess, the empty string would fail the refine and break
   * the app container's boot for any deploy that doesn't include the
   * backup secrets. */
  AGE_RECIPIENT: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .optional()
      .refine(
        (v) => v === undefined || v.startsWith('age1'),
        'AGE_RECIPIENT must be the public recipient (age1…), not the private identity (AGE-SECRET-KEY-1…). Re-derive with: age-keygen -y <identity-file>',
      ),
  ),
  /** Tmpfs-resident identity path used by the drill decrypt step.
   * Default matches the tmpfs mount in docker-compose.yml's `backup`
   * service so operators don't need to set it. */
  AGE_IDENTITY_PATH: z.string().default('/run/drill-key/identity'),
  // ---------------------------------------------------------------
  // Binary attachment e2e (ADR-0024 / AC-239). Independent keypair from
  // the backup AGE_RECIPIENT above — separate rotation cadence and
  // separate blast radius. The boot-time probe
  // `assertBinaryIdentityLoaded` refuses to start the app service when
  // the derived recipient of the tmpfs-loaded identity does not match
  // BINARY_AGE_RECIPIENT.
  // ---------------------------------------------------------------
  /** Public age recipient (X25519) for wrapping per-attachment DEKs.
   * Optional at the schema layer because the backup-runner CLI shares
   * `validateEnvRuntime`; `assertAppServerEnv` enforces presence on the
   * app-server boot path. */
  BINARY_AGE_RECIPIENT: z.string().optional(),
  /** Tmpfs-resident path the boot probe reads the operator-loaded
   * private identity from. Default matches the tmpfs mount declared on
   * the `app` service in docker-compose.yml — operators that follow the
   * runbook do not need to set this explicitly. */
  BINARY_AGE_IDENTITY_PATH: z.string().default('/run/binary-key/identity'),
  // ---------------------------------------------------------------
  // Web Push / VAPID (architecture.md §11.11). The public key is derived
  // from the private half at startup (P-256 ECDSA — `src/server/config/vapid.ts`),
  // so the operator only maintains the private key. In production,
  // missing `VAPID_PRIVATE_KEY` falls back to `noopPushDispatcher` with
  // a startup warn. In dev/test the helper auto-generates a key into
  // `data/.vapid/private-key` on first boot so push works zero-config.
  // `VAPID_SUBJECT` must be either a `mailto:` URL or an `https:` URL
  // per RFC 8292 §2.1 — format validated at WebPushDispatcher boot.
  // ---------------------------------------------------------------
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),
  // ---------------------------------------------------------------
  // Attachments (data-model.md §5.13, architecture.md §12.2).
  // All four overrides follow the "empty string → undefined" pattern
  // so docker-compose's `${VAR:-}` forward does not collapse an unset
  // variable into 0 (which `.positive()` would then reject). Build-time
  // defaults live in `src/config/attachmentConfig.ts`.
  // ---------------------------------------------------------------
  ATTACHMENT_PER_FILE_CAP_BYTES: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  ATTACHMENT_THUMB_CAP_BYTES: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  ATTACHMENT_BULK_MAX_FILES: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  ATTACHMENT_BULK_MAX_BYTES: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  ATTACHMENT_ORPHAN_REAPER_TTL_MINUTES: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  ATTACHMENT_WORKER_SELF_DELETE_GRACE_MINUTES: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  ATTACHMENT_ORPHAN_REAPER_INTERVAL_MINUTES: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  ATTACHMENT_HIDDEN_REAPER_TTL_MINUTES: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  ATTACHMENT_HIDDEN_REAPER_INTERVAL_MINUTES: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  // ---------------------------------------------------------------
  // Storage capacity declaration (architecture.md §12.2). The stored
  // ciphertext volume the deployment's bucket is provisioned for; the
  // threshold monitor warns the owner at
  // `THRESHOLD_MONITOR.storageWarnPercent` of this figure.
  //
  // Env rather than a source constant because it tracks the bucket this
  // deployment points at, not policy — a second deployment against a
  // bigger bucket must not need a code edit to tell the truth about its
  // own capacity.
  //
  // Optional, no default: an unset value means "capacity undeclared" and
  // the monitor skips the storage check entirely (logged once at
  // startup). A default here would be a fabricated capacity figure, and
  // warnings measured against a number nobody chose are worse than no
  // warnings. Power-of-1024 GB, matching `formatBytes` (AC-274).
  // ---------------------------------------------------------------
  STORAGE_QUOTA_GB: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  // ---------------------------------------------------------------
  // Full-account takeout staging (ADR-0018 / ADR-0024, data-model.md
  // §5.18 / §6.14, architecture.md §12.2). The export job builds the
  // archive (envelope + every ready attachment's plaintext) and stages
  // it on a VPS-local path — never on B2 (ADR-0024: plaintext stays
  // inside the trust radius). `TAKEOUT_STAGING_TTL_MINUTES` is the [C]
  // age after which the scheduled reaper sweeps a `ready` artifact
  // (default 1440 = §12.2's 24h, mirroring the ATTACHMENT_*_REAPER TTLs).
  // `TAKEOUT_STAGING_DIR` is the staging directory; the default lands
  // under the OS temp dir so the test env and a zero-config dev boot
  // both work without an explicit value. The builder creates the dir
  // before the first write.
  // ---------------------------------------------------------------
  TAKEOUT_STAGING_TTL_MINUTES: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().default(1440),
  ),
  TAKEOUT_STAGING_DIR: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().default(path.join(os.tmpdir(), 'projekt-manager-takeout')),
  ),
  // ---------------------------------------------------------------
  // Invoice retention (ADR-0026, architecture.md §12.2 / §11.14).
  // Object-Lock days applied to every rendered invoice PDF/A-3
  // binary descriptor; the boot-time bucket-safety probe (§11.4)
  // refuses to start when the deployed bucket retention envelope
  // is less than this value (only when > 0 — dev runs with 0 mean
  // retention is disabled, and the check is skipped).
  // .env.example ships 0 (dev — binaries are cleanable);
  // .env.production.example ships 3650 (10 years, §147 AO).
  // Integer ≥ 0 — bounds match architecture.md §12.2.
  // Independent from STORAGE_OBJECT_LOCK_DAYS (attachments).
  // ---------------------------------------------------------------
  // `.max(36525)` is a 100-year sanity cap — catches operator typos like
  // `36500` for the §147 AO 10-year window or values that exceed B2's
  // legal-hold envelope. The legitimate ceiling is the §147 AO 10-year
  // window (3650); the cap leaves an order of magnitude of headroom.
  INVOICE_OBJECT_LOCK_DAYS: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().min(0).max(36525).default(0),
  ),
  // ---------------------------------------------------------------
  // Realtime invalidation channel (ADR-0025, architecture.md §11.13).
  // Heartbeat cadence on the held SSE response — `:` keepalive every
  // `n` ms. The default (25 s) is fixed in api.md §14.2.13 and aligns
  // with reverse-proxy / browser idle-disconnect windows; the override
  // exists so integration tests can drive the heartbeat at sub-second
  // cadence rather than waiting >25 s of wall-clock per case.
  // ---------------------------------------------------------------
  SSE_HEARTBEAT_INTERVAL_MS: z.preprocess(
    (v) => (v === '' ? undefined : v),
    // Bounds match the spec in architecture.md §12.2:
    //   1 s — below this the heartbeat floods the socket and stops
    //         being a keepalive
    //   600 s — above this the keepalive can't outrun the typical
    //         reverse-proxy / browser idle-disconnect windows the
    //         heartbeat exists to defeat
    z.coerce.number().int().min(1000).max(600_000).default(25_000),
  ),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Known dev-default credentials forwarded to the app container by
 * docker-compose. Each entry pairs an env-var name with the values that
 * ship in the dev compose file — if any of these reach a production
 * container, the operator forgot to override them.
 *
 * Forwarded explicitly so the names appear in `process.env` (compose's
 * `environment:` block forwards POSTGRES_PASSWORD / MINIO_ROOT_USER /
 * MINIO_ROOT_PASSWORD into the app service alongside DATABASE_URL etc.).
 */
const DEV_DEFAULT_CREDENTIALS: ReadonlyArray<{ envVar: string; values: readonly string[] }> = [
  { envVar: 'POSTGRES_PASSWORD', values: ['postgres', 'devpassword'] },
  { envVar: 'MINIO_ROOT_USER', values: ['minioadmin'] },
  { envVar: 'MINIO_ROOT_PASSWORD', values: ['minioadmin'] },
];

/**
 * Aggregates dev-default credential offences into the supplied issue list.
 * Only fires in production; out-of-prod environments need their dev
 * defaults to keep working.
 *
 * Pure-function shape — no throws, no I/O — so the aggregating validator
 * can call it alongside the schema's safeParse output and the cross-field
 * guards in a single pass.
 */
export function assertNoDevCredentials(
  source: Record<string, string | undefined>,
  issues: string[],
): void {
  if (source.NODE_ENV !== 'production') return;
  for (const { envVar, values } of DEV_DEFAULT_CREDENTIALS) {
    const current = source[envVar];
    if (current !== undefined && values.includes(current)) {
      issues.push(
        `${envVar} is set to the dev default "${current}". Set a secure value for production.`,
      );
    }
  }
}

/**
 * Boot path. Parses `process.env`, returns the typed `Env`. Runs the
 * schema + `assertNoDevCredentials` so a forgotten dev-default credential
 * trips at boot regardless of which binary started — start.ts and
 * backup-runner.ts share this one check. The other cross-field guards
 * (`assertProductionSafe`, `assertAppServerEnv`,
 * `assertStoragePublicEndpointInProduction`) stay external so the caller
 * keeps control of their order and so the app-server-only narrowing
 * (`assertAppServerEnv`) doesn't reject the backup-runner path.
 */
export function validateEnvRuntime(): Env {
  return parseAndAggregate(process.env, { runAllGuards: false });
}

/**
 * Pre-flight / test path. Pure function over the supplied record. Runs
 * the schema AND every cross-field guard in one pass; all offences are
 * aggregated into a single thrown Error so a misconfigured deploy
 * iterates once, not N times (issue #139, AC-231).
 */
export function validateEnvAggregated(input: Record<string, string | undefined>): Env {
  return parseAndAggregate(input, { runAllGuards: true });
}

/**
 * Access the validated env. Re-parses `process.env` on every call (see
 * file header for rationale). Throws if validation fails — same surface
 * as `validateEnvRuntime()`.
 */
export function getEnv(): Env {
  return validateEnvRuntime();
}

/**
 * Run the schema and (optionally) every cross-field guard, accumulating
 * issues into a single thrown error. The `runAllGuards` switch controls
 * whether the cross-field guards (assertProductionSafe and friends) run
 * in this pass: `validateEnvAggregated` passes `true` to surface every
 * offence at once; `validateEnvRuntime` passes `false` because start.ts
 * calls those guards itself with the typed `Env` afterwards (this
 * avoids double-running them and preserves the historical wiring).
 *
 * `assertNoDevCredentials` runs in BOTH paths because rejecting dev
 * defaults is the only guard that depends on the raw input map (the
 * compose-forwarded vars are not part of the typed `Env`).
 *
 * Cross-field guards in the aggregated path operate on `source`
 * directly (not the parsed Env) so a schema failure on one field does
 * not silence the guard for an unrelated field. AC-231 wants every
 * offence reported in one pass — so a `PORT=0` Zod failure must NOT
 * mask `ALLOW_INSECURE_HTTP=true in production`.
 */
function parseAndAggregate(
  source: Record<string, string | undefined>,
  opts: { runAllGuards: boolean },
): Env {
  const issues: string[] = [];
  const result = envSchema.safeParse(source);
  if (!result.success) {
    for (const i of result.error.issues) {
      const pathStr = i.path.length > 0 ? i.path.join('.') : '<root>';
      issues.push(`${pathStr}: ${i.message}`);
    }
  }

  if (opts.runAllGuards) {
    for (const check of CROSS_FIELD_GUARDS) {
      const r = check(source);
      if (!r.ok) issues.push(r.message);
    }
  }

  // Dev-credential check uses the raw source map, so it can fire
  // regardless of whether the schema parse succeeded.
  assertNoDevCredentials(source, issues);

  if (issues.length > 0) {
    throw new Error(`Environment validation failed:\n${issues.map((m) => `  - ${m}`).join('\n')}`);
  }
  // Issues empty ⇒ schema succeeded — every Zod failure was pushed into
  // `issues` above, so reaching this point with `result.success === false`
  // is impossible.
  if (!result.success) throw new Error('unreachable: schema fail did not push issues');
  return result.data;
}

// ---------------------------------------------------------------------
// Cross-field guards.
//
// Each guard is one shared predicate (`check*`) returning a structured
// result. Two consumers route through it:
//   - The exported typed-Env throw helpers (`assert*`) — called by
//     start.ts at boot, used by tests, throws on failure.
//   - The aggregated validator's `parseAndAggregate` — collects the
//     same predicate's failure into the aggregated error message.
//
// Single source per predicate eliminates the silent drift mode flagged
// in #143 follow-up A-3: a regression that softens `ALLOW_INSECURE_HTTP
// === 'true'` to also accept `'1'` (or similar) used to need updating in
// two places; the path that wasn't updated kept the old behaviour. Now
// there is exactly one body to soften.
//
// Two guards are aggregated-path-ONLY and have no `assert*` counterpart:
// `checkBootstrapCredentials` and `checkVapidKeyShape` (#245). That
// asymmetry is intentional — see each function's doc comment — and must
// not be "fixed" by adding a boot-path wrapper.
// ---------------------------------------------------------------------

type GuardResult = { ok: true } | { ok: false; message: string };

/**
 * Structural source shape readable by the cross-field guards. Both the
 * raw `Record<string, string | undefined>` (preflight path) and the
 * typed `Env` (boot path) are assignable here — the guards read these
 * fields by name, never the index signature.
 */
type GuardSource = {
  NODE_ENV?: string | undefined;
  ALLOW_INSECURE_HTTP?: string | undefined;
  TRUSTED_PROXY_CIDRS?: string | undefined;
  STORAGE_ENDPOINT?: string | undefined;
  STORAGE_PUBLIC_ENDPOINT?: string | undefined;
  STORAGE_ACCESS_KEY?: string | undefined;
  STORAGE_SECRET_KEY?: string | undefined;
  STORAGE_REGION?: string | undefined;
  BINARY_AGE_RECIPIENT?: string | undefined;
  BOOTSTRAP_ADMIN_USERNAME?: string | undefined;
  BOOTSTRAP_ADMIN_PASSWORD?: string | undefined;
  VAPID_PRIVATE_KEY?: string | undefined;
};

const TRUSTED_PROXY_MISSING_MSG =
  'Refusing to start: TRUSTED_PROXY_CIDRS is unset in production. ' +
  'The app serves behind Caddy (ADR-0008), so without it every request is ' +
  'attributed to the proxy container IP — the login rate limiter degrades to ' +
  'one global bucket and the audit trail records the proxy, not the client. ' +
  'Set it to the pinned networks.default subnet in docker-compose.yml.';

const ALLOW_INSECURE_HTTP_IN_PROD_MSG =
  'Refusing to start: ALLOW_INSECURE_HTTP=true in production. ' +
  'This disables cookie security. Remove ALLOW_INSECURE_HTTP or set NODE_ENV=development.';

function appServerMissingMsg(missing: ReadonlyArray<string>): string {
  return (
    `App server requires these env vars: ${missing.join(', ')}. ` +
    'They are optional in the shared schema so the backup-runner CLI ' +
    'can share validateEnvRuntime(), but the app server cannot start without them.'
  );
}

function storagePublicEndpointMsg(endpoint: string): string {
  return (
    `Refusing to start: STORAGE_ENDPOINT (${endpoint}) is a container-only ` +
    'hostname but STORAGE_PUBLIC_ENDPOINT is not set. Presigned URLs the browser ' +
    'receives would be unreachable. Set STORAGE_PUBLIC_ENDPOINT to the public ' +
    'URL the browser can reach for presigned uploads/downloads. ' +
    'For B2 prod, leave STORAGE_PUBLIC_ENDPOINT unset and use the public ' +
    'B2 endpoint as STORAGE_ENDPOINT directly. See ' +
    'docs/ops/object-storage-provisioning.md.'
  );
}

/**
 * Production-safety predicate: refuses ALLOW_INSECURE_HTTP=true under
 * NODE_ENV=production. ADR-0013 / AC-45 promise the server refuses to
 * start on this combination — this is that promise.
 */
function checkProductionSafe(source: GuardSource): GuardResult {
  if (source.NODE_ENV === 'production' && source.ALLOW_INSECURE_HTTP === 'true') {
    return { ok: false, message: ALLOW_INSECURE_HTTP_IN_PROD_MSG };
  }
  return { ok: true };
}

/**
 * App-server presence predicate: every STORAGE_* must be set. The
 * shared schema keeps these optional so the backup-runner CLI (which
 * doesn't use MinIO) can share `validateEnvRuntime()`; this guard
 * restores the fail-fast semantic for the app server. Reports every
 * missing var in one message so an operator sees the full set, not
 * one-per-restart.
 */
function checkAppServerEnv(source: GuardSource): GuardResult {
  const missing: string[] = [];
  if (!source.STORAGE_ENDPOINT) missing.push('STORAGE_ENDPOINT');
  if (!source.STORAGE_ACCESS_KEY) missing.push('STORAGE_ACCESS_KEY');
  if (!source.STORAGE_SECRET_KEY) missing.push('STORAGE_SECRET_KEY');
  if (!source.STORAGE_REGION) missing.push('STORAGE_REGION');
  if (!source.BINARY_AGE_RECIPIENT) missing.push('BINARY_AGE_RECIPIENT');
  return missing.length === 0 ? { ok: true } : { ok: false, message: appServerMissingMsg(missing) };
}

/**
 * Reverse-proxy trust predicate: refuses to start in production when the
 * X-Forwarded-For trust boundary is unconfigured.
 *
 * Production always runs behind Caddy (ADR-0008), so `request.ip` is only
 * the real client if the app trusts the proxy's address. With
 * `TRUSTED_PROXY_CIDRS` unset, Fastify falls back to the socket peer and
 * every request is attributed to Caddy's container IP — the login rate
 * limiter ([C] LOGIN_RATE_LIMIT_MAX) degrades to a single global bucket,
 * so one client can lock out every user, and the login audit trail records
 * the proxy rather than the client.
 *
 * That failure is silent — the app serves normally — which is exactly the
 * case this project refuses to ship: fail the deploy instead.
 *
 * Dev and test do not trip this guard: they bypass Caddy, so the socket
 * peer already IS the client and trusting nothing is the correct posture.
 */
function checkTrustedProxyInProduction(source: GuardSource): GuardResult {
  if (source.NODE_ENV !== 'production') return { ok: true };
  if (source.TRUSTED_PROXY_CIDRS) return { ok: true };
  return { ok: false, message: TRUSTED_PROXY_MISSING_MSG };
}

/**
 * Container-hostname predicate: refuses to start in production when the
 * storage client would sign presigned URLs against a container-only
 * hostname. Without `STORAGE_PUBLIC_ENDPOINT`, the app signs URLs using
 * `STORAGE_ENDPOINT` (e.g. `http://storage:9000`) and hands them to the
 * browser — which cannot resolve the Docker-internal host, so every
 * upload POST fails silently and the `pending → ready` transition
 * never happens. That defect sat on the VPS undetected until an
 * operator noticed attachments never saving.
 *
 * Dev (STORAGE_ENDPOINT = localhost or an IP) does not trip this guard
 * because dev exposes MinIO on the host; the browser reaches the same
 * endpoint the app reaches.
 */
function checkStoragePublicEndpointInProduction(source: GuardSource): GuardResult {
  if (source.NODE_ENV !== 'production') return { ok: true };
  const endpoint = source.STORAGE_ENDPOINT;
  if (!endpoint) return { ok: true }; // covered by checkAppServerEnv
  if (source.STORAGE_PUBLIC_ENDPOINT) return { ok: true };
  if (!hostnameLooksInternal(endpoint)) return { ok: true };
  return { ok: false, message: storagePublicEndpointMsg(endpoint) };
}

/**
 * Bootstrap-credential predicate (#245). Validates the `BOOTSTRAP_ADMIN_*`
 * pairing and password policy *when present*, reusing the same
 * `checkBootstrapCredentialPair` the boot path uses so the two enforcement
 * points cannot diverge.
 *
 * Deploy-preflight-ONLY by construction: it lives in `CROSS_FIELD_GUARDS`,
 * which only `validateEnvAggregated` runs. There is deliberately no
 * `assert*` boot-path wrapper — ADR-0010 requires bootstrap to be a DB-gated
 * no-op on a populated users table, so leftover/invalid `BOOTSTRAP_ADMIN_*`
 * vars must NOT crash a restart. The strict enforcement belongs at the
 * non-destructive deploy gate, where there is no DB to gate on. Do not add
 * an `assert*` counterpart: it would pull this onto the boot path and
 * reintroduce the destructive crash-on-recreate this guard exists to
 * replace.
 */
function checkBootstrapCredentials(source: GuardSource): GuardResult {
  const message = checkBootstrapCredentialPair({
    username: source.BOOTSTRAP_ADMIN_USERNAME,
    password: source.BOOTSTRAP_ADMIN_PASSWORD,
  });
  return message === null ? { ok: true } : { ok: false, message };
}

/**
 * VAPID key-shape predicate (#245). When `VAPID_PRIVATE_KEY` is present,
 * derives the public half to assert it is a well-formed 32-byte P-256
 * scalar — the same `derivePublicKey` check the runtime resolver applies,
 * surfaced at deploy time so a malformed key fails the preflight instead of
 * crash-looping the recreated container.
 *
 * Empty / whitespace-only is "not configured" (compose forwards
 * `${VAPID_PRIVATE_KEY:-}`, so an unconfigured deploy sends ""); push then
 * runs in no-op mode. Aggregated-path-only for the same reason as
 * `checkBootstrapCredentials`: the boot path resolves VAPID material via
 * `resolveVapidKeyMaterial`, which owns its own malformed-key throw.
 */
function checkVapidKeyShape(source: GuardSource): GuardResult {
  const key = source.VAPID_PRIVATE_KEY?.trim();
  if (!key) return { ok: true };
  try {
    derivePublicKey(key);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `VAPID_PRIVATE_KEY is malformed (expected urlsafe-base64 32-byte P-256 scalar): ${reason}`,
    };
  }
  return { ok: true };
}

/** Iteration order for `parseAndAggregate`. Stable so the aggregated
 * error message lists offences in a deterministic order. */
const CROSS_FIELD_GUARDS: ReadonlyArray<(source: GuardSource) => GuardResult> = [
  checkProductionSafe,
  checkAppServerEnv,
  checkTrustedProxyInProduction,
  checkStoragePublicEndpointInProduction,
  checkBootstrapCredentials,
  checkVapidKeyShape,
];

/**
 * Hostname-looks-internal heuristic: no dot and not an IP literal. The
 * Docker-internal hostnames used by compose (`storage`, `db`, `app`) all
 * hit this, whereas a public URL (`storage.example.com`) does not. Used
 * only by `checkStoragePublicEndpointInProduction()` — a literal IP
 * (`http://10.0.0.5:9000`) is legitimate in self-hosted setups and is
 * NOT treated as internal.
 */
function hostnameLooksInternal(endpoint: string): boolean {
  let host: string;
  try {
    host = new URL(endpoint).hostname;
  } catch {
    // Malformed endpoint — let the storage client surface the real error
    // at connect time rather than double-reporting it here.
    return false;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  return !host.includes('.');
}

// ---------------------------------------------------------------------
// Typed-Env throw helpers — the public API for start.ts. Each delegates
// to the corresponding shared predicate above, throwing on failure.
// ---------------------------------------------------------------------

/**
 * Assert startup safety invariants that depend on NODE_ENV. Called from
 * start.ts right after validateEnvRuntime(). Refuses to start in
 * production with ALLOW_INSECURE_HTTP=true (ADR-0013 / AC-45).
 */
export function assertProductionSafe(env: Env): void {
  const r = checkProductionSafe(env);
  if (!r.ok) throw new Error(r.message);
}

/**
 * `Env` with the STORAGE_* fields narrowed to non-nullable strings —
 * the shape the app server sees after `assertAppServerEnv()` succeeds.
 */
export type AppServerEnv = Env & {
  STORAGE_ENDPOINT: string;
  STORAGE_ACCESS_KEY: string;
  STORAGE_SECRET_KEY: string;
  STORAGE_REGION: string;
};

/**
 * App-server-only presence check for the MinIO-backed attachment storage
 * config. Narrows the Env type so downstream calls in start.ts don't need
 * `!` non-null assertions on the STORAGE_* fields.
 */
export function assertAppServerEnv(env: Env): asserts env is AppServerEnv {
  const r = checkAppServerEnv(env);
  if (!r.ok) throw new Error(r.message);
}

/**
 * Refuses to start in production when the reverse-proxy trust boundary
 * (`TRUSTED_PROXY_CIDRS`) is unconfigured.
 */
export function assertTrustedProxyInProduction(env: Env): void {
  const r = checkTrustedProxyInProduction(env);
  if (!r.ok) throw new Error(r.message);
}

/**
 * Refuses to start in production when the storage client would sign
 * presigned URLs against a container-only hostname.
 */
export function assertStoragePublicEndpointInProduction(env: Env): void {
  const r = checkStoragePublicEndpointInProduction(env);
  if (!r.ok) throw new Error(r.message);
}
