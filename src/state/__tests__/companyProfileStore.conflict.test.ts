/**
 * `companyProfileStore` — stale-write recovery (AC-379).
 *
 * A `VERSION_CONFLICT` refetches the profile, so the form shows the current
 * values with the stale-write message. When that refetch fails nothing was
 * reloaded, so the outcome is a generic error — never the message claiming
 * the current version was loaded.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ApiFailure } from '@/api/client';
import type { CompanyProfile } from '@/domain/invoice';
import { STRINGS } from '@/config/strings';

const putMock = vi.fn();
const getMock = vi.fn();

vi.mock('@/api/client', () => ({
  companyProfileApi: {
    put: (...args: unknown[]) => putMock(...args),
    get: (...args: unknown[]) => getMock(...args),
  },
}));

vi.mock('@/state/sessionExpired', () => ({
  handleSessionExpired: vi.fn(),
}));

const { useCompanyProfileStore } = await import('@/state/companyProfileStore');

// Only `companyName` and `version` matter to the store's conflict path.
const profile = (version: number, companyName: string) =>
  ({ companyName, version }) as unknown as CompanyProfile;

/** The payload is irrelevant to the conflict path; the mocked API ignores it. */
const PAYLOAD = {} as Parameters<ReturnType<typeof useCompanyProfileStore.getState>['save']>[1];

function failure(code: string, message: string): ApiFailure {
  return {
    ok: false,
    error: { code, message },
    category: 'server_error',
    sessionExpired: false,
  };
}

beforeEach(() => {
  putMock.mockReset();
  getMock.mockReset();
  useCompanyProfileStore.setState({
    data: profile(1, 'Alt'),
    loading: false,
    fetchError: null,
    saveError: null,
  });
  putMock.mockResolvedValue(failure('VERSION_CONFLICT', 'stale'));
});

describe('companyProfileStore — VERSION_CONFLICT recovery', () => {
  it('AC-379: loads the current profile and keeps the stale-write message', async () => {
    getMock.mockResolvedValue({ ok: true, data: profile(2, 'Neu') });

    const outcome = await useCompanyProfileStore.getState().save(1, PAYLOAD);

    expect(outcome).toEqual({ status: 'conflict' });
    expect(useCompanyProfileStore.getState().data).toEqual(profile(2, 'Neu'));
    expect(useCompanyProfileStore.getState().saveError).toBe('stale');
  });

  it('AC-379: reports a generic error, not the stale-write message, when the refetch fails', async () => {
    getMock.mockResolvedValue(failure('SERVER_ERROR', 'down'));

    const outcome = await useCompanyProfileStore.getState().save(1, PAYLOAD);

    expect(outcome).toEqual({ status: 'error' });
    expect(useCompanyProfileStore.getState().saveError).toBe(STRINGS.errors.mutationFailed);
  });
});
