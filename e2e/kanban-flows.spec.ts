import { test, expect, type Page } from '@playwright/test';
import {
  addDays,
  differenceInCalendarDays,
  differenceInCalendarMonths,
  eachDayOfInterval,
  format,
  getDay,
  parseISO,
  setDate,
} from 'date-fns';
import { STORAGE_STATES } from './storage-states';

/**
 * E2E Kanban board flows
 *
 * Integration scenarios extracted from the original smoke test. The smoke
 * test is now a minimal boot-and-round-trip check (see smoke.spec.ts); this
 * file exercises the specific features that were previously bundled into
 * one 247-line mega-test. Each scenario is self-contained: it inherits a
 * logged-in context from the shared storageState (see e2e/auth.setup.ts
 * and playwright.config.ts), navigates to `/`, and starts from a clean
 * Kanban view. The per-test login was removed in favour of the shared
 * auth state because repeated logins would trip the 5-per-minute login
 * rate limit (src/server/config/index.ts:33) and 429 the 6th+ test.
 *
 * Seed data assumptions (inherited from the previous smoke test):
 *   - User: inhaber / changeme (Thomas Berger, admin/owner)
 *   - 19 projects distributed across 9 states
 *   - 3 projects in rechnung_faellig
 *   - 2 projects in geplant (both with planned dates)
 *   - 4+ projects without dates
 *
 * Project IDs are auto-generated UUIDs — tests discover them dynamically
 * from the page rather than hardcoding.
 */

/**
 * Pick an end date `daysOffset` days from today (no calendar-month
 * clamping). Different call sites use different offsets so two
 * date-mutation tests writing the same seeded card never try to PATCH
 * the same value — `<input type="date">` `fill()` is a no-op when the
 * value already matches, and an unchanged input does not fire a PATCH,
 * so the second test's `waitForResponse` would hang.
 *
 * Offset must comfortably exceed the seed's largest geplant
 * `plannedStartDays` (currently 8 — see src/server/seed/business.ts) so
 * the resulting end date never falls before the project's start date.
 * The server enforces `start <= end`; an end-before-start PATCH is
 * rejected and the optimistic UI update reverts to the seed value,
 * which surfaces as a stale `toHaveValue` assertion. This file's
 * offsets are 10/11/12 — well clear of the seed's 8-day horizon and
 * still tightly bunched so the dates are easy to reason about.
 *
 * No same-calendar-month clamp: the original implementation clipped to
 * `lastDayOfMonth(today)` whenever the offset crossed the month
 * boundary. That clamp doesn't know about the project's start date,
 * and on the last few days of a month it produced dates earlier than
 * the seeded geplant projects' start (today + 5 / today + 8) —
 * deterministic failure for those few days each month. The calendar
 * view renders full Mon–Sun weeks (weekStartsOn: 1, see
 * src/ui/calendar/CalendarGrid.tsx), so a date in the next month is
 * usually visible in the current month's view anyway; when it isn't,
 * `navigateCalendarToMonthOf` clicks `calendar-next` until the right
 * month is in view.
 */
function pickPlannedEndDate(daysOffset: number): { iso: string; testId: string } {
  const today = new Date();
  const target = addDays(today, daysOffset);
  const iso = format(target, 'yyyy-MM-dd');
  return { iso, testId: `calendar-day-${iso}` };
}

/**
 * Click `calendar-next` until the visible month matches `targetIso`'s
 * month. Idempotent when already on the right month. Bounded so a wrong
 * `targetIso` doesn't loop forever on a CalendarView regression.
 */
async function navigateCalendarToMonthOf(page: Page, targetIso: string): Promise<void> {
  const target = parseISO(targetIso);
  const monthsForward = differenceInCalendarMonths(target, new Date());
  for (let i = 0; i < monthsForward; i++) {
    await page.getByTestId('calendar-next').click();
  }
}

/** The workflow states table of docs/spec/index.md §3, with its default `[C]` values. */
const BOARD_STATES = [
  { key: 'anfrage', label: 'Anfrage', type: 'action', agingDays: 3, tier: 1 },
  { key: 'angebot', label: 'Angebot', type: 'buffer', agingDays: 14, tier: 3 },
  { key: 'beauftragt', label: 'Beauftragt', type: 'action', agingDays: 5, tier: 1 },
  { key: 'geplant', label: 'Geplant', type: 'buffer', agingDays: 21, tier: 2 },
  { key: 'in_arbeit', label: 'In Arbeit', type: 'active', agingDays: undefined, tier: 2 },
  { key: 'abnahme', label: 'Abnahme', type: 'buffer', agingDays: 7, tier: 2 },
  { key: 'rechnung_faellig', label: 'Rechnung fällig', type: 'action', agingDays: 3, tier: 1 },
  { key: 'abgerechnet', label: 'Abgerechnet', type: 'buffer', agingDays: 30, tier: 3 },
  { key: 'erledigt', label: 'Erledigt', type: 'done', agingDays: undefined, tier: 3 },
] as const;
type BoardState = (typeof BOARD_STATES)[number];

interface ApiProject {
  id: string;
  number: string;
  status: string;
  statusChangedAt: string;
}

/** Calendar days since the project entered its state. */
function daysInState(project: ApiProject): number {
  return differenceInCalendarDays(new Date(), parseISO(project.statusChangedAt));
}

interface DatedApiProject extends ApiProject {
  plannedStart: string | null;
  plannedEnd: string | null;
}

/** The widest viewport AC-474 calls narrow; one pixel more is wide (AC-473). */
const NARROW_MAX_WIDTH = 768;

/** AC-468's default display format, DD.MM.YYYY; `short` drops the year. */
function displayDate(iso: string, short = false): string {
  return format(parseISO(iso), short ? 'dd.MM.' : 'dd.MM.yyyy');
}

/** A timestamp's date in the company's zone (Germany), as DD.MM.YYYY. */
function displayTimestampDate(iso: string): string {
  return new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(iso));
}

