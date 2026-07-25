/**
 * Component tests for the `Baustelle:` line rendered identically on
 * both the quick-glance Project Detail Panel (workflow-views.md §8.4)
 * and the Project Detail Page (project-detail.md §8.15.2).
 *
 * Covers:
 *   - AC-282  Both surfaces render a `Baustelle:` line:
 *               - non-null `project.siteAddress`         → "{street}, {zip} {city}", no hint
 *               - null + customer.address present       → customer address + "(Kundenadresse)" hint
 *               - both absent                           → "Keine Adresse" placeholder, no map link
 *             The rendering on the two surfaces is identical.
 *   - AC-283  Map link is rendered exactly once on whichever address is
 *             displayed; absent when neither address is present.
 *
 * Why a dedicated file: `ProjectDetailPanel.test.tsx` already pins the
 * Öffnen affordance and `ProjectDetailPage.test.tsx` pins layout +
 * route-guard concerns. The Baustelle / Kundenadresse line is a
 * cross-surface contract that benefits from co-located cases —
 * mismatch between the two surfaces is the regression we care about.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { STRINGS } from '@/config/strings';
import type { ApiResult } from '@/api/client';
import type { Address, Customer, Project } from '@/domain/types';

type ProjectGetResult = ApiResult<Project>;

const projectGetMock = vi.fn<() => Promise<ProjectGetResult>>();

vi.mock('@/api/client', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    projectApi: {
      list: vi.fn().mockResolvedValue({ ok: true, data: { data: [], total: 0 } }),
      get: (...args: unknown[]) => projectGetMock(...(args as Parameters<typeof projectGetMock>)),
      create: vi.fn(),
      update: vi.fn(),
      updateDates: vi.fn(),
      delete: vi.fn(),
      transitionForward: vi.fn(),
      transitionBackward: vi.fn(),
    },
    customerApi: {
      list: vi.fn().mockResolvedValue({ ok: true, data: { customers: [], total: 0 } }),
      get: vi.fn(),
    },
    userApi: {
      list: vi.fn().mockResolvedValue({ ok: true, data: { users: [], total: 0 } }),
    },
    authApi: {
      login: vi.fn(),
      logout: vi.fn(),
      me: vi.fn().mockResolvedValue({ ok: false }),
    },
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

const { ProjectDetailPanel } = await import('@/ui/detail/ProjectDetailPanel');
const { ProjectDetailPage } = await import('@/ui/detail/ProjectDetailPage');
const { useAuthStore } = await import('@/state/authStore');
const { useProjectStore } = await import('@/state/projectStore');

const SITE: Address = { street: 'Goethestr. 18', zip: '51103', city: 'Köln' };
const CUSTOMER_ADDRESS: Address = { street: 'Rheinuferstr. 44', zip: '50996', city: 'Köln' };

function customerWith(address: Address | null): Customer {
  return {
    id: 'c-1',
    name: 'Hausverwaltung Rheinblick',
    phone: null,
    email: null,
    address,
    notes: null,
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
    createdBy: null,
    updatedBy: null,
  };
}

function makeProject(siteAddress: Address | null, customerAddress: Address | null): Project {
  const customer = customerWith(customerAddress);
  return {
    id: 'p-42',
    number: 'P-042',
    title: 'Dachsanierung',
    status: 'geplant',
    statusChangedAt: '2026-04-01T00:00:00Z',
    plannedStart: null,
    plannedEnd: null,
    customerId: customer.id,
    customer: {
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      email: customer.email,
      address: customer.address,
    },
    siteAddress,
    assignedWorkers: [],
    estimatedValue: null,
    notes: null,
    deleted: false,
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
    createdBy: null,
    updatedBy: null,
  };
}

function setAuthOwner(): void {
  useAuthStore.setState({
    authUser: {
      id: 'u-owner',
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
  setAuthOwner();
  projectGetMock.mockReset();
  // Hard-reset the project store between tests. The panel reads
  // `currentProject = projects.find(p => p.id === project.id) ?? project`,
  // so a stale entry under the same id ('p-42') from a prior test would
  // shadow the freshly-passed prop and render the wrong addresses.
  useProjectStore.setState({ projects: [], mutationInFlight: {}, mutationError: null });
});

function renderPanel(project: Project) {
  return render(
    <MemoryRouter>
      <ProjectDetailPanel project={project} onClose={vi.fn()} />
    </MemoryRouter>,
  );
}

function renderPage(project: Project) {
  projectGetMock.mockResolvedValue({ ok: true, data: project });
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

/**
 * The two surfaces render the line under different testids. Use a
 * single helper so each AC-282 case asserts on both surfaces and the
 * test loudly distinguishes which side regressed.
 */
async function findSiteAddressLineOnPanel(): Promise<HTMLElement> {
  return screen.findByTestId('detail-site-address');
}
async function findSiteAddressLineOnPage(): Promise<HTMLElement> {
  return screen.findByTestId('project-detail-site-address');
}

// --------------------------------------------------------------------
// AC-282 — Baustelle: line rendering on both surfaces
// --------------------------------------------------------------------
describe('Baustelle: line — non-null project.siteAddress (AC-282)', () => {
  const project = makeProject(SITE, CUSTOMER_ADDRESS);

  it('panel renders street, zip city from siteAddress with no fallback hint', async () => {
    renderPanel(project);
    const line = await findSiteAddressLineOnPanel();
    expect(line.textContent).toContain(STRINGS.projects.siteAddressLabel);
    expect(line.textContent).toContain(SITE.street);
    expect(line.textContent).toContain(SITE.zip);
    expect(line.textContent).toContain(SITE.city);
    expect(line.textContent).not.toContain(STRINGS.projects.siteAddressFallbackHint);
  });

  it('page renders street, zip city from siteAddress with no fallback hint', async () => {
    renderPage(project);
    const line = await findSiteAddressLineOnPage();
    expect(line.textContent).toContain(STRINGS.projects.siteAddressLabel);
    expect(line.textContent).toContain(SITE.street);
    expect(line.textContent).toContain(SITE.zip);
    expect(line.textContent).toContain(SITE.city);
    expect(line.textContent).not.toContain(STRINGS.projects.siteAddressFallbackHint);
  });
});

