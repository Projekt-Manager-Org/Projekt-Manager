import {
  test,
  expect,
  type BrowserContext,
  type BrowserContextOptions,
  type Locator,
  type Page,
} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { STORAGE_STATES } from './storage-states';
import { EXPECTED_RESTORE_PHRASE } from '../src/test/seedAssumptions';

/**
 * AC-748: text meets WCAG AA contrast against its surface in both themes.
 *
 * axe's `color-contrast` rule measures each rendered text node against its
 * computed background. The walk covers every view, the states a click
 * opens (dialogs, the detail panel, menus, popovers, a toast, the
 * company-profile block, active filters, validation errors) and, on each,
 * every `:hover` / `:focus*` rule that applies there; a separate test
 * fails on a rule that applies in no walk. States the seed does not hold
 * (attachments, an archived project, failed requests) come from stubbed
 * responses or a stubbed browser API. No walk writes data: an API write
 * that no stub answers is blocked and fails the test. The seeded users
 * store `system`, so `colorScheme` picks the theme.
 */

type Scheme = 'light' | 'dark';
const SCHEMES: Scheme[] = ['light', 'dark'];

const ROOT_ATTR = 'data-contrast-root';
const TARGET_ATTR = 'data-contrast-target';
const STATE = /:(hover|focus-visible|focus-within|focus)\b/g;
const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]';

async function expectTheme(page: Page, scheme: Scheme): Promise<void> {
  if (scheme === 'dark') await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  else await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark');
}

/** axe's contrast findings within `include`: failures and unmeasured text. */
async function contrastOffenders(page: Page, include: string, context: string): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withRules(['color-contrast'])
    .include(include)
    .analyze();
  const failed = results.violations.flatMap((v) =>
    v.nodes.map((n) => `${context}${n.target.join(' ')} — ${n.any[0]?.message ?? v.help}`),
  );
  // axe cannot measure text over images, gradients or overlapping elements
  // and reports it as incomplete. Icon glyphs (`nonBmp`) are not text.
  const unmeasured = results.incomplete.flatMap((v) =>
    v.nodes
      .filter((n) => (n.any[0]?.data as { messageKey?: string } | null)?.messageKey !== 'nonBmp')
      .map((n) => `${context}${n.target.join(' ')} — unmeasured: ${n.any[0]?.message ?? v.help}`),
  );
  return [...failed, ...unmeasured];
}

/**
 * A menu, popover or toast floats over the page; axe reports text whose
 * box spans several elements beneath as unmeasured, even on an opaque
 * layer. Behind an opaque layer the page cannot change the measured
 * color, so it is hidden.
 */
async function isolate(root: Locator): Promise<void> {
  const background = await root.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(background, 'a floating root must be opaque to be isolated').toMatch(/^rgb\(/);
  await root.evaluate((rootEl, attr) => {
    rootEl.setAttribute(attr, '');
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
      if (!rootEl.contains(el) && !el.contains(rootEl)) el.style.visibility = 'hidden';
    }
  }, ROOT_ATTR);
}

/** `media`: the rule's `@media` condition, empty for none. */
type StateRule = { selector: string; media: string; name: string };

/**
 * All `:hover` / `:focus*` rules: any property can change contrast (color,
 * background, opacity, a revealed tooltip). `name` reads as in the source,
 * `src/ui/kanban/KanbanBoard.module.css: .filterBanner button:hover`, as the
 * dev server's CSS module hash and line number change with each edit.
 */
