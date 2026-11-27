/**
 * ProjectCard — a card's forward and backward buttons ask for
 * confirmation naming the current and the target state (AC-457), and
 * only a confirmed dialog transitions the project.
 *
 * States and their order come from the spec (index.md §3), not from the
 * state config, so a mislabelled or reordered state fails here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { Project } from '@/domain/types';
import type { WorkflowState } from '@/config/stateConfig';
import { ProjectCard } from '@/ui/kanban/ProjectCard';
import { ConfirmDialog } from '@/ui/common/ConfirmDialog';
import { useAuthStore } from '@/state/authStore';
import { useConfirmStore } from '@/state/confirmStore';
import { useProjectStore } from '@/state/projectStore';

/** index.md §3 — the workflow states in order. */
const STATES: readonly { key: WorkflowState; label: string }[] = [
  { key: 'anfrage', label: 'Anfrage' },
  { key: 'angebot', label: 'Angebot' },
  { key: 'beauftragt', label: 'Beauftragt' },
  { key: 'geplant', label: 'Geplant' },
  { key: 'in_arbeit', label: 'In Arbeit' },
  { key: 'abnahme', label: 'Abnahme' },
  { key: 'rechnung_faellig', label: 'Rechnung fällig' },
  { key: 'abgerechnet', label: 'Abgerechnet' },
  { key: 'erledigt', label: 'Erledigt' },
];

const STEPS = STATES.slice(1).map((target, i) => ({ from: STATES[i]!, to: target }));
/** No transition leaves Erledigt (index.md §3). */
const BACKWARD_STEPS = STEPS.filter(({ to }) => to.key !== 'erledigt');

function makeProject(status: WorkflowState): Project {
  return {
    id: 'p-1',
    version: 1,
    number: 'P-1',
    title: 'Fassade',
    status,
    statusChangedAt: '2026-04-01T00:00:00Z',
    plannedStart: null,
    plannedEnd: null,
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
    customerId: 'c-1',
    customer: null,
    siteAddress: null,
    assignedWorkers: [],
    estimatedValue: null,
    notes: null,
    deleted: false,
    createdBy: null,
    updatedBy: null,
  } as Project;
}

const transitionForward = vi.fn();
const transitionBackward = vi.fn();

beforeEach(() => {
  transitionForward.mockReset();
  transitionBackward.mockReset();
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
  useConfirmStore.setState({ isOpen: false, resolver: null, message: '' });
  useProjectStore.setState({ mutationInFlight: {}, transitionForward, transitionBackward });
});

function renderCard(status: WorkflowState): void {
  render(
    <MemoryRouter>
      <ProjectCard project={makeProject(status)} />
      <ConfirmDialog />
    </MemoryRouter>,
  );
}

/** The open dialog's text names `current` first, then `target`. */
function expectDialogNaming(current: string, target: string): void {
  const text = screen.getByRole('dialog').textContent ?? '';
  expect(text).toContain(current);
  expect(text).toContain(target);
  expect(text.indexOf(current)).toBeLessThan(text.indexOf(target));
}

describe('ProjectCard — AC-457: a transition asks for confirmation naming both states', () => {
  it.each(STEPS)('forward: $from.label → $to.label', async ({ from, to }) => {
    renderCard(from.key);
    const button = screen.getByTestId('forward-button-p-1');

    await userEvent.click(button);
    expectDialogNaming(from.label, to.label);
    await userEvent.click(screen.getByTestId('confirm-cancel'));
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    expect(transitionForward).not.toHaveBeenCalled();

    await userEvent.click(button);
    expectDialogNaming(from.label, to.label);
    expect(transitionForward).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('confirm-ok'));
    expect(transitionForward).toHaveBeenCalledExactlyOnceWith('p-1');
    expect(transitionBackward).not.toHaveBeenCalled();
  });

  it.each(BACKWARD_STEPS)('backward: $to.label → $from.label', async ({ from, to }) => {
    renderCard(to.key);
    const button = screen.getByTestId('backward-button-p-1');

    await userEvent.click(button);
    expectDialogNaming(to.label, from.label);
    await userEvent.click(screen.getByTestId('confirm-cancel'));
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    expect(transitionBackward).not.toHaveBeenCalled();

    await userEvent.click(button);
    expectDialogNaming(to.label, from.label);
    expect(transitionBackward).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('confirm-ok'));
    expect(transitionBackward).toHaveBeenCalledExactlyOnceWith('p-1');
    expect(transitionForward).not.toHaveBeenCalled();
  });
});