describe('Baustelle: line — fallback to customer.address with hint (AC-282)', () => {
  const project = makeProject(null, CUSTOMER_ADDRESS);

  it('panel renders the customer address with the (Kundenadresse) hint', async () => {
    renderPanel(project);
    const line = await findSiteAddressLineOnPanel();
    expect(line.textContent).toContain(CUSTOMER_ADDRESS.street);
    expect(line.textContent).toContain(CUSTOMER_ADDRESS.zip);
    expect(line.textContent).toContain(CUSTOMER_ADDRESS.city);
    expect(line.textContent).toContain(STRINGS.projects.siteAddressFallbackHint);
  });

  it('page renders the customer address with the (Kundenadresse) hint', async () => {
    renderPage(project);
    const line = await findSiteAddressLineOnPage();
    expect(line.textContent).toContain(CUSTOMER_ADDRESS.street);
    expect(line.textContent).toContain(CUSTOMER_ADDRESS.zip);
    expect(line.textContent).toContain(CUSTOMER_ADDRESS.city);
    expect(line.textContent).toContain(STRINGS.projects.siteAddressFallbackHint);
  });
});

describe('Baustelle: line — both addresses absent → "Keine Adresse" (AC-282)', () => {
  const project = makeProject(null, null);

  it('panel renders the "Keine Adresse" placeholder with no map link', async () => {
    renderPanel(project);
    const line = await findSiteAddressLineOnPanel();
    expect(line.textContent).toContain(STRINGS.projects.siteAddressNone);
    // No map link — searched within the rendered Baustelle line.
    expect(within(line).queryByRole('link', { name: STRINGS.ui.openMaps })).toBeNull();
  });

  it('page renders the "Keine Adresse" placeholder with no map link', async () => {
    renderPage(project);
    const line = await findSiteAddressLineOnPage();
    expect(line.textContent).toContain(STRINGS.projects.siteAddressNone);
    expect(within(line).queryByRole('link', { name: STRINGS.ui.openMaps })).toBeNull();
  });
});

// --------------------------------------------------------------------
// AC-283 — exactly one map link, on whichever address is displayed
// --------------------------------------------------------------------
describe('Map link — exactly once, on the displayed address (AC-283)', () => {
  it('panel: map link points at project.siteAddress when present', async () => {
    const project = makeProject(SITE, CUSTOMER_ADDRESS);
    renderPanel(project);

    const links = screen.getAllByRole('link', { name: STRINGS.ui.openMaps });
    expect(links).toHaveLength(1);
    const href = links[0].getAttribute('href') ?? '';
    expect(href).toContain(encodeURIComponent(SITE.street));
    expect(href).toContain(encodeURIComponent(SITE.zip));
    expect(href).toContain(encodeURIComponent(SITE.city));
  });

  it('page: map link points at project.siteAddress when present', async () => {
    const project = makeProject(SITE, CUSTOMER_ADDRESS);
    renderPage(project);

    // Wait for the page to land before counting links.
    await screen.findByTestId('project-detail-page');

    const links = screen.getAllByRole('link', { name: STRINGS.ui.openMaps });
    expect(links).toHaveLength(1);
    const href = links[0].getAttribute('href') ?? '';
    expect(href).toContain(encodeURIComponent(SITE.street));
    expect(href).toContain(encodeURIComponent(SITE.zip));
    expect(href).toContain(encodeURIComponent(SITE.city));
  });

  it('panel: map link points at customer.address when siteAddress is null', async () => {
    const project = makeProject(null, CUSTOMER_ADDRESS);
    renderPanel(project);

    const links = screen.getAllByRole('link', { name: STRINGS.ui.openMaps });
    expect(links).toHaveLength(1);
    const href = links[0].getAttribute('href') ?? '';
    expect(href).toContain(encodeURIComponent(CUSTOMER_ADDRESS.street));
    expect(href).toContain(encodeURIComponent(CUSTOMER_ADDRESS.zip));
    expect(href).toContain(encodeURIComponent(CUSTOMER_ADDRESS.city));
  });

  it('page: map link points at customer.address when siteAddress is null', async () => {
    const project = makeProject(null, CUSTOMER_ADDRESS);
    renderPage(project);
    await screen.findByTestId('project-detail-page');

    const links = screen.getAllByRole('link', { name: STRINGS.ui.openMaps });
    expect(links).toHaveLength(1);
    const href = links[0].getAttribute('href') ?? '';
    expect(href).toContain(encodeURIComponent(CUSTOMER_ADDRESS.street));
    expect(href).toContain(encodeURIComponent(CUSTOMER_ADDRESS.zip));
    expect(href).toContain(encodeURIComponent(CUSTOMER_ADDRESS.city));
  });

  it('panel: no map link rendered when neither address is present', async () => {
    const project = makeProject(null, null);
    renderPanel(project);

    expect(screen.queryByRole('link', { name: STRINGS.ui.openMaps })).toBeNull();
  });

  it('page: no map link rendered when neither address is present', async () => {
    const project = makeProject(null, null);
    renderPage(project);
    await screen.findByTestId('project-detail-page');

    expect(screen.queryByRole('link', { name: STRINGS.ui.openMaps })).toBeNull();
  });
});