async function stateRules(page: Page): Promise<StateRule[]> {
  return page.evaluate((statePattern) => {
    const state = new RegExp(statePattern);
    const rules = new Map<string, StateRule>();
    const visit = (cssRules: CSSRuleList, source: string, media: string): void => {
      for (const rule of Array.from(cssRules)) {
        if (rule instanceof CSSStyleRule) {
          for (const part of rule.selectorText.split(',')) {
            const selector = part.trim();
            if (!state.test(selector)) continue;
            // `._badge_1m7ng_22` is `.badge`.
            const readable = selector.replace(/\._([\w-]+)_[0-9a-z]{1,5}_\d+/g, '.$1');
            const name = `${source}: ${media ? `@media ${media} ` : ''}${readable}`;
            rules.set(`${media}|${selector}`, { selector, media, name });
          }
        } else if (rule instanceof CSSMediaRule) {
          const condition = rule.media.mediaText;
          visit(rule.cssRules, source, media ? `${media} and ${condition}` : condition);
        } else if ('cssRules' in rule) {
          visit((rule as CSSGroupingRule).cssRules, source, media);
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      const id = (sheet.ownerNode as Element | null)?.getAttribute('data-vite-dev-id') ?? '';
      visit(sheet.cssRules, id.slice(id.lastIndexOf('/src/') + 1), '');
    }
    return [...rules.values()];
  }, STATE.source);
}

/**
 * The part of `selector` that carries the state: up to the end of the
 * compound holding its last state pseudo-class. `.badge:hover .tooltip`
 * gives `.badge:hover` — hovering the badge reveals the tooltip within.
 */
function stateHost(selector: string): string {
  const last = [...selector.matchAll(STATE)].at(-1)!;
  let depth = 0;
  for (let i = last.index + last[0].length; i < selector.length; i++) {
    const c = selector[i]!;
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && /[\s>+~]/.test(c)) return selector.slice(0, i);
  }
  return selector;
}

/**
 * Marks the first element under `include` that can carry `host`'s state:
 * enabled (WCAG exempts disabled controls), visible, not covered (an open
 * dialog covers the page) and, for `:focus-within`, holding something
 * focusable. None while the rule's `@media` does not match. Marked just
 * before use, as a re-render drops the attribute.
 */
async function markTarget(page: Page, include: string, rule: StateRule): Promise<boolean> {
  const host = stateHost(rule.selector);
  return page.evaluate(
    ({ include, base, media, attr, focusWithin, focusable }) => {
      document.querySelector(`[${attr}]`)?.removeAttribute(attr);
      if (media && !matchMedia(media).matches) return false;
      const uncovered = (el: Element): boolean => {
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || el.matches(':disabled')) return false;
        if (focusWithin && !el.matches(focusable) && !el.querySelector(focusable)) return false;
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return hit !== null && el.contains(hit);
      };
      const el = Array.from(document.querySelector(include)!.querySelectorAll(base)).find(
        uncovered,
      );
      el?.setAttribute(attr, '');
      return el !== undefined;
    },
    {
      include,
      base: host.replace(STATE, ''),
      media: rule.media,
      attr: TARGET_ATTR,
      focusWithin: /:focus-within\b/.test(host),
      focusable: FOCUSABLE,
    },
  );
}

/** Puts `target` into the state `host` names; the reason if it did not apply. */
async function enterState(page: Page, target: Locator, host: string): Promise<string | null> {
  try {
    if (/:focus/.test(host)) {
      // A key press first: after a click, Chromium shows no :focus-visible
      // for a focus set by script.
      await page.keyboard.press('Shift');
      if (/:focus-within\b/.test(host)) {
        await target.evaluate((el, focusable) => {
          (el.matches(focusable) ? el : el.querySelector<HTMLElement>(focusable))?.focus();
        }, FOCUSABLE);
      } else {
        await target.focus({ timeout: 2000 });
      }
    } else {
      await target.hover({ timeout: 2000 });
    }
  } catch (e) {
    return (e as Error).message.split('\n')[0]!;
  }
  return (await target.evaluate((el, s) => el.matches(s), host)) ? null : 'no match';
}

/**
 * Freezes transitions and, for a floating `root`, hides the page around
 * it. Returns the selector the walk checks within.
 */
async function settle(page: Page, root: Locator | null): Promise<string> {
  // Transitions and animations would let axe measure a color mid-change.
  await page.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; animation: none !important; }',
  });
  if (!root) return 'body';
  await isolate(root);
  return `[${ROOT_ATTR}]`;
}

/**
 * Runs the contrast check on `root` (null: the page) as rendered, then on
 * one element per hover/focus rule that applies in that state. A rule
 * whose state cannot be entered fails rather than passing unchecked.
 */
async function expectAaContrast(page: Page, scheme: Scheme, root: Locator | null): Promise<void> {
  await expectTheme(page, scheme);
  const include = await settle(page, root);
  const offenders = await contrastOffenders(page, include, '');

  // The rules with a target here, before any is entered; the rest apply in
  // another walk, which the coverage test checks.
  const applicable: StateRule[] = [];
  for (const rule of await stateRules(page)) {
    if (await markTarget(page, include, rule)) applicable.push(rule);
  }

  const target = page.locator(`[${TARGET_ATTR}]`);
  for (const rule of applicable) {
    const { name } = rule;
    if (!(await markTarget(page, include, rule))) {
      offenders.push(`${name} — target lost`);
      continue;
    }
    const notEntered = await enterState(page, target, stateHost(rule.selector));
    if (notEntered) {
      offenders.push(`${name} — state not entered: ${notEntered}`);
      continue;
    }
    offenders.push(...(await contrastOffenders(page, `[${TARGET_ATTR}]`, `${name} — `)));
    // Leave both states, so the next rule is measured alone.
    await target.blur();
    await page.mouse.move(0, 0);
  }
  expect(offenders, offenders.join('\n')).toEqual([]);
}

