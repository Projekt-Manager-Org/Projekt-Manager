/**
 * UT-18 / AC-379 — the client's write lane (ui/behavior.md §9.5): one
 * write per entity at a time, the start version advanced only by this
 * client's own successful writes, queued writes discarded after a
 * conflict.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { ApiResult } from '@/api/client';
import { clearVersionedWrites, versionedWrite } from '../versionedWrites';

type Row = { version: number };

const ok = (version: number): ApiResult<Row> => ({ ok: true, data: { version } });
const conflict: ApiResult<Row> = {
  ok: false,
  error: { code: 'VERSION_CONFLICT', message: 'Inzwischen geändert.' },
  category: 'server_error',
  sessionExpired: false,
};

/** A send whose response the test releases by hand. */
function deferredSend() {
  const sent: number[] = [];
  const releases: ((r: ApiResult<Row>) => void)[] = [];
  const send = (expectedVersion: number) => {
    sent.push(expectedVersion);
    return new Promise<ApiResult<Row>>((resolve) => releases.push(resolve));
  };
  return { send, sent, release: (i: number, r: ApiResult<Row>) => releases[i]!(r) };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => clearVersionedWrites());

describe('UT-18 / AC-379: versioned write lane', () => {
  it('sends one write per entity at a time, the second with the version the first produced', async () => {
    const { send, sent, release } = deferredSend();
    // Both edits started from version 1 (two fields focused before either save returned).
    const first = versionedWrite('project:p', 1, send);
    const second = versionedWrite('project:p', 1, send);
    await tick();
    expect(sent).toEqual([1]);

    release(0, ok(2));
    expect(await first).toEqual(ok(2));
    await tick();
    expect(sent).toEqual([1, 2]);

    release(1, ok(3));
    expect(await second).toEqual(ok(3));
  });

  it('does not advance an edit started before a version this client did not write', async () => {
    const { send, sent, release } = deferredSend();
    // Own write 1 → 2; a background refresh then shows 5. An edit that
    // started at 1 resolves to 2, never to 5.
    const own = versionedWrite('project:p', 1, send);
    await tick();
    release(0, ok(2));
    await own;

    const stale = versionedWrite('project:p', 1, send);
    await tick();
    expect(sent).toEqual([1, 2]);
    release(1, conflict);
    expect(await stale).toEqual(conflict);
  });

  it('discards a write queued behind a conflict without sending it', async () => {
    const { send, sent, release } = deferredSend();
    const first = versionedWrite('project:p', 1, send);
    const queued = versionedWrite('project:p', 1, send);
    await tick();
    release(0, conflict);
    await first;

    const result = await queued;
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('VERSION_CONFLICT');
    expect(sent).toEqual([1]);

    // A write enqueued after the conflict — a fresh edit — is sent.
    const fresh = versionedWrite('project:p', 4, send);
    await tick();
    expect(sent).toEqual([1, 4]);
    release(1, ok(5));
    expect(await fresh).toEqual(ok(5));
  });

  it('keeps entities independent', async () => {
    const { send, sent } = deferredSend();
    void versionedWrite('project:a', 1, send);
    void versionedWrite('project:b', 7, send);
    await tick();
    expect(sent).toEqual([1, 7]);
  });

  it('ignores a result that does not move the version forward', async () => {
    const { send, sent, release } = deferredSend();
    const first = versionedWrite('project:p', 1, send);
    await tick();
    release(0, ok(1));
    await first;

    void versionedWrite('project:p', 1, send);
    await tick();
    expect(sent).toEqual([1, 1]);
  });
});
