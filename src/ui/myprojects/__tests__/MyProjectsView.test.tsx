/**
 * MyProjectsView — the worker's landing list, grouped into `Heute`,
 * `Demnächst` and `Weitere` (AC-753).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { Project } from '@/domain/types';
import { useTimezone } from '@/test/timezone';

vi.mock('@/api/client', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    projectApi: { list: vi.fn() },
  };
});

const { MyProjectsView } = await import('@/ui/myprojects/MyProjectsView');
const { useAuthStore } = await import('@/state/authStore');
const { useProjectStore } = await import('@/state/projectStore');
const { projectApi } = await import('@/api/client');

const ME = { userId: 'u-me', displayName: 'Ich' };
const OTHER = { userId: 'u-other', displayName: 'Andere' };

function project(id: string, overrides: Partial<Project>): Project {
  return {
    id,
    number: id.toUpperCase(),
    title: `Projekt ${id}`,
    status: 'geplant',
    statusChangedAt: '2026-11-01T00:00:00Z',
    plannedStart: null,
    plannedEnd: null,
    customerId: 'c-1',
    customer: null,
    siteAddress: null,
    assignedWorkers: [ME],
    estimatedValue: null,
    notes: null,
    deleted: false,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    createdBy: null,
    updatedBy: null,
    ...overrides,
  };
}

function renderWith(projects: Project[]): void {
  vi.mocked(projectApi.list).mockResolvedValue({
    ok: true,
    data: { data: projects, total: projects.length },
  } as Awaited<ReturnType<typeof projectApi.list>>);
  render(
    <MemoryRouter>
      <MyProjectsView />
    </MemoryRouter>,
  );
}

/** Row ids of one group, in rendered order. */
async function groupRows(title: string): Promise<string[]> {
  const heading = await screen.findByRole('heading', { name: new RegExp(`^${title}`) });
  const section = heading.closest('section');
  if (!section) throw new Error(`no section for ${title}`);
  return within(section)
    .getAllByRole('link')
    .map((a) => a.getAttribute('data-testid')!.replace('my-project-row-', ''));
}

beforeEach(() => {
  // Noon in the deployment's zone (set below), so each date-only
  // planned date falls on one unambiguous day.
  vi.useFakeTimers({ now: new Date(2026, 10, 20, 12, 0), shouldAdvanceTime: true });
  useProjectStore.setState({ projects: [] });
  useAuthStore.setState({
    authUser: {
      id: ME.userId,
      username: 'worker',
      displayName: ME.displayName,
      roles: ['worker'],
      email: null,
      themePreference: 'system',
      pushMuted: false,
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AC-753: Meine Projekte groups the worker’s assigned projects', () => {
  // The deployment runs in Germany; west of UTC a date-only string
  // parses into the previous local day.
  useTimezone('Europe/Berlin');

  it('sorts each project into Heute, Demnächst or Weitere, each by planned start, undated last', async () => {
    renderWith([
      project('later', { plannedStart: '2026-12-10', plannedEnd: '2026-12-12' }),
      project('soon', { plannedStart: '2026-11-21', plannedEnd: '2026-11-25' }),
      project('ends-today', { plannedStart: '2026-11-18', plannedEnd: '2026-11-20' }),
      project('starts-today', { plannedStart: '2026-11-20', plannedEnd: null }),
      project('spans-today', { plannedStart: '2026-11-10', plannedEnd: '2026-11-30' }),
      project('undated', {}),
      project('past', { plannedStart: '2026-10-01', plannedEnd: '2026-10-05' }),
      project('finished', {
        status: 'erledigt',
        plannedStart: '2026-09-01',
        plannedEnd: '2026-09-02',
      }),
      project('not-mine', { plannedStart: '2026-11-20', assignedWorkers: [OTHER] }),
    ]);

    expect(await groupRows('Heute')).toEqual(['spans-today', 'ends-today', 'starts-today']);
    expect(await groupRows('Demnächst')).toEqual(['soon', 'later']);
    expect(await groupRows('Weitere')).toEqual(['finished', 'past', 'undated']);
    expect(screen.queryByTestId('my-project-row-not-mine')).toBeNull();
  });

  it('shows the empty message when no project is assigned to the worker', async () => {
    renderWith([project('not-mine', { assignedWorkers: [OTHER] })]);

    expect(await screen.findByText('Keine zugewiesenen Projekte.')).toBeInTheDocument();
  });
});