/**
 * Blocks each API request but a GET that no stub of the walk answered,
 * and lists it. Stubs are page routes, which run before this context
 * route. The Vite dev server proxies only `/api` to the backend.
 */
async function blockWrites(context: BrowserContext): Promise<string[]> {
  const blocked: string[] = [];
  await context.route('**/api/**', (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fallback();
    blocked.push(`${request.method()} ${new URL(request.url()).pathname}`);
    return route.abort('blockedbyclient');
  });
  return blocked;
}

async function firstId(page: Page, url: string): Promise<string> {
  const res = await page.request.get(url);
  expect(res.ok()).toBe(true);
  const id = ((await res.json()) as { data: { id: string }[] }).data[0]?.id;
  expect(id, `${url} returned no rows`).toBeDefined();
  return id!;
}

type InvoiceRow = { id: string; status: string; projectId: string; cancellationOf: string | null };

async function seededInvoice(
  page: Page,
  what: string,
  match: (row: InvoiceRow) => boolean,
): Promise<InvoiceRow> {
  const res = await page.request.get('/api/invoices?limit=100');
  expect(res.ok()).toBe(true);
  const row = ((await res.json()) as { data: InvoiceRow[] }).data.find(match);
  expect(row, `the seed holds no ${what}`).toBeDefined();
  return row!;
}

/** Answers `url` with the real response, its JSON changed by `edit`. */
async function editJson<T>(
  page: Page,
  url: string | ((url: URL) => boolean),
  edit: (json: T) => T,
): Promise<void> {
  await page.route(url, async (route) => {
    // A write goes on to `blockWrites`: `route.fetch` would send it.
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    await route.fulfill({ response, json: edit((await response.json()) as T) });
  });
}

async function failWith500(page: Page, url: string): Promise<void> {
  await page.route(url, (route) =>
    route.fulfill({ status: 500, json: { code: 'INTERNAL_ERROR', message: 'Serverfehler' } }),
  );
}

/** Extraction reads as configured: the header shows its button. */
async function extractionConfigured(page: Page): Promise<void> {
  await page.route('**/api/extract/status', (route) =>
    route.fulfill({ json: { configured: true } }),
  );
}

