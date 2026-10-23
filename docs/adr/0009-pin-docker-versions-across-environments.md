# ADR-0009: Pin Docker Engine and Compose versions across environments

- **Status:** Accepted
- **Date:** 2026-04-07 (amended 2026-10-23, #599)
- **Confidence:** High

## Context

Docker runs in three places: developer workstations, CI (build + Compose validation), and the production VPS. All three install from the official `download.docker.com/linux/ubuntu` apt repo, which always resolves to current stable.

On 2026-04-07 a drift surfaced: the VPS (provisioned 2026-04-06) was on Docker 29.3.1 while a same-day fresh dev install pulled 29.4.0. Both had Compose plugin v5.1.1 by coincidence, not by enforcement. `unattended-upgrades` and `apt upgrade` can silently bump either host; drift compounds over time.

Key forces:

- **Local/prod parity is load-bearing.** ADR-0003 commits us to `docker compose up` producing identical stacks locally and in production. Silent version drift erodes that — a Compose-file or BuildKit syntax that works locally can fail on deploy.
- **VPS runs Docker in production.** Images are built in CI and pulled on the VPS (see [ADR-0011](0011-build-images-in-ci-distribute-via-ghcr.md)), but the VPS Docker version still governs runtime.
- **CI exercises Docker.** `ci.yml` validates Compose files in `lint`, builds, scans and smokes images in `docker`, and publishes them in `publish`.
- **Solo operator.** No platform team to absorb surprise breakage. Determinism beats automatic patching at this scale.

## Decision

Pin Docker Engine, CLI, containerd, BuildKit plugin, and Compose plugin to explicit versions on every host; place all five on apt hold. Bumps are deliberate, lockstep across all environments.

```
docker/host-versions.txt ──▶ Renovate PR (grouped, manual merge)
        │                            │
        ├──▶ CI installs the pins ───┘  compose validation + smoke + Caddy build = merge check
        ├──▶ docker-converge.sh (sudo, one command per host)
        └──▶ deploy.sh: docker-converge.sh --check → refuses on drift
```

- **Source of truth:** [`docker/host-versions.txt`](../../docker/host-versions.txt). Hosts converge to the file; no copy of the versions lives anywhere else.
- **Image store:** the containerd image store, the Engine 29 fresh-install default. It is part of "in sync": an in-place upgrade from an older Engine keeps overlay2 ([Docker docs](https://docs.docker.com/engine/storage/containerd/)). The converge script reports store drift but never switches the store, which would hide every existing image and container.
- **Hosts:** `scripts/ops/docker-converge.sh` installs the five pins in one call and holds them; a no-op when in sync. `--check` reports drift without installing.
- **Enforcement:** `deploy.sh` runs `--check` before any compose call and refuses to deploy on drift; `.husky/pre-push` warns.
- **Bumps:** Renovate proposes one grouped PR (`deb` datasource), never auto-merged. Merging is the decision to converge the hosts now. Procedure: [server-setup.md § Upgrading pinned versions](../ops/server-setup.md#upgrading-pinned-versions).
- **CI:** `.github/actions/install-docker` brings the runner to the pins (same converge script) wherever CI reproduces what a host does with its own Docker: `lint`'s compose validation, the `build-scan-smoke` composite, and the Caddy build (the one image a host builds itself; path-filtered). Jobs with `services:` (e2e, `check-shard`) stay on the runner's Docker: they need only _a_ container, and the install's daemon restart would stop theirs.

## Alternatives Considered

- **Track `latest` (status quo).** `apt-get install docker-ce`, auto-upgrades. Security patches land automatically but breaks local/prod parity silently with no drift monitoring.
- **Snap-based Docker.** `snap install docker`. Not published by Docker Inc., lags upstream, history of cgroup/socket-path quirks breaking Compose v2 healthchecks, opaque update cadence. Trades explicit drift for implicit drift.
- **Ubuntu's `docker.io`.** Distro package, eligible for Ubuntu security updates. Lags upstream on patches; does not include Compose V2.
- **Pin Engine only, leave plugins floating.** Less maintenance, but Compose-file semantics and BuildKit behaviour live in the plugins — exactly the layer this ADR stabilises.
- **Unattended host upgrades** (a timer converging the VPS after merge). No `live-restore`, so every upgrade restarts the daemon and stops every container — downtime at a time nobody chose.

## Consequences

### Positive

- `docker compose` behaviour is deterministic across local, VPS, CI, and future hosts.
- Silent `apt upgrade` drift is eliminated at the package layer.
- Upgrades are explicit, reviewable changes — easy to correlate with regressions.
- Reproducing production incidents locally is reliable.
- New releases surface as a Renovate PR whose CI ran on exactly the proposed versions.

### Negative

- Applying a bump stays a manual step per host, and it restarts the daemon (all containers stop; tmpfs keys are wiped until the next `deploy.sh`).
- A merged bump blocks deploys until the VPS is converged.
- Pinned CI costs an apt install per `lint` and `docker` run.
- No release-age cooldown: the `deb` datasource reports no release timestamps. Manual merge is the delay.
- Renovate surfaces releases, not advisories: advisory tracking stays an operator duty ([Betriebsverantwortung §3](../compliance/betriebsverantwortung.md#3-operator)).

## Dep lifecycle health (as of 2026-10-23)

The version surface is `docker/host-versions.txt`. Upstream metadata:

| Dep                                                                                            | License    | Maintainership           | Notes                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------- | ---------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker-ce`, `docker-ce-cli`, `containerd.io`, `docker-buildx-plugin`, `docker-compose-plugin` | Apache-2.0 | Docker Inc., very active | CVE channel: [Docker Engine release notes](https://docs.docker.com/engine/release-notes/) + GHSA. Tracked by Renovate ([ADR-0027](0027-continuous-dependency-updates-with-supply-chain-scanning.md)), `deb` datasource. |

## Amendments

### 2026-10-23 — Pins in one file, bumps proposed by Renovate, CI on the pins

Manual tracking did not hold: on 2026-10-23 all five packages were behind, and the previous bump had moved only Engine and containerd, leaving buildx and Compose 3–4 months stale. The version table was hand-synced in two documents, and CI ran the runner's own Docker (Engine 28, Compose 2.38, overlay2), so a green CI said nothing about the pins. The VPS was the source of truth; the file is now ([#599](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/599)). New for the operator: `deploy.sh` refuses on drift, and a non-containerd image store counts as drift.

## References

- [ADR-0003: Deployment infrastructure — VPS, Docker Compose, GitHub Actions](0003-deployment-infrastructure-vps-docker-compose-github-actions.md)
- [ADR-0011: Build app images in CI, distribute via GHCR](0011-build-images-in-ci-distribute-via-ghcr.md) — CI now builds and pushes images
- [docs/ops/server-setup.md](../ops/server-setup.md) — Phase 4 (Docker install, VPS), § Upgrading pinned versions
- [docs/ops/local-dev.md](../ops/local-dev.md) — Installing Docker (dev workstation)
- Docker apt repository: https://download.docker.com/linux/ubuntu
