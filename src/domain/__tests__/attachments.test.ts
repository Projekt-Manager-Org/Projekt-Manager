/**
 * Tests for the attachment domain helpers and catalogs that back the
 * client-side enforcement surface of AC-245 — the closed `AttachmentLabel`
 * enum, the closed MIME whitelist, `classifyKind` (MIME → photo|binary),
 * `validateKind`, `validateLabel`, and `validateMime`.
 *
 * Parity with architecture.md §12.2's attachment-label catalog entry and
 * data-model.md §5.13's MIME whitelist is pinned explicitly: a future
 * change to either side must update both the spec and this test together
 * (closed-catalog pattern, mirroring `auditRowDescription.test.ts`).
 */

import { describe, it, expect } from 'vitest';
import {
  ATTACHMENT_LABELS,
  ATTACHMENT_MIME_WHITELIST,
  classifyKind,
  validateKind,
  validateLabel,
  validateMime,
} from '../attachments';
import type { AttachmentLabel } from '../types';

describe('ATTACHMENT_LABELS', () => {
  it('enumerates exactly the six labels from data-model.md §5.13', () => {
    // The catalog is closed — adding a label is a code change plus a
    // migration (architecture.md §12.2). Pin the full set so a silent
    // extension in one place and not the other is a test failure here.
    const values = ATTACHMENT_LABELS.map((entry) => entry.value);
    expect(values).toEqual([
      'angebot',
      'auftragsbestaetigung',
      'rechnung',
      'aufmass',
      'foto',
      'sonstiges',
    ]);
  });

  it('pairs every enum value with the German display string in architecture.md §12.2', () => {
    // The `value → label` table is the `[C]` catalog entry. Any drift
    // between the catalog and the in-code map is a translation gap —
    // users would see an English raw enum value in a German UI.
    const expected: Record<AttachmentLabel, string> = {
      angebot: 'Angebot',
      auftragsbestaetigung: 'Auftragsbestätigung',
      rechnung: 'Rechnung',
      aufmass: 'Aufmaß',
      foto: 'Foto',
      sonstiges: 'Sonstiges',
    };
    for (const entry of ATTACHMENT_LABELS) {
      expect(entry.label).toBe(expected[entry.value]);
    }
  });

  it('contains no duplicate values (enum closedness)', () => {
    const values = ATTACHMENT_LABELS.map((entry) => entry.value);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('ATTACHMENT_MIME_WHITELIST', () => {
  it('enumerates exactly the five MIME types from data-model.md §5.13', () => {
    // Closed set — "Values outside the set are rejected at init". A
    // change here is a schema + validator change and must stay in lock
    // step with the server's init route. HEIC is deliberately NOT on
    // the list (Apple-only format, transcoding overhead was not worth
    // the narrow user base — see kickoff).
    expect([...ATTACHMENT_MIME_WHITELIST]).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]);
  });

  it('contains no duplicate MIME types', () => {
    const entries = [...ATTACHMENT_MIME_WHITELIST];
    expect(new Set(entries).size).toBe(entries.length);
  });
});

describe('classifyKind', () => {
  // Mapping is pinned in data-model.md §5.13: the four image types are
  // photos; PDF and DOCX are binaries. Every whitelisted MIME must
  // classify into one bucket.
  it.each([
    ['image/jpeg', 'photo'],
    ['image/png', 'photo'],
    ['image/webp', 'photo'],
  ] as const)('classifies %s as a photo', (mime, expected) => {
    expect(classifyKind(mime)).toBe(expected);
  });

  it.each([
    ['application/pdf', 'binary'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'binary'],
  ] as const)('classifies %s as a binary', (mime, expected) => {
    expect(classifyKind(mime)).toBe(expected);
  });

  it('throws for a MIME outside the whitelist', () => {
    // Classification must not silently map an unknown MIME onto one of
    // the two kinds — the init path relies on `classifyKind` only ever
    // being reached after `validateMime` has accepted the input. Throwing
    // here surfaces a contract violation at the call site instead of
    // letting a rejected MIME land in the DB as a mislabeled row.
    expect(() => classifyKind('text/plain')).toThrow();
    expect(() => classifyKind('image/gif')).toThrow();
    expect(() => classifyKind('')).toThrow();
  });
});

describe('validateKind', () => {
  it.each(['photo', 'binary'] as const)('accepts %s and returns it typed', (kind) => {
    expect(validateKind(kind)).toBe(kind);
  });

  it('rejects a kind outside the closed enum', () => {
    // Mirrors the `attachments_valid_kind` CHECK. The import runner's
    // Pass-1 gate relies on this throwing so a tampered envelope fails
    // before the destructive wipe (AC-327).
    expect(() => validateKind('document')).toThrow();
    expect(() => validateKind('Photo')).toThrow();
    expect(() => validateKind('')).toThrow();
  });
});

describe('validateLabel', () => {
  it.each(['angebot', 'auftragsbestaetigung', 'rechnung', 'aufmass', 'foto', 'sonstiges'] as const)(
    'accepts %s and returns it typed',
    (label) => {
      expect(validateLabel(label)).toBe(label);
    },
  );

  it('rejects a label outside the closed enum', () => {
    // AC-245: "a `label` outside the enum … returns `422 VALIDATION_ERROR`".
    // The client-side helper is the first gate — surface the rejection
    // before the bytes hit the network.
    expect(() => validateLabel('notiz')).toThrow();
    expect(() => validateLabel('FOTO')).toThrow();
    expect(() => validateLabel('')).toThrow();
  });
});

describe('validateMime', () => {
  it.each([
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ] as const)('accepts %s and returns it typed', (mime) => {
    expect(validateMime(mime)).toBe(mime);
  });

  it('rejects a MIME outside the whitelist', () => {
    // AC-245: "a `mimeType` outside the whitelist … returns `422
    // VALIDATION_ERROR`". The helper is the load-bearing client-side
    // gate referenced by ui/project-detail.md §8.15.5 ("Dateityp nicht
    // unterstützt") — a miss here is a silently-accepted upload. HEIC
    // is in this rejection set by design.
    expect(() => validateMime('image/heic')).toThrow();
    expect(() => validateMime('image/gif')).toThrow();
    expect(() => validateMime('application/zip')).toThrow();
    expect(() => validateMime('text/plain')).toThrow();
    expect(() => validateMime('')).toThrow();
  });

  it('is case-sensitive (IANA MIME registry is lowercase)', () => {
    // Defensive: the server enforces the same whitelist, and tolerating
    // case variants on one side and not the other drifts the surface.
    // The IANA registry itself is lowercase; anything else is a typo.
    expect(() => validateMime('IMAGE/JPEG')).toThrow();
    expect(() => validateMime('Application/Pdf')).toThrow();
  });
});
