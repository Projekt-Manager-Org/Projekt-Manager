/**
 * Unit coverage for the central route table.
 *
 * Pins the per-role nav matrix in `docs/spec/ui/index.md §8.7.1` (AC-75) at
 * the table level — if a predicate drifts from the spec, this test
 * fires before the UI/guard ever sees the bad value.
 *
 * Also pins the per-role landing behavior (ui/index.md §8.1.2): exactly one
 * entry is the landing for any given role set. AC-149 is exercised
 * elsewhere (route-guard test + E2E in Round 9); here we only pin the
 * table's observable contract.
 */
import { describe, it, expect } from 'vitest';
import {
  LANDING_ORDER,
  ROUTES,
  assertLandingCoherent,
  landingPathForUser,
  routeByPath,
  routeByView,
  viewFromPath,
  pathFromView,
  visibleRoutesForUser,
  type RouteAccess,
  type RouteCaller,
  type RouteEntry,
} from '@/config/routes';
import { ROLE_KEYS } from '@/config/roleKeys';
import { readCheckedBlock, tableRows } from '@/test/checkedBlock';

type RoleName = 'owner' | 'office' | 'worker' | 'bookkeeper';

const caller = (role: RoleName): RouteCaller => ({ roles: [role] });

/**
 * Hand-written pins for the parametrized entries — deep-link targets,
 * which §8.7.1 omits, so its check (below) does not cover them. Every nav
 * entry is pinned by §8.7.1 itself.
 *
 * Every column is pinned, `access` included: the rule, not only the role
 * set it resolves to today. `roles` is that rule resolved against the
 * production role set; neither entry is a landing view. Gating per
 * project-detail.md §8.15 and invoices.md §8.16.3.
 */
const DEEP_LINKS: readonly {
  readonly view: string;
  readonly path: string;
  readonly label: string;
  readonly access: RouteAccess;
  readonly roles: readonly RoleName[];
}[] = [
  {
    view: 'rechnungDetail',
    path: '/rechnungen/:id',
    label: 'Rechnungen',
    access: { kind: 'permission', permission: 'invoice:read' },
    roles: ['owner', 'office', 'bookkeeper'],
  },
  {
    view: 'projektDetail',
    path: '/projects/:id',
    label: 'Projekte',
    access: { kind: 'permission', permission: 'project:read' },
    roles: ['owner', 'office', 'worker', 'bookkeeper'],
  },
];

const ROLE_NAMES: readonly RoleName[] = ['owner', 'office', 'worker', 'bookkeeper'];

const LANDINGS: Record<RoleName, string> = {
  owner: '/kanban',
  office: '/kanban',
  worker: '/meine-projekte',
  bookkeeper: '/rechnungen',
};

const NAV_DOC = 'docs/spec/ui/index.md';

/** The production roles a per-role predicate admits, as a §8.7.1 cell. */
const roleCell = (admits: (caller: RouteCaller) => boolean): string =>
  ROLE_KEYS.filter((role) => admits({ roles: [role] })).join(', ') || '—';

/** A route as §8.7.1 publishes it: the rule, then what it resolves to. */
const publishedRow = (entry: RouteEntry): string[] => [
  `\`${entry.view}\``,
  `\`${entry.path}\``,
  `"${entry.label}"`,
  entry.access.kind === 'role'
    ? `Role: ${entry.access.roles.join(', ')}`
    : `\`${entry.access.permission}\``,
  roleCell(entry.canAccess),
  roleCell(entry.isDefaultFor),
];

/**
 * The nav views §8.7.1 publishes for a role, in table order. Read from
 * the hand-written matrix rather than from `ROUTES`, so AC-75 checks
 * `visibleRoutesForUser` against the spec, not against its own source.
 */
const navViewsFor = (role: RoleName): string[] =>
  tableRows(readCheckedBlock(NAV_DOC, 'nav-matrix'))
    .filter(([, , , , roles]) => roles.split(', ').includes(role))
    .map(([view]) => view.replaceAll('`', ''));

