import { test, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { STORAGE_STATES } from './storage-states';
import { clickView } from './nav-helpers';
import { SEED_USERS } from '../src/test/seedAssumptions';

/**
 * E2E — app-shell live activity dock (AC-317 + AC-318).
 *
 * Pins the dock criteria from `docs/spec/verification.md §15.32`, a
 * privileged-only realtime consumer of the audit feed docked above the
 * Footer in the authenticated layout (ui/index.md §8.1.2):
 *
 *   - AC-317 [vis] — while EXPANDED, an audit event committed by ANOTHER
 *     session appears in the dock within 2 seconds with no manual refresh
 *     on the observing session, driven by the `audit_changed` SSE event
 *     (api.md §14.2.13) + a refetch of api.md §14.2.8. Parity with AC-277
 *     (project lifecycle) and AC-273 (storage usage). The multi-session
 *     "always-open observer" structure mirrors
 *     `storage-usage-multi-user.spec.ts` precisely: a long-lived office
 *     context (the observer) plus a one-shot owner request context for
 *     the mutation, with an `expect.poll({ timeout: 2_000 })` gate.
 *
 *   - AC-318 [vis] — the dock is collapsible and default-COLLAPSED; its
 *     collapse state PERSISTS across view navigation within a session (it
 *     does NOT reset on a view switch); it is DESKTOP-ONLY (hidden on
 *     phones, parity with the Footer media query at max-width:768px,
 *     AC-271); it exposes an "Ältere anzeigen" affordance to page older
 *     entries; and its default list is the caller's recipient-scoped set
 *     per AC-200.
 *
 * ── Testid contract (the implementer must provide these) ──────────────
 *   - `activity-dock`            — outer container; rendered ONLY for
 *                                  `audit:read` holders on desktop (AC-319).
 *   - `activity-dock-toggle`     — collapse/expand control.
 *   - `activity-dock-panel`      — expanded feed region; ABSENT/hidden
 *                                  when collapsed.
 *   - `activity-dock-load-older` — the "Ältere anzeigen" pager affordance.
 *   Individual entries REUSE the existing `ActivityFeed` row testid
 *   `activity-feed-row-<id>` (src/ui/audit/ActivityFeedRow.tsx) — the dock
 *   embeds the feed and must not invent a parallel entry testid.
 *
 * Auth: the office observer and the one-shot owner request context each
 * load a pre-authenticated storage state (e2e/auth.setup.ts) — no per-test
 * login, so the suite does not burn the dev-mode login rate limit.
 *
 * Runs under `chromium-mutating`: the AC-317 arm commits audit rows
 * (notification rule + project + assignment) that persist, so it must
 * serialize after the read-only specs. The `MUTATING_TESTS` regex in
 * `playwright.config.ts` matches `activity-dock`.
 */

/**
 * AC-317 propagation budget — the dock must reflect a cross-session audit
 * commit within this window, driven by the `audit_changed` SSE frame.
 * The 2 s poll timeout is the contractual gate (parity with AC-273/AC-277):
 * it resolves on the first refetch after the frame lands, and a regression
 * to a slow path (long-poll, 30 s reconnect) surfaces as a timeout here.
 */
const SSE_PROPAGATION_TIMEOUT_MS = 2_000;

/** Phone viewport — below the 768px Footer/dock breakpoint (AC-318/AC-271). */
const PHONE_VIEWPORT = { width: 390, height: 844 } as const;

/** Count the entry rows currently rendered inside the expanded dock panel. */
function dockRows(page: Page): Locator {
  // Reuse the ActivityFeed row testid (src/ui/audit/ActivityFeedRow.tsx)
  // rather than inventing a dock-specific one — the dock embeds the feed.
  return page.getByTestId('activity-dock-panel').locator('[data-testid^="activity-feed-row-"]');
}

/**
 * Expand the dock if it is collapsed, then wait for the panel to be
 * visible. The toggle is idempotent from the caller's view — callers
 * assert collapse/expand state explicitly elsewhere; this helper only
 * guarantees "panel open" as a precondition for row assertions.
 */
async function expandDock(page: Page): Promise<void> {
  const panel = page.getByTestId('activity-dock-panel');
  if (!(await panel.isVisible())) {
    await page.getByTestId('activity-dock-toggle').click();
  }
  await expect(panel).toBeVisible();
}

/**
 * Resolve a seeded user's id by username via an owner request context.
 * Owner holds `user:read`, so `GET /api/users` returns the full list
 * `{ users: [{ id, username, ... }], total }` (repositories/user.ts).
 * Used to target the office observer in the AC-200 recipient rule below.
 */
async function resolveUserId(context: BrowserContext, username: string): Promise<string> {
  const res = await context.request.get('/api/users?limit=200');
  expect(res.ok(), `GET /api/users failed: ${res.status()} ${await res.text()}`).toBe(true);
  const body = (await res.json()) as { users: { id: string; username: string }[] };
  const match = body.users.find((u) => u.username === username);
  if (!match) throw new Error(`seeded user not found: ${username}`);
  return match.id;
}

test.describe('AC-317: activity dock reflects a cross-session audit commit within 2s while expanded', () => {
  let officeContext: BrowserContext;
  let officePage: Page;
  /**
   * Id of the recipient rule created in the test body, hoisted to the
   * describe scope so `afterAll` can delete it. Recipient-scoping is
   * computed at read time against the current rule set, so a leftover
   * rule would silently widen office's scoped feed for any spec ordered
   * after this one — `afterAll` removes it to keep blocks decoupled.
   */
  let createdRuleId: string | null = null;

  test.beforeAll(async ({ browser }) => {
    officeContext = await browser.newContext({ storageState: STORAGE_STATES.office });
    officePage = await officeContext.newPage();
  });

  test.afterAll(async ({ browser }) => {
    await officeContext.close();
    if (createdRuleId) {
      const ownerContext = await browser.newContext({ storageState: STORAGE_STATES.owner });
      try {
        await ownerContext.request.delete(`/api/notification-rules/${createdRuleId}`);
      } finally {
        await ownerContext.close();
      }
    }
  });

  test('office observer sees an owner-committed audit row in the expanded dock within 2s, no manual refresh', async ({
    browser,
  }) => {
    // The office observer parks on /kanban and EXPANDS the dock. The whole
    // point of AC-317 is "without manual refresh" — after this initial
    // mount + expand, the new-row assertion is allowed to consume only the
    // SSE-driven refetch; no goto / reload / visibilitychange on the
    // observer below.
    await officePage.goto('/kanban');
    await expect(officePage.getByTestId('kanban-board')).toBeVisible();

    const dock = officePage.getByTestId('activity-dock');
    await expect(dock).toBeVisible();
    await expandDock(officePage);

    const rows = dockRows(officePage);
    // Snapshot the row ids visible before the cross-session mutation so the
    // poll asserts on a genuinely NEW entry, not just a count change — a
    // regression that re-renders the same set with a different length
    // (e.g. dedup churn) would otherwise pass an `> before` count gate.
    const beforeIds = new Set(
      await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid'))),
    );

    // ── Cross-session mutation (owner request context) ─────────────────
    // The dock defaults to the office caller's recipient-scoped set
    // (AC-200 / AC-318). Office is NOT a default recipient of any seed
    // rule (transition/assignment → assigned workers; archived/backup/disk
    // → owner; src/server/seed/notificationRules.ts), so an arbitrary
    // owner mutation would NOT surface in office's recipient-scoped dock.
    //
    // To drive a row office IS a recipient for, the owner context posts an
    // explicit `project.assignment_changed → userIds:[officeId]` rule, then
    // creates a project and assigns office to it — the resulting
    // `project_worker.create` audit row resolves to office under that rule
    // (mirrors the userIds arm of e2e/.. audit-recipient-scope coverage).
    // All three writes originate from the owner session, distinct from the
    // office observer, satisfying AC-317's "another session" clause.
    const ownerContext = await browser.newContext({ storageState: STORAGE_STATES.owner });
    try {
      const officeId = await resolveUserId(ownerContext, SEED_USERS.office.username);

      const ruleRes = await ownerContext.request.post('/api/notification-rules', {
        data: {
          eventClass: 'project.assignment_changed',
          recipientSpec: { roles: [], includeAssignedWorkers: false, userIds: [officeId] },
          enabled: true,
        },
      });
      expect(
        ruleRes.status(),
        `rule POST failed: ${ruleRes.status()} ${await ruleRes.text()}`,
      ).toBe(201);
      createdRuleId = (await ruleRes.json()).id as string;

      const custRes = await ownerContext.request.post('/api/customers', {
        data: { name: `AC-317 dock fixture ${Date.now()}` },
      });
      expect(custRes.ok(), `customer POST failed: ${custRes.status()}`).toBe(true);
      const customerId = (await custRes.json()).id as string;

      const projRes = await ownerContext.request.post('/api/projects', {
        data: {
          number: `AC317-${Date.now()}`,
          title: 'AC-317 dock fixture',
          customerId,
        },
      });
      expect(projRes.ok(), `project POST failed: ${projRes.status()}`).toBe(true);
      const projectId = (await projRes.json()).id as string;

      // The assignment is the audit-row-producing mutation: a
      // `project_worker.create` row whose recipient set includes office.
      const assignRes = await ownerContext.request.patch(`/api/projects/${projectId}`, {
        data: { assignedWorkerIds: [officeId] },
      });
      expect(
        assignRes.ok(),
        `assignment PATCH failed: ${assignRes.status()} ${await assignRes.text()}`,
      ).toBe(true);
    } finally {
      await ownerContext.close();
    }

    // The AC-317 gate: a NEW row appears in the expanded dock within the
    // propagation budget, driven solely by the `audit_changed` SSE frame +
    // the dock's refetch. The poll resolves on the first refetch after the
    // frame lands; a timeout means the realtime path regressed.
    await expect
      .poll(
        async () => {
          const ids = await rows.evaluateAll((els) =>
            els.map((e) => e.getAttribute('data-testid')),
          );
          return ids.some((id) => id !== null && !beforeIds.has(id));
        },
        {
          message:
            'expanded activity dock did not surface the cross-session audit row within the AC-317 budget',
          timeout: SSE_PROPAGATION_TIMEOUT_MS,
        },
      )
      .toBe(true);
  });
});

test.describe('AC-318: activity dock collapse default, session persistence, responsive posture, scope', () => {
  test.use({ storageState: STORAGE_STATES.office });

  test('default-collapsed: dock present but panel hidden on a fresh page', async ({ page }) => {
    await page.goto('/kanban');
    await expect(page.getByTestId('kanban-board')).toBeVisible();

    // The container is present (office holds audit:read), but the feed
    // region is hidden until the caller expands it — AC-318 "default-
    // collapsed". A toggle control is offered to expand.
    await expect(page.getByTestId('activity-dock')).toBeVisible();
    await expect(page.getByTestId('activity-dock-toggle')).toBeVisible();
    await expect(page.getByTestId('activity-dock-panel')).toBeHidden();
  });

  test('collapse state persists across view navigation within a session', async ({ page }) => {
    await page.goto('/kanban');
    await expect(page.getByTestId('kanban-board')).toBeVisible();

    const panel = page.getByTestId('activity-dock-panel');
    const toggle = page.getByTestId('activity-dock-toggle');

    // Expand, then navigate to another view — the dock must STAY expanded
    // (AC-318 "does not reset on a view switch"). A naive per-view remount
    // that re-reads the default would collapse here.
    await toggle.click();
    await expect(panel).toBeVisible();

    await page.getByTestId('view-toggle-kalender').click();
    await expect(page.getByTestId('calendar-view')).toBeVisible();
    await expect(panel).toBeVisible();

    // Now collapse, navigate again — the collapsed state must likewise
    // persist (both directions of the persisted state, not just expanded).
    await toggle.click();
    await expect(panel).toBeHidden();

    await page.getByTestId('view-toggle-kanban').click();
    await expect(page.getByTestId('kanban-board')).toBeVisible();
    await expect(panel).toBeHidden();
  });

  test('desktop-only: dock is hidden at phone viewport', async ({ page }) => {
    // Parity with the Footer media query (max-width:768px, AC-271):
    // phones reach the same history through the Aktivität view, so the
    // dock must not render. The default project viewport is desktop
    // (1920×1080); shrink to a phone to exercise the hidden branch.
    await page.setViewportSize({ width: PHONE_VIEWPORT.width, height: PHONE_VIEWPORT.height });
    await page.goto('/kanban');
    await expect(page.getByTestId('kanban-board')).toBeVisible();

    await expect(page.getByTestId('activity-dock')).toBeHidden();
  });

  test('default list is the full RBAC-scoped feed, NOT the recipient-scoped subset', async ({
    page,
  }) => {
    // AC-318 (revised): the dock fetches every audit row the caller may
    // read. Recipient-scoping is a notifications concern (AC-200) and
    // is exercised only on the Aktivität page via its "Alles anzeigen"
    // toggle — NOT on the dock. The dock surface is "everything the
    // caller may read", so a freshly written audit row (e.g. a project
    // create with no matching notification rule) must appear in the
    // dock even though no rule admits the viewer as a recipient.
    //
    // This case asserts only the wire shape: the dock's first audit
    // fetch must NOT carry `recipientScope=true`. The recipient-scope
    // narrowing machinery itself is pinned by the server integration
    // suite and by e2e/activity-recipient-scope.spec.ts for the
    // Aktivität page; this test stays focused on the dock's contract.
    await page.goto('/kanban');
    await expect(page.getByTestId('kanban-board')).toBeVisible();

    const auditFetch = page.waitForRequest(
      (req) => req.url().includes('/api/audit') && req.method() === 'GET',
    );
    await expandDock(page);
    const request = await auditFetch;
    expect(new URL(request.url()).searchParams.get('recipientScope')).toBeNull();
  });
});

/**
 * AC-318 — the "Ältere anzeigen" pager. Isolated in its own block
 * because it must MANUFACTURE its data: even with the dock now fetching
 * the full RBAC-scoped feed (AC-318 — no recipient narrowing), the
 * seed traffic under office's scope is below the default page size, so
 * `hasMore` is false and `ActivityFeed` renders no pager. The
 * `beforeAll` drives > the audit page size of audit rows visible to
 * office so the first page leaves older entries behind the pager. The
 * page-size literal is NOT hardcoded here — `activity-dock-load-older`
 * visibility IS the `hasMore` signal, so > the boundary is the only
 * thing the test relies on. The notification-rule POST below is a
 * residual from the recipient-scope era; under the new dock contract
 * it is a no-op but harmless and kept to minimise spec churn.
 */
test.describe('AC-318: activity dock "Ältere anzeigen" pages older entries', () => {
  test.use({ storageState: STORAGE_STATES.office });

  /**
   * Audit rows to manufacture for office. Above the server's default page
   * size (50, api.md §14.1 / AUDIT_PAGE_SIZE) so the recipient-scoped
   * dock's first page is full and the pager has a real boundary to cross.
   */
  const AUDIT_ROWS_TO_GENERATE = 56;

  let createdRuleId: string | null = null;

  test.beforeAll(async ({ browser }) => {
    const ownerContext = await browser.newContext({ storageState: STORAGE_STATES.owner });
    try {
      const officeId = await resolveUserId(ownerContext, SEED_USERS.office.username);

      // Recipient-scoping is computed at READ time against the current
      // rule set, so this single rule admits office to EVERY
      // `project.assignment_changed` row generated below.
      const ruleRes = await ownerContext.request.post('/api/notification-rules', {
        data: {
          eventClass: 'project.assignment_changed',
          recipientSpec: { roles: [], includeAssignedWorkers: false, userIds: [officeId] },
          enabled: true,
        },
      });
      expect(
        ruleRes.status(),
        `pager rule POST failed: ${ruleRes.status()} ${await ruleRes.text()}`,
      ).toBe(201);
      createdRuleId = (await ruleRes.json()).id as string;

      const custRes = await ownerContext.request.post('/api/customers', {
        data: { name: `AC-318 pager fixture ${Date.now()}` },
      });
      expect(custRes.ok(), `pager customer POST failed: ${custRes.status()}`).toBe(true);
      const customerId = (await custRes.json()).id as string;

      const projRes = await ownerContext.request.post('/api/projects', {
        data: { number: `AC318-${Date.now()}`, title: 'AC-318 pager fixture', customerId },
      });
      expect(projRes.ok(), `pager project POST failed: ${projRes.status()}`).toBe(true);
      const projectId = (await projRes.json()).id as string;

      // Each set-CHANGE of `assignedWorkerIds` writes one `project_worker`
      // create or delete row → one `assignment_changed` audit row. Starting
      // from no workers, alternate [officeId] ↔ [] so every PATCH is a real
      // change (a no-op PATCH writes nothing). Assigning office — a
      // non-worker — is a bare FK insert, valid per the assigned-workers
      // arm of `src/server/__tests__/audit-recipient-scope.test.ts`.
      for (let i = 0; i < AUDIT_ROWS_TO_GENERATE; i++) {
        const assignedWorkerIds = i % 2 === 0 ? [officeId] : [];
        const patchRes = await ownerContext.request.patch(`/api/projects/${projectId}`, {
          data: { assignedWorkerIds },
        });
        expect(
          patchRes.ok(),
          `pager assignment PATCH ${i} failed: ${patchRes.status()} ${await patchRes.text()}`,
        ).toBe(true);
      }
    } finally {
      await ownerContext.close();
    }
  });

  test.afterAll(async ({ browser }) => {
    if (!createdRuleId) return;
    const ownerContext = await browser.newContext({ storageState: STORAGE_STATES.owner });
    try {
      await ownerContext.request.delete(`/api/notification-rules/${createdRuleId}`);
    } finally {
      await ownerContext.close();
    }
  });

  test('"Ältere anzeigen" pages older entries — expanded dock count grows', async ({ page }) => {
    await page.goto('/kanban');
    await expect(page.getByTestId('kanban-board')).toBeVisible();
    await expandDock(page);

    const rows = dockRows(page);
    // The beforeAll manufactured > the page size of office-recipient-scoped
    // rows, so the first page leaves older entries behind the pager. The
    // pager affordance renders only when `hasMore` (ActivityFeed.tsx), so
    // its visibility is itself the > boundary assertion — no page-size
    // literal is hardcoded.
    const loadOlder = page.getByTestId('activity-dock-load-older');
    await expect(loadOlder).toBeVisible();
    const before = await rows.count();

    await loadOlder.click();
    // Appending older entries grows the rendered set (AC-318 pager). The
    // append-vs-replace semantics of the pager itself are pinned for the
    // shared feed by AC-185 (e2e/activity-feed.spec.ts); here we assert
    // only that the dock surfaces the pager and it grows the count, to
    // avoid duplicating that machinery (T-REDU).
    await expect.poll(async () => rows.count(), { timeout: 5_000 }).toBeGreaterThan(before);
  });
});

/**
 * AC-340 — global `Alt+A` shortcut. The shortcut is wired at the shell
 * (App.tsx via ActivityDock) so it works from any view; the focus-in-
 * input suppression is unit-tested in `useGlobalShortcut.test.tsx`.
 * This e2e pin asserts only the cross-view + preventDefault behaviour,
 * which JSDOM cannot honestly verify.
 */
test.describe('AC-340: Alt+A global toggle for the activity dock', () => {
  test.use({ storageState: STORAGE_STATES.office });

  test('Alt+A toggles the dock from Kanban — header hint is visible', async ({ page }) => {
    await page.goto('/kanban');
    await expect(page.getByTestId('kanban-board')).toBeVisible();

    const toggle = page.getByTestId('activity-dock-toggle');
    const panel = page.getByTestId('activity-dock-panel');

    // The hint is rendered inline next to the title — AC-340.
    await expect(toggle).toContainText('Aktivität');
    await expect(toggle).toContainText('(Alt+A)');

    // Collapsed by default — panel hidden via CSS.
    await expect(panel).toBeHidden();

    // First Alt+A → expand.
    await page.keyboard.press('Alt+a');
    await expect(panel).toBeVisible();

    // Second Alt+A → collapse.
    await page.keyboard.press('Alt+a');
    await expect(panel).toBeHidden();
  });
});

/**
 * AC-341 — the dock is hidden while Verwaltung → Aktivität is the
 * active view, since the page already renders the full audit table and
 * a second feed below it would be redundant.
 */
test.describe('AC-341: activity dock hidden on Verwaltung → Aktivität', () => {
  test.use({ storageState: STORAGE_STATES.office });

  test('dock is absent on /audit and reappears on navigation away', async ({ page }) => {
    await page.goto('/kanban');
    await expect(page.getByTestId('kanban-board')).toBeVisible();

    // Dock is present on Kanban.
    await expect(page.getByTestId('activity-dock')).toBeVisible();

    // Navigate to Verwaltung → Aktivität; dock disappears entirely.
    await clickView(page, 'aktivitaet');
    await expect(page.getByTestId('audit-list')).toBeVisible();
    await expect(page.getByTestId('activity-dock')).toBeHidden();

    // Alt+A on /audit is a no-op (handler suppressed). No element
    // appears, and navigation state is unchanged.
    await page.keyboard.press('Alt+a');
    await expect(page.getByTestId('activity-dock')).toBeHidden();

    // Back to Kanban → dock returns in its prior (collapsed) state.
    await clickView(page, 'kanban');
    await expect(page.getByTestId('activity-dock')).toBeVisible();
    await expect(page.getByTestId('activity-dock-panel')).toBeHidden();
  });
});
