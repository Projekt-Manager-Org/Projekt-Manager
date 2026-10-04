<!-- READ-ONLY for AI -->

# Plan

**CURRENT** The project is a successful MVP in a _Feature Freeze_ - extensive testing, fixing bugs and improving the user experience.

## Iteration 0.A - Discovery

- [x] project definition
- [x] preliminary discussions with the target company[^1]
- [x] realization of scope and setting limits
- [x] consideration of approaching the project as a general solution for a wider audience

**Artifacts**

- [x] Kickoff document

## Iteration 0.B - Clarification

- [x] meetings with stakeholders, clarification of details and ambiguities[^1]
- [x] meeting with owner, clarification of roles and rights[^1]
- [x] clarification of data, fields, types and their relations[^1]

**Artifacts**

- [x] definition of a "walking skeleton"
- [x] detailed specification for the implementation of a "walking skeleton"
- [x] interactive prototypes

## Iteration 0.C - Pre-Work Setup

- [x] separation of the work into modules
- [x] setting up an environment, coding style, and workflow

**Artifacts**

- [x] Git repository initialized.
- [x] A GitHub Kanban board set up.
- [x] CONTRIBUTING.md with conventions, code style, branching strategy

## Iteration 1 - Walking Skeleton

- [x] parallel prototyping of 5 tech stacks (React+FullCalendar+shadcn, React+Custom, Svelte 5, Vue 3, PHP)
- [x] empirical evaluation: page weight, LOC, build time, configurability audit
- [x] tech stack decision formalized
- [x] presentation to pilot company[^1]
- [x] chosen implementation (React, Prototype B) promoted to the iteration branch
- [x] linter, formatter, test framework, quality gates
- [x] CI pipeline

**Artifacts**

- [x] a "walking skeleton" (prototype stage — 5 implementations)
- [x] presentation[^1]
- [x] production-quality walking skeleton on chosen stack

## Iteration 2 - Infrastructure foundation: backend, auth, storage, Docker, CI/CD

- [x] API layer between frontend and data
- [x] a module encapsulating all storage operations (S3 SDK)
- [x] user authentication
- [x] replace mock data with a persistent data source in a database
- [x] extensive quality and security reviews — the biggest timesink

Deployment deferred to iteration 3 — security review revealed problems.
Presentation skipped — no visible difference for non-technical users vs the walking skeleton.

**Artifacts**

- realistic app with persistent data and authentication
- security-hardened foundation for deployment

## Iteration 3 - Stabilization

Structural refactor triggered by compounding debt. Feature work halted.

- [x] multi-angle code quality audit (5 parallel agents: spec, backend, frontend, infra, coupling)
- [x] backend: service layer (AuthService, ProjectService), repository split, centralized config, Zod env validation
- [x] frontend: API client extraction (eliminated 3× fetch duplication), Zustand store split into auth/project/ui slices, shared transition hook
- [x] routing: React Router for URL-based navigation
- [x] testing: +50 tests (136 → 186), test file split, shared DB setup helper, seed race fix
- [x] docs: ARCHITECTURE.md, spec security checklist, known debt index, iteration scope mapping
- [x] infra: MinIO bucket init container, DB indexes
- [x] retrospection → journal entry, workflow learnings (agent isolation, spec-implementation gap as quality signal)

**Artifacts**

- structurally sound codebase ready for production deployment
- documented architecture and onboarding entry point
- validated extensibility: config-driven states, independent view composition

## Iteration 4 - Deployment and integration testing

From test environment into production on Hetzner.