describe('ROUTES — published nav matrix (AC-349)', () => {
  it('ui/index.md §8.7.1 publishes exactly the nav entries of ROUTES', () => {
    const published = tableRows(readCheckedBlock(NAV_DOC, 'nav-matrix'));
    // Parametrized paths are deep-link targets, not nav entries — the
    // same `/:` filter `visibleRoutesForUser` applies.
    const expected = ROUTES.filter((r) => !r.path.includes('/:')).map(publishedRow);
    expect(published).toEqual(expected);
  });

  it('ui/index.md §8.7.1 publishes exactly LANDING_ORDER', () => {
    const block = readCheckedBlock(NAV_DOC, 'nav-matrix');
    // `owner / office → \`kanban\`` — the table carries no arrows, so
    // every match belongs to the first-match order below it.
    const published = [...block.matchAll(/(\w+(?: \/ \w+)*) → `(\w+)`/g)].map(
      ([, roles, view]) => ({ roles: roles.split(' / '), view }),
    );
    expect(published).toEqual(
      LANDING_ORDER.map((entry) => ({ roles: [...entry.roles], view: entry.view })),
    );
  });
});

describe('ROUTES — deep-link entries', () => {
  it('has exactly the pinned deep links, in table order', () => {
    expect(ROUTES.filter((r) => r.path.includes('/:')).map((r) => r.view)).toEqual(
      DEEP_LINKS.map((r) => r.view),
    );
  });

  for (const row of DEEP_LINKS) {
    it(`'${row.view}' has the pinned path, label and access rule`, () => {
      const entry = ROUTES.find((r) => r.view === row.view);
      expect(entry, `no route entry for '${row.view}'`).toBeDefined();
      expect(entry?.path).toBe(row.path);
      expect(entry?.label).toBe(row.label);
      // The rule itself, not the role set it happens to resolve to today.
      expect(entry?.access).toEqual(row.access);
    });

    it(`'${row.view}' resolves to the pinned roles and is no landing`, () => {
      const entry = ROUTES.find((r) => r.view === row.view);
      const granted = ROLE_NAMES.filter((role) => entry?.canAccess(caller(role)));
      const lands = ROLE_NAMES.filter((role) => entry?.isDefaultFor(caller(role)));
      expect(granted).toEqual(row.roles);
      expect(lands).toEqual([]);
    });
  }
});

describe('ROUTES — per-role nav matrix (AC-75)', () => {
  for (const role of ROLE_NAMES) {
    it(`role '${role}' sees exactly the matrix set`, () => {
      const visible = visibleRoutesForUser(caller(role)).map((r) => r.view);
      expect(visible).toEqual(navViewsFor(role));
    });
  }

  it('preserves matrix order in the visible list', () => {
    // The header renders in table order; swapping the table order would
    // silently reshuffle the nav buttons.
    const ownerCaller = caller('owner');
    const owner = visibleRoutesForUser(ownerCaller).map((r) => r.view);
    expect(owner).toEqual(
      ROUTES.filter((r) => !r.path.includes('/:') && r.canAccess(ownerCaller)).map((r) => r.view),
    );
  });

  it('never exposes a Daten tab to a caller without data:export', () => {
    // worker has neither user:read nor data:export under the default
    // permission map, so both admin tabs must be hidden. Keeps the
    // AC-142/150 defense-in-depth chain intact at the table level.
    const visible = visibleRoutesForUser(caller('worker')).map((r) => r.view);
    expect(visible).not.toContain('daten');
    expect(visible).not.toContain('benutzer');
  });

  it('never exposes an Aktivität tab to a caller without audit:read', () => {
    // bookkeeper is the only role without `audit:read` in the permission
    // matrix, so the Aktivität tab must stay hidden. Pins the
    // audit-surface half of the AC-75 / AC-149 defense-in-depth chain
    // alongside the Daten negative above.
    const visible = visibleRoutesForUser(caller('bookkeeper')).map((r) => r.view);
    expect(visible).not.toContain('aktivitaet');
  });
});