/** Two PDF attachments, ready: the binary list shows every row action. */
function pdfAttachments(projectId: string): { data: object[] } {
  return {
    data: [1, 2].map((n) => ({
      id: `00000000-0000-4000-8000-00000000000${n}`,
      projectId,
      status: 'ready',
      kind: 'binary',
      label: 'angebot',
      fileName: `Angebot-${n}.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: 2048,
      originalKey: `mock/${n}`,
      thumbKey: null,
      hasThumbnail: false,
      hiddenAt: null,
      createdAt: new Date().toISOString(),
      createdBy: null,
    })),
  };
}

// Each view with the first element that exists only once its data loaded.
const OWNER_VIEWS: { path: string; loaded: string }[] = [
  { path: '/kanban', loaded: '[data-testid^="project-card-"]' },
  { path: '/calendar', loaded: '[data-testid^="calendar-bar-"]' },
  { path: '/projects', loaded: '[data-testid="project-table"] tbody tr' },
  { path: '/customers', loaded: '[data-testid="customer-table"] tbody tr' },
  { path: '/rechnungen', loaded: '[data-testid^="invoice-row-"]' },
  { path: '/users', loaded: '[data-testid="user-table"] tbody tr' },
  { path: '/daten', loaded: '[data-testid="daten-view"]' },
  // A fresh seed may hold no audit entries yet: the empty state is loaded too.
  {
    path: '/audit',
    loaded:
      '[data-testid="audit-list"] :is([data-testid^="activity-feed-row-"], [data-testid$="empty-state"])',
  },
  { path: '/benachrichtigungen', loaded: '[data-testid^="notification-rule-row-"]' },
];

/**
 * A page or state the walk checks. `open` returns the root to check — a
 * menu or popover covers the page beneath it, which the view walk already
 * checks — or null for the whole page. `use` sets the context: a viewport,
 * a device, another role.
 */
type Walk = {
  name: string;
  use?: Pick<BrowserContextOptions, 'viewport' | 'hasTouch' | 'isMobile' | 'storageState'>;
  open: (page: Page) => Promise<Locator | null>;
};

/** States a click opens, each read-only: nothing is submitted. */
const OWNER_STATES: Walk[] = [
  {
    name: 'detail panel',
    open: async (page) => {
      await page.goto('/kanban');
      await page.locator('[data-testid^="project-card-"]').first().click();
      await expect(page.getByTestId('detail-panel')).toBeVisible();
      await expect(page.getByTestId('detail-status-badge')).toBeVisible();
      return null;
    },
  },
  {
    name: 'user menu',
    open: async (page) => {
      await page.goto('/kanban');
      await page.getByTestId('user-menu-trigger').click();
      return page.getByTestId('user-menu-dropdown');
    },
  },
  {
    name: 'admin menu',
    open: async (page) => {
      await page.goto('/kanban');
      await page.getByTestId('nav-admin-trigger').click();
      return page.getByRole('menu');
    },
  },
  {
    name: 'toast',
    open: async (page) => {
      await page.goto('/kanban');
      // The backup badge answers a click with its status as a toast.
      await page.getByTestId('backup-badge').click();
      const toast = page.locator('[data-testid^="toast-"][role="status"]').first();
      await expect(toast).toBeVisible();
      return toast;
    },
  },
  {
    name: 'project create',
    open: async (page) => {
      await page.goto('/projects');
      await page.getByTestId('project-create-button').click();
      await expect(page.getByTestId('project-customer-select')).toBeVisible();
      return null;
    },
  },
  {
    name: 'worker filter',
    open: async (page) => {
      await page.goto('/projects');
      await page.getByTestId('worker-filter-toggle').click();
      return page.getByTestId('worker-filter-popover');
    },
  },
  {
    name: 'customer create',
    open: async (page) => {
      await page.goto('/customers');
      await page.getByTestId('customer-create-button').click();
      await expect(page.getByTestId('customer-name-input')).toBeVisible();
      return null;
    },
  },
  {
    name: 'user create',
    open: async (page) => {
      await page.goto('/users');
      await page.getByTestId('user-create-button').click();
      await expect(page.getByTestId('user-username-input')).toBeVisible();
      return null;
    },
  },
  {
    name: 'user detail',
    open: async (page) => {
      await page.goto('/users');
      await page.locator('[data-testid="user-table"] tbody tr').first().click();
      await expect(page.getByTestId('user-panel-displayname-input')).toBeVisible();
      return null;
    },
  },
  {
    name: 'notification rule form',
    open: async (page) => {
      await page.goto('/benachrichtigungen');
      await page.getByTestId('notification-rule-create-button').click();
      await expect(page.getByTestId('notification-rule-event-select')).toBeVisible();
      return null;
    },
  },
  {
    name: 'confirmation',
    open: async (page) => {
      await page.goto('/benachrichtigungen');
      await page.getByTestId('notification-rule-delete-button').first().click();
      await expect(page.getByTestId('confirm-dialog')).toBeVisible();
      return null;
    },
  },
  {
    name: 'company profile',
    open: async (page) => {
      await page.goto('/rechnungen');
      await page.getByTestId('company-profile-details').locator('summary').click();
      await expect(page.getByTestId('company-profile-form')).toBeVisible();
      return null;
    },
  },
  {
    name: 'invoice draft form',
    open: async (page) => {
      await page.goto('/rechnungen');
      await page.getByTestId('invoice-draft-edit').first().click();
      await expect(page.getByTestId('invoice-form')).toBeVisible();
      return null;
    },
  },
  {
    name: 'storno',
    open: async (page) => {
      const issued = await seededInvoice(page, 'issued invoice', (r) => r.status === 'issued');
      await page.goto(`/rechnungen/${issued.id}`);
      await page.getByTestId('invoice-detail-cancel-button').click();
      await expect(page.getByTestId('invoice-cancel-dialog')).toBeVisible();
      return null;
    },
  },
  {
    name: 'export',
    open: async (page) => {
      await page.goto('/daten');
      await page.getByTestId('data-export-button').click();
      await expect(page.getByTestId('export-job-dialog')).toBeVisible();
      return null;
    },
  },
  {
    name: 'import',
    open: async (page) => {
      await page.goto('/daten');
      // The button opens the file picker; a chosen file opens the dialog
      // at its confirmation step, before anything is uploaded.
      const chooser = page.waitForEvent('filechooser');
      await page.getByTestId('data-import-button').click();
      await (
        await chooser
      ).setFiles({
        name: 'export.zip',
        mimeType: 'application/zip',
        buffer: Buffer.from('PK'),
      });
      await expect(page.getByTestId('import-job-phrase-input')).toBeVisible();
      return null;
    },
  },
  {
    name: 'password change',
    open: async (page) => {
      await page.goto('/kanban');
      await page.getByTestId('user-menu-trigger').click();
      await page.getByTestId('pw-change-button').click();
      await expect(page.getByTestId('pw-change-confirm')).toBeVisible();
      return null;
    },
  },
  {
    name: 'activity dock',
    open: async (page) => {
      await page.goto('/kanban');
      await page.getByTestId('activity-dock-toggle').click();
      await expect(page.getByTestId('activity-dock-panel')).toBeVisible();
      return null;
    },
  },
  {
    name: 'site address',
    open: async (page) => {
      await page.goto(`/projects/${await firstId(page, '/api/projects?limit=1')}`);
      await page.getByTestId('project-detail-site-address-edit').click();
      await expect(page.getByTestId('site-address-modal')).toBeVisible();
      return null;
    },
  },
  {
    name: 'worker picker',
    open: async (page) => {
      await page.goto(`/projects/${await firstId(page, '/api/projects?limit=1')}`);
      await page.getByTestId('worker-editor-add').click();
      return page.getByTestId('worker-editor-options');
    },
  },
  {
    name: 'email intake',
    open: async (page) => {
      // The entry shows only while extraction is configured; e2e has no key.
      await extractionConfigured(page);
      await page.goto('/kanban');
      await page.getByTestId('extract-button').click();
      await expect(page.getByTestId('extract-email-input')).toBeVisible();
      return null;
    },
  },
  {
    name: 'email intake review',
    open: async (page) => {
      await extractionConfigured(page);
      await page.route('**/api/extract', (route) =>
        route.fulfill({
          json: {
            customer: {
              name: 'Kunde',
              phone: null,
              email: null,
              street: null,
              zip: null,
              city: null,
            },
            project: { title: 'Dachrinne', description: null, siteAddress: null },
          },
        }),
      );
      await page.goto('/kanban');
      await page.getByTestId('extract-button').click();
      await page.getByTestId('extract-email-input').fill('Bitte die Dachrinne erneuern.');
      await page.getByTestId('extract-submit').click();
      await expect(page.getByTestId('extract-project-number')).toBeVisible();
      return null;
    },
  },
  {
    name: 'extraction configured',
    open: async (page) => {
      await extractionConfigured(page);
      await page.goto('/kanban');
      await expect(page.getByTestId('extract-button')).toBeVisible();
      return null;
    },
  },
  {
    name: 'push menu',
    open: async (page) => {
      // Headless Chromium denies notifications; this browser has not decided.
      await page.addInitScript(() => {
        Object.defineProperty(Notification, 'permission', { get: () => 'default' });
        const registration = { pushManager: { getSubscription: async () => null } };
        Object.defineProperty(Object.getPrototypeOf(navigator.serviceWorker), 'getRegistration', {
          value: async () => registration,
        });
        Object.defineProperty(navigator.serviceWorker, 'ready', {
          get: () => Promise.resolve(registration),
        });
      });
      await page.goto('/kanban');
      await page.getByTestId('user-menu-trigger').click();
      await expect(page.getByTestId('push-opt-in-button')).toBeVisible();
      return page.getByTestId('user-menu-dropdown');
    },
  },
  {
    name: 'kanban without dates',
    open: async (page) => {
      await page.goto('/calendar');
      await page.getByTestId('no-dates-counter').click();
      await expect(page.getByTestId('kanban-filter-banner')).toBeVisible();
      return null;
    },
  },
  {
    name: 'worker filter active',
    open: async (page) => {
      await page.goto('/projects');
      await page.getByTestId('worker-filter-toggle').click();
      await page.getByTestId('worker-filter-option-unassigned').click();
      await page.getByTestId('worker-filter-toggle').click();
      await expect(page.getByTestId('worker-filter-clear')).toBeVisible();
      return null;
    },
  },
  {
    name: 'worker filter search',
    open: async (page) => {
      // Ten workers bring up the search field.
      await editJson<{ data: { userId: string; displayName: string }[] }>(
        page,
        '**/api/workers',
        (json) => ({
          ...json,
          data: Array.from({ length: 10 }, (_, i) => ({
            userId: json.data[i]?.userId ?? `00000000-0000-4000-8000-0000000001${i}0`,
            displayName: `${json.data[i % json.data.length]!.displayName} ${i + 1}`,
          })),
        }),
      );
      await page.goto('/projects');
      await page.getByTestId('worker-filter-toggle').click();
      // Narrowed to two workers: the list no longer scrolls, so no option is clipped.
      await page.getByTestId('worker-filter-search').fill('1');
      await expect(page.locator('[data-testid^="worker-filter-option-"]')).toHaveCount(3);
      return page.getByTestId('worker-filter-popover');
    },
  },
  {
    name: 'customer picker',
    open: async (page) => {
      await page.goto('/projects');
      await page.getByTestId('project-create-button').click();
      await page.getByTestId('project-customer-select').locator('input').click();
      return page.getByTestId('project-customer-options');
    },
  },
  {
    name: 'notification rule suggestions',
    open: async (page) => {
      await page.goto('/benachrichtigungen');
      await page.getByTestId('notification-rule-create-button').click();
      await page.getByTestId('notification-rule-user-search').fill('e');
      return page.getByRole('listbox');
    },
  },
  {
    name: 'notification rule recipient',
    open: async (page) => {
      await page.goto('/benachrichtigungen');
      await page.getByTestId('notification-rule-create-button').click();
      // Picking a user only fills the form; nothing is saved.
      await page.getByTestId('notification-rule-user-search').fill('e');
      await page.locator('[data-testid^="notification-rule-user-suggestion-"]').first().click();
      await expect(page.getByRole('listbox')).toBeHidden();
      await expect(
        page.locator('[data-testid^="notification-rule-user-chip-remove-"]'),
      ).toHaveCount(1);
      return null;
    },
  },
  {
    name: 'company profile invalid',
    open: async (page) => {
      await page.goto('/rechnungen');
      await page.getByTestId('company-profile-details').locator('summary').click();
      // Rejected in the browser: nothing is sent.
      await page.locator('#company-profile-companyName').fill('');
      await page.getByTestId('company-profile-save').click();
      await expect(page.locator('#company-profile-companyName')).toHaveAttribute(
        'aria-invalid',
        'true',
      );
      return null;
    },
  },
  {
    name: 'company profile fetch error',
    open: async (page) => {
      await failWith500(page, '**/api/company-profile');
      await page.goto('/rechnungen');
      await page.getByTestId('company-profile-details').locator('summary').click();
      await expect(page.getByTestId('company-profile-fetch-error')).toBeVisible();
      return null;
    },
  },
  {
    name: 'invoice list filtered',
    open: async (page) => {
      const draft = await seededInvoice(page, 'draft invoice', (r) => r.status === 'draft');
      await page.goto(`/rechnungen?projectId=${draft.projectId}`);
      await page.getByTestId('invoice-list-filter-status').selectOption('draft');
      await expect(page.getByTestId('invoice-list-project-chip')).toBeVisible();
      return null;
    },
  },
  {
    name: 'invoice cancelled',
    open: async (page) => {
      const original = await seededInvoice(
        page,
        'cancelled invoice',
        (r) => r.status === 'cancelled' && r.cancellationOf === null,
      );
      await page.goto(`/rechnungen/${original.id}`);
      await expect(page.getByTestId('invoice-detail-storno-siblings')).toBeVisible();
      return null;
    },
  },
  {
    name: 'storno invoice',
    open: async (page) => {
      const storno = await seededInvoice(page, 'storno invoice', (r) => r.cancellationOf !== null);
      await page.goto(`/rechnungen/${storno.id}`);
      await expect(page.getByTestId('invoice-detail-view-original')).toBeVisible();
      return null;
    },
  },
  {
    name: 'project invoice section',
    open: async (page) => {
      const draft = await seededInvoice(page, 'draft invoice', (r) => r.status === 'draft');
      // Issuing answers with the missing company-profile fields; nothing is issued.
      await page.route('**/api/invoices/*/issue', (route) =>
        route.fulfill({
          status: 422,
          json: {
            code: 'COMPANY_PROFILE_REQUIRED',
            message: 'Firmenprofil unvollständig',
            details: { missingFields: ['taxId'] },
          },
        }),
      );
      await page.goto(`/projects/${draft.projectId}`);
      await page.getByTestId('invoice-issue-button').first().click();
      await page.getByTestId('confirm-ok').click();
      await expect(page.getByTestId('invoice-company-profile-required-banner')).toBeVisible();
      return null;
    },
  },
  {
    name: 'invoice due',
    open: async (page) => {
      await page.goto(
        `/projects/${await firstId(page, '/api/projects?status=rechnung_faellig&limit=1')}`,
      );
      await expect(page.getByTestId('invoice-draft-create')).toBeVisible();
      return null;
    },
  },
  {
    name: 'attachments',
    open: async (page) => {
      const projectId = await firstId(page, '/api/projects?limit=1');
      await page.route(`**/api/projects/${projectId}/attachments`, (route) =>
        route.fulfill({ json: pdfAttachments(projectId) }),
      );
      await page.goto(`/projects/${projectId}`);
      await page.getByTestId('binary-select-all').check();
      await expect(page.getByTestId('binary-bulk-download')).toBeVisible();
      return null;
    },
  },
  {
    name: 'attachment trash error',
    open: async (page) => {
      const projectId = await firstId(page, '/api/projects?limit=1');
      await failWith500(page, `**/api/projects/${projectId}/attachments/trash`);
      await page.goto(`/projects/${projectId}`);
      await page.getByTestId('attachment-tab-papierkorb').click();
      await expect(page.getByTestId('papierkorb-retry')).toBeVisible();
      return null;
    },
  },
  {
    name: 'archived project',
    open: async (page) => {
      const projectId = await firstId(page, '/api/projects?limit=1');
      await editJson<object>(page, `**/api/projects/${projectId}`, (json) => ({
        ...json,
        deleted: true,
      }));
      // The store prefers the list row: an archived project is not listed.
      await editJson<{ data: { id: string }[] }>(
        page,
        (url) => url.pathname === '/api/projects',
        (json) => ({ ...json, data: json.data.filter((p) => p.id !== projectId) }),
      );
      await page.goto(`/projects/${projectId}`);
      await expect(page.getByTestId('project-detail-purge')).toBeVisible();
      return null;
    },
  },
  {
    name: 'activity log',
    open: async (page) => {
      // A total above the first page brings up "load more".
      await editJson<{ data: object[]; total: number }>(
        page,
        (url) => url.pathname === '/api/audit',
        (json) => ({ ...json, total: json.data.length + 1 }),
      );
      await page.goto('/audit');
      // The default scope lists entries that notify the viewer: none in the seed.
      await page.getByTestId('activity-recipient-toggle').check();
      await expect(page.getByTestId('activity-feed-drawer-toggle').first()).toBeVisible();
      return null;
    },
  },
  {
    name: 'assigned workers',
    open: async (page) => {
      const res = await page.request.get('/api/projects?limit=100');
      const projects = (await res.json()) as {
        data: { id: string; assignedWorkers: unknown[] | null }[];
      };
      const staffed = projects.data.find((p) => (p.assignedWorkers ?? []).length > 0);
      expect(staffed, 'the seed holds no project with assigned workers').toBeDefined();
      await page.goto(`/projects/${staffed!.id}`);
      await expect(page.locator('[data-testid^="worker-chip-remove-"]').first()).toBeVisible();
      return null;
    },
  },
  {
    name: 'import confirmed',
    open: async (page) => {
      await page.goto('/daten');
      const chooser = page.waitForEvent('filechooser');
      await page.getByTestId('data-import-button').click();
      await (
        await chooser
      ).setFiles({ name: 'export.zip', mimeType: 'application/zip', buffer: Buffer.from('PK') });
      await page.getByTestId('import-job-phrase-input').fill(EXPECTED_RESTORE_PHRASE);
      await expect(page.getByTestId('import-job-start')).toBeEnabled();
      return null;
    },
  },
];

const PHONE = { width: 390, height: 844 };
const SIGNED_OUT = { cookies: [], origins: [] };

/** Every walk: the views, the states, and the pages in another context. */
const WALKS: Walk[] = [
  ...OWNER_VIEWS.map((view) => ({
    name: view.path,
    open: async (page: Page) => {
      await page.goto(view.path);
      await expect(page.locator(view.loaded).first()).toBeVisible();
      return null;
    },
  })),
  {
    name: 'project detail page',
    open: async (page) => {
      await page.goto(`/projects/${await firstId(page, '/api/projects?limit=1')}`);
      await expect(page.getByTestId('project-detail-page')).toBeVisible();
      return null;
    },
  },
  {
    name: 'invoice detail view',
    open: async (page) => {
      await page.goto(`/rechnungen/${await firstId(page, '/api/invoices?limit=1')}`);
      await expect(page.getByTestId('invoice-detail-view')).toBeVisible();
      return null;
    },
  },
  ...OWNER_STATES,
  {
    name: '/kanban with collapsed columns',
    // Below 1780 px the board collapses its low-tier columns.
    use: { viewport: { width: 1440, height: 900 } },
    open: async (page) => {
      await page.goto('/kanban');
      await expect(page.locator('[data-testid^="project-card-"]').first()).toBeVisible();
      return null;
    },
  },
  {
    name: '/projects with the tab bar',
    use: { viewport: PHONE },
    open: async (page) => {
      await page.goto('/projects');
      await expect(page.locator('[data-testid="project-table"] tbody tr').first()).toBeVisible();
      return null;
    },
  },
  {
    name: 'project detail page with the camera button',
    // A touch device shows the camera button, hidden under a fine pointer.
    use: { viewport: PHONE, hasTouch: true, isMobile: true },
    open: async (page) => {
      await page.goto(`/projects/${await firstId(page, '/api/projects?limit=1')}`);
      await expect(page.getByTestId('detail-camera-capture')).toBeVisible();
      return null;
    },
  },
  {
    name: '/meine-projekte',
    use: { storageState: STORAGE_STATES.worker },
    open: async (page) => {
      await page.goto('/meine-projekte');
      await expect(page.getByTestId('my-projects-view')).toBeVisible();
      return null;
    },
  },
  {
    name: 'not-permitted page',
    use: { storageState: STORAGE_STATES.worker },
    open: async (page) => {
      await page.goto('/audit');
      await expect(page.getByTestId('not-permitted-view')).toBeVisible();
      return null;
    },
  },
  {
    name: 'login screen',
    use: { storageState: SIGNED_OUT },
    open: async (page) => {
      await page.goto('/');
      await expect(page.getByTestId('login-form')).toBeVisible();
      return null;
    },
  },
  {
    name: 'login error',
    use: { storageState: SIGNED_OUT },
    open: async (page) => {
      // Answered here, so no real failed login counts against the account.
      await page.route('**/api/auth/login', (route) =>
        route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'INVALID_CREDENTIALS',
            message: 'Anmeldung fehlgeschlagen',
          }),
        }),
      );
      await page.goto('/');
      await page.getByTestId('login-username').fill('inhaber');
      await page.getByTestId('login-password').fill('falsch');
      await page.getByTestId('login-submit').click();
      await expect(page.getByTestId('login-error')).toBeVisible();
      return null;
    },
  },
];

/**
 * Hover/focus rules that apply in no walk, each with the reason. The
 * coverage test fails on any other such rule, and on an entry here that
 * a walk enters or no stylesheet holds.
 */
const NOT_WALKED: Record<string, string> = {};

for (const scheme of SCHEMES) {
  test.describe(`AC-748: text contrast, ${scheme} theme`, () => {
    test.use({ colorScheme: scheme });

    let blocked: string[] = [];
    test.beforeEach(async ({ context }) => {
      blocked = await blockWrites(context);
    });
    test.afterEach(() => {
      expect(blocked, 'API writes no stub answered').toEqual([]);
    });

    for (const walk of WALKS) {
      test.describe(() => {
        test.use(walk.use ?? {});

        test(`AC-748: ${walk.name}`, async ({ page }) => {
          const root = await walk.open(page);
          await expectAaContrast(page, scheme, root);
        });
      });
    }
  });
}

/**
 * Each walk skips the rules with no element in its state. A rule that
 * applies in no walk would go unchecked with the suite green, so this
 * opens every walk and fails on such a rule. The rules carry no theme,
 * so one scheme decides.
 */
test('AC-748: every hover and focus rule applies in a walk', async ({ browser }) => {
  // One pass over every walk, without axe.
  test.setTimeout(WALKS.length * 10_000);
  // The context options the project sets; the walks' own come from `use`.
  const { baseURL, viewport, storageState } = test.info().project.use;
  const rules = new Set<string>();
  const applied = new Set<string>();
  for (const walk of WALKS) {
    await test.step(walk.name, async () => {
      const context = await browser.newContext({ baseURL, viewport, storageState, ...walk.use });
      const blocked = await blockWrites(context);
      const page = await context.newPage();
      const include = await settle(page, await walk.open(page));
      for (const rule of await stateRules(page)) {
        rules.add(rule.name);
        if (await markTarget(page, include, rule)) applied.add(rule.name);
      }
      await context.close();
      expect(blocked, 'API writes no stub answered').toEqual([]);
    });
  }

  const unwalked = [...rules].filter((r) => !applied.has(r) && !(r in NOT_WALKED));
  expect.soft(unwalked, `rules no walk enters:\n${unwalked.join('\n')}`).toEqual([]);
  const stale = Object.keys(NOT_WALKED).filter((r) => !rules.has(r) || applied.has(r));
  expect(stale, 'NOT_WALKED entries a walk enters or no stylesheet holds').toEqual([]);
});
