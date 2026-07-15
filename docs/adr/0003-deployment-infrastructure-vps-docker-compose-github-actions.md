# ADR-0003: Deployment infrastructure — VPS, Docker Compose, GitHub Actions

- **Status:** Accepted
- **Date:** 2026-04-04
- **Confidence:** High

## Context

Iteration 2 requires deploying the application (frontend + API), PostgreSQL, and S3-compatible object storage — demonstrating full functionality for a pilot audience on a near-zero budget (free to ~€5/month).

Key forces:

- **Portability over convenience.** ADR-0001 mandates multiple independent deployments. The same codebase must run on a small demo VPS, a larger production server, or on managed PaaS — without code changes.
- **Operational simplicity.** A solo developer operates the demo. Multi-provider dashboards add cognitive overhead disproportionate to the scale.
- **Contributor onboarding.** Cloning the repo must yield a full local stack without installing PostgreSQL, MinIO, etc. individually.
- **CI/CD required.** Spec mandates continuous delivery with a pre-deploy test gate (lint, type-check, unit, component, integration tests).

## Decision

All services on a single VPS via Docker Compose, with GitHub Actions for CI. Images are built in CI and distributed via GHCR; deploys are manual pull-based operations over WireGuard (see [ADR-0011](0011-build-images-in-ci-distribute-via-ghcr.md), [ADR-0012](0012-manual-pull-based-deploy-over-wireguard.md)).

**Infrastructure:**

- **VPS** as deployment target (e.g., Hetzner CX23 at 2 vCPU / 4 GB RAM / 40 GB disk, ~€4–6/month).
- **Docker Compose** declares the full stack: app, PostgreSQL, MinIO, Caddy reverse proxy. Single source of truth.
- **PostgreSQL** in a Docker container with a mounted volume. Swappable for any managed PostgreSQL (Supabase, RDS) via connection string.
- **MinIO** for S3-compatible object storage. Swappable for Cloudflare R2, AWS S3, or any S3-compatible provider via endpoint and credentials.
- **Caddy** reverse proxy with HTTPS via Let's Encrypt DNS-01 ACME (Cloudflare). See [ADR-0008](0008-vpn-first-network-access.md).

**Deployment pattern:**

- **Monolith.** Backend serves both the API and the static frontend build (Vite output). One service, one URL, no CORS.

**CI/CD pipeline:**

- **GitHub Actions** runs the full test suite on GitHub's free runners on every push to `main`. The VPS never runs tests.
- **On green:** CI builds and pushes the app image to GHCR. Operator deploys manually on the VPS via `scripts/deploy.sh` over WireGuard.
- **Rollback:** re-deploy a previous SHA-tagged image via the same script.

**Portability contract:**

- `docker compose up` runs the complete system — locally, on any VPS, or in any Docker-capable environment.
- Swapping a containerized service for a managed offering requires only env var changes.

## Alternatives Considered

### PaaS (Render, Railway, Fly.io)

Faster setup, managed infra, built-in CI/CD. Rejected: each provider manages only part of the stack (DB on one, storage on another, app on a third) — multiple accounts, dashboards, billing. Docker Compose gives the same portability without provider coupling, and VPS operational burden scales with demo size (1–5 users, single server).

### Bare metal on VPS (no Docker)

Fewer abstractions — `apt install` each dependency. Rejected: every contributor and operator must install and configure the full stack manually. Docker Compose reduces the prerequisite to `docker` plus a single command.

### Webhook-based CD (server self-deploys on GitHub webhook)

Server listens for push events and pulls itself. Rejected: tests would run on the VPS (competing with production, risking broken deploys), the listener is custom infra to write and maintain, and the exposed endpoint adds attack surface. GitHub Actions already provides the test gate, execution env, and logs.

### Split deployment (frontend and backend on separate hosts)

Frontend on a static host (Vercel, Netlify), backend elsewhere. Rejected: introduces CORS config, two CI pipelines, two services to monitor — complexity without benefit at this scale. The spec supports same-origin serving.

## Consequences

### Positive

- Full control over the stack — no provider abstractions to work around
- Reproducible: `docker compose up` runs the identical stack locally and in production
- Portable: swapping any service for a managed alternative is a config change
- Cheapest long-term (~€5/month vs. expiring free tiers)
- Operator learns what PaaS abstracts — transferable knowledge

### Negative

- Operator is the ops team: OS patches, firewall rules, monitoring are manual (`unattended-upgrades` covers most, not all)
- No redundancy — single server means downtime during hardware failure or maintenance
- Database backups must be implemented manually (scheduled `pg_dump` to off-server storage)
- Initial server setup (firewall, Docker, DNS, Caddy) takes longer than a PaaS first deploy

## Dep lifecycle health (as of 2026-05-15)

| Dep                               | Status                                                                                                                                            | Notes                                                                                                                                                                                                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker Engine + Compose plugin    | see [ADR-0009](0009-pin-docker-versions-across-environments.md) version table                                                                     | Apache-2.0, Docker Inc., very active. Lifecycle surface lives in ADR-0009.                                                                                                                                                                                                                                              |
| PostgreSQL (`postgres:17-alpine`) | active; Postgres 17 supported through 2029-11                                                                                                     | PostgreSQL Licence, PGDG, very active. Image tag floats; minor releases on the official Postgres quarterly cadence.                                                                                                                                                                                                     |
| MinIO (dev/CI mirror only)        | **upstream archived 2026-04-24**                                                                                                                  | AGPL-3.0. `RELEASE.2025-10-15T17-29-55Z` is the last release ever; migration off in flight ([#191](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/191)). The canonical "adopted-already-dying" failure case that motivated [ADR-0027](0027-continuous-dependency-updates-with-supply-chain-scanning.md). |
| Caddy                             | 2.11.3 (released 2026-05-12; security-bumped on the VPS 2026-05-15 per [#187](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/187)) | Apache-2.0, Stack Holdings / Light Code Labs, very active. Release carried four security patches (fastcgi non-PHP execution, GHSA-m2w3-8f23-hxxf vars-module follow-up, admin-socket auth bypass × 2). `caddy-dns/cloudflare` plugin pinned by commit SHA (HEAD on `main`).                                             |
| GitHub Actions / GHCR             | see [ADR-0011](0011-build-images-in-ci-distribute-via-ghcr.md)                                                                                    | GitHub Inc.-managed platform; Renovate manages action-SHA pins.                                                                                                                                                                                                                                                         |

## References

- [ADR-0001: Generalized system with configurable customer specifics](0001-generalized-system-with-configurable-customer-specifics.md)
- [ADR-0002: Tech Stack — TypeScript, React 19, Vite, Zustand](0002-tech-stack-typescript-react-vite-zustand.md)
- [ADR-0011: Build app images in CI, distribute via GHCR](0011-build-images-in-ci-distribute-via-ghcr.md) — refines the image-build topology
- [ADR-0012: Manual pull-based deploy over WireGuard](0012-manual-pull-based-deploy-over-wireguard.md) — replaces the deploy leg
- [Product Spec](../spec/index.md)
- [Architecture — Responsibility layers](../spec/architecture.md)
