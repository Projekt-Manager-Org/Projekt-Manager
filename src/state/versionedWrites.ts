/**
 * Client side of edit optimistic concurrency (ui/behavior.md §9.5,
 * data-model.md §6.4).
 *
 * An edit sends the entity version it started from — captured when the
 * form opened, the field gained focus or the dialog opened. Only this
 * client's own successful writes advance it: a background refresh never
 * does, or it would launder a stale edit into a current-looking one.
 *
 * Writes to one entity run one at a time, in a lane keyed by the entity.
 * A write still queued when its predecessor hits `VERSION_CONFLICT` is
 * discarded — it was based on the same stale read.
 *
 *   field A focus (v1) ─ blur ─▶ PATCH v1 ──▶ 200, v2      advances v1 → v2
 *   field B focus (v1) ─ blur ─▶ (queued) ──▶ PATCH v2     own write: no conflict
 *   refresh shows v5 ─────────────────────────────────▶   advances nothing
 */

import { STRINGS } from '@/config/strings';
import type { ApiFailure, ApiResult } from '@/api/client';

export const VERSION_CONFLICT = 'VERSION_CONFLICT';

interface Lane {
  tail: Promise<unknown>;
  /** Bumped on every conflict; queued writes enqueued before it are dropped. */
  conflicts: number;
  /** Own successful writes: expected version → resulting version. */
  advanced: Map<number, number>;
}

const lanes = new Map<string, Lane>();

function laneFor(key: string): Lane {
  let lane = lanes.get(key);
  if (!lane) {
    lane = { tail: Promise.resolve(), conflicts: 0, advanced: new Map() };
    lanes.set(key, lane);
  }
  return lane;
}

/** `start` carried forward through this client's own writes. */
function resolveVersion(lane: Lane, start: number): number {
  let version = start;
  while (lane.advanced.has(version)) version = lane.advanced.get(version)!;
  return version;
}

const discarded: ApiFailure = {
  ok: false,
  error: { code: VERSION_CONFLICT, message: STRINGS.errors.versionConflict },
  category: 'server_error',
  sessionExpired: false,
};

export function isVersionConflict(result: ApiResult<unknown>): boolean {
  return !result.ok && result.error.code === VERSION_CONFLICT;
}

/**
 * Run a versioned write in the entity's lane. `startVersion` is the
 * version the edit began from; `send` receives it advanced through this
 * client's own earlier writes. A write discarded after a predecessor's
 * conflict resolves to a `VERSION_CONFLICT` failure without a request.
 */
export function versionedWrite<T extends { version: number } | null>(
  key: string,
  startVersion: number,
  send: (expectedVersion: number) => Promise<ApiResult<T>>,
): Promise<ApiResult<T>> {
  const lane = laneFor(key);
  const conflictsAtEnqueue = lane.conflicts;

  const run = async (): Promise<ApiResult<T>> => {
    if (lane.conflicts !== conflictsAtEnqueue) return discarded;
    const expectedVersion = resolveVersion(lane, startVersion);
    const result = await send(expectedVersion);
    if (result.ok) {
      // Only a forward step: a self-edge would make `resolveVersion` spin.
      if (result.data && result.data.version > expectedVersion) {
        lane.advanced.set(expectedVersion, result.data.version);
      }
    } else if (isVersionConflict(result)) {
      lane.conflicts++;
    }
    return result;
  };

  const task = lane.tail.then(run, run);
  lane.tail = task.catch(() => undefined);
  return task;
}

/** Test seam — drop every lane. */
export function resetVersionedWrites(): void {
  lanes.clear();
}
