/**
 * ProjectDetailPage — layout + route-guard tests.
 *
 * The page is the canonical full-context view of a project at
 * `/projects/:id`. It reads the id from the route param, fetches the
 * project, and lays out six regions in a fixed order per spec
 * §8.15.1. Access follows the role matrix — a worker not assigned to
 * the project lands on the not-permitted surface per AC-149.
 *
 * Network surface is mocked at the API-client boundary; real stores
 * and router context run so the route param → URL read path is
 * exercised end-to-end within the component.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router';
import type { ApiResult } from '@/api/client';
import type { Customer, Project } from '@/domain/types';

type ProjectResult = ApiResult<Project>;

const projectGetMock = vi.fn<(id: string) => Promise<ProjectResult>>();

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
      changePassword: vi.fn(),
    },
    attachmentApi: {
      list: vi.fn().mockResolvedValue({ ok: true, data: { data: [] } }),
      initUpload: vi.fn(),
      completeUpload: vi.fn(),
      delete: vi.fn(),
      downloadUrl: vi.fn(),
      // Per-blob bulk wire shape (api.md §14.2.11) — replaces the
      // legacy server-side zip-URL endpoint per ADR-0024.
      bulkFetch: vi.fn(),
    },
    auditApi: {
      list: vi.fn().mockResolvedValue({ ok: true, data: { data: [], nextCursor: null } }),
    },
  };
});

const { ProjectDetailPage } = await import('@/ui/detail/ProjectDetailPage');
const { useAuthStore } = await import('@/state/authStore');
const { useProjectStore } = await import('@/state/projectStore');
const { useAttachmentStore } = await import('@/state/attachmentStore');
const { useToastStore } = await import('@/state/toastStore');

const CUSTOMER: Customer = {
  id: 'c-1',
  name: 'Kunde GmbH',
  phone: null,
  email: null,
  address: null,
  notes: null,
  createdAt: '2026-03-30T00:00:00Z',
  updatedAt: '2026-03-30T00:00:00Z',
  createdBy: null,
  updatedBy: null,
};

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p-42',
    number: 'P-042',
    title: 'Dachsanierung',
    status: 'geplant',
    statusChangedAt: '2026-04-01T00:00:00Z',
    plannedStart: '2026-05-01',
    plannedEnd: '2026-06-01',
    customerId: 'c-1',
    customer: CUSTOMER,
    siteAddress: null,
    assignedWorkers: [
      { userId: 'u-worker-1', displayName: 'Anna Arbeiter' },
      { userId: 'u-worker-2', displayName: 'Bernd Bauer' },
    ],
    estimatedValue: 15000,
    notes: 'Kundennotiz',
    deleted: false,
    createdAt: '2026-03-30T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
    createdBy: null,
    updatedBy: null,
    ...overrides,
  };
}

function setAuthUser(roles: string[], id = 'u-owner'): void {
  useAuthStore.setState({
    authUser: {
      id,
      username: 'user',
      displayName: 'Test',
      roles,
      email: null,
      themePreference: 'system',
      pushMuted: false,
    },
    authError: null,
    sessionChecked: true,
  });
}

beforeAll(() => {
  // jsdom lacks matchMedia; KanbanBoard and friends probe it on mount.
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
  projectGetMock.mockReset();
  projectGetMock.mockResolvedValue({ ok: true, data: makeProject() });
  useAuthStore.setState({ authUser: null, authError: null, sessionChecked: true });
  useProjectStore.setState({
    projects: [makeProject()],
    mutationInFlight: {},
    mutationError: null,
  });
});

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProjectDetailPage — layout (spec §8.15.1)', () => {
  it('renders the six regions in the spec-ordered sequence', async () => {
    setAuthUser(['owner']);
    renderAt('/projects/p-42');

    const page = await screen.findByTestId('project-detail-page');

    // Six region testids, in exact order.
    const expectedOrder = [
      'project-detail-header',
      'project-detail-core',
      'project-detail-assigned-workers',
      'project-detail-photos',
      'project-detail-binaries',
      'project-detail-activity',
    ];

    // `getByTestId` throws on missing — a missing region fails the test
    // with a clear error rather than silently shortening the list.
    const rendered = expectedOrder.map((id) => within(page).getByTestId(id));

    expect(rendered.map((el) => el.getAttribute('data-testid'))).toEqual(expectedOrder);
  });

  it('renders core fields (number, title, customer, dates, value, notes)', async () => {
    setAuthUser(['owner']);
    renderAt('/projects/p-42');

    // Header carries the project number (plain text) and the title
    // (inline input — read its `value`, not textContent).
    const header = await screen.findByTestId('project-detail-header');
    expect(header.textContent).toContain('P-042');
    const titleInput = within(header).getByTestId('project-title-edit') as HTMLInputElement;
    expect(titleInput.value).toBe('Dachsanierung');

    // Core region surfaces the customer, planned dates, value, notes.
    // Dates / value / notes are editable inputs; assert on their
    // current value rather than textContent (which is '' for inputs).
    const core = screen.getByTestId('project-detail-core');
    expect(core.textContent).toContain('Kunde GmbH');
    const start = within(core).getByTestId('project-detail-start') as HTMLInputElement;
    const end = within(core).getByTestId('project-detail-end') as HTMLInputElement;
    expect(start.value).toBe('2026-05-01');
    expect(end.value).toBe('2026-06-01');
    const notes = within(core).getByTestId('project-notes-input') as HTMLTextAreaElement;
    expect(notes.value).toBe('Kundennotiz');
  });
});

describe('ProjectDetailPage — route param → load', () => {
  it('reads :id from the URL and requests the matching project', async () => {
    setAuthUser(['owner']);
    renderAt('/projects/p-42');

    await waitFor(() => {
      expect(projectGetMock).toHaveBeenCalledWith('p-42');
    });
  });

  it('reads a different :id when the route path changes', async () => {
    setAuthUser(['owner']);
    projectGetMock.mockResolvedValue({
      ok: true,
      data: makeProject({ id: 'p-99', number: 'P-099', title: 'Anderes Projekt' }),
    });

    renderAt('/projects/p-99');

    await waitFor(() => {
      expect(projectGetMock).toHaveBeenCalledWith('p-99');
    });
  });
});

describe('ProjectDetailPage — out-of-scope worker surface (AC-149 mirror)', () => {
  it('renders the not-permitted surface when the server reports NOT_PERMITTED', async () => {
    // A worker not assigned to the project: the server answers
    // 403 NOT_PERMITTED per the attachment-scope + project-detail
    // policy. The page must surface the not-permitted copy, not a
    // stale or empty detail view.
    setAuthUser(['worker'], 'u-worker-outside');
    projectGetMock.mockResolvedValue({
      ok: false,
      error: { code: 'NOT_PERMITTED', message: 'Keine Berechtigung.' },
      category: 'authorization',
      sessionExpired: false,
    });

    renderAt('/projects/p-42');

    expect(await screen.findByTestId('not-permitted-view')).toBeInTheDocument();
    // The detail shell is not mounted on the not-permitted branch.
    expect(screen.queryByTestId('project-detail-core')).not.toBeInTheDocument();
  });

  it('renders the not-found surface when the server returns 404 (unknown project)', async () => {
    // An unknown project id is a 404, not a 403. The page must
    // distinguish so the user is not shown a stale authorization error.
    setAuthUser(['owner']);
    projectGetMock.mockResolvedValue({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Projekt nicht gefunden.' },
      category: 'not_found',
      sessionExpired: false,
    });

    renderAt('/projects/p-ghost');

    expect(await screen.findByTestId('project-detail-not-found')).toBeInTheDocument();
  });
});

describe('ProjectDetailPage — camera FAB MIME gate', () => {
  beforeEach(() => {
    // Replace uploadFile with an observable no-op so the test can
    // assert call-site behaviour without spinning up the full upload
    // orchestrator (which would hit the `attachmentApi.initUpload`
    // stub at `vi.fn()` and crash on an undefined response).
    const uploadFileStub = vi.fn().mockResolvedValue(undefined);
    useAttachmentStore.setState({
      uploadFile: uploadFileStub as unknown as ReturnType<
        typeof useAttachmentStore.getState
      >['uploadFile'],
      pendingUploads: {},
      byProject: {},
      error: null,
    });
    useToastStore.setState({ toasts: [] });
  });

  it('rejects a non-whitelisted MIME (e.g. HEIC) with a toast and does not dispatch uploadFile', async () => {
    // Mirror of UploadCta.dispatchUpload's whitelist gate. Without
    // this check a HEIC from an exotic camera app reaches the upload
    // orchestrator, trips the per-file size cap at the post-pipeline
    // check, and surfaces the misleading "Datei zu groß" banner.
    setAuthUser(['owner']);
    renderAt('/projects/p-42');

    const fab = await screen.findByTestId('detail-camera-capture');
    const input = fab.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();

    const heic = new File([new Uint8Array([1, 2, 3])], 'photo.heic', { type: 'image/heic' });
    // `applyAccept: false` — the browser's `accept` attribute is a
    // hint, not a gate (this is exactly why we need the JS-level
    // whitelist check). userEvent's default is to simulate the
    // browser's hint and skip mismatched files, which would mean the
    // onChange handler never fires in this test. Turning off the
    // hint simulates a browser that let the file through, which is
    // the behaviour the gate exists to defend against.
    await userEvent.upload(input, heic, { applyAccept: false });

    const uploadFileMock = useAttachmentStore.getState().uploadFile as unknown as ReturnType<
      typeof vi.fn
    >;
    expect(uploadFileMock).not.toHaveBeenCalled();

    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe('error');
    expect(toasts[0].message).toContain('Dateityp nicht unterstützt');
  });

  it('dispatches uploadFile for a whitelisted photo MIME (image/jpeg)', async () => {
    // Happy path: a regular JPEG from the camera roll or phone camera
    // reaches uploadFile with the `foto` label and `hasThumbnail: true`
    // — the FAB's canonical contract.
    setAuthUser(['owner']);
    renderAt('/projects/p-42');

    const fab = await screen.findByTestId('detail-camera-capture');
    const input = fab.querySelector('input[type="file"]') as HTMLInputElement;

    const jpeg = new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' });
    await userEvent.upload(input, jpeg);

    const uploadFileMock = useAttachmentStore.getState().uploadFile as unknown as ReturnType<
      typeof vi.fn
    >;
    await waitFor(() => {
      expect(uploadFileMock).toHaveBeenCalledTimes(1);
    });
    expect(uploadFileMock).toHaveBeenCalledWith(
      'p-42',
      expect.any(File),
      expect.objectContaining({ label: 'foto', hasThumbnail: true }),
    );
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});

describe('ProjectDetailPage — KUNDE click opens CustomerEditForm modal', () => {
  it('opens the modal for an owner (canEditCustomer = true)', async () => {
    setAuthUser(['owner']);
    renderAt('/projects/p-42');

    const card = await screen.findByTestId('project-detail-customer');
    // The clickable affordance becomes a role="button" surface; the
    // attribute is the contract the keyboard a11y path relies on.
    expect(card).toHaveAttribute('role', 'button');
    expect(card).toHaveAttribute('tabindex', '0');

    await userEvent.click(card);

    // CustomerEditForm renders the canonical "Speichern" testid the
    // Kunden tab uses; presence implies the modal mounted.
    expect(await screen.findByTestId('customer-save')).toBeInTheDocument();
    // The name input is pre-seeded from the embedded customer payload.
    expect((screen.getByTestId('customer-name-input') as HTMLInputElement).value).toBe(
      'Kunde GmbH',
    );
  });

  it('does NOT open the modal for a bookkeeper (no customer:write)', async () => {
    setAuthUser(['bookkeeper']);
    renderAt('/projects/p-42');

    const card = await screen.findByTestId('project-detail-customer');
    expect(card).not.toHaveAttribute('role', 'button');

    // Even if a stray click reaches the wrapper, the modal must not open.
    await userEvent.click(card);
    expect(screen.queryByTestId('customer-save')).toBeNull();
  });

  it('inner tel: / mailto: anchors do not trigger the modal', async () => {
    // Owner role + a customer with phone+email so both anchors render.
    // Tapping a phone link must place the call (anchor default action),
    // not steal focus into the edit modal.
    const projectWithContact = makeProject({
      customer: { ...CUSTOMER, phone: '+49 30 1234567', email: 'kunde@example.de' },
    });
    projectGetMock.mockResolvedValue({ ok: true, data: projectWithContact });
    useProjectStore.setState({
      projects: [projectWithContact],
      mutationInFlight: {},
      mutationError: null,
    });

    setAuthUser(['owner']);
    renderAt('/projects/p-42');

    const phone = await screen.findByTestId('project-detail-customer-phone');
    await userEvent.click(phone);
    expect(screen.queryByTestId('customer-save')).toBeNull();

    const email = screen.getByTestId('project-detail-customer-email');
    await userEvent.click(email);
    expect(screen.queryByTestId('customer-save')).toBeNull();
  });
});

describe('ProjectDetailPage — BAUSTELLE click opens SiteAddressEditModal', () => {
  it('opens the modal for an owner (canUpdate = true)', async () => {
    setAuthUser(['owner']);
    renderAt('/projects/p-42');

    const wrap = await screen.findByTestId('project-detail-site-address-edit');
    expect(wrap).toHaveAttribute('role', 'button');

    await userEvent.click(wrap);

    expect(await screen.findByTestId('site-address-modal')).toBeInTheDocument();
    // The modal carries the same Speichern testid the previous inline
    // panel did — call sites that already targeted it keep working.
    expect(screen.getByTestId('project-site-save')).toBeInTheDocument();
  });

  it('does NOT mount the clickable wrapper for a bookkeeper (no project:update)', async () => {
    setAuthUser(['bookkeeper']);
    renderAt('/projects/p-42');

    // The read-only SiteAddressLine still renders under the original
    // testid; the click-to-edit wrapper is what disappears. Without
    // the wrapper, there is no click target that could open the modal,
    // so the wrapper-absence assertion is sufficient.
    await screen.findByTestId('project-detail-site-address');
    expect(screen.queryByTestId('project-detail-site-address-edit')).toBeNull();
  });

  it('clicking the inner map link does not open the modal', async () => {
    // Project with a non-null siteAddress so the SiteAddressLine
    // renders the "In Google Maps öffnen" anchor.
    const projectWithSite = makeProject({
      siteAddress: { street: 'Goethestr. 18', zip: '51103', city: 'Köln' },
    });
    projectGetMock.mockResolvedValue({ ok: true, data: projectWithSite });
    useProjectStore.setState({
      projects: [projectWithSite],
      mutationInFlight: {},
      mutationError: null,
    });

    setAuthUser(['owner']);
    renderAt('/projects/p-42');

    const wrap = await screen.findByTestId('project-detail-site-address-edit');
    const mapLink = within(wrap).getByRole('link', { name: 'In Google Maps öffnen' });

    await userEvent.click(mapLink);
    expect(screen.queryByTestId('site-address-modal')).toBeNull();
  });
});