/**
 * The calendar days a project's bars cover: each bar segment covers the day
 * cells of its week row whose horizontal centre lies within the bar.
 */
async function calendarDaysCovered(page: Page, projectId: string): Promise<string[]> {
  return page.evaluate((id) => {
    const covered = new Set<string>();
    for (const bar of document.querySelectorAll(`[data-testid="calendar-bar-${id}"]`)) {
      const b = bar.getBoundingClientRect();
      for (const cell of bar.parentElement!.querySelectorAll('[data-testid^="calendar-day-"]')) {
        const c = cell.getBoundingClientRect();
        const centre = c.left + c.width / 2;
        if (centre >= b.left && centre <= b.right) {
          covered.add(cell.getAttribute('data-testid')!.slice('calendar-day-'.length));
        }
      }
    }
    return [...covered].sort();
  }, projectId);
}

/** The calendar's week rows, each as its days' ISO dates from left to right. */
async function calendarWeekRows(page: Page): Promise<string[][]> {
  return page.getByTestId('calendar-grid').evaluate((grid) => {
    const rows = new Map<Element, { left: number; iso: string }[]>();
    for (const cell of grid.querySelectorAll('[data-testid^="calendar-day-"]')) {
      const row = rows.get(cell.parentElement!) ?? [];
      row.push({
        left: cell.getBoundingClientRect().left,
        iso: cell.getAttribute('data-testid')!.slice('calendar-day-'.length),
      });
      rows.set(cell.parentElement!, row);
    }
    return [...rows.values()].map((row) =>
      row.sort((a, b) => a.left - b.left).map((cell) => cell.iso),
    );
  });
}

/** Every date from `start` to `end`, inclusive, as ISO dates. */
function isoDaysBetween(start: string, end: string): string[] {
  return eachDayOfInterval({ start: parseISO(start), end: parseISO(end) }).map((d) =>
    format(d, 'yyyy-MM-dd'),
  );
}

// Run this file's tests serially within a single worker. The suite has
// no DB reset between tests and every test operates on the same seeded
// geplant card (via `.first()`), so parallel workers racing on writes
// produce flaky "last-write-wins" failures — the date-mutation tests in
// particular would see each other's values after `page.reload()`, and
// the net-zero state-transition teardown established in d9d8203 only
// covers the forward/backward tests. Serial mode is a narrow constraint
// (tests in other files still parallelize), and it pairs with
// `fullyParallel: true` at the config level.
test.describe.configure({ mode: 'serial' });

