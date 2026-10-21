# ADR-0019: Worker data scoping — repository-layer predicate over split permission

- **Status:** Accepted
- **Date:** 2026-04-16
- **Confidence:** High

## Context

Kickoff line 60: a worker sees only projects they are assigned to. Iteration 7's spec (commit `fccb905`) pins the observable behavior — worker `GET /api/projects` returns only rows where the caller appears in `project_workers`; worker `GET /api/customers` returns only customers referenced by those projects; get-by-id on an out-of-scope row returns `403 NOT_PERMITTED`, not `404`. Bookkeeper is unscoped as an MVP placeholder; owner and office are unscoped by design. The spec defers the _mechanism_ here.

Forces and constraints:

- `src/server/repositories/project-read.ts` — `listProjects(db, opts)` takes no caller context today. Natural seam.
- `project_workers` join (`src/server/db/schema.ts:149-162`) is already populated by the assignment flow.
- Handlers gate via `requirePermission(...)` preHandlers. No precedent for scoped reads.
- `docs/spec/api.md §14.3` declares a flat permission matrix — one `project:read`, one `customer:read`.
- CLAUDE.md: data-integrity defaults are baseline. A scope-miss must be an architectural impossibility, not per-handler discipline.
- ADR-0018 preserves a test-seed path that bypasses the API layer — any mechanism forbidding that is incompatible.

## Decision

Apply read scope in the **repository layer** via a pure predicate function of caller identity that contributes a `WHERE`-clause fragment. Permissions stay coarse (`project:read`, `customer:read`); scope is orthogonal to capability.

Shape:

| Concern                      | Realization                                                                                                                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoint gating              | `requirePermission('project:read' \| 'customer:read')` preHandler, unchanged                                                                                                                                            |
| Scope derivation             | `projectScopeForCaller(user): SQL \| null` / `customerScopeForCaller(user): SQL \| null` — pure, total, unit-testable                                                                                                   |
| Caller threading             | Explicit argument: handler → service → repository. No async-local context, no request-object mutation                                                                                                                   |
| Worker predicate (projects)  | `WHERE EXISTS (SELECT 1 FROM project_workers pw WHERE pw.project_id = projects.id AND pw.user_id = :callerId)`                                                                                                          |
| Worker predicate (customers) | AND-ed existence over the same join: customer visible iff at least one of its projects is visible                                                                                                                       |
| Owner / office               | Predicate returns `null` — no additional filter                                                                                                                                                                         |
| Bookkeeper                   | Predicate returns `null` — unscoped per `index.md §4.2` MVP stand-in. Revisit when the invoice-oriented view is introduced (see kickoff)                                                                                |
| Get-by-id                    | Repository fetches by id without the scope fragment, then applies the predicate to distinguish three outcomes: not-found (`null`), in-scope (`row`), out-of-scope (`{ outOfScope: true }`). Handler maps to 200/403/404 |

Predicate composes via Drizzle's `and(...)`. For list endpoints it inlines in the `WHERE`; for get-by-id the two-step exists/scope check avoids collapsing 403 and 404 into the same SQL result.

## Alternatives Considered

### Split permission (`project:read` vs `project:read-all`)

Encode scope in the permission catalog — workers get scoped, owner/office get unscoped. Ruled out: conflates _capability_ (what you may do) with _extent_ (over what subset), which the api.md §14.3 matrix deliberately keeps flat. Every scoped-readable entity would double its permission count, and scope evolution (bookkeeper placeholder → real rule) would churn the catalog instead of one predicate.

### Handler-level branching

`if (user.role === 'worker') { filter } else { return all }` at each list handler. Ruled out: duplicates scope logic across every list and get-by-id, turns a missed branch into a privilege-escalation bug, and hardcodes role names in handlers — fighting the `index.md §4.2` note that roles stay configurable.

### Middleware-level query mutation

A preHandler derives a `scopePredicate` and attaches it to `request`; handlers pass it to repositories. Ruled out: the repository still has to accept and apply it (so the repo seam is already required), request-object mutation obscures data flow, and hanging the predicate off an untyped request property weakens type safety vs. an explicit argument. Ceremony without removing the seam it claims to replace.

### Row-level security (RLS) in PostgreSQL

`CREATE POLICY` on `projects` and `customers`; set a per-connection session var carrying caller id before every query. Ruled out: the `node-postgres` pool (ADR-0004) hands out shared connections — per-caller session state needs `SET LOCAL` inside a transaction on every request, significant plumbing; queries look unscoped but the DB silently redacts, harder to debug; incompatible with ADR-0018's test-seed path, which must write and read unscoped. Reconsider if scope grows beyond single-table predicates.

## Consequences

### Positive

- `api.md §14.3` stays flat — one permission per entity, scope evolves independently.
- Scope lives in two predicate functions; auditing "what can a worker see?" is reading both.
- Pure function of caller identity — unit-testable with no request context or DB round-trip.
- Handlers stay role-agnostic past `requirePermission`; role names do not leak into endpoint logic.
- Adding a scoped entity is one predicate plus one seam — bounded, mechanical.
- Compatible with ADR-0018's test-seed helper: seeding bypasses the API, so the predicate is never invoked on that path.

### Negative

- Repository signatures gain a caller argument; every existing caller of a now-scoped repository needs updating. Mechanical but wide.
- The get-by-id three-way result (not-found / in-scope / out-of-scope) is a subtle bug vector — the spec's 403-over-404 choice forces us to keep the distinction honest, and a future refactor could collapse it back to a single null.
- Legitimate unscoped consumers (exports per ADR-0018, future admin views) must go through a distinct entry point or pass a sentinel "system" caller returning `null`. Careless use grows a second-class API.
- Test writers must set up `project_workers` rows in fixtures to exercise scoped behavior — minor overhead, easy to forget, silently produces empty result sets instead of meaningful assertions.

## References

- Spec commit `fccb905` — `docs/spec/api.md §14.3` (permission matrix), `docs/spec/verification.md §15.21` (AC-145, AC-146, AC-147, AC-148, AC-149, AC-150)
- [Kickoff](../project/kickoff.md) — line 60 (worker-visible projects)
- [ADR-0014](0014-ac-tier-system-critical-vs-design.md) — AC tiers; AC-145, AC-146, AC-147 and AC-148 are `[crit]` and require unit/integration coverage of the predicate
- [ADR-0018](0018-data-persistence-and-recovery-layered-strategy.md) — test-seed path that bypasses the API (reason RLS is ruled out)
- [ADR-0004](0004-backend-stack-fastify-drizzle-node-postgres.md) — `node-postgres` pool shape (reason per-connection RLS is expensive)
- `docs/spec/api.md §14.4.1` — NOT_PERMITTED vs NOT_FOUND taxonomy underlying the 403-over-404 choice
