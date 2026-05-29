/**
 * Deploy pre-flight entry point. Invoked by `scripts/deploy.sh` INSIDE a
 * one-shot `docker run --rm` against the just-pulled deploy image. The
 * bundled output ships at `dist/server/deploy-preflight-cli.js` (esbuild
 * target list in `package.json` > `build:server`); the host-side
 * `deploy.sh` does not need any project node_modules — it only needs
 * Docker.
 *
 * Six checkpoints, one container start:
 *   1. `validateEnvAggregated()` — schema + every cross-field guard in
 *      one pass. Aborts the deploy on first failure (issue #139,
 *      AC-231).
 *   2. `formatFeatureManifest()` — the same per-feature manifest the
 *      app emits at boot (`event = 'config-feature-manifest'`),
 *      formatted for the operator's terminal so the operator sees what
 *      will be enabled / disabled BEFORE `docker compose up` recreates
 *      containers (AC-230 — the boot-time emission still lands in the
 *      app's stdout for log aggregation; this is the deploy-time
 *      mirror).
 *   3. Storage reachability probe — calls `client.ping()` against the
 *      configured bucket. Catches stale `STORAGE_ACCESS_KEY` /
 *      `STORAGE_SECRET_KEY` mismatches, wrong region, missing
 *      capabilities — every operator-side credential class failure
 *      that survives shape validation. Without this step, those
 *      failures only surface at app boot AFTER `docker compose up`
 *      has recreated the app container — at which point the previous
 *      good replica is gone and rolling back means another deploy.
 *   4. Upload-verb probe — signs a presigned PUT to a sentinel key,
 *      executes it with a 1-byte body + matching Content-MD5, asserts
 *      2xx. Catches the class of provider gaps the listing probe in
 *      step 3 cannot see — most concretely, the B2 cutover uncovered
 *      that `POST /<bucket>` returns `501 NotImplemented` (the
 *      previous flow used presigned POST; ADR-0022 § Upload protocol).
 *      Verifying the upload verb at deploy time means a future provider
 *      cutover that drops PUT, breaks SigV4 signed-header binding, or
 *      changes the Content-MD5 contract surfaces here, not at first
 *      user upload.
 *   5. CopyObject-verb probe — server-side-copies the upload sentinel to
 *      a second sentinel key with a tight per-call timeout, asserts
 *      success. This is the canary for the **restore** flow
 *      (`copyFromVersion` in `src/server/storage/client.ts`). The
 *      specific failure mode is B2-specific: an app key without
 *      `writeFileRetentions` on a bucket with default Compliance
 *      retention silently HANGS `CopyObject` for ~5 minutes per attempt
 *      before B2 returns 503; the SDK then retries 3×, totaling ~17
 *      minutes before the user-facing restore call surfaces a 500. See
 *      docs/ops/object-storage-provisioning.md (App key table) for the
 *      cap rationale. Verifying at deploy time means the same
 *      misconfiguration surfaces here, not at first user-clicked
 *      Wiederherstellen.
 *   6. Bucket-safety probe — `assertStorageBucketSafe()`, the same
 *      data-integrity gate `start.ts` runs at boot (ADR-0022 / ADR-0026):
 *      versioning on, Object Lock = Compliance, lifecycle present, the
 *      running credential provably CANNOT destroy versions, and the
 *      bucket's default retention window covers `INVOICE_OBJECT_LOCK_DAYS`.
 *      It runs only at boot today, so config drift or an over-capable app
 *      key refuses to start the just-recreated container; surfacing it here
 *      fails the deploy non-destructively instead.
 *
 * Why a dedicated entry:
 *   - The existing `start.ts` entry point validates AND boots Fastify,
 *     opens DB pool, runs migrations — running it with the `up`-side
 *     effects to JUST check env would double-bind the port and race the
 *     eventual `docker compose up`. A dedicated CLI runs the checks
 *     only and exits.
 *   - Bundling keeps the "shells out to validateEnvAggregated +
 *     formatFeatureManifest" contract stable across schema refactors.
 *     The host-side script doesn't need to track esbuild's
 *     chunk-emission decisions.
 *
 * Aborts the deploy on first failure: prints the aggregated error
 * message to stderr and exits with code 1, which `deploy.sh`'s
 * `set -euo pipefail` propagates to the operator before `docker
 * compose up` runs.
 */
import crypto from 'node:crypto';
import { S3Client, CopyObjectCommand } from '@aws-sdk/client-s3';
import { assertAppServerEnv, validateEnvAggregated } from './config/env.js';
import { formatFeatureManifest } from './config/features.js';
import { createStorageClient, type AttachmentStorageClient } from './storage/client.js';
import { assertStorageBucketSafe } from './storage/safety.js';

