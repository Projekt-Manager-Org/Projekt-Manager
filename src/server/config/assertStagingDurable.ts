import fs from 'node:fs';

/**
 * Linux filesystem magic numbers that indicate RAM-backed storage.
 * Source: /usr/include/linux/magic.h
 *
 * Used by the boot-time staging-durability probe to reject a tmpfs or
 * ramfs mount as `TAKEOUT_STAGING_DIR` in production. A multi-GB
 * takeout archive on a tmpfs mount can exhaust container RAM and
 * OOM-kill the VPS (self-inflicted DoS).
 */
const TMPFS_MAGIC = 0x01021994;
const RAMFS_MAGIC = 0x858458f6;

/**
 * Parameters for the staging-durability guard.
 *
 * `fsType` is the filesystem magic number returned by `statfs(2)`. It is
 * injected so the guard can be unit-tested with synthetic magic numbers
 * without relying on the actual FS type of any host path.
 */
export interface AssertStagingDurableParams {
  stagingDir: string;
  nodeEnv: string;
  /** `statfs(2)` filesystem magic number for `stagingDir`. */
  fsType: number;
}

/**
 * Assert that the takeout staging directory is on a durable (disk-backed)
 * filesystem in production.
 *
 * - In production (`NODE_ENV === 'production'`): throws if `fsType` is
 *   tmpfs (0x01021994) or ramfs (0x858458f6). The thrown error propagates
 *   to `start().catch(…)` which exits non-zero.
 * - Outside production: emits a one-line `console.warn` when staging is
 *   RAM-backed but never blocks boot.
 *
 * Pure function — no I/O. The caller is responsible for creating the
 * directory (mkdir -p) and calling `fs.statfsSync(stagingDir).type`
 * before passing `fsType` here.
 */
export function assertStagingDurable({
  stagingDir,
  nodeEnv,
  fsType,
}: AssertStagingDurableParams): void {
  const isRamBacked = fsType === TMPFS_MAGIC || fsType === RAMFS_MAGIC;

  if (!isRamBacked) return;

  const fsName = fsType === TMPFS_MAGIC ? 'tmpfs' : 'ramfs';

  if (nodeEnv === 'production') {
    throw new Error(
      `Refusing to start: TAKEOUT_STAGING_DIR (${stagingDir}) is on a ${fsName} ` +
        `(RAM-backed) filesystem. A large takeout archive on a RAM-backed staging ` +
        `path exhausts container memory and OOM-kills the process. ` +
        `Mount a disk-backed volume at that path (see docker-compose.yml ` +
        `takeout-staging volume) or set TAKEOUT_STAGING_DIR to a path on a ` +
        `persistent volume.`,
    );
  }

  console.warn(
    `WARNING: TAKEOUT_STAGING_DIR (${stagingDir}) is on a ${fsName} (RAM-backed) ` +
      `filesystem. This is acceptable in development but would OOM-kill a ` +
      `production container on a large export. Pin a disk-backed volume in prod.`,
  );
}

/**
 * Production wiring: mkdir -p the staging dir, statfs it, then call the
 * pure guard. Extracted so start.ts stays readable and the pure guard
 * stays unit-testable without touching the filesystem.
 *
 * Throws (via `assertStagingDurable`) when staging is RAM-backed in
 * production; a warning is logged in dev/test. Safe to call before the
 * app accepts requests — all I/O is synchronous and completes in < 1 ms.
 */
export function probeStagingDurability(stagingDir: string, nodeEnv: string): void {
  fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  const { type: fsType } = fs.statfsSync(stagingDir);
  assertStagingDurable({ stagingDir, nodeEnv, fsType });
}
