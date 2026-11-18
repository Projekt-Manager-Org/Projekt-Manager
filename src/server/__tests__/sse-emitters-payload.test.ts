/**
 * AC-680 — realtime events carry only the kind of data that changed.
 *
 * Runs every `emit*` helper exported by `src/server/sse/emitters.ts`
 * against a subscribed fake connection and asserts each frame's `data:`
 * line is exactly `{ "type": <event name> }`. Iterating the module's
 * exports covers a new emitter without editing this file.
 */

import { describe, it, expect } from 'vitest';
import { subscribe, unsubscribe, type SseConnection } from '../sse/bus.js';
import * as emitters from '../sse/emitters.js';
import { SSE_EVENT_NAMES } from '../../config/sseEvents.js';

function parseFrame(chunk: string): { event: string; data: unknown } {
  const event = /^event: (.+)$/m.exec(chunk)?.[1];
  const data = /^data: (.+)$/m.exec(chunk)?.[1];
  if (event === undefined || data === undefined) throw new Error(`malformed frame: ${chunk}`);
  return { event, data: JSON.parse(data) as unknown };
}

const emitFns = Object.entries(emitters).filter(
  (entry): entry is [string, () => void] =>
    entry[0].startsWith('emit') && typeof entry[1] === 'function',
);

describe('AC-680: realtime event frames carry no data', () => {
  it('every catalog event has an emitter', () => {
    const emitted = new Set<string>();
    const conn: SseConnection = { write: (c) => emitted.add(parseFrame(c).event) };
    subscribe(conn);
    try {
      for (const [, emit] of emitFns) emit();
    } finally {
      unsubscribe(conn);
    }
    expect([...emitted].sort()).toEqual([...SSE_EVENT_NAMES].sort());
  });

  it.each(emitFns)('%s sends only the event kind', (_name, emit) => {
    const chunks: string[] = [];
    const conn: SseConnection = { write: (c) => chunks.push(c) };
    subscribe(conn);
    try {
      emit();
    } finally {
      unsubscribe(conn);
    }
    expect(chunks).toHaveLength(1);
    const { event, data } = parseFrame(chunks[0]);
    expect(data).toEqual({ type: event });
  });
});