async function main(): Promise<void> {
  // Snapshot process.env into a record so the aggregated path runs
  // every cross-field guard — ALLOW_INSECURE_HTTP-in-prod, dev-default
  // credentials, container-only STORAGE_ENDPOINT — alongside the schema
  // check. validateEnvRuntime (the boot path) skips those guards
  // because start.ts runs them sequentially against the typed Env; the
  // preflight's whole purpose is to catch them BEFORE `docker compose
  // up` recreates containers, so it must run them itself per AC-231.
  const env = validateEnvAggregated({ ...process.env });

  // All output to stderr so a wrapping `docker run … 2>/dev/null` does
  // not suppress operator-visible acknowledgement. Exit 0 below
  // propagates to deploy.sh's `set -euo pipefail` as success.
  console.error('validateEnv: env validation OK.');
  console.error('');
  console.error(formatFeatureManifest(env));
  console.error('');

  // Storage reachability probe. The aggregated guard already proved
  // STORAGE_* are present and shape-valid (`checkAppServerEnv` is in
  // CROSS_FIELD_GUARDS); narrow the type via the same throw-helper
  // start.ts uses so we share the contract. A failure here means the
  // bucket-side credential or capability is wrong — the exact class of
  // failure the schema can't see and the prior incarnation of this
  // CLI used to let through to crash-loop the recreated app container.
  assertAppServerEnv(env);
  const storage = createStorageClient({
    endpoint: env.STORAGE_ENDPOINT,
    publicEndpoint: env.STORAGE_PUBLIC_ENDPOINT,
    bucket: env.STORAGE_BUCKET,
    accessKey: env.STORAGE_ACCESS_KEY,
    secretKey: env.STORAGE_SECRET_KEY,
    region: env.STORAGE_REGION,
    keyPrefix: env.STORAGE_KEY_PREFIX,
  });
  try {
    await storage.ping();
    console.error(
      `probe-storage: OK bucket=${env.STORAGE_BUCKET} endpoint=${env.STORAGE_ENDPOINT}`,
    );
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `probe-storage: FAILED bucket=${env.STORAGE_BUCKET} endpoint=${env.STORAGE_ENDPOINT}\n` +
        `  ${name}: ${msg}\n` +
        `Common causes: stale STORAGE_ACCESS_KEY (rotated keyId not propagated to .env), ` +
        `mismatched STORAGE_SECRET_KEY (applicationKey from a different key pair), ` +
        `wrong STORAGE_REGION, or app-key capability set missing listFiles. ` +
        `See docs/ops/object-storage-provisioning.md.`,
      { cause: err },
    );
  }

  await probeUploadVerb(storage, env.STORAGE_BUCKET);
  await probeCopyObjectVerb(env);
  await probeBucketSafety(storage, env.INVOICE_OBJECT_LOCK_DAYS);
}

/**
 * Data-integrity bucket-safety gate — the same `assertStorageBucketSafe()`
 * `start.ts` runs at boot (ADR-0022 / ADR-0026), surfaced at deploy time so
 * bucket-config drift (versioning off, Object Lock not Compliance, lifecycle
 * gaps, an app key that CAN destroy versions, or a default retention window
 * that under-covers `INVOICE_OBJECT_LOCK_DAYS`) fails the deploy
 * non-destructively instead of refusing to start the recreated container.
 *
 * Reuses the same client built above. The helper aggregates every defect
 * into one throw and already names the remediation per failure class; we
 * only add the operator-visible OK line and a `probe-bucketsafe:` label on
 * the failure path so the deploy log reads consistently with the probes
 * above. `INVOICE_OBJECT_LOCK_DAYS = 0` (dev default) skips the retention
 * envelope assertion; the shape + capability checks always run.
 */
async function probeBucketSafety(
  storage: AttachmentStorageClient,
  invoiceObjectLockDays: number,
): Promise<void> {
  try {
    await assertStorageBucketSafe(storage, { invoiceObjectLockDays });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`probe-bucketsafe: FAILED\n${msg}`, { cause: err });
  }
  console.error('probe-bucketsafe: OK');
}

/**
 * Sign a presigned PUT against a sentinel key and execute it with a
 * 1-byte body. Asserts the storage provider implements the verb the
 * browser upload flow depends on (ADR-0022 § Upload protocol).
 *
 * The sentinel key is fixed (`__probe/upload`) so each deploy
 * overwrites the prior probe — Object Lock retention ages out on the
 * default `R` window and the lifecycle reaper handles the noncurrent
 * versions. Storage cost is one byte per deploy.
 */
