/**
 * Unit tests for the bucket-orphan prune scheduler (issue #169).
 *
 * The diff itself is covered by `pruneBucketOrphans.test.ts`. What only
 * this file can pin is the wiring that makes an UNATTENDED destructive
 * sweep safe: the scheduler must always ask for the bucket/database
 * mismatch refusal, and must forward the configured cadence and min-age
 * rather than substituting its own. A regression there is invisible
 * until the day it hides a live bucket.
 *
 * Pattern mirrors `attachment-hidden-reaper-scheduler.test.ts`: fake
 * timers plus a `vi.mock` on the prune so the scheduler's wiring is
 * exercised without a DB.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../db/connection.js';
import type { AttachmentStorageClient } from '../storage/client.js';
import type { PruneBucketOrphansResult } from '../storage/pruneBucketOrphans.js';
import {
  EVENT_BUCKET_ORPHAN_PRUNE,
  startBucketOrphanPruneScheduler,
} from '../bucket-orphan-prune-scheduler.js';

const CLEAN_RESULT: PruneBucketOrphansResult = {
  bucketObjectCount: 7,
  preservedCount: 6,
  skippedRecentCount: 0,
  orphanCount: 1,
};

const prune = vi.hoisted(() =>
  vi.fn<(opts: Record<string, unknown>) => Promise<PruneBucketOrphansResult>>(),
);
vi.mock('../storage/pruneBucketOrphans.js', () => ({ pruneBucketOrphans: prune }));

function makeLogger() {
  return {
    info: vi.fn<(ctx: Record<string, unknown>, event: string) => void>(),
    error: vi.fn<(ctx: Record<string, unknown>, event: string) => void>(),
  };
}

const FAKE_DB = {} as Database;
const FAKE_STORAGE = {} as AttachmentStorageClient;
const MINUTE_MS = 60 * 1000;

function start(
  overrides: Partial<Omit<Parameters<typeof startBucketOrphanPruneScheduler>[0], 'logger'>> = {},
) {
  const logger = makeLogger();
  const scheduler = startBucketOrphanPruneScheduler({
    db: FAKE_DB,
    storage: FAKE_STORAGE,
    listBucketObjects: vi.fn().mockResolvedValue([]),
    bucketLabel: 'test-bucket',
    intervalMinutes: 1440,
    minAgeMinutes: 1440,
    ...overrides,
    logger,
  });
  return { scheduler, logger };
}

describe('startBucketOrphanPruneScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    prune.mockReset();
    prune.mockResolvedValue(CLEAN_RESULT);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('always demands the bucket/database mismatch refusal', async () => {
    // The whole reason the sweep may run unattended: with no operator
    // reading the diff, the refusal is the only thing standing between a
    // wrong DATABASE_URL and a delete-marker over the entire bucket.
    const { scheduler } = start();
    await vi.advanceTimersByTimeAsync(1440 * MINUTE_MS);

    expect(prune).toHaveBeenCalledTimes(1);
    expect(prune.mock.calls[0]![0]).toMatchObject({ requireReferencedRows: true });
    await scheduler.stop();
  });

  it('forwards the configured cadence and min-age', async () => {
    const { scheduler } = start({ minAgeMinutes: 90, intervalMinutes: 30 });
    // Just under the interval — no sweep yet.
    await vi.advanceTimersByTimeAsync(30 * MINUTE_MS - 1);
    expect(prune).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(prune.mock.calls[0]![0]).toMatchObject({
      db: FAKE_DB,
      storage: FAKE_STORAGE,
      bucketLabel: 'test-bucket',
      minAgeMinutes: 90,
    });
    await scheduler.stop();
  });

  it('emits one summary line per sweep carrying the counts', async () => {
    const { scheduler, logger } = start();
    await vi.advanceTimersByTimeAsync(1440 * MINUTE_MS);

    const summaries = logger.info.mock.calls.filter(
      ([, event]) => event === EVENT_BUCKET_ORPHAN_PRUNE,
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]![0]).toMatchObject({
      bucket: 'test-bucket',
      bucket_object_count: 7,
      preserved_count: 6,
      skipped_recent_count: 0,
      orphan_count: 1,
    });
    await scheduler.stop();
  });

  it('surfaces a refusal as a sweep failure instead of crashing the process', async () => {
    // The mismatch refusal throws. The shared sweeper must catch it, log
    // it, and keep the schedule alive — a thrown rejection out of a
    // timer callback would take the app down.
    prune.mockRejectedValue(new Error('bucket/database mismatch'));
    const { scheduler, logger } = start();

    await vi.advanceTimersByTimeAsync(1440 * MINUTE_MS);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]![0]).toMatchObject({
      error_message: 'bucket/database mismatch',
    });
    await scheduler.stop();
  });
});
