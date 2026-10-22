/**
 * Client-side required-field validation on the company-profile form
 * (ui/daten.md §8.11.4): submitting with a required field empty shows an
 * inline German message next to that field, marks it `aria-invalid`, and
 * does not dispatch the PUT.
 *
 * The API client is stubbed at module boundary; the real store runs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApiResult, AuthUser } from '@/api/client';
import type { CompanyProfile } from '@/domain/invoice';
import { STRINGS } from '@/config/strings';

const getMock = vi.fn<() => Promise<ApiResult<CompanyProfile>>>();
const putMock = vi.fn<() => Promise<ApiResult<CompanyProfile>>>();

vi.mock('@/api/client', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    companyProfileApi: {
      get: (...args: unknown[]) => getMock(...(args as Parameters<typeof getMock>)),
      put: (...args: unknown[]) => putMock(...(args as Parameters<typeof putMock>)),
    },
  };
});

const { CompanyProfileSection } = await import('@/ui/management/CompanyProfileSection');
const { useCompanyProfileStore } = await import('@/state/companyProfileStore');
const { useAuthStore } = await import('@/state/authStore');

const PROFILE: CompanyProfile = {
  id: 'cp-1',
  companyName: 'Muster GmbH',
  address: { street: 'Hauptstraße 1', zip: '10115', city: 'Berlin' },
  taxId: '12/345/67890',
  ustId: 'DE123456789',
  iban: null,
  accentColor: null,
  footerText: null,
  defaultTaxMode: 'standard',
  version: 1,
  updatedAt: '2026-05-25T00:00:00.000Z',
  updatedBy: null,
};

const REQUIRED_FIELDS = [
  { key: 'companyName', label: STRINGS.companyProfile.companyName },
  { key: 'street', label: STRINGS.companyProfile.street },
  { key: 'zip', label: STRINGS.companyProfile.zip },
  { key: 'city', label: STRINGS.companyProfile.city },
  { key: 'taxId', label: STRINGS.companyProfile.taxId },
  { key: 'ustId', label: STRINGS.companyProfile.ustId },
] as const;

function setOwner(): void {
  const user: AuthUser = {
    id: 'u-1',
    username: 'owner',
    displayName: 'Owner',
    roles: ['owner'],
    email: null,
    themePreference: 'system',
    pushMuted: false,
  };
  useAuthStore.setState({ authUser: user, authError: null, sessionChecked: true });
}

async function renderForm(): Promise<void> {
  render(<CompanyProfileSection />);
  await screen.findByTestId('company-profile-form');
}

beforeEach(() => {
  // jsdom lacks scrollIntoView; without it the submit handler throws
  // before its own short-circuit, and "no PUT" would pass vacuously.
  Element.prototype.scrollIntoView = vi.fn();
  getMock.mockReset().mockResolvedValue({ ok: true, data: PROFILE });
  putMock.mockReset();
  useCompanyProfileStore.setState({ data: null, fetchError: null, saveError: null });
  setOwner();
});

afterEach(() => {
  cleanup();
  delete (Element.prototype as Partial<Element>).scrollIntoView;
  useAuthStore.setState({ authUser: null, authError: null, sessionChecked: true });
});

describe('CompanyProfileSection — required-field validation (ui/daten.md §8.11.4)', () => {
  it.each(REQUIRED_FIELDS)(
    'empty $key shows an inline message naming "$label" and blocks the PUT',
    async ({ key, label }) => {
      const user = userEvent.setup();
      await renderForm();

      await user.clear(screen.getByTestId(`company-profile-${key}-input`));
      await user.click(screen.getByTestId('company-profile-save'));

      expect(screen.getByTestId(`company-profile-${key}-error`)).toHaveTextContent(label);
      const input = screen.getByTestId(`company-profile-${key}-input`);
      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(input).toHaveFocus();
      expect(putMock).not.toHaveBeenCalled();
    },
  );

  it('every empty required field shows its message at once', async () => {
    const user = userEvent.setup();
    await renderForm();

    for (const { key } of REQUIRED_FIELDS) {
      await user.clear(screen.getByTestId(`company-profile-${key}-input`));
    }
    await user.click(screen.getByTestId('company-profile-save'));

    for (const { key, label } of REQUIRED_FIELDS) {
      expect(screen.getByTestId(`company-profile-${key}-error`)).toHaveTextContent(label);
    }
    expect(putMock).not.toHaveBeenCalled();
  });
});
