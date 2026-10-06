/**
 * Unit tests for the backup-release watcher (AC-376, architecture.md
 * §11.13 "Emitters of `invoice_changed`").
 *
 * The `backup` service releases marks from another process, so no
 * in-process mutation site can emit `invoice_changed`. The watcher reads
 * the standing marks each sweep and emits when one disappeared. A new
 * mark is not its business — issuance already emitted for it.
 */

import { describe, expect, it, vi } from 'vitest';
import { createInvoiceBackupWatcher } from '../services/invoice-backup-watcher.js';

function setup(...reads: string[][]) {
  const listPendingIds = vi.fn<() => Promise<string[]>>();
  for (const ids of reads) listPendingIds.mockResolvedValueOnce(ids);
  const emit = vi.fn<() => void>();
  const watcher = createInvoiceBackupWatcher({ listPendingIds, emit });
  return { watcher, emit };
}

describe('invoice backup watcher (AC-376)', () => {
  it('emits once per release, not on every later sweep', async () => {
    const { watcher, emit } = setup(['a'], [], []);
    await watcher.sweep();
    await watcher.sweep();
    await watcher.sweep();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('emits once when a mark is released', async () => {
    const { watcher, emit } = setup(['a', 'b'], ['b']);
    await watcher.sweep();
    await watcher.sweep();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('does not emit when marks only appear', async () => {
    const { watcher, emit } = setup([], ['a'], ['a', 'b']);
    await watcher.sweep();
    await watcher.sweep();
    await watcher.sweep();
    expect(emit).not.toHaveBeenCalled();
  });

  it('emits when a release and a new mark land between two sweeps', async () => {
    const { watcher, emit } = setup(['a'], ['b']);
    await watcher.sweep();
    await watcher.sweep();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('keeps its baseline when a read fails, so the next sweep still sees the release', async () => {
    const listPendingIds = vi
      .fn<() => Promise<string[]>>()
      .mockResolvedValueOnce(['a'])
      .mockRejectedValueOnce(new Error('db down (test simulation)'))
      .mockResolvedValueOnce([]);
    const emit = vi.fn<() => void>();
    const watcher = createInvoiceBackupWatcher({ listPendingIds, emit });
    await watcher.sweep();
    await expect(watcher.sweep()).rejects.toThrow('db down');
    await watcher.sweep();
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
