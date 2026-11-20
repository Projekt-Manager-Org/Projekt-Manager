import { test, expect, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { STORAGE_STATES } from './storage-states';

/**
 * AC-748: text meets WCAG AA contrast against its surface in both themes.
 *
 * axe's `color-contrast` rule measures each rendered text node against its
 * computed background. The walk covers every view, the states a click
 * opens (dialogs, the detail panel, menus, popovers, a toast, the
 * company-profile block) and, on each, every `:hover` / `:focus*` rule
 * that applies there. Rules for states the walk does not open (attachments,
 * trash, active filters, validation errors) stay unchecked. The seeded
 * users store `system`, so `colorScheme` picks the theme.
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

/**
 * The selectors of all `:hover` / `:focus*` rules: any property can change
 * contrast (color, background, opacity, a revealed tooltip).
 */
async function interactiveSelectors(page: Page): Promise<string[]> {
  return page.evaluate((statePattern) => {
    const state = new RegExp(statePattern);
    const selectors = new Set<string>();
    const visit = (rules: CSSRuleList): void => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSStyleRule) {
          for (const part of rule.selectorText.split(',')) {
            if (state.test(part)) selectors.add(part.trim());
          }
        } else if ('cssRules' in rule) {
          visit((rule as CSSGroupingRule).cssRules);
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) visit(sheet.cssRules);
    return [...selectors];
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
 * focusable. Marked just before use, as a re-render drops the attribute.
 */
async function markTarget(page: Page, include: string, host: string): Promise<boolean> {
  return page.evaluate(
    ({ include, base, attr, focusWithin, focusable }) => {
      document.querySelector(`[${attr}]`)?.removeAttribute(attr);
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
 * Runs the contrast check on `root` (null: the page) as rendered, then on
 * one element per hover/focus rule that applies in that state. A rule
 * whose state cannot be entered fails rather than passing unchecked.
 */
async function expectAaContrast(page: Page, scheme: Scheme, root: Locator | null): Promise<void> {
  await expectTheme(page, scheme);
  // Transitions and animations would let axe measure a color mid-change.
  await page.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; animation: none !important; }',
  });

  let include = 'body';
  if (root) {
    await isolate(root);
    include = `[${ROOT_ATTR}]`;
  }
  const offenders = await contrastOffenders(page, include, '');

  const target = page.locator(`[${TARGET_ATTR}]`);
  for (const selector of await interactiveSelectors(page)) {
    const host = stateHost(selector);
    if (!(await markTarget(page, include, host))) continue;
    const notEntered = await enterState(page, target, host);
    if (notEntered) {
      offenders.push(`${selector} — state not entered: ${notEntered}`);
      continue;
    }
    offenders.push(...(await contrastOffenders(page, `[${TARGET_ATTR}]`, `${selector}: `)));
    // Leave both states, so the next rule is measured alone.
    await target.blur();
    await page.mouse.move(0, 0);
  }
  expect(offenders, offenders.join('\n')).toEqual([]);
}

async function firstId(page: Page, url: string): Promise<string> {
  const res = await page.request.get(url);
  expect(res.ok()).toBe(true);
  const id = ((await res.json()) as { data: { id: string }[] }).data[0]?.id;
  expect(id, `${url} returned no rows`).toBeDefined();
  return id!;
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
 * States a click opens, each read-only: nothing is submitted. `open`
 * returns the root to check — a menu or popover covers the page beneath
 * it, which the view walk already checks — or null for the whole page.
 */
const OWNER_STATES: { name: string; open: (page: Page) => Promise<Locator | null> }[] = [
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
      const res = await page.request.get('/api/invoices?limit=100');
      const rows = ((await res.json()) as { data: { id: string; status: string }[] }).data;
      const issued = rows.find((r) => r.status === 'issued');
      expect(issued, 'the seed holds no issued invoice').toBeDefined();
      await page.goto(`/rechnungen/${issued!.id}`);
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
      await page.route('**/api/extract/status', (route) =>
        route.fulfill({ json: { configured: true } }),
      );
      await page.goto('/kanban');
      await page.getByTestId('extract-button').click();
      await expect(page.getByTestId('extract-email-input')).toBeVisible();
      return null;
    },
  },
  {
    name: 'email intake review',
    open: async (page) => {
      await page.route('**/api/extract/status', (route) =>
        route.fulfill({ json: { configured: true } }),
      );
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
];

for (const scheme of SCHEMES) {
  test.describe(`AC-748: text contrast, ${scheme} theme`, () => {
    test.use({ colorScheme: scheme });

    for (const view of OWNER_VIEWS) {
      test(`AC-748: ${view.path}`, async ({ page }) => {
        await page.goto(view.path);
        await expect(page.locator(view.loaded).first()).toBeVisible();
        await expectAaContrast(page, scheme, null);
      });
    }

    test('AC-748: project detail page', async ({ page }) => {
      await page.goto(`/projects/${await firstId(page, '/api/projects?limit=1')}`);
      await expect(page.getByTestId('project-detail-page')).toBeVisible();
      await expectAaContrast(page, scheme, null);
    });

    test('AC-748: invoice detail view', async ({ page }) => {
      await page.goto(`/rechnungen/${await firstId(page, '/api/invoices?limit=1')}`);
      await expect(page.getByTestId('invoice-detail-view')).toBeVisible();
      await expectAaContrast(page, scheme, null);
    });

    for (const state of OWNER_STATES) {
      test(`AC-748: ${state.name}`, async ({ page }) => {
        const root = await state.open(page);
        await expectAaContrast(page, scheme, root);
      });
    }

    test.describe('laptop width', () => {
      // Below 1780 px the board collapses its low-tier columns.
      test.use({ viewport: { width: 1440, height: 900 } });

      test('AC-748: /kanban with collapsed columns', async ({ page }) => {
        await page.goto('/kanban');
        await expect(page.locator('[data-testid^="project-card-"]').first()).toBeVisible();
        await expectAaContrast(page, scheme, null);
      });
    });

    test.describe('phone width', () => {
      test.use({ viewport: { width: 390, height: 844 } });

      test('AC-748: /projects with the tab bar', async ({ page }) => {
        await page.goto('/projects');
        await expect(page.locator('[data-testid="project-table"] tbody tr').first()).toBeVisible();
        await expectAaContrast(page, scheme, null);
      });
    });

    test.describe('worker', () => {
      test.use({ storageState: STORAGE_STATES.worker });

      test('AC-748: /meine-projekte', async ({ page }) => {
        await page.goto('/meine-projekte');
        await expect(page.getByTestId('my-projects-view')).toBeVisible();
        await expectAaContrast(page, scheme, null);
      });
    });

    test.describe('signed out', () => {
      test.use({ storageState: { cookies: [], origins: [] } });

      test('AC-748: login screen', async ({ page }) => {
        await page.goto('/');
        await expect(page.getByTestId('login-form')).toBeVisible();
        await expectAaContrast(page, scheme, null);
      });

      test('AC-748: login error', async ({ page }) => {
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
        await expectAaContrast(page, scheme, null);
      });
    });
  });
}
