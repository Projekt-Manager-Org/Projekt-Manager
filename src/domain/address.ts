import type { Address } from '@/domain/types';

/**
 * The most characters each address component may hold — one shape for
 * every address: project site (data-model.md §5.1), customer (§5.6),
 * invoice recipient (§5.15), company profile (§5.17).
 */
export const ADDRESS_MAX = { street: 200, zip: 20, city: 200 } as const;

export type AddressDraftResult = { kind: 'valid'; value: Address | null } | { kind: 'partial' };

/**
 * Read a street / zip / city form group: all three, or none
 * (data-model.md §5.6). Whitespace counts as empty.
 */
export function readAddressDraft(street: string, zip: string, city: string): AddressDraftResult {
  const value = { street: street.trim(), zip: zip.trim(), city: city.trim() };
  const filled = [value.street, value.zip, value.city].filter((v) => v.length > 0).length;
  if (filled === 0) return { kind: 'valid', value: null };
  return filled === 3 ? { kind: 'valid', value } : { kind: 'partial' };
}