- [x] deploy to Hetzner VPS (Docker Compose, Caddy with real domain + TLS)
- ~~object storage: evaluate Cloudflare R2 vs Hetzner Object Storage~~ — deferred (#45)
- [x] VPN setup (plain WireGuard) — all access behind VPN initially
- [x] validate full deployment path: push to main → CI green → auto-deploy → app running
- [x] integration/smoke tests against the deployed environment
- ~~backup strategy for PostgreSQL and object storage~~ — deferred (#46)
- ~~monitoring: at minimum, health check pings and container restart alerting~~ — deferred (#46)
- ~~seed with representative fake data, demo to pilot company[^1]~~ — skipped; no visible change for non-technical users vs iteration 3
- [x] retrospection → issues for the backlog

**Unplanned work**

- first-run admin bootstrap from environment variables
- env-drift CI check
- Docker version pinning across environments
- CD pipeline hardening (#48) partially addressed via the env-drift check; rest deferred to iteration 5

**Artifacts**

- walking skeleton live, reachable only through WireGuard
- validated CI/CD pipeline from commit to production (8 successful deploys this iteration)

## Iteration 5 - Consolidation

- [x] test suite QC
- [x] documentation QC and reorganization
- [x] spec ↔ code drift reconciliation
- ~~security review — systematic audit across backend, frontend, infrastructure, deployment, data handling~~ — deferred to iteration 6
- [x] cleanup of open non-architectural, non-feature issues

**Not planned:** presentation: no visible change for non-technical users.

**Unplanned work**

- support for HTTP in testing/evaluating mode with very perceptible warnings
- CD pipeline cutover to manual pull-based deploy, GHCR build
- i18n reconciliation — compounding debt that was producing spec contradictions

**Artifacts**

- quality-controlled test suite, docs, and spec
- ~~security review~~ deferred until next iteration
- backlog reduced to feature and architectural work

## Iteration 6 - Specification expansion

- [x] security review (deferred from iteration 5)
- [x] spec expansion — API and UI for: data import/export, user management, project management, customer management

**Unplanned work**

- tests for the new ACs
- implementation of API and UI for these
- implementation of API/UI for the LLM-email-extraction feature
- a presentation[^1]

**Artifacts**

- new spec sections regarding the above
- ACs for the above

## Iteration 7 - Cleanup and Data

- [x] cleanup: UI, open issues
- [x] data: import/export consolidation
- [x] data: alignment of workflows for testing and deployment, migrations
- [x] data: R2 integration
- [x] data: automated and manual backup and recovery

**Unplanned work**

(as we are way ahead of time)

- theming: dark mode with FOUC prevention, brand-accent token, per-user preference
- per-role navigation + data scoping, permission-aware UI
- archive / destructive-action UX overhaul
- idempotent create + duplicate-detection UX, deterministic transitions
- backup status API and UI hints
- a presentation[^1]

**Artifacts**

- polished UI
- new workflows defined, scripts added

## Iteration 8 - Uploads and Notifications

- [x] PWA/SW
- [x] a notification system
- [x] file uploads
- [x] a presentation[^1]

**Unplanned work**

(as we are still way ahead of time)

- taking pictures with the phone camera, automatic compression
- PWA app with push notifications
- API/UI for configuring notifications
- an extended project page
- layout improvements, especially for mobile users
- default page for different roles
- bulk download with archiving
- gradual switch to the deployed app on the VPS as the main testing target
- a backup notification in the UI

**Artifacts**

- a mobile-first view with file uploads
- configurable notification system
  _as well as all of the "Unplanned work" ones_

## Iteration 9 - e2e tests, polish, ops, data

- [x] more extensive testing with the deployed app and different clients
- [x] polish according to user feedback
- [x] extensive testing of the operator-driven processes
- [x] integration of B2
- [x] a presentation[^1]

**Artifacts**

- polished app
- polished docs
- e2e-tested workflows

## All iterations

- spec updated
- new tests / tests updated
- docs updated
- environment setup when introducing new technology
- retrospection

## Next iterations

presentation[^1] -> scope for the next iteration -> specification -> tests -> implementation -> presentation[^1] ...
until all goals, defined in the Definition of Done, are achieved (see [Done when](kickoff.md#done-when-final-product))

## Time allocation

We plan to use different LLMs in a custom workflow for most of the implementation work. Thus, we expect that the most time-consuming part of the project will be the clarification of goals, definition of the current scope, integration and quality control. We plan to start with a 3-day slot for an iteration cycle, which may be adjusted as needed.

[^1]: For this Open-Source repository, no real company data will be used and thus reasonable assumptions are to be made. See [Company specifics](kickoff.md#company-specifics)