async function probeUploadVerb(storage: AttachmentStorageClient, bucket: string): Promise<void> {
  const PROBE_KEY = '__probe/upload';
  const body = Buffer.from([0]);
  const md5Base64 = crypto.createHash('md5').update(body).digest('base64');
  let descriptor;
  try {
    descriptor = await storage.createPresignedPut(
      PROBE_KEY,
      'application/octet-stream',
      body.byteLength,
      md5Base64,
      60,
    );
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `probe-upload: FAILED to sign presigned PUT (bucket=${bucket})\n  ${name}: ${msg}`,
      { cause: err },
    );
  }
  // The browser's fetch refuses to honor a manual Content-Length and
  // computes one from the body; Node's fetch accepts it. Strip the
  // header here so the same code path works in both runtimes — the
  // signed length is bound to `body.byteLength` either way.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(descriptor.headers)) {
    if (k.toLowerCase() === 'content-length') continue;
    headers[k] = v;
  }
  let res: Response;
  try {
    res = await fetch(descriptor.url, { method: 'PUT', headers, body });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`probe-upload: FAILED PUT request (bucket=${bucket})\n  ${msg}`, {
      cause: err,
    });
  }
  if (!res.ok) {
    let respBody: string;
    try {
      respBody = (await res.text()).slice(0, 600);
    } catch {
      respBody = '(no body)';
    }
    throw new Error(
      `probe-upload: FAILED bucket=${bucket} status=${res.status} ${res.statusText}\n` +
        `  ${respBody}\n` +
        `Common causes: provider does not implement presigned PUT for this bucket, ` +
        `Content-MD5 missing/required by Object Lock policy, signed-header mismatch, ` +
        `bucket CORS rule rejects the call. See ADR-0022 § Upload protocol.`,
    );
  }
  console.error(`probe-upload: OK bucket=${bucket} key=${PROBE_KEY}`);
}

/**
 * Server-side-copy `__probe/upload` (just written by `probeUploadVerb`)
 * to a second sentinel key with a tight per-call timeout and assert
 * success. This is the canary for the **restore** flow
 * (`copyFromVersion` in `src/server/storage/client.ts`).
 *
 * The B2-specific failure mode this catches: an app key without
 * `writeFileRetentions` against a bucket with default Compliance
 * retention silently HANGS `CopyObject` for ~5 minutes per attempt
 * before B2 returns 503 ServiceUnavailable. The SDK retries 3×
 * (~17 minutes total) before the user-facing call surfaces an error.
 * The cap requirement is documented at
 * `docs/ops/object-storage-provisioning.md` (App key table). MinIO
 * does not surface this quirk, so the same probe passes against the
 * dev mirror without any IAM-policy change.
 *
 * Wiring choice — direct SDK rather than `storage.copyFromVersion`:
 * we want explicit per-call timeouts (`requestTimeout`,
 * `connectionTimeout`) and `maxAttempts: 1` so the probe fails fast
 * (within ~30 seconds) instead of waiting on the SDK's full retry
 * budget. The shared `AttachmentStorageClient` keeps the production
 * retry shape; the probe binds its own short-leash client.
 *
 * The destination key is fixed (`__probe/copyobj`) so each deploy
 * overwrites the prior probe — same model as `probeUploadVerb`. The
 * bucket lifecycle reaps both the upload and copyobj sentinels along
 * with everything else.
 */
async function probeCopyObjectVerb(env: {
  STORAGE_ENDPOINT: string;
  STORAGE_REGION: string;
  STORAGE_BUCKET: string;
  STORAGE_ACCESS_KEY: string;
  STORAGE_SECRET_KEY: string;
}): Promise<void> {
  const SOURCE_KEY = '__probe/upload';
  const DEST_KEY = '__probe/copyobj';
  const bucket = env.STORAGE_BUCKET;
  // Short-leash client — the whole point of this probe is to catch a
  // hang quickly. The production storage client uses default retries
  // (3 attempts) which would mask the hang as a 17-minute stall.
  const s3 = new S3Client({
    endpoint: env.STORAGE_ENDPOINT,
    region: env.STORAGE_REGION,
    credentials: {
      accessKeyId: env.STORAGE_ACCESS_KEY,
      secretAccessKey: env.STORAGE_SECRET_KEY,
    },
    forcePathStyle: true,
    maxAttempts: 1,
    requestHandler: { requestTimeout: 25_000, connectionTimeout: 5_000 },
  });
  const t0 = Date.now();
  try {
    await s3.send(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: DEST_KEY,
        // CopySource format per AWS S3 docs: "<bucket>/<key>". No
        // versionId — the source's current version is what we just wrote
        // in probeUploadVerb. Slashes inside the key remain raw; the SDK
        // URL-encodes the rest.
        CopySource: `${bucket}/${SOURCE_KEY}`,
      }),
    );
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    const msg = err instanceof Error ? err.message : String(err);
    const elapsed = Date.now() - t0;
    throw new Error(
      `probe-copyobj: FAILED bucket=${bucket} elapsed=${elapsed}ms\n` +
        `  ${name}: ${msg}\n` +
        `Most common cause on B2: app key is missing the writeFileRetentions ` +
        `capability. CopyObject under a Compliance-default-retention bucket ` +
        `requires it; without, B2 silently hangs the request and eventually ` +
        `returns 503 ServiceUnavailable. Re-create the app key per ` +
        `docs/ops/object-storage-provisioning.md (App key — via b2 CLI) ` +
        `with the full seven-cap set including writeFileRetentions, then ` +
        `update STORAGE_ACCESS_KEY in .env and STORAGE_SECRET_KEY in ` +
        `secrets.env.age, and redeploy.`,
      { cause: err },
    );
  }
  console.error(
    `probe-copyobj: OK bucket=${bucket} src=${SOURCE_KEY} dst=${DEST_KEY} elapsed=${Date.now() - t0}ms`,
  );
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`deploy-preflight: FAILED:\n${msg}`);
    process.exit(1);
  },
);
