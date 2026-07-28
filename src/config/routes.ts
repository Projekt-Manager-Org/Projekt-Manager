/**
 * Central route table — single source of truth for:
 *   - URL ↔ view key mapping
 *   - Per-route access rules (role- or permission-based, via a predicate)
 *   - Per-user landing choice (the "default view" after login, §8.1.2)
 *
 * Both the nav renderer (`Header`) and the route guard (`App`) consume
 * this table, so what the user sees and what the guard allows cannot
 * disagree. The per-role matrix in `docs/spec/ui/index.md §8.7.1` is
 * generated from this table, not hand-authored, and CI fails on drift
 * (AC-349) — the same guarantee the permission matrix carries.
 *
 * Access rules are DATA, not closures (`RouteAccess` below). A
 * predicate can be evaluated but not read: `(u) => hasPermission(u.roles,
 * 'invoice:read')` resolves to a role set and loses the rule that
 * produced it, so a generated matrix could only ever publish the
 * outcome. Declaring the rule and deriving the predicate from it —
 * policy-as-data, the shape IAM policy documents and OPA/Rego use —
 * means one source answers both "may this caller enter?" and "what does
 * the spec say gates this view?".
 *
 * Design echoes ADR-0019: explicit, declarative access rules over
 * hidden role branching. The spec mixes role-based gating (Kanban,
 * Kalender, Projekte, Kunden) with permission-based gating (Benutzer →
 * `user:manage`, Daten → `data:export`), so one rule shape covers both
 * uniformly.
 *
 * Note on layering: this module sits in the config layer per
 * `eslint.config.js` CONFIG_BANNED, so the predicate parameter is a
 * structural `RouteCaller` rather than the concrete `AuthUser` from
 * `src/api/client.ts`. `AuthUser` is structurally assignable to
 * `RouteCaller`, so callers in the state/UI layers can pass their
 * `authUser` directly. The `view` key is likewise a string literal
 * union mirrored from `src/domain/types.ts`'s `ViewMode` — the
 * conditional-type pair in `src/hooks/useRouterNav.ts` asserts exact
 * mirror at compile time.
 */
import { matchPath } from 'react-router';
import type { Permission, Role } from '@/config/permissions';
import { hasPermission } from '@/config/permissions';
import { STRINGS } from '@/config/strings';

/**
 * Minimal caller shape the route predicates need. `AuthUser` from
 * `@/api/client` is structurally assignable to this type — the state
 * and UI layers pass their `authUser` directly without a cast.
 */
export interface RouteCaller {
  roles: string[];
}

/**
 * View keys. Mirrors the `ViewMode` union in `src/domain/types.ts`.
 * A compile-time check in `src/hooks/useRouterNav.ts` guarantees the
 * two unions stay in sync; a drift there fails `tsc --noEmit`.
 */
export type RouteView =
  | 'meineProjekte'
  | 'kanban'
  | 'kalender'
  | 'kunden'
  | 'projekte'
  | 'rechnungen'
  | 'rechnungDetail'
  | 'benutzer'
  | 'daten'
  | 'aktivitaet'
  | 'benachrichtigungen'
  | 'projektDetail';

/**
 * What gates a route. Two kinds, because the spec gates two ways:
 * directly on role (Kanban, Kalender, Projekte, Kunden) or on a
 * permission the role matrix grants (Benutzer → `user:manage`).
 *
 * Readable by construction — `scripts/generate-nav-doc.ts` publishes
 * the rule verbatim, and resolves it against `ROLE_KEYS` to publish the
 * role set alongside. Neither is hand-transcribed into the spec.
 */
export type RouteAccess =
  | { readonly kind: 'role'; readonly roles: readonly Role[] }
  | { readonly kind: 'permission'; readonly permission: Permission };

/** A route as declared. `ROUTES` compiles these into `RouteEntry`. */
interface RouteDefinition {
  /** Stable view key. */
  readonly view: RouteView;
  /** URL path segment (absolute, single level — no parameters today). */
  readonly path: string;
  /** German label used in navigation. Reuses `STRINGS.ui.view*`. */
  readonly label: string;
  /** Access rule — see `RouteAccess`. */
  readonly access: RouteAccess;
}

