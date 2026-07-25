/**
 * Component tests for the Baustelle group on the project Create form
 * (and Edit surface, which the spec routes through the project detail
 * page — see ui/management.md §8.8.3 + §8.8.6).
 *
 * Covers:
 *   - AC-280  Both Create and Edit render a `Baustelle` group with an
 *             "Identisch mit Kundenadresse" toggle and street/zip/city
 *             inputs. Default state is ON for create; on edit the toggle
 *             reflects the stored value (ON when null, OFF + populated
 *             when non-null). Submit body shape:
 *               toggle ON  → siteAddress: null
 *               toggle OFF → siteAddress: { street, zip, city }
 *   - AC-281  Toggle ON↔OFF behavior — fields disabled when ON,
 *             revealed empty when OFF, no premature dispatch.
 *
 * Surface under test: `ProjectCreateForm` for the create branch. The
 * edit branch is the project detail page (`ProjectDetailPage`) — its
 * Baustelle group lives in the same form-rule (§8.8.6) so we exercise
 * the rendering + initial state there too.
 *
 * The API client is stubbed at module boundary; real stores run.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router';
import { STRINGS } from '@/config/strings';
import type { ApiResult } from '@/api/client';
import type { Customer, Project } from '@/domain/types';

type ProjectListResult = ApiResult<{ data: Project[]; total: number }>;
type CustomerListResult = ApiResult<{ customers: Customer[]; total: number }>;
type ProjectCreateResult = ApiResult<Project>;
type ProjectGetResult = ApiResult<Project>;
type ProjectUpdateResult = ApiResult<Project>;

const projectListMock = vi.fn<() => Promise<ProjectListResult>>();
const customerListMock = vi.fn<() => Promise<CustomerListResult>>();
const projectCreateMock = vi.fn<() => Promise<ProjectCreateResult>>();
const projectGetMock = vi.fn<() => Promise<ProjectGetResult>>();
const projectUpdateMock = vi.fn<() => Promise<ProjectUpdateResult>>();

vi.mock('@/api/client', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    projectApi: {
      list: (...args: unknown[]) =>
        projectListMock(...(args as Parameters<typeof projectListMock>)),
      get: (...args: unknown[]) => projectGetMock(...(args as Parameters<typeof projectGetMock>)),
      create: (...args: unknown[]) =>
        projectCreateMock(...(args as Parameters<typeof projectCreateMock>)),
      update: (...args: unknown[]) =>
        projectUpdateMock(...(args as Parameters<typeof projectUpdateMock>)),
      updateDates: vi.fn(),
      delete: vi.fn(),
      transitionForward: vi.fn(),
      transitionBackward: vi.fn(),
    },
    customerApi: {
      list: (...args: unknown[]) =>
        customerListMock(...(args as Parameters<typeof customerListMock>)),
      get: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      update: vi.fn(),
    },
    authApi: {
      me: vi.fn().mockResolvedValue({ ok: false }),
      login: vi.fn(),
      logout: vi.fn(),
    },
    userApi: { list: vi.fn().mockResolvedValue({ ok: true, data: { users: [], total: 0 } }) },
    attachmentApi: {
      list: vi.fn().mockResolvedValue({ ok: true, data: { data: [] } }),
      initUpload: vi.fn(),
      completeUpload: vi.fn(),
      delete: vi.fn(),
      downloadUrl: vi.fn(),
      bulkFetch: vi.fn(),
    },
    auditApi: {
      list: vi.fn().mockResolvedValue({ ok: true, data: { data: [], nextCursor: null } }),
    },
  };
});

const { ProjectManagement } = await import('@/ui/management/ProjectManagement');
const { ProjectDetailPage } = await import('@/ui/detail/ProjectDetailPage');
const { useAuthStore } = await import('@/state/authStore');
const { useProjectManagementStore } = await import('@/state/projectManagementStore');
const { useProjectStore } = await import('@/state/projectStore');

const SEED_CUSTOMER: Customer = {
  id: 'c-1',
  name: 'Hausverwaltung Rheinblick',
  phone: null,
  email: null,
  address: { street: 'Rheinuferstr. 44', zip: '50996', city: 'Köln' },
  notes: null,
  createdAt: '2026-04-01T00:00:00Z',
  updatedAt: '2026-04-01T00:00:00Z',
  createdBy: null,
  updatedBy: null,
};

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p-1',
    number: 'P-001',
    title: 'Dachsanierung',
    status: 'geplant',
    statusChangedAt: '2026-04-01T00:00:00Z',
    plannedStart: null,
    plannedEnd: null,
    customerId: SEED_CUSTOMER.id,
    customer: {
      id: SEED_CUSTOMER.id,
      name: SEED_CUSTOMER.name,
      phone: null,
      email: null,
      address: SEED_CUSTOMER.address,
    },
    siteAddress: null,
    assignedWorkers: [],
    estimatedValue: null,
    notes: null,
    deleted: false,
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
    createdBy: null,
    updatedBy: null,
    ...overrides,
  };
}

function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

beforeAll(() => {
  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }
});

beforeEach(() => {
  projectListMock.mockReset();
  customerListMock.mockReset();
  projectCreateMock.mockReset();
  projectGetMock.mockReset();
  projectUpdateMock.mockReset();
  projectListMock.mockResolvedValue(ok({ data: [], total: 0 }));
  customerListMock.mockResolvedValue(ok({ customers: [SEED_CUSTOMER], total: 1 }));
  projectCreateMock.mockResolvedValue(ok(makeProject()));
  projectUpdateMock.mockResolvedValue(ok(makeProject()));
  useAuthStore.setState({
    authUser: {
      id: 'u-1',
      username: 'owner',
      displayName: 'Owner',
      roles: ['owner'],
      email: null,
      themePreference: 'system',
      pushMuted: false,
    },
    authError: null,
    sessionChecked: true,
  });
  useProjectManagementStore.setState({
    projects: [],
    customers: [SEED_CUSTOMER],
    loading: false,
    error: null,
    showArchived: false,
  });
  useProjectStore.setState({
    projects: [],
    mutationInFlight: {},
    mutationError: null,
  });
});

async function openCreateForm() {
  render(
    <MemoryRouter>
      <ProjectManagement />
    </MemoryRouter>,
  );
  await userEvent.click(screen.getByTestId('project-create-button'));
}

async function fillRequiredCreateFields() {
  await userEvent.type(screen.getByTestId('project-number-input'), 'P-NEW');
  await userEvent.type(screen.getByTestId('project-title-input'), 'Neues Projekt');
  // Open the customer dropdown and pick the seeded customer.
  const customerSelect = screen.getByTestId('project-customer-select');
  await userEvent.click(customerSelect.querySelector('input')!);
  await userEvent.click(await screen.findByText(SEED_CUSTOMER.name));
}

// ---------------------------------------------------------------------
// AC-280 — render + default state + submit body shape (Create branch)
// ---------------------------------------------------------------------
describe('ProjectCreateForm — Baustelle group (AC-280, create branch)', () => {
  it('renders the Baustelle group label, the toggle, and street/zip/city inputs', async () => {
    await openCreateForm();

    // Group label.
    expect(screen.getByText(STRINGS.projects.siteAddressLabel)).toBeInTheDocument();
    // Toggle is a labelled control — assert by its label so the test
    // does not couple to a particular testid string.
    expect(screen.getByLabelText(STRINGS.projects.siteAddressIdenticalToggle)).toBeInTheDocument();

    // Street/zip/city inputs.
    expect(screen.getByTestId('project-site-street-input')).toBeInTheDocument();
    expect(screen.getByTestId('project-site-zip-input')).toBeInTheDocument();
    expect(screen.getByTestId('project-site-city-input')).toBeInTheDocument();
  });

  it('default state on Create is ON — toggle checked, inputs disabled', async () => {
    await openCreateForm();

    const toggle = screen.getByLabelText(
      STRINGS.projects.siteAddressIdenticalToggle,
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(true);

    expect((screen.getByTestId('project-site-street-input') as HTMLInputElement).disabled).toBe(
      true,
    );
    expect((screen.getByTestId('project-site-zip-input') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('project-site-city-input') as HTMLInputElement).disabled).toBe(true);
  });

  it('submit with toggle ON sends siteAddress: null', async () => {
    await openCreateForm();
    await fillRequiredCreateFields();

    await userEvent.click(screen.getByTestId('project-submit'));

    await waitFor(() => {
      expect(projectCreateMock).toHaveBeenCalledTimes(1);
    });
    const [body] = projectCreateMock.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(body.siteAddress).toBeNull();
  });

  it('submit with toggle OFF sends siteAddress: { street, zip, city }', async () => {
    await openCreateForm();
    await fillRequiredCreateFields();

    // Flip toggle OFF, fill in the divergent address.
    await userEvent.click(screen.getByLabelText(STRINGS.projects.siteAddressIdenticalToggle));
    await userEvent.type(screen.getByTestId('project-site-street-input'), 'Goethestr. 18');
    await userEvent.type(screen.getByTestId('project-site-zip-input'), '51103');
    await userEvent.type(screen.getByTestId('project-site-city-input'), 'Köln');

    await userEvent.click(screen.getByTestId('project-submit'));

    await waitFor(() => {
      expect(projectCreateMock).toHaveBeenCalledTimes(1);
    });
    const [body] = projectCreateMock.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(body.siteAddress).toEqual({
      street: 'Goethestr. 18',
      zip: '51103',
      city: 'Köln',
    });
  });
});

// ---------------------------------------------------------------------
// AC-280 — Edit branch (Project Detail Page is the edit surface)
// ---------------------------------------------------------------------
describe('ProjectDetailPage — Baustelle group (AC-280, edit branch)', () => {
  function renderDetailAt(project: Project) {
    projectGetMock.mockResolvedValue(ok(project));
    useProjectStore.setState({
      projects: [project],
      mutationInFlight: {},
      mutationError: null,
    });
    return render(
      <MemoryRouter initialEntries={[`/projects/${project.id}`]}>
        <Routes>
          <Route path="/projects/:id" element={<ProjectDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  // The Baustelle group is no longer inline on the detail page — it
  // lives inside SiteAddressEditModal, opened by clicking the read-only
  // address row. Tests therefore open the modal as a precondition.
  async function openSiteAddressModal() {
    await userEvent.click(await screen.findByTestId('project-detail-site-address-edit'));
    return screen.findByTestId('site-address-modal');
  }

  it('renders the Baustelle group on the edit surface', async () => {
    renderDetailAt(makeProject({ siteAddress: null }));

    await openSiteAddressModal();

    expect(screen.getByLabelText(STRINGS.projects.siteAddressIdenticalToggle)).toBeInTheDocument();
    expect(screen.getByTestId('project-site-street-input')).toBeInTheDocument();
    expect(screen.getByTestId('project-site-zip-input')).toBeInTheDocument();
    expect(screen.getByTestId('project-site-city-input')).toBeInTheDocument();
  });

  it('initial toggle state on Edit is ON when project.siteAddress is null', async () => {
    renderDetailAt(makeProject({ siteAddress: null }));

    await openSiteAddressModal();

    const toggle = screen.getByLabelText(
      STRINGS.projects.siteAddressIdenticalToggle,
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(true);

    expect((screen.getByTestId('project-site-street-input') as HTMLInputElement).disabled).toBe(
      true,
    );
  });

  it('initial toggle state on Edit is OFF + populated when project.siteAddress is non-null', async () => {
    const stored = { street: 'Goethestr. 18', zip: '51103', city: 'Köln' };
    renderDetailAt(makeProject({ siteAddress: stored }));

    await openSiteAddressModal();

    const toggle = screen.getByLabelText(
      STRINGS.projects.siteAddressIdenticalToggle,
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(false);

    const street = screen.getByTestId('project-site-street-input') as HTMLInputElement;
    const zip = screen.getByTestId('project-site-zip-input') as HTMLInputElement;
    const city = screen.getByTestId('project-site-city-input') as HTMLInputElement;
    expect(street.value).toBe(stored.street);
    expect(zip.value).toBe(stored.zip);
    expect(city.value).toBe(stored.city);
    expect(street.disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------
// AC-281 — toggle ON↔OFF behavior + no premature dispatch
// ---------------------------------------------------------------------
describe('ProjectCreateForm — Baustelle toggle behavior (AC-281)', () => {
  it('switching ON → OFF reveals the empty inputs without dispatching', async () => {
    await openCreateForm();

    const toggle = screen.getByLabelText(
      STRINGS.projects.siteAddressIdenticalToggle,
    ) as HTMLInputElement;
    // Default ON — flip to OFF.
    await userEvent.click(toggle);

    expect(toggle.checked).toBe(false);

    const street = screen.getByTestId('project-site-street-input') as HTMLInputElement;
    expect(street.disabled).toBe(false);
    expect(street.value).toBe('');

    // The toggle change is a UI-only operation — no mutation must
    // dispatch. (No POST, no GET-side-effect on the test mock.)
    expect(projectCreateMock).not.toHaveBeenCalled();
  });

  it('switching OFF → ON disables the inputs and discards typed values without dispatching', async () => {
    await openCreateForm();
    const toggle = screen.getByLabelText(
      STRINGS.projects.siteAddressIdenticalToggle,
    ) as HTMLInputElement;

    // OFF, type, then back to ON. The typed values must not survive
    // the next OFF flip, AND the toggle must not dispatch a request.
    await userEvent.click(toggle);
    await userEvent.type(screen.getByTestId('project-site-street-input'), 'Discardstr. 1');
    await userEvent.type(screen.getByTestId('project-site-zip-input'), '99999');
    await userEvent.type(screen.getByTestId('project-site-city-input'), 'Discardstadt');

    await userEvent.click(toggle);
    expect(toggle.checked).toBe(true);

    const street = screen.getByTestId('project-site-street-input') as HTMLInputElement;
    expect(street.disabled).toBe(true);

    // Back OFF — fields are revealed empty per the spec rule (typed
    // values are not retained across the round-trip).
    await userEvent.click(toggle);
    expect((screen.getByTestId('project-site-street-input') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('project-site-zip-input') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('project-site-city-input') as HTMLInputElement).value).toBe('');

    // Throughout, no mutation has fired.
    expect(projectCreateMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------
// AC-281 — Edit-branch: OFF → ON discards typed values without
// reverting persisted state. The "persisted state" clause has teeth
// only on Edit, where the underlying project.siteAddress is non-null.
// ---------------------------------------------------------------------
describe('ProjectDetailPage — Baustelle toggle behavior (AC-281, edit branch)', () => {
  const STORED = { street: 'Goethestr. 18', zip: '51103', city: 'Köln' };

  function renderDetailWithStoredAddress() {
    const project = makeProject({ siteAddress: STORED });
    projectGetMock.mockResolvedValue(ok(project));
    useProjectStore.setState({
      projects: [project],
      mutationInFlight: {},
      mutationError: null,
    });
    render(
      <MemoryRouter initialEntries={[`/projects/${project.id}`]}>
        <Routes>
          <Route path="/projects/:id" element={<ProjectDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    return project;
  }

  it('OFF → ON discards typed values without dispatching a PATCH or reverting persisted state', async () => {
    const project = renderDetailWithStoredAddress();

    // Open the modal — the Baustelle group is no longer inline.
    await userEvent.click(await screen.findByTestId('project-detail-site-address-edit'));
    await screen.findByTestId('site-address-modal');

    const toggle = screen.getByLabelText(
      STRINGS.projects.siteAddressIdenticalToggle,
    ) as HTMLInputElement;
    // Edit starts OFF (siteAddress non-null), inputs pre-filled.
    expect(toggle.checked).toBe(false);

    // User edits the inputs in-place — typing live, no submit yet.
    const street = screen.getByTestId('project-site-street-input') as HTMLInputElement;
    await userEvent.clear(street);
    await userEvent.type(street, 'Schillerstr. 4');
    expect(street.value).toBe('Schillerstr. 4');

    // Toggle OFF → ON. Per AC-281 this must:
    //   (a) disable the inputs,
    //   (b) discard the typed values (no commit/PATCH),
    //   (c) NOT revert the persisted state.
    await userEvent.click(toggle);
    expect(toggle.checked).toBe(true);
    expect((screen.getByTestId('project-site-street-input') as HTMLInputElement).disabled).toBe(
      true,
    );

    // No PATCH dispatched as a side-effect of the toggle.
    expect(projectUpdateMock).not.toHaveBeenCalled();

    // Persisted store entry still carries the original siteAddress —
    // the typed value never reached the wire and never reached the
    // store. (This is the "without reverting persisted state" axis —
    // toggling is a UI-only concern.)
    const stored = useProjectStore.getState().projects.find((p) => p.id === project.id);
    expect(stored?.siteAddress).toEqual(STORED);

    // Round-trip back OFF — the typed "Schillerstr. 4" was discarded
    // by the OFF→ON flip per AC-281, so the inputs render empty. Only
    // a server commit (which bumps project.updatedAt and remounts via
    // `key`) re-seeds from persisted state. This mirrors the create-
    // branch round-trip at AC-281 above and pins the destructive-wipe
    // behavior so any future "preserve typed value" change must
    // update the test on purpose.
    await userEvent.click(toggle);
    expect(toggle.checked).toBe(false);
    expect((screen.getByTestId('project-site-street-input') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('project-site-zip-input') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('project-site-city-input') as HTMLInputElement).value).toBe('');

    // Still no PATCH dispatched as a side-effect of either toggle.
    expect(projectUpdateMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------
// AC-284 — All-or-none validation on the Baustelle group.
//
// The defense-in-depth pair (form blocks; API would 400 anyway) lives
// in this file's form layer. The API arm is exercised in
// `src/server/__tests__/projects-site-address.test.ts`.
//
// The spec rule: with the toggle OFF and exactly 1 or 2 of street /
// zip / city populated (whitespace-only counts as empty), the form
// blocks submit and surfaces `STRINGS.projects.siteAddressPartial`.
// No POST / PATCH dispatched in the partial case. The toggle ON case
// remains the canonical "site = customer billing address" submission
// and MUST NOT trigger this validation.
// ---------------------------------------------------------------------
describe('ProjectCreateForm — Baustelle all-or-none validation (AC-284)', () => {
  it('toggle OFF with only street filled → submit blocked, German message visible, no POST', async () => {
    await openCreateForm();
    await fillRequiredCreateFields();

    // Flip toggle OFF, fill only street.
    await userEvent.click(screen.getByLabelText(STRINGS.projects.siteAddressIdenticalToggle));
    await userEvent.type(screen.getByTestId('project-site-street-input'), 'Goethestr. 18');

    await userEvent.click(screen.getByTestId('project-submit'));

    // Validation message visible — keyed on the spec's German copy.
    expect(await screen.findByTestId('project-site-address-error')).toHaveTextContent(
      STRINGS.projects.siteAddressPartial,
    );
    // No POST dispatched.
    expect(projectCreateMock).not.toHaveBeenCalled();
  });

  it('toggle OFF with street + zip but city empty → submit blocked, no POST', async () => {
    await openCreateForm();
    await fillRequiredCreateFields();

    await userEvent.click(screen.getByLabelText(STRINGS.projects.siteAddressIdenticalToggle));
    await userEvent.type(screen.getByTestId('project-site-street-input'), 'Goethestr. 18');
    await userEvent.type(screen.getByTestId('project-site-zip-input'), '51103');

    await userEvent.click(screen.getByTestId('project-submit'));

    expect(await screen.findByTestId('project-site-address-error')).toHaveTextContent(
      STRINGS.projects.siteAddressPartial,
    );
    expect(projectCreateMock).not.toHaveBeenCalled();
  });

  it('toggle OFF with whitespace-only in one field → treated as empty, submit blocked, no POST', async () => {
    await openCreateForm();
    await fillRequiredCreateFields();

    await userEvent.click(screen.getByLabelText(STRINGS.projects.siteAddressIdenticalToggle));
    await userEvent.type(screen.getByTestId('project-site-street-input'), 'Goethestr. 18');
    // ZIP gets whitespace only — counts as empty per AC-284.
    await userEvent.type(screen.getByTestId('project-site-zip-input'), '   ');
    await userEvent.type(screen.getByTestId('project-site-city-input'), 'Köln');

    await userEvent.click(screen.getByTestId('project-submit'));

    expect(await screen.findByTestId('project-site-address-error')).toHaveTextContent(
      STRINGS.projects.siteAddressPartial,
    );
    expect(projectCreateMock).not.toHaveBeenCalled();
  });

  it('toggle ON with all three blank → submits siteAddress: null, no validation error', async () => {
    await openCreateForm();
    await fillRequiredCreateFields();
    // Toggle stays ON (default for create) — the canonical "site at
    // customer billing address" submission. No partial-fill error.
    await userEvent.click(screen.getByTestId('project-submit'));

    await waitFor(() => {
      expect(projectCreateMock).toHaveBeenCalledTimes(1);
    });
    const [body] = projectCreateMock.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(body.siteAddress).toBeNull();
    // No validation error rendered.
    expect(screen.queryByTestId('project-site-address-error')).toBeNull();
  });

  it('toggle OFF with all three populated → submits the triple, no validation error', async () => {
    await openCreateForm();
    await fillRequiredCreateFields();

    await userEvent.click(screen.getByLabelText(STRINGS.projects.siteAddressIdenticalToggle));
    await userEvent.type(screen.getByTestId('project-site-street-input'), 'Goethestr. 18');
    await userEvent.type(screen.getByTestId('project-site-zip-input'), '51103');
    await userEvent.type(screen.getByTestId('project-site-city-input'), 'Köln');

    await userEvent.click(screen.getByTestId('project-submit'));

    await waitFor(() => {
      expect(projectCreateMock).toHaveBeenCalledTimes(1);
    });
    const [body] = projectCreateMock.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(body.siteAddress).toEqual({
      street: 'Goethestr. 18',
      zip: '51103',
      city: 'Köln',
    });
    expect(screen.queryByTestId('project-site-address-error')).toBeNull();
  });
});

// ---------------------------------------------------------------------
// Visual auto-fill — when the toggle is ON the disabled inputs show the
// customer's billing address as a read-only preview of what the project
// will inherit. Submit shape is unaffected (still `siteAddress: null`)
// since the fields are never the source of truth in the ON state.
// ---------------------------------------------------------------------
describe('ProjectCreateForm — Baustelle visual auto-fill (toggle ON)', () => {
  it('selecting a customer with an address fills the disabled inputs with that address', async () => {
    await openCreateForm();
    await fillRequiredCreateFields();

    const street = screen.getByTestId('project-site-street-input') as HTMLInputElement;
    const zip = screen.getByTestId('project-site-zip-input') as HTMLInputElement;
    const city = screen.getByTestId('project-site-city-input') as HTMLInputElement;

    expect(street.disabled).toBe(true);
    expect(zip.disabled).toBe(true);
    expect(city.disabled).toBe(true);

    expect(street.value).toBe(SEED_CUSTOMER.address!.street);
    expect(zip.value).toBe(SEED_CUSTOMER.address!.zip);
    expect(city.value).toBe(SEED_CUSTOMER.address!.city);
  });

  it('switching to a different customer updates the displayed address reactively', async () => {
    const otherCustomer: Customer = {
      ...SEED_CUSTOMER,
      id: 'c-2',
      name: 'Bauträger Mitte',
      address: { street: 'Marktstr. 5', zip: '10117', city: 'Berlin' },
    };
    // Override the API mock too — the management view re-fetches on
    // mount and would otherwise overwrite the seeded store with the
    // beforeEach default of just SEED_CUSTOMER.
    customerListMock.mockResolvedValue(ok({ customers: [SEED_CUSTOMER, otherCustomer], total: 2 }));
    useProjectManagementStore.setState({
      projects: [],
      customers: [SEED_CUSTOMER, otherCustomer],
      loading: false,
      error: null,
      showArchived: false,
    });

    await openCreateForm();
    // Pick the seeded customer first.
    await userEvent.click(screen.getByTestId('project-customer-select').querySelector('input')!);
    await userEvent.click(await screen.findByText(SEED_CUSTOMER.name));
    expect((screen.getByTestId('project-site-street-input') as HTMLInputElement).value).toBe(
      SEED_CUSTOMER.address!.street,
    );

    // Switch to the other customer — fields must follow.
    await userEvent.click(screen.getByTestId('project-customer-select').querySelector('input')!);
    await userEvent.click(await screen.findByText(otherCustomer.name));

    expect((screen.getByTestId('project-site-street-input') as HTMLInputElement).value).toBe(
      otherCustomer.address!.street,
    );
    expect((screen.getByTestId('project-site-zip-input') as HTMLInputElement).value).toBe(
      otherCustomer.address!.zip,
    );
    expect((screen.getByTestId('project-site-city-input') as HTMLInputElement).value).toBe(
      otherCustomer.address!.city,
    );
  });

  it('submit with toggle ON still sends siteAddress: null even though fields show customer address', async () => {
    await openCreateForm();
    await fillRequiredCreateFields();

    // Sanity: the disabled inputs visibly carry the customer's address.
    expect((screen.getByTestId('project-site-street-input') as HTMLInputElement).value).toBe(
      SEED_CUSTOMER.address!.street,
    );

    await userEvent.click(screen.getByTestId('project-submit'));

    await waitFor(() => {
      expect(projectCreateMock).toHaveBeenCalledTimes(1);
    });
    const [body] = projectCreateMock.mock.calls[0] as unknown as [Record<string, unknown>];
    // The visual fill is presentation only — the submit body still
    // inherits via `null`, not by copying the customer address.
    expect(body.siteAddress).toBeNull();
  });

  it('customer with null address leaves the disabled inputs empty', async () => {
    const noAddressCustomer: Customer = {
      ...SEED_CUSTOMER,
      id: 'c-no-addr',
      name: 'Kunde ohne Adresse',
      address: null,
    };
    customerListMock.mockResolvedValue(ok({ customers: [noAddressCustomer], total: 1 }));
    useProjectManagementStore.setState({
      projects: [],
      customers: [noAddressCustomer],
      loading: false,
      error: null,
      showArchived: false,
    });

    await openCreateForm();
    await userEvent.click(screen.getByTestId('project-customer-select').querySelector('input')!);
    await userEvent.click(await screen.findByText(noAddressCustomer.name));

    expect((screen.getByTestId('project-site-street-input') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('project-site-zip-input') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('project-site-city-input') as HTMLInputElement).value).toBe('');
  });
});

describe('SiteAddressEditModal — Baustelle visual auto-fill (toggle ON)', () => {
  function renderDetailAt(project: Project) {
    projectGetMock.mockResolvedValue(ok(project));
    useProjectStore.setState({
      projects: [project],
      mutationInFlight: {},
      mutationError: null,
    });
    return render(
      <MemoryRouter initialEntries={[`/projects/${project.id}`]}>
        <Routes>
          <Route path="/projects/:id" element={<ProjectDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('shows the customer address in the disabled inputs when project.siteAddress is null', async () => {
    renderDetailAt(makeProject({ siteAddress: null }));

    await userEvent.click(await screen.findByTestId('project-detail-site-address-edit'));
    await screen.findByTestId('site-address-modal');

    const street = screen.getByTestId('project-site-street-input') as HTMLInputElement;
    const zip = screen.getByTestId('project-site-zip-input') as HTMLInputElement;
    const city = screen.getByTestId('project-site-city-input') as HTMLInputElement;

    expect(street.disabled).toBe(true);
    expect(street.value).toBe(SEED_CUSTOMER.address!.street);
    expect(zip.value).toBe(SEED_CUSTOMER.address!.zip);
    expect(city.value).toBe(SEED_CUSTOMER.address!.city);
  });

  it('toggling ON over a stored siteAddress shows customer address (not stored), submit sends null', async () => {
    const stored = { street: 'Goethestr. 18', zip: '51103', city: 'Köln' };
    renderDetailAt(makeProject({ siteAddress: stored }));

    await userEvent.click(await screen.findByTestId('project-detail-site-address-edit'));
    await screen.findByTestId('site-address-modal');

    // Initial: OFF + populated with stored.
    const street = screen.getByTestId('project-site-street-input') as HTMLInputElement;
    expect(street.value).toBe(stored.street);

    // Flip ON — display must swap to the customer's address.
    await userEvent.click(screen.getByLabelText(STRINGS.projects.siteAddressIdenticalToggle));
    expect(street.disabled).toBe(true);
    expect(street.value).toBe(SEED_CUSTOMER.address!.street);

    // Save — submit body carries `siteAddress: null` regardless of the
    // visible value, clearing the stored override.
    await userEvent.click(screen.getByTestId('project-site-save'));
    await waitFor(() => {
      expect(projectUpdateMock).toHaveBeenCalledTimes(1);
    });
    const [, body] = projectUpdateMock.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(body.siteAddress).toBeNull();
  });
});
