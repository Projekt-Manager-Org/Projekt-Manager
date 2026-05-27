/**
 * Attachment domain helpers — closed catalogs + validators.
 *
 * The label enum and MIME whitelist are pinned by data-model.md §5.13
 * and architecture.md §12.2 (`[C]` catalog). Server and client share
 * these so rejected inputs surface the same German message regardless
 * of which layer catches them first.
 */

import type { AttachmentKind, AttachmentLabel } from './types.js';

export const ATTACHMENT_LABELS: ReadonlyArray<{
  readonly value: AttachmentLabel;
  readonly label: string;
}> = [
  { value: 'angebot', label: 'Angebot' },
  { value: 'auftragsbestaetigung', label: 'Auftragsbestätigung' },
  { value: 'rechnung', label: 'Rechnung' },
  { value: 'aufmass', label: 'Aufmaß' },
  { value: 'foto', label: 'Foto' },
  { value: 'sonstiges', label: 'Sonstiges' },
] as const;

export const ATTACHMENT_MIME_WHITELIST = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

export type AttachmentMime = (typeof ATTACHMENT_MIME_WHITELIST)[number];

/**
 * Current wrapped-DEK envelope-format version (ADR-0024). Init writes
 * this value into the `attachments.wrappedDekVersion` column at every
 * insert site; the unwrap path validates the stored value against this
 * constant and throws on any mismatch so legacy / future formats are
 * never silently fed to the v1 parser. The export envelope carries the
 * version alongside the wrapped envelopes so post-import rows preserve
 * the discriminator.
 *
 * The set of accepted versions is `{ 1 }` today. A future v2 introduction
 * widens this set explicitly at every relevant call site — there is no
 * accept-all fallback by design.
 */
export const WRAPPED_DEK_CURRENT_VERSION = 1 as const;

/**
 * Predicate over the closed set of known envelope-format versions. The
 * current set is a singleton; widening is a code change at this set, the
 * unwrap-time guard, and the import-time guard simultaneously so a future
 * v2 cannot leak past one of them.
 */
export function isKnownWrappedDekVersion(version: number): boolean {
  return version === WRAPPED_DEK_CURRENT_VERSION;
}

const PHOTO_MIMES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp']);

const KIND_VALUES: ReadonlySet<string> = new Set<string>(['photo', 'binary']);

const LABEL_VALUES: ReadonlySet<string> = new Set(ATTACHMENT_LABELS.map((entry) => entry.value));

const MIME_WHITELIST_SET: ReadonlySet<string> = new Set(ATTACHMENT_MIME_WHITELIST);

/**
 * Classification of a whitelisted MIME into the photo/binary bucket used
 * by the gallery and the thumbnail flow (data-model.md §5.13). Callers
 * must have validated the MIME first via `validateMime`; passing an
 * unknown MIME throws so a contract violation fails loudly at the call
 * site rather than landing as a mislabeled row in the DB.
 */
export function classifyKind(mime: string): AttachmentKind {
  if (!MIME_WHITELIST_SET.has(mime)) {
    throw new Error(`classifyKind: MIME '${mime}' is not in the whitelist`);
  }
  return PHOTO_MIMES.has(mime) ? 'photo' : 'binary';
}

/**
 * Accept-or-throw guard for `AttachmentKind` (closed enum). Mirrors the
 * `attachments_valid_kind` CHECK constraint (schema.ts). Used by the
 * takeout import runner to reject a tampered envelope in Pass-1, before
 * any destructive write — a `kind` outside the enum would otherwise pass
 * validation and only trip the CHECK on the post-wipe insert (AC-327).
 */
export function validateKind(kind: string): AttachmentKind {
  if (!KIND_VALUES.has(kind)) {
    throw new Error(`validateKind: '${kind}' is not a valid AttachmentKind`);
  }
  return kind as AttachmentKind;
}

/**
 * Accept-or-throw guard for `AttachmentLabel` (closed enum). Throws a
 * plain Error — service/route layers catch and translate to a 422. The
 * helper is used both server-side (route validation) and client-side
 * (pre-upload UX gate).
 */
export function validateLabel(label: string): AttachmentLabel {
  if (!LABEL_VALUES.has(label)) {
    throw new Error(`validateLabel: '${label}' is not a valid AttachmentLabel`);
  }
  return label as AttachmentLabel;
}

/**
 * Accept-or-throw guard for the MIME whitelist. IANA MIME types are
 * lowercase — rejecting case variants keeps client and server aligned.
 */
export function validateMime(mime: string): AttachmentMime {
  if (!MIME_WHITELIST_SET.has(mime)) {
    throw new Error(`validateMime: '${mime}' is not in the whitelist`);
  }
  return mime as AttachmentMime;
}

/**
 * Server- and client-side predicate for "safe" attachment filenames.
 *
 * Rejects:
 *   - control chars (`\x00-\x1f`, `\x7f`) — header-injection vector on
 *     the presigned-GET `Content-Disposition`, and a source of broken
 *     UI strings in the browser.
 *   - path separators (`/`, `\`) — callers have no business supplying
 *     a directory traversal; the server owns the storage key and the
 *     filename is for display / download only.
 *
 * Length and emptiness are intentionally NOT checked here — those are
 * separate concerns with their own error messages at the service
 * boundary (`requiredString`, `maxLength`). The point of this helper is
 * a single definition of "malicious / malformed bytes" that both the
 * domain validator and future client-side checks can share.
 */
export function isSafeFileName(fileName: string): boolean {
  // Rejecting these control bytes is the whole point: they're the
  // CR/LF/null payloads a header-injection attack would smuggle into a
  // Content-Disposition string.
  // eslint-disable-next-line no-control-regex
  const UNSAFE_BYTES = /[\x00-\x1f\x7f/\\]/;
  return typeof fileName === 'string' && !UNSAFE_BYTES.test(fileName);
}

/**
 * Client-side rule for showing the delete affordance on a row. Mirrors
 * the server-side check (AC-215): owner + office can delete any
 * attachment; a worker only if they authored it AND the grace window has
 * not expired; bookkeeper never. The server stays authoritative — this
 * is UX gating per the hidden-control pattern (AC-121).
 */
export function canDeleteAttachment(
  row: { createdBy: { id: string; displayName: string } | null; createdAt: string },
  caller: { id: string; roles: string[] },
  graceWindowMinutes: number,
  now: Date = new Date(),
): boolean {
  if (caller.roles.includes('owner') || caller.roles.includes('office')) return true;
  if (caller.roles.includes('worker')) {
    if (row.createdBy?.id !== caller.id) return false;
    const ageMs = now.getTime() - new Date(row.createdAt).getTime();
    return ageMs <= graceWindowMinutes * 60_000;
  }
  return false;
}