export interface RouteEntry extends RouteDefinition {
  /** True iff this caller may enter the route (nav + guard). Derived from `access`. */
  canAccess: (caller: RouteCaller) => boolean;
  /**
   * True iff this is the landing entry for this caller. At most one
   * entry returns true for any given caller — `LANDING_ORDER` is
   * first-match, so overlap is not expressible.
   */
  isDefaultFor: (caller: RouteCaller) => boolean;
}

/**
 * True iff the caller holds any of the listed roles. Accepts the
 * network-boundary shape `string[]` and coerces via `includes` —
 * unknown role strings are silently ignored, matching the server's
 * role enforcement.
 */
function hasRole(caller: RouteCaller, ...roles: Role[]): boolean {
  return caller.roles.some((r) => (roles as readonly string[]).includes(r));
}

/** True iff this caller satisfies the rule. The `RouteAccess` interpreter. */
function allows(access: RouteAccess, caller: RouteCaller): boolean {
  return access.kind === 'role'
    ? hasRole(caller, ...access.roles)
    : hasPermission(caller.roles, access.permission);
}

/**
 * Per-role landing choice (ui/index.md §8.1.2), **first match wins**.
 *
 * Order is the whole rule. A caller holding several roles lands on the
 * first entry that matches, which is why `bookkeeper` sits last: an
 * owner who is also the bookkeeper lands on Kanban, not the invoice
 * register. Expressing that as three independent predicates meant
 * hand-writing the exclusions (`hasRole('bookkeeper') && !landsOnKanban
 * && !landsOnMeineProjekte`) and re-deriving them on every new role;
 * as an ordered list, overlap is not expressible.
 *
 * - **worker → Meine Projekte.** Workers spend most of their app time
 *   on phones; the kanban board is a manager's view. The personal list
 *   is one tap from any of their projects' detail pages, with no
 *   horizontal scroll and no per-state column collapse. Kanban and
 *   Kalender remain available as secondary nav.
 * - **owner / office → Kanban.** The board is the shared operational
 *   surface.
 * - **bookkeeper → Rechnungen.** The invoice register
 *   (search/filter/export) is their primary workflow.
 *
 * Exported so `scripts/generate-nav-doc.ts` can publish the ORDER, not
 * just the per-role outcome. Resolving each role on its own loses the
 * rule — the matrix would show `bookkeeper → Rechnungen` and never say
 * that an owner who is also the bookkeeper lands on Kanban.
 */
export const LANDING_ORDER: readonly {
  readonly roles: readonly Role[];
  readonly view: RouteView;
}[] = [
  { roles: ['worker'], view: 'meineProjekte' },
  { roles: ['owner', 'office'], view: 'kanban' },
  { roles: ['bookkeeper'], view: 'rechnungen' },
];

/** The caller's landing view, or `undefined` when no rule matches. */
function landingViewFor(caller: RouteCaller): RouteView | undefined {
  return LANDING_ORDER.find((entry) => hasRole(caller, ...entry.roles))?.view;
}

/**
 * Route table — ordered to match the nav matrix in `docs/spec/ui/index.md
 * §8.7.1`. The Header renders in this order, and the generator publishes
 * the table in this order, so the spec and the nav agree on sequence too.
 *
 * Declarations only. `ROUTES` below compiles each into a `RouteEntry` by
 * deriving `canAccess` from `access` and `isDefaultFor` from
 * `LANDING_ORDER`.
 */
