# ADR-0014: AC tier system — critical, design, and infra coverage

- **Status:** Accepted
- **Date:** 2026-04-12 (original); updated 2026-04-15 (see [Updates](#updates))
- **Confidence:** High

## Context

By iteration 5, the project had accumulated ~4,700 LOC of component and UI tests that mocked APIs and rendered components in jsdom. Three compounding problems:

1. **False confidence.** Mock-based UI tests passed while the real app failed. Agents excused failures with "the app is not running" — the mocks were the test, not the application. A suite that passes when the product is broken is worse than none.
2. **Perverse incentives from coverage targets.** A numeric goal steered authors toward the cheapest lines to cover, not the most valuable behavior to verify.
3. **Unmaintainable volume.** Every UI atom had a dedicated test file. 16 component files, 3 orphaned helpers, hundreds of assertions that broke on any refactor regardless of whether behavior changed.

## Decision

Classify every AC into one of three tiers by defect impact, and verify each with the strategy matching its risk.

**Classification test:**

> If this breaks, does the user lose data, money, access, or act on wrong information?
> **Yes → `[crit]`** — unit and/or integration test against the real stack.
> **No → `[vis]`** — an E2E test drives the scenario; visual judgment is human review via `npx playwright test --ui`.
>
> Orthogonal: constraints on the deployed environment, the build pipeline, or the source tree (CI gates, deploy procedures, lint-enforced layering, repo-scan checks) carry `[infra]` and are verified by their respective automation — not by tests against the running system.

**Applied:** every AC in [verification.md §15](../spec/verification.md#15-acceptance-criteria) carries exactly one of `[crit]`, `[vis]`, `[infra]`. Mapping lives in [traceability.md](../testing/traceability.md); an empty cell is a gap, not a default.

**Concrete changes:**

- Removed 16 mock-based component/UI test files and 3 orphaned helpers (−3,789 LOC).
- Added an E2E flow suite (`management-flows`, `kanban-flows`, `permission-visibility`, `failure-paths`, `theming`, `theme-preference`, `import-export-flows`, …) driving every `[vis]` scenario. Runs headless as the automated gate; human reviewer judges in UI mode.
- Removed jsdom from vitest; unit project runs in node environment only.
- No coverage target. The traceability matrix is the sole "is everything covered?" measure.
- Added `scripts/check-traceability.sh` lint step to detect drift between spec, matrix, and test files.

## Alternatives Considered

### Keep mock-based tests and add E2E on top

Additive, no deletion. Ruled out: doubles maintenance surface without fixing the core problem — mocks still test mocks. Overlapping suites disagree ambiguously.

### E2E only — no unit or integration tests

Ruled out: E2E is too slow and too coarse for critical-path verification. Domain logic (state transitions, auth rules, constraints) needs isolated, fast, deterministic tests that pinpoint the defect.

### Coverage target with exclusions

Ruled out: same perverse incentive — the metric still optimizes for covered lines, not defect detection. Exclusion lists add maintenance without changing what's rewarded.

## Consequences

### Positive

- Net −4,051 LOC of test code. Lower maintenance, fewer refactor-induced false failures.
- Higher confidence per test: unit/integration hit the real stack (Fastify + PostgreSQL); E2E runs the real app in a real browser against real infrastructure.
- Clear ownership: every AC has exactly one verification strategy.
- The classification test is a one-sentence rule that two people apply consistently.

### Negative

- `[vis]`-tier verification depends on a human running Playwright UI mode. Slower than pixel-diff, but the stored-screenshot path failed (see [Updates](#updates)).
- Every `[vis]` AC needs an E2E driving the scenario even when nothing `expect()`s on the result — without it, the reviewer has nothing to watch. An uncovered `[vis]` AC is a gap, not a "design-only" exemption.
- The traceability matrix is load-bearing. Drift = undetected gaps. The lint script mitigates but stays advisory until the workflow matures.

## Updates

### 2026-04-14 — screenshot baselines dropped

Stored Playwright screenshot baselines (`visual-regression*.spec.ts` and the associated `-snapshots/` directories) were removed in commits cf6f63d and 9577fdf. They were net-negative: legitimate UI tweaks produced constant false positives, training contributors to blind-update baselines — defeating the signal. `[vis]` verification moved from "Playwright screenshot diff" to "E2E drives the scenario; human review via `npx playwright test --ui`". The classification rule and tier semantics are unchanged.

The functional E2E specs remain the automated gate and are exactly what the reviewer time-travels through in UI mode. Trace retention flipped to `retain-on-failure` so any failed run produces a reviewable trace without a retry.

### 2026-04-15 — `[infra]` promoted to a first-class tier label

The original ADR treated infrastructure/structural ACs as "untiered". Every AC in [verification.md §15](../spec/verification.md#15-acceptance-criteria) now carries exactly one of `[crit]`, `[vis]`, `[infra]`. Closes the "what tier is this?" ambiguity flagged by `S-ACS1` and makes the "no tests against the running system" expectation explicit for deployment, lint, and repo-scan constraints.

## References

- [docs/spec/verification.md §15](../spec/verification.md#15-acceptance-criteria): the tier legend (definitions and classification test) and the tiered AC list
- [CONTRIBUTING.md § Testing](../../CONTRIBUTING.md#testing): UI-mode workflow for `[vis]` review
- [docs/testing/traceability.md](../testing/traceability.md): the traceability matrix
