/**
 * AC-710 `[crit]`: the invoice lock period **[C]** defaults to 3650 days
 * in production and 0 elsewhere (architecture.md §12.2); an explicit
 * value, 0 included, overrides it.
 *
 * The mock runs the real schema fields, so the pin covers both the
 * schema (no hard-coded default) and `getInvoiceObjectLockDays()`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const source = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('../config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/env.js')>();
  const fields = actual.envSchema.pick({ NODE_ENV: true, INVOICE_OBJECT_LOCK_DAYS: true });
  return { ...actual, getEnv: () => fields.parse(source.current) };
});

const { getInvoiceObjectLockDays } = await import('../config/index.js');

beforeEach(() => {
  source.current = {};
});

describe('AC-710: invoice lock period default', () => {
  it.each([
    ['production', 3650],
    ['development', 0],
    ['test', 0],
  ])('unset under NODE_ENV=%s → %i', (nodeEnv, days) => {
    source.current = { NODE_ENV: nodeEnv };
    expect(getInvoiceObjectLockDays()).toBe(days);
  });

  it('empty, as compose passes an unset variable, is unset → 3650 in production', () => {
    source.current = { NODE_ENV: 'production', INVOICE_OBJECT_LOCK_DAYS: '' };
    expect(getInvoiceObjectLockDays()).toBe(3650);
  });

  it('unset NODE_ENV is production → 3650', () => {
    expect(getInvoiceObjectLockDays()).toBe(3650);
  });

  it('an explicit 0 overrides the production default', () => {
    source.current = { NODE_ENV: 'production', INVOICE_OBJECT_LOCK_DAYS: '0' };
    expect(getInvoiceObjectLockDays()).toBe(0);
  });

  it('an explicit value overrides the default elsewhere', () => {
    source.current = { NODE_ENV: 'development', INVOICE_OBJECT_LOCK_DAYS: '30' };
    expect(getInvoiceObjectLockDays()).toBe(30);
  });
});