const ROUTE_DEFINITIONS: readonly RouteDefinition[] = [
  {
    view: 'meineProjekte',
    path: '/meine-projekte',
    label: STRINGS.ui.viewMyProjects,
    // Worker-only surface — owner/office have richer tools and don't
    // need a personal "what am I assigned to" view as their first
    // screen. If office ever needs a personal view, gate via a new
    // permission rather than widening this role rule.
    access: { kind: 'role', roles: ['worker'] },
  },
  {
    view: 'kanban',
    path: '/kanban',
    label: STRINGS.ui.viewKanban,
    access: { kind: 'role', roles: ['owner', 'office', 'worker'] },
  },
  {
    view: 'kalender',
    path: '/calendar',
    label: STRINGS.ui.viewCalendar,
    access: { kind: 'role', roles: ['owner', 'office', 'worker'] },
  },
  {
    view: 'projekte',
    path: '/projects',
    label: STRINGS.ui.viewProjects,
    access: { kind: 'role', roles: ['owner', 'office', 'bookkeeper'] },
  },
  {
    view: 'kunden',
    path: '/customers',
    label: STRINGS.ui.viewCustomers,
    access: { kind: 'role', roles: ['owner', 'office', 'bookkeeper'] },
  },
  {
    // Standalone Rechnungen list view (ui/invoices.md §8.16.1) — gated
    // on `invoice:read` (owner / office / bookkeeper under the default
    // matrix). Worker holds no invoice permission and the repository
    // scope predicate (ADR-0019) returns the empty set, so worker is
    // structurally excluded both client- and server-side.
    view: 'rechnungen',
    path: '/rechnungen',
    label: STRINGS.ui.viewInvoices,
    access: { kind: 'permission', permission: 'invoice:read' },
  },
  {
    // Per-invoice viewer (ui/invoices.md §8.16.3) — gated on
    // `invoice:read`, same as the list. Worker is excluded both
    // client-side (no permission) and server-side (repository scope
    // predicate, ADR-0019 + AC-298). Parametrized — deep-linkable,
    // not a nav entry; excluded from `visibleRoutesForUser` by the
    // `/:` filter alongside `projektDetail`.
    view: 'rechnungDetail',
    path: '/rechnungen/:id',
    label: STRINGS.ui.viewInvoices,
    access: { kind: 'permission', permission: 'invoice:read' },
  },
  {
    view: 'benutzer',
    path: '/users',
    label: STRINGS.ui.viewUsers,
    // View gated on `user:manage` per ui/management.md §8.10 — owner-only under
    // the default role set, matching the nav matrix in §8.7.1.
    // Office holds `user:read` for worker-assignment dropdowns, not
    // administration, and is not admitted here.
    access: { kind: 'permission', permission: 'user:manage' },
  },
  {
    view: 'daten',
    path: '/daten',
    label: STRINGS.ui.viewData,
    access: { kind: 'permission', permission: 'data:export' },
  },
  {
    // View gated on `audit:read` per ui/index.md §8.7.1 — owner and
    // office under the default matrix. Worker and bookkeeper lack
    // `audit:read` and do not see the tab. The per-role visible row set
    // is narrowed server-side (api.md §14.2.8) by the destructive-action
    // scope, so this gate is the nav-visibility concern; data exposure
    // is authoritative on the server.
    view: 'aktivitaet',
    path: '/audit',
    label: STRINGS.ui.viewAudit,
    access: { kind: 'permission', permission: 'audit:read' },
  },
  {
    // Notification rules admin view (ui/management.md §8.14) — gated on
    // `notifications:manage`. Owner-only under the default matrix per
    // api.md §14.3 + ADR-0023. Server-side authorization remains
    // authoritative; this is the nav-visibility concern only.
    view: 'benachrichtigungen',
    path: '/benachrichtigungen',
    label: STRINGS.ui.viewNotifications,
    access: { kind: 'permission', permission: 'notifications:manage' },
  },
  {
    view: 'projektDetail',
    path: '/projects/:id',
    label: STRINGS.ui.viewProjects,
    access: { kind: 'permission', permission: 'project:read' },
  },
] as const;

/**
 * The compiled table. Consumers keep calling `entry.canAccess(user)` /
 * `entry.isDefaultFor(user)`; the difference is that both now come from
 * data a generator can read.
 */
export const ROUTES: readonly RouteEntry[] = ROUTE_DEFINITIONS.map((definition) => ({
  ...definition,
  canAccess: (caller: RouteCaller) => allows(definition.access, caller),
  isDefaultFor: (caller: RouteCaller) => landingViewFor(caller) === definition.view,
}));

/**
 * Dev-time invariant on the landing choice. Two failure modes, both of
 * which produce an unrecoverable or wrong login:
 *
 *  1. A caller with route access has no landing rule — `LANDING_ORDER`
 *     forgot a role that `ROUTE_DEFINITIONS` admits.
 *  2. A caller's landing view is one they may not enter — the failure
 *     mode created by declaring landing separately from access. Narrow
 *     a view's `access` without revisiting `LANDING_ORDER` and the
 *     affected role logs straight into `NotPermittedView`.
 *
 * "Exactly one landing" is not checked because it is not expressible:
 * `LANDING_ORDER` is first-match, so `landingViewFor` returns at most
 * one view.
 *
 * Callers with no route access at all (empty roles, unknown roles)
 * legitimately have no landing — the fallback branch in
 * `landingPathForUser` handles that, and the route guard then renders
 * `NotPermittedView`.
 */