describe('ROUTES — landing (ui/index.md §8.1.2)', () => {
  for (const role of Object.keys(LANDINGS) as RoleName[]) {
    it(`role '${role}' has exactly one landing entry at ${LANDINGS[role]}`, () => {
      const c = caller(role);
      expect(() => assertLandingCoherent(c)).not.toThrow();
      expect(landingPathForUser(c)).toBe(LANDINGS[role]);
    });
  }

  it('a multi-role caller lands on the first matching rule, not the last', () => {
    // `LANDING_ORDER` is first-match: worker, then owner/office, then
    // bookkeeper. The ordering IS the exclusion rule — an owner who is
    // also the bookkeeper belongs on the board, not the invoice
    // register. Pins the semantics that replaced the hand-written
    // `!landsOnKanban && !landsOnMeineProjekte` guard.
    expect(landingPathForUser({ roles: ['owner', 'bookkeeper'] })).toBe('/kanban');
    expect(landingPathForUser({ roles: ['bookkeeper', 'owner'] })).toBe('/kanban');
    expect(landingPathForUser({ roles: ['worker', 'bookkeeper'] })).toBe('/meine-projekte');
    expect(landingPathForUser({ roles: ['worker', 'owner'] })).toBe('/meine-projekte');
  });

  it('every landing view is one the landing role may actually enter', () => {
    // The failure mode created by declaring landing separately from
    // access: narrow a view's `access` without revisiting
    // `LANDING_ORDER` and that role logs straight into NotPermittedView.
    for (const role of Object.keys(LANDINGS) as RoleName[]) {
      const c = caller(role);
      const landing = ROUTES.find((r) => r.isDefaultFor(c));
      expect(landing, `role '${role}' has no landing route`).toBeDefined();
      expect(landing?.canAccess(c), `role '${role}' cannot access its landing view`).toBe(true);
    }
  });

  it('a caller with no recognized roles still lands somewhere safe', () => {
    // Production defensively falls back to the first accessible route
    // rather than crashing. An unknown-role caller has no access, so
    // the fallback path is '/kanban' (the last-resort default).
    const unknown: RouteCaller = { roles: ['someNewRole'] };
    expect(landingPathForUser(unknown)).toBe('/kanban');
  });

  it('caller with empty roles sees no nav and lands on fallback', () => {
    // Empty-role caller is another flavour of "no access anywhere" —
    // pin both observables so a regression on either surfaces here.
    // Fallback is '/kanban'; the route guard then renders
    // `NotPermittedView` (AC-149) because the caller cannot access it.
    const caller: RouteCaller = { roles: [] };
    expect(visibleRoutesForUser(caller)).toEqual([]);
    expect(landingPathForUser(caller)).toBe('/kanban');
  });
});

describe('ROUTES — path/view helpers', () => {
  it('routeByPath returns the matching entry', () => {
    expect(routeByPath('/kanban')?.view).toBe('kanban');
    expect(routeByPath('/daten')?.view).toBe('daten');
    expect(routeByPath('/nowhere')).toBeUndefined();
  });

  it('routeByPath resolves parametrized paths by pattern', () => {
    expect(routeByPath('/projects/abc123')?.view).toBe('projektDetail');
    // Per-invoice viewer (ui/invoices.md §8.16.3) — same parametrized
    // shape, gated on invoice:read alongside the list view.
    expect(routeByPath('/rechnungen/abc123')?.view).toBe('rechnungDetail');
  });

  it('routeByView throws for an unknown view', () => {
    // Today this is compile-time impossible; the assertion guards a
    // future union drift between `RouteView` and the table.
    // @ts-expect-error — deliberate violation for the guard path.
    expect(() => routeByView('ghost')).toThrow();
  });

  it('viewFromPath round-trips with pathFromView', () => {
    for (const r of ROUTES) {
      expect(viewFromPath(r.path)).toBe(r.view);
      expect(pathFromView(r.view)).toBe(r.path);
    }
  });

  it('viewFromPath falls back to kanban for unknown paths', () => {
    expect(viewFromPath('/totally/fake')).toBe('kanban');
  });
});