test.describe('Kanban board flows', () => {
  test.beforeEach(async ({ page }) => {
    // Auth is supplied by the shared storageState (see auth.setup.ts);
    // all we need here is the initial navigation so every test starts
    // from a freshly loaded board. The visibility assertion pins the
    // pre-condition that the authenticated render actually succeeded.
    await page.goto('/');
    await expect(page.getByTestId('kanban-board')).toBeVisible();
  });

  test.describe('Kanban board render', () => {
    test('walks the board ACs', async ({ page }) => {
      // The API is the oracle for each card's state and entry date, so the
      // flow holds whatever earlier specs did to the seeded projects.
      const res = await page.request.get('/api/projects');
      expect(res.ok(), `GET /api/projects returned ${res.status()}`).toBe(true);
      const { data } = (await res.json()) as { data: ApiProject[] };
      const projectById = new Map(data.map((p) => [p.id, p]));
      await expect(page.locator('[data-testid^="project-card-"]').first()).toBeVisible();

      const cardsByState = new Map<string, ApiProject[]>();
      for (const state of BOARD_STATES) {
        const ids = await page
          .getByTestId(`kanban-column-${state.key}`)
          .locator('[data-testid^="project-card-"]')
          .evaluateAll((els) =>
            els.map((el) => el.getAttribute('data-testid')!.slice('project-card-'.length)),
          );
        cardsByState.set(
          state.key,
          ids.map((id) => {
            const project = projectById.get(id);
            expect(project, `card ${id} is not in GET /api/projects`).toBeDefined();
            return project!;
          }),
        );
      }
      const cards = BOARD_STATES.flatMap((state) =>
        cardsByState.get(state.key)!.map((project) => ({ state, project })),
      );
      const isAged = (state: BoardState, project: ApiProject) =>
        state.agingDays !== undefined && daysInState(project) >= state.agingDays;

      await test.step('AC-452 one column per state, in workflow order', async () => {
        const keys = await page
          .locator('[data-testid^="kanban-column-"]')
          .evaluateAll((els) =>
            els.map((el) => el.getAttribute('data-testid')!.slice('kanban-column-'.length)),
          );
        expect(keys).toEqual(BOARD_STATES.map((s) => s.key));
        for (const state of BOARD_STATES) {
          await expect(page.getByTestId(`column-header-${state.key}`)).toContainText(state.label);
        }
      });

      await test.step('AC-11 action columns are distinct from buffer columns', async () => {
        const background = (key: string) =>
          page
            .getByTestId(`kanban-column-${key}`)
            .evaluate((el) => getComputedStyle(el).backgroundColor);
        const ofType = (type: BoardState['type']) =>
          Promise.all(BOARD_STATES.filter((s) => s.type === type).map((s) => background(s.key)));
        const [action, buffer] = await Promise.all([ofType('action'), ofType('buffer')]);
        for (const a of action) {
          for (const b of buffer) expect(a).not.toBe(b);
        }
      });

      await test.step('AC-453 each card sits in the column of its state', async () => {
        expect(cards.length).toBeGreaterThan(0);
        for (const { state, project } of cards) {
          expect(project.status, `card ${project.number}`).toBe(state.key);
        }
      });

      await test.step('AC-454 cards are ordered by entry date, oldest first', async () => {
        const orderable = BOARD_STATES.some(
          (s) => new Set(cardsByState.get(s.key)!.map((p) => p.statusChangedAt)).size > 1,
        );
        expect(orderable, 'needs a column with two entry dates').toBe(true);
        for (const state of BOARD_STATES) {
          const entered = cardsByState.get(state.key)!.map((p) => p.statusChangedAt);
          const oldestFirst = [...entered].sort((a, b) => Date.parse(a) - Date.parse(b));
          expect(entered, `column ${state.key}`).toEqual(oldestFirst);
        }
      });

      await test.step('AC-460 transition buttons only where the transition is allowed', async () => {
        for (const key of ['anfrage', 'erledigt']) {
          expect(cardsByState.get(key)!.length, `needs a card in ${key}`).toBeGreaterThan(0);
        }
        for (const { state, project } of cards) {
          const forward = state.key === 'erledigt' ? 0 : 1;
          const backward = state.key === 'anfrage' || state.key === 'erledigt' ? 0 : 1;
          await expect(page.getByTestId(`forward-button-${project.id}`)).toHaveCount(forward);
          await expect(page.getByTestId(`backward-button-${project.id}`)).toHaveCount(backward);
        }
      });

      await test.step('AC-461 entry date is bold from the aging threshold on', async () => {
        const aging = cards.filter(({ state }) => state.agingDays !== undefined);
        const aged = aging.map(({ state, project }) => isAged(state, project));
        expect(aged, 'needs aged and fresh cards').toContain(true);
        expect(aged, 'needs aged and fresh cards').toContain(false);
        for (const [i, { project }] of aging.entries()) {
          const weight = await page
            .getByTestId(`entry-date-${project.id}`)
            .evaluate((el) => Number(getComputedStyle(el).fontWeight));
          expect(weight >= 700, `card ${project.number} bold`).toBe(aged[i]);
        }
      });

      await test.step('AC-462 aged buffer cards show the days in their state', async () => {
        const buffer = cards.filter(({ state }) => state.type === 'buffer');
        const aged = buffer.map(({ state, project }) => isAged(state, project));
        expect(aged, 'needs aged and fresh buffer cards').toContain(true);
        expect(aged, 'needs aged and fresh buffer cards').toContain(false);
        for (const [i, { project }] of buffer.entries()) {
          const text = page.getByTestId(`aging-text-${project.id}`);
          if (aged[i]) await expect(text).toHaveText(`seit ${daysInState(project)} Tagen`);
          else await expect(text).toHaveCount(0);
        }
      });

      const agedCount = (state: BoardState) =>
        cardsByState.get(state.key)!.filter((p) => isAged(state, p)).length;
      const bufferStates = BOARD_STATES.filter((s) => s.type === 'buffer');

      await test.step('AC-463 expanded buffer header shows aged count and threshold', async () => {
        const counts = bufferStates.map(agedCount);
        expect(counts.some((n) => n > 0) && counts.includes(0), 'needs aged and fresh').toBe(true);
        for (const [i, state] of bufferStates.entries()) {
          const signal = page.getByTestId(`column-aged-${state.key}`);
          if (counts[i] > 0) {
            await expect(signal).toContainText(`${counts[i]}× seit mind. ${state.agingDays} Tagen`);
          } else {
            await expect(signal).toHaveCount(0);
          }
        }
      });

      await test.step('AC-470 too narrow a board collapses by tier, highest first', async () => {
        // Each width is below the room the expanded columns need (derived in
        // src/ui/kanban/useCollapseTier.ts); 1920 px fits all nine.
        for (const { width, fromTier } of [
          { width: 1920, fromTier: 4 },
          { width: 1600, fromTier: 3 },
          { width: 1200, fromTier: 2 },
          { width: 800, fromTier: 1 },
        ]) {
          await page.setViewportSize({ width, height: 1080 });
          for (const state of BOARD_STATES) {
            await expect(
              page.getByTestId(`kanban-column-${state.key}`),
              `${state.key} at ${width}px`,
            ).toBeVisible();
            await expect(
              page.getByTestId(`column-header-${state.key}`),
              `${state.key} at ${width}px`,
            ).toHaveCount(state.tier >= fromTier ? 0 : 1);
          }
        }
      });

      await test.step('AC-463 collapsed buffer column marks aged cards', async () => {
        // At 800 px every column is collapsed.
        for (const state of bufferStates) {
          const marker = page.getByTestId(`column-aged-${state.key}`);
          if (agedCount(state) > 0) await expect(marker).toBeVisible();
          else await expect(marker).toHaveCount(0);
        }
      });
    });

    test('clicking an expanded column header collapses it, and again expands it', async ({
      page,
    }) => {
      // AC-44. Regression: a column that is not auto-collapsed by the tier must
      // still toggle on header click. At 1920px viewport, tier is 0 and
      // all columns render expanded — the toggle is the user's only way
      // to collapse them. The expanded column renders the full header with
      // its `column-header-*` testid; the collapsed column renders only
      // the vertical strip (no such testid). Switching between those two
      // renderings is the observable proof that the toggle fires.
      const header = page.getByTestId('column-header-anfrage');
      const column = page.getByTestId('kanban-column-anfrage');
      await expect(header).toBeVisible();

      await header.click();
      await expect(header).toHaveCount(0);

      await column.click();
      await expect(page.getByTestId('column-header-anfrage')).toBeVisible();
    });

    test('scrolls a board wider than the viewport to its last column', async ({ page }) => {
      // AC-788. At 900px the tiers collapse columns; expanding every one
      // makes the board wider than the viewport. A horizontal wheel — not
      // scrollIntoView, which also moves an overflow-hidden board — proves
      // the user can reach the last column.
      await page.setViewportSize({ width: 900, height: 900 });
      // At 900px (tier 1) every column collapses; Angebot's collapse shows
      // the tier applied.
      await expect(page.getByTestId('column-header-angebot')).toHaveCount(0);
      const states = [
        'anfrage',
        'angebot',
        'beauftragt',
        'geplant',
        'in_arbeit',
        'abnahme',
        'rechnung_faellig',
        'abgerechnet',
        'erledigt',
      ];
      for (const state of states) {
        const header = page.getByTestId(`column-header-${state}`);
        if ((await header.count()) === 0) {
          await page.getByTestId(`kanban-column-${state}`).click();
          await expect(header).toBeVisible();
        }
      }
      const last = page.getByTestId('kanban-column-erledigt');
      await expect(last).not.toBeInViewport({ ratio: 1 });

      await page.getByTestId('column-header-anfrage').hover();
      await page.mouse.wheel(10_000, 0);
      await expect(last).toBeInViewport({ ratio: 1 });
    });
  });

  test.describe('State transitions', () => {
    // Net-zero teardown note: the kanban-flows suite has no DB reset
    // between tests (playwright.config.ts has no globalSetup, and the
    // web server is reused across tests). Each mutating test must
    // restore the seed state it touched — otherwise a later test that
    // picks a `.first()` card from the same column gets a different
    // card than the seed promises, cascading into count-assertion
    // failures that look unrelated to the real cause.
    // Read the integer count displayed in a column-count badge. Returned
    // as a number so the assertion can express transitions relative to
    // the count seen at test start — earlier mutating suites in the
    // serial bucket (invoices, daten-jobs) reshape the
    // seed before kanban-flows runs, so pinning to a literal "2" / "3"
    // is brittle.
    async function readColumnCount(page: Page, status: string) {
      const text = await page.getByTestId(`column-count-${status}`).textContent();
      return Number((text ?? '').trim());
    }

    test('advances a card via the forward button and confirmation', async ({ page }) => {
      // Transitions live on the Kanban card only — the detail panel
      // carries no forward / backward buttons.
      const initialGeplant = await readColumnCount(page, 'geplant');

      const geplantColumn = page.getByTestId('kanban-column-geplant');
      const geplantCard = geplantColumn.locator('[data-testid^="project-card-"]').first();
      const cardTestId = await geplantCard.getAttribute('data-testid');
      const projectId = cardTestId!.replace('project-card-', '');

      // AC-457: the forward dialog names the current and target state.
      await geplantCard.getByTestId(`forward-button-${projectId}`).click();
      const forwardDialog = page.getByTestId('confirm-dialog');
      await expect(forwardDialog).toBeVisible();
      await expect(forwardDialog).toContainText('Geplant → In Arbeit');
      await page.getByTestId('confirm-ok').click();
      await expect(forwardDialog).not.toBeVisible();

      // Verify the card is now in the "In Arbeit" column.
      const movedCard = page
        .getByTestId('kanban-column-in_arbeit')
        .getByTestId(`project-card-${projectId}`);
      await expect(movedCard).toBeVisible();
      await expect(page.getByTestId('column-count-geplant')).toHaveText(String(initialGeplant - 1));

      // Net-zero teardown: move the card back to geplant via the backward
      // arrow so later tests see the seed column counts restored.
      await movedCard.getByTestId(`backward-button-${projectId}`).click();
      const backwardDialog = page.getByTestId('confirm-dialog');
      await expect(backwardDialog).toBeVisible();
      await page.getByTestId('confirm-ok').click();
      await expect(backwardDialog).not.toBeVisible();
      await expect(
        page.getByTestId('kanban-column-geplant').getByTestId(`project-card-${projectId}`),
      ).toBeVisible();
      await expect(page.getByTestId('column-count-geplant')).toHaveText(String(initialGeplant));
    });

    test('moves a card backward from the Kanban card', async ({ page }) => {
      // Net-zero by construction: this test forwards then backs the
      // SAME card, so it restores its starting column regardless of
      // execution order.
      const initialGeplant = await readColumnCount(page, 'geplant');
      const initialRechnungFaellig = await readColumnCount(page, 'rechnung_faellig');

      // Set up: advance a geplant card so we have something to move back.
      const geplantColumn = page.getByTestId('kanban-column-geplant');
      const geplantCard = geplantColumn.locator('[data-testid^="project-card-"]').first();
      const cardTestId = await geplantCard.getAttribute('data-testid');
      const projectId = cardTestId!.replace('project-card-', '');

      await geplantCard.getByTestId(`forward-button-${projectId}`).click();
      await expect(page.getByTestId('confirm-dialog')).toBeVisible();
      await page.getByTestId('confirm-ok').click();
      const movedCard = page
        .getByTestId('kanban-column-in_arbeit')
        .getByTestId(`project-card-${projectId}`);
      await expect(movedCard).toBeVisible();

      // AC-457: the backward dialog names the current and target state.
      await movedCard.getByTestId(`backward-button-${projectId}`).click();
      const backwardDialog = page.getByTestId('confirm-dialog');
      await expect(backwardDialog).toBeVisible();
      await expect(backwardDialog).toContainText('In Arbeit → Geplant');
      await page.getByTestId('confirm-ok').click();
      await expect(backwardDialog).not.toBeVisible();

      // Verify the card is back in the "Geplant" column
      await expect(
        page.getByTestId('kanban-column-geplant').getByTestId(`project-card-${projectId}`),
      ).toBeVisible();

      // Geplant count restored to its pre-mutation value.
      await expect(page.getByTestId('column-count-geplant')).toHaveText(String(initialGeplant));

      // Cross-feature invariance: an unrelated state transition must
      // leave the rechnung_faellig column count untouched.
      await expect(page.getByTestId('column-count-rechnung_faellig')).toHaveText(
        String(initialRechnungFaellig),
      );
    });
  });

  test.describe('Detail panel date editing', () => {
    test('updates the planned end date and persists it', async ({ page }) => {
      // AC-7: Changing a date updates plannedEnd and persists
      // Both geplant projects have dates from seed data — only end date is changed.
      const geplantColumn = page.getByTestId('kanban-column-geplant');
      const geplantCard = geplantColumn.locator('[data-testid^="project-card-"]').first();
      await geplantCard.click();
      await expect(page.getByTestId('detail-panel')).toBeVisible();

      // Wait for the PATCH to land before moving on, otherwise the next steps
      // may race the optimistic update against the actual server commit.
      // This test uses offset 10; the other date-mutation tests in this file
      // pick different offsets so two tests editing the same seeded card
      // don't write the same value (which would make `fill()` a no-op
      // and stall the `waitForResponse` below). Offset must exceed the
      // seed's largest geplant `plannedStartDays` (8) — see the
      // `pickPlannedEndDate` doc comment.
      const plannedEndDate = pickPlannedEndDate(10);
      const endDateInput = page.getByTestId('detail-date-end');
      // Dates commit on blur (not change) — intermediate empty values
      // emitted by native `<input type="date">` during keyboard edits
      // would otherwise clobber the other date. fill() + blur()
      // matches a real user leaving the field.
      await endDateInput.fill(plannedEndDate.iso);
      await Promise.all([
        page.waitForResponse(
          (r) => /\/api\/projects\/[^/]+\/dates$/.test(r.url()) && r.request().method() === 'PATCH',
        ),
        endDateInput.blur(),
      ]);

      await expect(endDateInput).toHaveValue(plannedEndDate.iso);
    });
  });

  test.describe('Calendar view', () => {
    test('walks the calendar and panel ACs', async ({ page, browser }) => {
      // Fixtures are created here, not taken from the seed, so each case
      // exists whatever earlier specs did; `GET /api/projects` is the oracle
      // for the counts. The span and the start-only block sit in the current
      // month (the calendar opens on it); the span crosses a week boundary.
      // The cross-year range is for the board's date format.
      const today = new Date();
      const iso = (d: Date) => format(d, 'yyyy-MM-dd');
      const spanStart = iso(setDate(today, 10));
      const spanEnd = iso(setDate(today, 18));
      const blockStart = iso(setDate(today, 20));
      const crossYearStart = `${today.getFullYear()}-12-28`;
      const crossYearEnd = `${today.getFullYear() + 1}-01-03`;

      const stamp = Date.now() % 1_000_000_000;
      const customer = await page.request.post('/api/customers', {
        data: { name: `Kalender ${stamp}` },
      });
      expect(customer.ok(), `customer POST ${customer.status()}`).toBe(true);
      const customerId = (await customer.json()).id as string;
      const created: string[] = [];
      const create = async (
        suffix: string,
        dates: { plannedStart?: string; plannedEnd?: string },
      ) => {
        const res = await page.request.post('/api/projects', {
          data: {
            number: `KAL-${stamp}-${suffix}`,
            title: `Kalender ${suffix}`,
            customerId,
            ...dates,
          },
        });
        expect(res.ok(), `project ${suffix} POST ${res.status()}`).toBe(true);
        const id = (await res.json()).id as string;
        created.push(id);
        return id;
      };
      const fetchProjects = async () => {
        const res = await page.request.get('/api/projects');
        expect(res.ok(), `GET /api/projects returned ${res.status()}`).toBe(true);
        return ((await res.json()) as { data: DatedApiProject[] }).data;
      };

      try {
        const span = await create('S', { plannedStart: spanStart, plannedEnd: spanEnd });
        const block = await create('B', { plannedStart: blockStart });
        const crossYear = await create('Y', {
          plannedStart: crossYearStart,
          plannedEnd: crossYearEnd,
        });
        const undated = await create('U', {});
        // A second state on the calendar for AC-12.
        const moved = await page.request.post(`/api/projects/${block}/transition/forward`, {
          data: { expectedStatus: 'anfrage' },
        });
        expect(moved.ok(), `transition ${moved.status()}`).toBe(true);

        await page.reload();
        await expect(page.getByTestId(`project-card-${undated}`)).toBeVisible();
        const projects = await fetchProjects();
        const projectById = new Map(projects.map((p) => [p.id, p]));
        const cards = page.locator('[data-testid^="project-card-"]');
        const panel = page.getByTestId('detail-panel');
        const openCalendar = async () => {
          await page.getByTestId('view-toggle-kalender').click();
          await expect(page.getByTestId('calendar-view')).toBeVisible();
        };

        await test.step('AC-468 dates show as DD.MM.YYYY, a one-year range with a short start', async () => {
          await expect(page.getByTestId(`card-dates-${span}`)).toHaveText(
            `${displayDate(spanStart, true)} – ${displayDate(spanEnd)}`,
          );
          await expect(page.getByTestId(`card-dates-${crossYear}`)).toHaveText(
            `${displayDate(crossYearStart)} – ${displayDate(crossYearEnd)}`,
          );
          await expect(page.getByTestId(`card-dates-${block}`)).toHaveText(displayDate(blockStart));
          for (const id of [span, block, crossYear, undated]) {
            await expect(page.getByTestId(`entry-date-${id}`)).toHaveText(
              displayTimestampDate(projectById.get(id)!.statusChangedAt),
            );
          }
        });

        await test.step('AC-473 a click on a board card opens the panel over the board', async () => {
          await page.getByTestId(`project-card-${span}`).click();
          await expect(panel).toBeVisible();
          await expect(panel).toContainText(projectById.get(span)!.number);
          await expect(page.getByTestId('kanban-board')).toBeVisible();
          await expect(page.getByTestId('project-detail-page')).toHaveCount(0);
        });

        await test.step('AC-761 a click outside the panel closes it', async () => {
          const box = (await panel.boundingBox())!;
          const outside = { x: box.x / 2, y: page.viewportSize()!.height / 2 };
          expect(outside.x, 'the click point lies left of the panel').toBeLessThan(box.x);
          await page.mouse.click(outside.x, outside.y);
          await expect(panel).toHaveCount(0);
        });

        await test.step('AC-12 a state has one colour on card dots, calendar bars and the badge', async () => {
          const dotColor = await page
            .locator('[data-testid^="card-dot-"]')
            .evaluateAll((els) =>
              els.map(
                (el) =>
                  [
                    el.getAttribute('data-testid')!.slice('card-dot-'.length),
                    getComputedStyle(el).backgroundColor,
                  ] as const,
              ),
            );
          const stateColor = new Map<string, string>();
          for (const [id, color] of dotColor) {
            const state = projectById.get(id)!.status;
            expect(color, `dot of ${projectById.get(id)!.number} (${state})`).toBe(
              stateColor.get(state) ?? color,
            );
            stateColor.set(state, color);
          }

          await openCalendar();
          await expect(page.getByTestId(`calendar-bar-${block}`).first()).toBeVisible();
          const bars = await page.locator('[data-testid^="calendar-bar-"]').evaluateAll((els) =>
            els.map((el) => ({
              id: el.getAttribute('data-testid')!.slice('calendar-bar-'.length),
              color: getComputedStyle(el).backgroundColor,
            })),
          );
          const barStates = new Map<string, string>();
          for (const { id, color } of bars) {
            const state = projectById.get(id)!.status;
            expect(color, `bar of ${projectById.get(id)!.number}`).toBe(stateColor.get(state));
            barStates.set(state, id);
          }
          expect(barStates.size, 'needs bars in two states').toBeGreaterThanOrEqual(2);
          for (const [state, id] of barStates) {
            await page.getByTestId(`calendar-bar-${id}`).first().click();
            await expect(page.getByTestId('detail-status-badge')).toHaveCSS(
              'background-color',
              stateColor.get(state)!,
            );
            await page.getByTestId('detail-close').click();
            await expect(panel).toHaveCount(0);
          }
        });

        await test.step('AC-469 calendar weeks start on Monday', async () => {
          const isWeekFromMonday = (row: string[]) => {
            expect(getDay(parseISO(row[0])), `weekday of the week starting ${row[0]}`).toBe(1);
            expect(row).toEqual(isoDaysBetween(row[0], iso(addDays(parseISO(row[0]), 6))));
          };
          const monthRows = await calendarWeekRows(page);
          expect(monthRows.length).toBeGreaterThanOrEqual(4);
          monthRows.forEach(isWeekFromMonday);

          await page.getByTestId('calendar-toggle-week').click();
          await expect(page.locator('[data-testid^="calendar-day-"]')).toHaveCount(7);
          const weekRows = await calendarWeekRows(page);
          weekRows.forEach(isWeekFromMonday);
          await page.getByTestId('calendar-toggle-month').click();
          await expect(page.getByTestId(`calendar-day-${spanStart}`)).toBeVisible();
        });

        await test.step('AC-455 a project with start and end is a bar spanning those dates', async () => {
          await expect(page.getByTestId(`calendar-bar-${span}`).first()).toBeVisible();
          expect(await calendarDaysCovered(page, span)).toEqual(isoDaysBetween(spanStart, spanEnd));
        });

        await test.step('AC-456 a start-only project is a one-day block on its start', async () => {
          await expect(page.getByTestId(`calendar-bar-${block}`)).toHaveCount(1);
          expect(await calendarDaysCovered(page, block)).toEqual([blockStart]);
        });

        const undatedCount = projects.filter((p) => !p.plannedStart && !p.plannedEnd).length;
        const counter = page.getByTestId('no-dates-counter');
        const banner = page.getByTestId('kanban-filter-banner');

        await test.step('AC-464 the calendar shows the count of projects without dates', async () => {
          expect(undatedCount).toBeGreaterThan(0);
          await expect(counter).toHaveText(`${undatedCount} Projekte ohne Termin`);
        });

        await test.step('AC-466 "Filter aufheben" removes the no-dates filter', async () => {
          await counter.click();
          await expect(banner).toBeVisible();
          await expect(cards).toHaveCount(undatedCount);
          await page.getByRole('button', { name: 'Filter aufheben' }).click();
          await expect(banner).toHaveCount(0);
          await expect(cards).toHaveCount(projects.length);
        });

        await test.step('AC-467 switching views removes the no-dates filter', async () => {
          await openCalendar();
          await counter.click();
          await expect(banner).toBeVisible();
          await openCalendar();
          await page.getByTestId('view-toggle-kanban').click();
          await expect(page.getByTestId('kanban-board')).toBeVisible();
          await expect(banner).toHaveCount(0);
          await expect(cards).toHaveCount(projects.length);
        });

        await test.step('AC-473 above 768 px a click on a calendar bar opens the panel', async () => {
          await openCalendar();
          await page.setViewportSize({ width: NARROW_MAX_WIDTH + 1, height: 1080 });
          await page.getByTestId(`calendar-bar-${span}`).first().click();
          await expect(panel).toBeVisible();
          await expect(panel).toContainText(projectById.get(span)!.number);
          await expect(page.getByTestId('calendar-view')).toBeVisible();
          await expect(page.getByTestId('project-detail-page')).toHaveCount(0);
          await page.getByTestId('detail-close').click();
          await expect(panel).toHaveCount(0);
          await page.setViewportSize({ width: 1920, height: 1080 });
        });

        await test.step('AC-472 back from the detail page shows the view the panel was on', async () => {
          await page.getByTestId(`calendar-bar-${block}`).click();
          await page.getByTestId('detail-open-page').click();
          await expect(page.getByTestId('project-detail-page')).toBeVisible();
          await expect(page).toHaveURL(new RegExp(`/projects/${block}$`));
          await page.goBack();
          await expect(page.getByTestId('calendar-view')).toBeVisible();
        });

        await test.step('AC-471 clearing the start in the panel clears the end too', async () => {
          await page.getByTestId(`calendar-bar-${span}`).first().click();
          const start = page.getByTestId('detail-date-start');
          const end = page.getByTestId('detail-date-end');
          await expect(start).toHaveValue(spanStart);
          await expect(end).toHaveValue(spanEnd);
          await start.fill('');
          const [patch] = await Promise.all([
            page.waitForResponse(
              (r) =>
                r.url().endsWith(`/api/projects/${span}/dates`) && r.request().method() === 'PATCH',
            ),
            start.blur(),
          ]);
          expect(patch.ok(), `PATCH dates ${patch.status()}`).toBe(true);
          await expect(start).toHaveValue('');
          await expect(end).toHaveValue('');
          const stored = (await fetchProjects()).find((p) => p.id === span)!;
          expect([stored.plannedStart, stored.plannedEnd]).toEqual([null, null]);
          await page.getByTestId('detail-close').click();
          await expect(page.getByTestId(`calendar-bar-${span}`)).toHaveCount(0);
        });

        await test.step('AC-474 at 768 px a click on a card or a bar opens the detail page', async () => {
          const context = await browser.newContext({
            storageState: STORAGE_STATES.owner,
            viewport: { width: NARROW_MAX_WIDTH, height: 1024 },
          });
          try {
            const phone = await context.newPage();
            await phone.goto('/kanban');
            // Below the tier widths the column is collapsed (AC-470); expand it.
            const header = phone.getByTestId('column-header-anfrage');
            await expect(phone.getByTestId('kanban-column-anfrage')).toBeVisible();
            if ((await header.count()) === 0)
              await phone.getByTestId('kanban-column-anfrage').click();
            await phone.getByTestId(`project-card-${crossYear}`).click();
            await expect(phone.getByTestId('project-detail-page')).toBeVisible();
            await expect(phone).toHaveURL(new RegExp(`/projects/${crossYear}$`));
            await expect(phone.getByTestId('detail-panel')).toHaveCount(0);

            await phone.goto('/calendar');
            await phone.getByTestId(`calendar-bar-${block}`).click();
            await expect(phone.getByTestId('project-detail-page')).toBeVisible();
            await expect(phone).toHaveURL(new RegExp(`/projects/${block}$`));
            await expect(phone.getByTestId('detail-panel')).toHaveCount(0);
          } finally {
            await context.close();
          }
        });
      } finally {
        // Archive the fixtures so later tests see the board they expect.
        for (const id of created) {
          const res = await page.request.delete(`/api/projects/${id}`);
          // Soft: a failed cleanup must not mask the failing AC step.
          expect.soft(res.ok(), `archive ${id}: ${res.status()}`).toBe(true);
        }
      }
    });

    test('shows the updated date bar after a detail-panel edit', async ({ page }) => {
      // Set up: pick a geplant project and change its end date (mirrors the
      // precondition from the original smoke test that fed this calendar check).
      const geplantColumn = page.getByTestId('kanban-column-geplant');
      const geplantCard = geplantColumn.locator('[data-testid^="project-card-"]').first();
      await geplantCard.click();

      const cardTestId = await geplantCard.getAttribute('data-testid');
      const projectId = cardTestId!.replace('project-card-', '');

      const detailPanel = page.getByTestId('detail-panel');
      await expect(detailPanel).toBeVisible();

      // Offset 11 — see `pickPlannedEndDate` and the matching note in the
      // "updates the planned end date" test above for why each date-
      // mutation test needs a unique offset.
      const plannedEndDate = pickPlannedEndDate(11);
      const endDateInput = page.getByTestId('detail-date-end');
      // Dates commit on blur — fill sets the value, blur fires the
      // PATCH the test is waiting on.
      await endDateInput.fill(plannedEndDate.iso);
      await Promise.all([
        page.waitForResponse(
          (r) => /\/api\/projects\/[^/]+\/dates$/.test(r.url()) && r.request().method() === 'PATCH',
        ),
        endDateInput.blur(),
      ]);

      // The calendar shows the project with its updated dates.
      await page.getByTestId('detail-close').click();
      await expect(detailPanel).not.toBeVisible();

      const calendarToggle = page.getByTestId('view-toggle-kalender');
      await calendarToggle.click();
      await expect(page.getByTestId('calendar-view')).toBeVisible();
      await expect(page.getByTestId('calendar-grid')).toBeVisible();
      // Calendar opens on today's month; if the offset crosses the
      // boundary, advance until the target month is in view. No-op when
      // already on the right month (e.g. mid-month runs).
      await navigateCalendarToMonthOf(page, plannedEndDate.iso);
      // The project bar should be visible with the updated date
      const calendarBar = page.getByTestId(`calendar-bar-${projectId}`).first();
      await expect(calendarBar).toBeVisible();
      await expect(page.getByTestId(plannedEndDate.testId)).toBeVisible();
    });

    test('filters to projects without dates via the calendar counter', async ({ page }) => {
      // Grab a geplant card ID — geplant projects have dates in seed data, so
      // this specific card must NOT show up once the dateless filter is applied.
      const geplantColumn = page.getByTestId('kanban-column-geplant');
      const geplantCard = geplantColumn.locator('[data-testid^="project-card-"]').first();
      const cardTestId = await geplantCard.getAttribute('data-testid');
      const projectId = cardTestId!.replace('project-card-', '');

      // Open calendar view where the "Projekte ohne Termin" counter lives.
      await page.getByTestId('view-toggle-kalender').click();
      await expect(page.getByTestId('calendar-view')).toBeVisible();

      // The "X Projekte ohne Termin" counter below the calendar.
      const noDatesCounter = page.getByTestId('no-dates-counter');
      await expect(noDatesCounter).toBeVisible();
      await expect(noDatesCounter).toContainText('Projekte ohne Termin');
      await noDatesCounter.click();

      // AC-465: back on Kanban, filtered to projects without dates.
      // The geplant card has dates — it must NOT appear in the dateless filter.
      await expect(page.getByTestId('kanban-board')).toBeVisible();
      await expect(page.getByTestId(`project-card-${projectId}`)).not.toBeVisible();
      // Verify dateless projects are actually shown, and only those
      const visibleCards = page.locator('[data-testid^="project-card-"]');
      const cardCount = await visibleCards.count();
      expect(cardCount).toBeGreaterThan(0);
      const cardDates = page.locator('[data-testid^="card-dates-"]');
      await expect(cardDates).toHaveCount(cardCount);
      for (const dates of await cardDates.all()) {
        await expect(dates).toHaveText('Kein Termin');
      }
    });
  });

  test.describe('Session and navigation', () => {
    test('persists the user and mutations across a page refresh', async ({ page }) => {
      // Set up: perform a state transition and a date edit so both kinds of
      // mutation have something to verify post-reload.
      const geplantColumn = page.getByTestId('kanban-column-geplant');
      const geplantCard = geplantColumn.locator('[data-testid^="project-card-"]').first();
      const cardTestId = await geplantCard.getAttribute('data-testid');
      const projectId = cardTestId!.replace('project-card-', '');

      // Forward transition: geplant → in_arbeit (via the card arrow —
      // transitions moved off the detail panel).
      await geplantCard.getByTestId(`forward-button-${projectId}`).click();
      await expect(page.getByTestId('confirm-dialog')).toBeVisible();
      await page.getByTestId('confirm-ok').click();
      const movedCard = page
        .getByTestId('kanban-column-in_arbeit')
        .getByTestId(`project-card-${projectId}`);
      await expect(movedCard).toBeVisible();

      // Move back to geplant so we can edit its planned end date.
      await movedCard.getByTestId(`backward-button-${projectId}`).click();
      await expect(page.getByTestId('confirm-dialog')).toBeVisible();
      await page.getByTestId('confirm-ok').click();
      const restoredCard = page
        .getByTestId('kanban-column-geplant')
        .getByTestId(`project-card-${projectId}`);
      await expect(restoredCard).toBeVisible();

      // Open the detail panel for the date-edit step.
      await restoredCard.click();
      await expect(page.getByTestId('detail-panel')).toBeVisible();

      // Edit the planned end date. Offset 12 — see `pickPlannedEndDate`
      // for why each date-mutation test uses a unique offset. Commit
      // on blur, not on change (see the other detail-date-end test).
      const plannedEndDate = pickPlannedEndDate(12);
      const endDateInput = page.getByTestId('detail-date-end');
      await endDateInput.fill(plannedEndDate.iso);
      await Promise.all([
        page.waitForResponse(
          (r) => /\/api\/projects\/[^/]+\/dates$/.test(r.url()) && r.request().method() === 'PATCH',
        ),
        endDateInput.blur(),
      ]);
      await page.getByTestId('detail-close').click();

      // AC-458 / AC-7: the stored state and the date change survive a reload
      await page.reload();

      // AC-395: user is still authenticated — Kanban loads, not login screen
      await expect(page.getByTestId('kanban-board')).toBeVisible();
      await expect(page.getByTestId('login-form')).not.toBeVisible();

      // Display name still in header
      await expect(page.getByTestId('user-indicator')).toContainText('Thomas Berger');

      // Verify state transition persisted: project should still be in "Geplant" column
      await expect(
        page.getByTestId('kanban-column-geplant').getByTestId(`project-card-${projectId}`),
      ).toBeVisible();

      // The date change persisted — verify via detail panel. Use the same
      // computed date as the edit so this assertion does not become stale as
      // the calendar moves.
      await page.getByTestId(`project-card-${projectId}`).click();
      await expect(page.getByTestId('detail-panel')).toBeVisible();
      await expect(page.getByTestId('detail-date-end')).toHaveValue(plannedEndDate.iso);
    });

    test('back button does not leak project data after logout', async ({ browser }) => {
      // This test must own its own browser context and its own session —
      // it logs out via the UI, which destroys the server-side session
      // behind the shared storageState cookie. If we consumed the shared
      // `page` fixture here, parallel workers running other tests would
      // suddenly see `Sitzung abgelaufen` mid-flight because their
      // cookie is the same one we just invalidated. The whole point of
      // running Playwright with fullyParallel is that tests don't
      // interfere with each other — this test opts out of the shared
      // state by construction.
      const context = await browser.newContext({
        storageState: { cookies: [], origins: [] },
        viewport: { width: 1920, height: 1080 },
      });
      const page = await context.newPage();
      try {
        // Perform a dedicated login so we have our own session to kill.
        await page.goto('/');
        await page.getByTestId('login-username').fill('inhaber');
        await page.getByTestId('login-password').fill('changeme');
        await page.getByTestId('login-submit').click();
        await expect(page.getByTestId('kanban-board')).toBeVisible();

        // Discover a project ID we can later assert is gone from the DOM.
        const geplantColumn = page.getByTestId('kanban-column-geplant');
        const geplantCard = geplantColumn.locator('[data-testid^="project-card-"]').first();
        const cardTestId = await geplantCard.getAttribute('data-testid');
        const projectId = cardTestId!.replace('project-card-', '');

        // Navigate to the calendar view before logging out so the browser
        // has at least one traversable history entry to go back to. The
        // original monolithic smoke test covered AC-26 after many view
        // toggles, which incidentally supplied the history `goBack()`
        // expects — the split version was missing that setup, and
        // `page.goBack()` on a context with only the auto-redirect from
        // `/` to `/kanban` in its history is a no-op. The assertion
        // below still exercises AC-26: after logout the router must not
        // re-render project data for any historical URL.
        await page.getByTestId('view-toggle-kalender').click();
        await expect(page.getByTestId('calendar-view')).toBeVisible();
        await page.getByTestId('view-toggle-kanban').click();
        await expect(page.getByTestId('kanban-board')).toBeVisible();

        // AC-25: Clicking "Abmelden" logs out and shows login screen
        await page.getByTestId('user-indicator').click();
        await page.getByTestId('logout-button').click();

        await expect(page.getByTestId('login-form')).toBeVisible();
        await expect(page.getByTestId('kanban-board')).not.toBeVisible();

        // AC-26: After logout, back button must not reveal project data
        await page.goBack();
        await expect(page.getByTestId('login-form')).toBeVisible();
        await expect(page.getByTestId('kanban-board')).not.toBeVisible();
        await expect(page.getByTestId(`project-card-${projectId}`)).not.toBeVisible();
      } finally {
        await context.close();
      }
    });
  });
});
