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

Pin Docker Engine, CLI, containerd, BuildKit plugin, and Compose plugin to explicit versions on every host; place all five on apt hold. Bumps are deliberate, lockstep across all hosts, and accepted on the VPS before they merge.

```
docker/host-versions.txt ──▶ Renovate PR (grouped, quarterly, manual merge)
  └─▶ VPS: deploy.sh <PR branch> → refuses on drift → docker-converge.sh → deploy.sh → acceptance
        ├─ pass → merge → converge the dev workstation
        └─ fail → revert → close the PR
```

- **Source of truth:** [`docker/host-versions.txt`](../../docker/host-versions.txt). Hosts converge to the file; no copy of the versions lives anywhere else.
- **Image store:** the containerd image store, the Engine 29 fresh-install default. It is part of "in sync": an in-place upgrade from an older Engine keeps overlay2 ([Docker docs](https://docs.docker.com/engine/storage/containerd/)). The converge script reports store drift but never switches the store, which would hide every existing image and container.
- **Hosts:** `scripts/ops/docker-converge.sh` installs the five pins in one call and holds them; a no-op when in sync. `--check` reports drift without installing.
- **Enforcement:** `deploy.sh` runs `--check` before any compose call and refuses to deploy on drift; `.husky/pre-push` warns. After deploying, `deploy.sh` checks health through Caddy on the published address, the layer Engine releases change.
- **Bumps:** Renovate proposes one grouped PR (`deb` datasource) per quarter, never auto-merged. The operator tests it on the VPS (staging) with `scripts/ops/docker-bump.sh`, which switches the host and runs the acceptance, and merges only once it passes. Procedure, acceptance and revert: [server-setup.md § Upgrading pinned versions](../ops/server-setup.md#upgrading-pinned-versions).
- **CI does not run the pins.** It uses the runner's Docker. The acceptance test is the real host: a runner has no ufw, WireGuard or external storage, where Engine releases change behaviour.

## Alternatives Considered

- **Track `latest` (status quo).** `apt-get install docker-ce`, auto-upgrades. Security patches land automatically but breaks local/prod parity silently with no drift monitoring.
- **Snap-based Docker.** `snap install docker`. Not published by Docker Inc., lags upstream, history of cgroup/socket-path quirks breaking Compose v2 healthchecks, opaque update cadence. Trades explicit drift for implicit drift.
- **Ubuntu's `docker.io`.** Distro package, eligible for Ubuntu security updates. Lags upstream on patches; does not include Compose V2.
- **Pin Engine only, leave plugins floating.** Less maintenance, but Compose-file semantics and BuildKit behaviour live in the plugins — exactly the layer this ADR stabilises.
- **Unattended host upgrades.** No `live-restore`, so every upgrade restarts the daemon and the app stays down until the operator pastes the key ([ADR-0024](0024-binary-attachment-e2e-encryption.md)). Docker releases almost every week.
- **CI on the pins** (install the pins on the runner; upgrade and revert a running stack on every bump PR). Prototyped in [#606](https://github.com/Projekt-Manager-Org/Projekt-Manager/pull/606): about 1,100 lines of CI and scripts. Its only coverage beyond the VPS acceptance was a downgrade proof on a fresh runner, and the runner lacks the network setup where Engine releases break things.

## Consequences

### Positive

- `docker compose` behaviour is deterministic across local, VPS, and future hosts.
- Silent `apt upgrade` drift is eliminated at the package layer.
- Upgrades are explicit, reviewable changes — easy to correlate with regressions.
- Reproducing production incidents locally is reliable.
- Releases surface as one Renovate PR per quarter; each bump is accepted on the real host before it merges.

### Negative

- Testing a bump is operator-run: one command on the VPS plus a check from a WireGuard client. Each converge restarts the daemon: an outage until the key paste.
- While open, the `docker-host` PR holds Renovate's single PR slot.
- No release-age cooldown: the `deb` datasource reports no release timestamps. Review judges a release's age.
- Renovate surfaces releases, not advisories: tracking and acting on them stay an operator duty ([Betriebsverantwortung §3](../compliance/betriebsverantwortung.md#3-operator)), supported by a nightly upstream-advisory feed (§2026-11-01).
- CI validates Compose files with the runner's Compose, not the pinned one.

## Dep lifecycle health (as of 2026-11-01)

The version surface is `docker/host-versions.txt`. Upstream metadata:

| Dep                                                                                            | License    | Maintainership           | Notes                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------- | ---------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker-ce`, `docker-ce-cli`, `containerd.io`, `docker-buildx-plugin`, `docker-compose-plugin` | Apache-2.0 | Docker Inc., very active | CVE channel: [Docker Engine release notes](https://docs.docker.com/engine/release-notes/) + upstream repo GHSAs (§2026-11-01). Tracked by Renovate ([ADR-0027](0027-continuous-dependency-updates-with-supply-chain-scanning.md)), `deb` datasource. containerd supports sequential minor upgrades only. |

## Amendments

### 2026-11-01 — Advisories reach the operator

[GHSA-7cfq-22r6-qp73](https://github.com/moby/moby/security/advisories/GHSA-7cfq-22r6-qp73) (HIGH) was found by hand 8 days after publishing ([#495](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/495)): nothing watched the host packages' advisories ([#699](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/699)). The quarterly window stays — each bump costs a daemon restart and a key paste — so the signal comes from upstream:

```
nightly ─▶ repo security advisories of each pinned package's upstream (docker/host-advisory-repos.txt)
        ─▶ not MEDIUM/LOW, updated in the last 7 days, not yet reported
        ─▶ one issue per advisory, assigned to the operator ─▶ triage, out-of-schedule bump if it applies
```

Triage: [server-setup.md § Triaging a Docker host advisory](../ops/server-setup.md#triaging-a-docker-host-advisory). Code: `scripts/ci/docker-host-advisories.sh`.

Accepted: no version check (upstream ranges are free text without an ecosystem); coverage is what the mapped repos publish (vendored Go libraries and the Go stdlib only via their own advisories); a fix ships when Docker's apt repo has it.

Rejected: scanning the pinned `.deb`s (blind to Engine and CLI, red monthly on Go stdlib); Ubuntu's `docker.io-app` packages (lagging evaluation, unattended daemon restarts wipe the keys); a monthly or current-by-default window (a key paste per bump, 2–3 Engine releases a month).

### 2026-10-23 — Pins in one file, bumps proposed by Renovate, accepted on the VPS

The version table was hand-synced in two documents, nothing but the quarterly review triggered a bump, and neither the acceptance of a bump nor a way back was written down. The VPS was the source of truth; the file is now ([#599](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/599)). New for the operator: `deploy.sh` refuses on drift (a non-containerd image store counts as drift) and checks health through Caddy.

## References

- [ADR-0003: Deployment infrastructure — VPS, Docker Compose, GitHub Actions](0003-deployment-infrastructure-vps-docker-compose-github-actions.md)
- [ADR-0011: Build app images in CI, distribute via GHCR](0011-build-images-in-ci-distribute-via-ghcr.md) — CI now builds and pushes images
- [docs/ops/server-setup.md](../ops/server-setup.md) — Phase 4 (Docker install, VPS), § Upgrading pinned versions
- [docs/ops/local-dev.md](../ops/local-dev.md) — Installing Docker (dev workstation)
- Docker apt repository: https://download.docker.com/linux/ubuntu
