/**
 * AC-338 — subscribe-side SSE coverage guard.
 *
 * The emit side of the realtime channel is enumerated and pinned by
 * crit ACs (AC-270 storage, AC-276 project, AC-320 audit, AC-336
 * attachment). The *subscribe* side was not enforced: a typed event
 * could be emitted with no client ever subscribing, so the mutation
 * fired into the void and the always-open observer stayed stale. That
 * is exactly the gallery gap (#237) — `attachment_changed` did not even
 * exist, and `attachmentStore` subscribed to nothing.
 *
 * This guard closes the loop: every member of the `SseEventName` union
 * (enumerated at runtime by `SSE_EVENT_NAMES`) must have ≥1 client
 * subscriber — an `onSseEvent(<CONST>, …)` call somewhere under
 * `src/state/` or `src/ui/`. A new event added emit-only fails CI here
 * instead of silently shipping a dead surface.
 *
 * Mechanism mirrors `src/server/__tests__/no-raw-env-access.test.ts`:
 * a self-tested source matcher plus a tree scan. The matcher captures
 * the identifier passed as the first argument to `onSseEvent(` and
 * resolves it back to a catalog wire value via the `sseEvents` module's
 * own exports (no hard-coded name↔value table to drift).
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import * as sseEvents from '@/config/sseEvents';
import { SSE_EVENT_NAMES } from '@/config/sseEvents';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

// ---------------------------------------------------------------------
// Allowlist — events deliberately without a client subscriber. Empty by
// design; an entry requires a non-empty reason at review time (e.g. a
// future server-diagnostic-only event). Keeping it explicit means a
// genuinely-unsubscribed event is a recorded decision, not an oversight.
// ---------------------------------------------------------------------
interface KnownUnsubscribed {
  event: string;
  reason: string;
}
const KNOWN_UNSUBSCRIBED: ReadonlyArray<KnownUnsubscribed> = [];

// name → wire value, harvested from the catalog module's exports.
const nameToValue = new Map<string, string>();
for (const [name, value] of Object.entries(sseEvents)) {
  if (typeof value === 'string') nameToValue.set(name, value);
}

// ---------------------------------------------------------------------
// Matcher — capture the first-argument identifier of every onSseEvent(…)
// call. Comments are stripped first so a doc reference does not count as
// a subscription.
// ---------------------------------------------------------------------
function findSubscribedIdentifiers(source: string): string[] {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
  const out: string[] = [];
  const re = /onSseEvent\s*\(\s*([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) out.push(m[1]!);
  return out;
}

async function walkClientFiles(absDir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(absDir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...(await walkClientFiles(full)));
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Matcher self-tests — a regex regression must fail loud here, not slip
// through the tree scan as a false "covered".
// ---------------------------------------------------------------------
describe('AC-338: onSseEvent matcher captures the subscribed identifier', () => {
  it('captures a plain subscription identifier', () => {
    expect(findSubscribedIdentifiers('onSseEvent(STORAGE_USAGE_CHANGED, () => {})')).toEqual([
      'STORAGE_USAGE_CHANGED',
    ]);
  });

  it('captures across whitespace / newlines', () => {
    expect(findSubscribedIdentifiers('onSseEvent(\n  AUDIT_CHANGED,\n  handler,\n)')).toEqual([
      'AUDIT_CHANGED',
    ]);
  });

  it('captures multiple subscriptions in one file', () => {
    const src = 'onSseEvent(A, f); onSseEvent(B, g);';
    expect(findSubscribedIdentifiers(src)).toEqual(['A', 'B']);
  });

  it('ignores a subscription mentioned only in a comment', () => {
    expect(findSubscribedIdentifiers('// onSseEvent(PROJECT_CHANGED, fn)')).toEqual([]);
    expect(findSubscribedIdentifiers('/* onSseEvent(PROJECT_CHANGED, fn) */')).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// Tree scan — every SseEventName member must have a live subscriber.
// ---------------------------------------------------------------------
describe('AC-338: every SseEventName has ≥1 client subscriber', () => {
  it('finds a subscriber under src/state or src/ui for each catalog event', async () => {
    const roots = ['src/state', 'src/ui'];
    const files: string[] = [];
    for (const root of roots) {
      files.push(...(await walkClientFiles(path.join(repoRoot, root))));
    }

    // Harvest every subscribed wire value across the client tree.
    const covered = new Set<string>();
    for (const abs of files) {
      const source = await readFile(abs, 'utf8');
      for (const ident of findSubscribedIdentifiers(source)) {
        const value = nameToValue.get(ident);
        if (value) covered.add(value);
      }
    }

    const allowed = new Set(KNOWN_UNSUBSCRIBED.map((e) => e.event));
    const missing = SSE_EVENT_NAMES.filter((e) => !covered.has(e) && !allowed.has(e));

    expect(
      missing,
      `SseEventName members emitted but never subscribed (add an onSseEvent subscriber, ` +
        `or an allowlisted KNOWN_UNSUBSCRIBED entry with a reason):\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('allowlist entries each carry a non-empty reason', () => {
    for (const e of KNOWN_UNSUBSCRIBED) {
      expect(e.reason.trim().length).toBeGreaterThan(0);
    }
  });
});