export function assertLandingCoherent(caller: RouteCaller): void {
  if (process.env.NODE_ENV === 'production') return;
  const landing = ROUTES.find((r) => r.isDefaultFor(caller));
  if (!landing) {
    if (ROUTES.some((r) => r.canAccess(caller))) {
      throw new Error(
        `routes: caller with roles [${caller.roles.join(', ')}] has route ` +
          `access but no landing route`,
      );
    }
    return;
  }
  if (!landing.canAccess(caller)) {
    throw new Error(
      `routes: caller with roles [${caller.roles.join(', ')}] lands on ` +
        `'${landing.view}' but cannot access it — LANDING_ORDER and the ` +
        `route's access rule disagree`,
    );
  }
}

/** Route keyed by URL path. Matches parametrized patterns (e.g. `/projects/:id`). `undefined` for unknown paths. */
export function routeByPath(pathname: string): RouteEntry | undefined {
  return ROUTES.find((r) => matchPath({ path: r.path, end: true }, pathname) !== null);
}

/** Route keyed by view. Throws for unknown views (compile-time impossible today). */
export function routeByView(view: RouteView): RouteEntry {
  const match = ROUTES.find((r) => r.view === view);
  if (!match) {
    throw new Error(`routes: no route for view '${view}'`);
  }
  return match;
}

/** Path → view key. Falls back to 'kanban' for unknown paths (legacy behavior). */
export function viewFromPath(pathname: string): RouteView {
  return routeByPath(pathname)?.view ?? 'kanban';
}

/** View key → path. Total over the `RouteView` union. */
export function pathFromView(view: RouteView): string {
  return routeByView(view).path;
}

/**
 * Views that live under the "Verwaltung" (administration) secondary menu
 * rather than the primary nav. Administration + audit observability are
 * lower-frequency surfaces for the roles that see them; keeping them out
 * of the primary row keeps the header compact when the summary area is
 * wide.
 *
 * `rechnungen` is included so owner / office surface it under Verwaltung
 * (their secondary bucket has ≥2 entries). Bookkeeper has only
 * `rechnungen` in their secondary bucket — the "≥2 to render the menu"
 * rule in Header / MobileTabBar routes it inline alongside Projekte /
 * Kunden, which matches the `docs/spec/ui/invoices.md §8.16` "primary for
 * bookkeeper" line.
 *
 * Exported so Header and MobileTabBar consume a single source of truth.
 * Unlike the nav matrix itself, this grouping is NOT generated — it is
 * hand-synced with the "Primary / secondary header grouping" paragraph
 * in `docs/spec/ui/index.md §8.7.1`, below the generated block.
 */
export const SECONDARY_VIEWS: readonly RouteView[] = [
  'rechnungen',
  'benutzer',
  'daten',
  'aktivitaet',
  'benachrichtigungen',
];

/** The nav set this caller sees, in matrix order. Parametrized paths are excluded — they're deep-linked, not nav entries. */
export function visibleRoutesForUser(caller: RouteCaller): readonly RouteEntry[] {
  return ROUTES.filter((r) => !r.path.includes('/:') && r.canAccess(caller));
}

/** The caller's default landing path — used on login and on `/` redirects. */
export function landingPathForUser(caller: RouteCaller): string {
  // Dev-time invariant check — throws if two `isDefaultFor` predicates
  // overlap or none matches. Self-guarded on NODE_ENV so prod is a no-op.
  assertLandingCoherent(caller);
  const match = ROUTES.find((r) => r.isDefaultFor(caller));
  // In dev, `assertLandingCoherent` has already caught this; in prod,
  // fall back to the first accessible route so an unseen role
  // combination cannot produce an unrecoverable login.
  if (match) return match.path;
  const fallback = ROUTES.find((r) => r.canAccess(caller));
  return fallback?.path ?? '/kanban';
}
