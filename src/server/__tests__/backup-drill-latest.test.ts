/**
 * Layer 2 drill — which backup it restores.
 *
 * Covers verification.md §15.22 AC-619 [crit]: a drill restores the
 * latest uploaded backup. `backup-drill.test.ts` stubs the downloader, so
 * the selection lives here: the production downloader against an object
 * listing that is neither sorted nor on one page.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
} from '@aws-sdk/client-s3';

import { createR2Downloader } from '../services/r2Uploader.js';

const NEWEST = '2026-04-17T14:00:00.000Z';

// Three pages, the newest dump mid-way through the middle one; the first
// and last pages hold only older dumps, and the newest key overall is a
// manifest whose dump is missing. A selection that reads only the first or
// last page, keeps one page's max, takes the first or last key seen, or
// the newest of any suffix picks the wrong backup.
const PAGES: ReadonlyArray<string[]> = [
  [
    'daily/2026-04-16T02:00:00.000Z.dump.age',
    'daily/2026-04-18T02:00:00.000Z.manifest.json.age',
    'daily/2026-04-15T02:00:00.000Z.dump.age',
  ],
  [
    'daily/2026-04-13T02:00:00.000Z.dump.age',
    `daily/${NEWEST}.manifest.json.age`,
    `daily/${NEWEST}.dump.age`,
    'daily/2026-04-16T02:00:00.000Z.manifest.json.age',
    'daily/2026-04-12T02:00:00.000Z.dump.age',
  ],
  ['daily/2026-04-15T02:00:00.000Z.manifest.json.age', 'daily/2026-04-14T02:00:00.000Z.dump.age'],
];

afterEach(() => vi.restoreAllMocks());

describe('AC-619: the drill restores the latest uploaded backup', () => {
  it('fetches the newest daily/ dump and its manifest from an unsorted, paged listing', async () => {
    const fetched: string[] = [];
    vi.spyOn(S3Client.prototype, 'send').mockImplementation(async (command: unknown) => {
      if (command instanceof ListObjectsV2Command) {
        const token = command.input.ContinuationToken;
        const page = token === undefined ? 0 : Number(token);
        const last = page === PAGES.length - 1;
        return {
          Contents: PAGES[page]!.map((Key) => ({ Key })),
          IsTruncated: !last,
          NextContinuationToken: last ? undefined : String(page + 1),
        } satisfies Partial<ListObjectsV2CommandOutput>;
      }
      if (command instanceof GetObjectCommand) {
        const key = command.input.Key!;
        fetched.push(key);
        return { Body: { transformToByteArray: async () => new TextEncoder().encode(key) } };
      }
      throw new Error(`unexpected command ${String(command)}`);
    });

    const downloader = createR2Downloader({
      endpoint: 'https://example.invalid',
      bucket: 'backups',
      accessKeyId: 'irrelevant',
      secretAccessKey: 'irrelevant',
    });
    const result = await downloader.downloadLatestDumpAndManifest();

    const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
    expect(result.key).toBe(NEWEST);
    expect(decode(result.dump)).toBe(`daily/${NEWEST}.dump.age`);
    expect(decode(result.manifest)).toBe(`daily/${NEWEST}.manifest.json.age`);
    expect(fetched.sort()).toEqual(
      [`daily/${NEWEST}.dump.age`, `daily/${NEWEST}.manifest.json.age`].sort(),
    );
  });
});
