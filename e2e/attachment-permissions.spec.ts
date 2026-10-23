import { test, expect } from '@playwright/test';
import { STORAGE_STATES } from './storage-states';

/**
 * Attachment role-gating smoke — the browser-observable slice of the
 * route-scoping + per-role visibility contract on the project detail
 * page (AC-507 deep-link, AC-121 hidden controls; the bookkeeper's
 * unscoped read and lack of hide per api.md §14.3). Server-layer contracts live in `src/server/__tests__/`.
 *
 * Runs under `chromium` (read-only). The spec does not persist any new
 * `attachment` rows — it only asserts visibility and navigation.
 *
 * Pre-seeded projects the test leans on (see
 * `src/server/seed/business.ts` ASSIGNMENT_SPECS):
 *   - suffix `-010` — `arbeiter2` only. `arbeiter1` is NOT assigned, so
 *     the worker-1 storage state gives us a "worker not on project"
 *     case to probe the not-permitted surface.
 *   - suffix `-007` — both `arbeiter1` and `arbeiter2`; usable by any
 *     role that reaches the page to exercise the read-only matrix.
 */

/**
 * Discover a project id by its number suffix. The assertion walks
 * Kanban as owner once (not in this spec's storage-state — we use the
 * request context to fetch the ids directly), but because `/api/projects`
 * is read-open to owner + office + bookkeeper, owner via a per-request
 * context is the cheapest source of truth.
 */
async function resolveProjectIdBySuffix(
  request: import('@playwright/test').APIRequestContext,
  suffix: string,
): Promise<string> {
  const res = await request.get('/api/projects');
  expect(res.ok(), `GET /api/projects returned ${res.status()}`).toBe(true);
  const body = (await res.json()) as { data: Array<{ id: string; number: string }> };
  const hit = body.data.find((p) => p.number.endsWith(suffix));
  expect(hit, `no seeded project with number ending in ${suffix}`).toBeDefined();
  return hit!.id;
}

test.describe('AC-507: unassigned worker deep-linking /projects/:id', () => {
  test.use({ storageState: STORAGE_STATES.worker });

  test('worker hitting a project they are not on lands on the not-permitted surface', async ({
    page,
    playwright,
  }) => {
    // Use a fresh owner-scoped request context to resolve the -010
    // project id (arbeiter2-only). The worker-1 storage state cannot
    // reach the full project list, so we pay one owner login to learn
    // the id, then navigate as the worker.
    const ownerCtx = await playwright.request.newContext({
      baseURL: test.info().project.use.baseURL,
      storageState: STORAGE_STATES.owner,
    });
    const unassignedId = await resolveProjectIdBySuffix(ownerCtx, '-010');
    await ownerCtx.dispose();

    await page.goto(`/projects/${unassignedId}`);

    // Unassigned worker → not-permitted view, URL stays put, no
    // detail-page content leaks (ui/project-detail.md §8.15 + AC-149
    // pattern — deep link to a forbidden path surfaces the explicit
    // not-permitted copy, URL unchanged).
    await expect(page.getByTestId('not-permitted-view')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/projects/${unassignedId}$`));
    await expect(page.getByTestId('project-detail-page')).toHaveCount(0);
  });
});

test.describe('AC-509 / AC-121: bookkeeper reads the detail page, cannot write', () => {
  test.use({ storageState: STORAGE_STATES.bookkeeper });

  test('bookkeeper lands on the page and sees gallery + binary list, no control surfaces', async ({
    page,
    playwright,
  }) => {
    const ownerCtx = await playwright.request.newContext({
      baseURL: test.info().project.use.baseURL,
      storageState: STORAGE_STATES.owner,
    });
    const projectId = await resolveProjectIdBySuffix(ownerCtx, '-007');
    await ownerCtx.dispose();

    await page.goto(`/projects/${projectId}`);

    // Bookkeeper reaches the page (holds `attachment:read` unscoped per
    // api.md §14.3).
    await expect(page.getByTestId('project-detail-page')).toBeVisible();
    await expect(page.getByTestId('not-permitted-view')).toHaveCount(0);

    // The gallery and binary list read surfaces render for bookkeeper
    // via the `attachmentScopeForCaller` unscoped branch.
    await expect(page.getByTestId('project-detail-photos')).toBeVisible();
    await expect(page.getByTestId('project-detail-binaries')).toBeVisible();

    // Bookkeeper holds `attachment:read` only (ui/project-detail.md
    // §8.15.6, api.md §14.3) — no upload CTA, no delete affordance, no
    // worker-editor control. Any of those rendering is the client-side
    // gate leaking state the server would 403 anyway (hidden-control
    // pattern, AC-121).
    await expect(page.getByTestId('attachment-photo-input')).toHaveCount(0);
    await expect(page.getByTestId('attachment-binary-input')).toHaveCount(0);
    await expect(page.getByTestId('attachment-delete')).toHaveCount(0);

    // Inline assigned-worker editor is gated on `project:update`, which
    // bookkeeper does not hold. The section wrapper may still render as
    // a read-only surface; the edit-trigger control must be absent.
    await expect(page.getByTestId('assigned-worker-edit-trigger')).toHaveCount(0);
  });
});
