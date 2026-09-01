# ADR-0009: Pin Docker Engine and Compose versions across environments

- **Status:** Accepted
- **Date:** 2026-04-07 (last bump: 2026-07-14)
- **Confidence:** High

## Context

Docker runs in three places: developer workstations, CI (build + Compose validation), and the production VPS. All three install from the official `download.docker.com/linux/ubuntu` apt repo, which always resolves to current stable.

On 2026-04-07 a drift surfaced: the VPS (provisioned 2026-04-06) was on Docker 29.3.1 while a same-day fresh dev install pulled 29.4.0. Both had Compose plugin v5.1.1 by coincidence, not by enforcement. `unattended-upgrades` and `apt upgrade` can silently bump either host; drift compounds over time.

Key forces:

- **Local/prod parity is load-bearing.** ADR-0003 commits us to `docker compose up` producing identical stacks locally and in production. Silent version drift erodes that — a Compose-file or BuildKit syntax that works locally can fail on deploy.
- **VPS runs Docker in production.** Images are built in CI and pulled on the VPS (see [ADR-0011](0011-build-images-in-ci-distribute-via-ghcr.md)), but the VPS Docker version still governs runtime.
- **CI exercises Docker.** `ci.yml` has a `docker` job (Compose validation + image build + scan + runtime smoke) and a `publish` job (GHCR publish).
- **Solo operator.** No platform team to absorb surprise breakage. Determinism beats automatic patching at this scale.

## Decision

Pin Docker Engine, CLI, containerd, BuildKit plugin, and Compose plugin to explicit versions on every host; place all five on apt hold. Bumps are deliberate, lockstep across all environments.

**Pinned versions (as of 2026-07-14):**

| Package                 | Version                         |
| ----------------------- | ------------------------------- |
| `docker-ce`             | `5:29.6.1-1~ubuntu.24.04~noble` |
| `docker-ce-cli`         | `5:29.6.1-1~ubuntu.24.04~noble` |
| `containerd.io`         | `2.2.6-1~ubuntu.24.04~noble`    |
| `docker-buildx-plugin`  | `0.35.0-1~ubuntu.24.04~noble`   |
| `docker-compose-plugin` | `5.3.1-1~ubuntu.24.04~noble`    |

**Source of truth:** the VPS. Local environments match the VPS, not the other way around — so dev reproduces prod rather than leading it.

**Enforcement:** `sudo apt-mark hold` on all five; verify via `apt-mark showhold` on install and on each host audit.

**Upgrades:** [server-setup.md § Upgrading pinned versions](../ops/server-setup.md#upgrading-pinned-versions).

## Alternatives Considered

- **Track `latest` (status quo).** `apt-get install docker-ce`, auto-upgrades. Security patches land automatically but breaks local/prod parity silently with no drift monitoring.
- **Snap-based Docker.** `snap install docker`. Not published by Docker Inc., lags upstream, history of cgroup/socket-path quirks breaking Compose v2 healthchecks, opaque update cadence. Trades explicit drift for implicit drift.
- **Ubuntu's `docker.io`.** Distro package, eligible for Ubuntu security updates. Lags upstream on patches; does not include Compose V2 (see `docs/ops/server-setup.md` Phase 4).
- **Pin Engine only, leave plugins floating.** Less maintenance, but Compose-file semantics and BuildKit behaviour live in the plugins — exactly the layer this ADR stabilises.

## Consequences

### Positive

- `docker compose` behaviour is deterministic across local, VPS, and future hosts.
- Silent `apt upgrade` drift is eliminated at the package layer.
- Upgrades are explicit, reviewable changes — easy to correlate with regressions.
- Reproducing production incidents locally is reliable.

### Negative

- Docker security patches require manual operator action; advisories must be tracked.
- Upgrade is a coordinated multi-host procedure; forgetting a host reintroduces drift.
- This ADR's pinned-version table must be kept current.
- Fresh-host setup gains a manual step (install explicit version + hold).

### Mitigations

- Security-advisory tracking mechanism is an open decision; interim backstop is manually checking Docker release notes before any bump.
- `apt-mark showhold` is part of post-install verification (see `docs/ops/server-setup.md` Phase 4).

## Dep lifecycle health (as of 2026-07-14)

The "Pinned versions" table above is the version surface. Upstream metadata:

| Dep                                                                                            | License    | Maintainership           | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------- | ---------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker-ce`, `docker-ce-cli`, `containerd.io`, `docker-buildx-plugin`, `docker-compose-plugin` | Apache-2.0 | Docker Inc., very active | CVE channel: [Docker Engine release notes](https://docs.docker.com/engine/release-notes/) + GHSA. These packages are installed on the VPS host (not in a container), so [ADR-0027](0027-continuous-dependency-updates-with-supply-chain-scanning.md)'s Renovate config does NOT track them. Bumps require the lockstep upgrade procedure (see § Upgrades above); the quarterly review walk (per [docs/ops/dep-management.md](../ops/dep-management.md#quarterly-lifecycle-review)) and the Docker release-notes channel are the surfacing mechanism. |

## References

- [ADR-0003: Deployment infrastructure — VPS, Docker Compose, GitHub Actions](0003-deployment-infrastructure-vps-docker-compose-github-actions.md)
- [ADR-0011: Build app images in CI, distribute via GHCR](0011-build-images-in-ci-distribute-via-ghcr.md) — CI now builds and pushes images
- [docs/ops/server-setup.md](../ops/server-setup.md) — step 4 (Docker install, VPS)
- [docs/ops/local-dev.md](../ops/local-dev.md) — Installing Docker (dev workstation)
- Docker apt repository: https://download.docker.com/linux/ubuntu
