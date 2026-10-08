/**
 * Key namespaces the bucket carries that no `attachments` row indexes and
 * that hold no envelope metadata (architecture.md §11.4).
 *
 * `__probe/` holds the deploy-preflight sentinels `__probe/upload` and
 * `__probe/copyobj` (`deploy-preflight-cli.ts`), rewritten on every
 * deploy. The bucket-orphan sweep must not hide them — every sweep on a
 * real deployment would report orphans, and an operator who learns to
 * ignore that report loses the only signal that says the bucket is clean —
 * and the recovery tool must not try to decrypt them.
 */
export const RESERVED_KEY_PREFIXES = ['__probe/'] as const;

export function isReservedKey(key: string): boolean {
  return RESERVED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}
