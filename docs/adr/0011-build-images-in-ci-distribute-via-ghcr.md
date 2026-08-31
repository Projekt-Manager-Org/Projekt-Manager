# ADR-0011: Build app images in CI, distribute via GHCR

- **Status:** Accepted
- **Date:** 2026-04-09
- **Confidence:** High

## Context

ADR-0003 set the deployment topology (VPS + Docker Compose + GitHub Actions) but left the _location_ of image builds implicit. Previously, images were built on the VPS immediately before `docker compose up -d`.

With iteration 4's walking skeleton live, the resource math no longer holds:

| Component                           | RAM         |
| ----------------------------------- | ----------- |
| `app` container (limit)             | 512 MB      |
| `db` container (limit)              | 512 MB      |
| `storage` (MinIO) container (limit) | 512 MB      |
| `caddy` container (limit)           | 128 MB      |
| Docker daemon                       | ~200 MB     |
| Kernel + misc                       | ~500 MB     |
| **Baseline running stack**          | **~2.4 GB** |

VPS is 2 vCPU / 4 GB, leaving ~1.6 GB free at idle. `docker compose build app` peaks at ~1–1.5 GB (two `npm ci`, `tsc --noEmit` loading the full type graph, `vite build` running esbuild + rollup). Total ~3.6 GB of 4 GB — headroom collapses under any load. Realistic failure modes during a deploy:

- **OOM killer** picks a victim (app, postgres, or the build).
- **Swap thrashing** degrades the running app for the full 2–3 minute build.
- **Slow rollback**: rebuild still competes with the running stack.

Key forces:

- **Foundation quality.** CLAUDE.md §Principles rejects "document and accept" for foundation issues. A 2 vCPU / 4 GB VPS building its own image in production is not acceptable long-term.
- **Attended deploys.** Operator watches every deploy (solo dev, email on failure). The real need is to stop the deploy from disturbing the running stack, not automatic rollback.
- **Local/prod parity (ADR-0009).** VPS and dev machines run pinned Docker so `docker compose up` is deterministic. Moving builds to CI puts a CI runner in the build path — its Docker version is not under the same pin.
- **VPN-first (ADR-0008).** The app is only reachable via WG. A GitHub runner cannot reach the running app. CI only needs to reach GHCR, which is public.

## Decision

Build the production `app` image in GitHub Actions, push to GitHub Container Registry (`ghcr.io/projekt-manager-org/projekt-manager`), pull on the VPS during deploy.

**CI pipeline:**

Two composite actions in `.github/actions/`, deliberately split at the publish boundary so validation cannot be skipped and publishing cannot happen without it:

- **`build-scan-smoke`** — builds both images into the runner's local store, Trivy-scans both, boots the stack and runs the smoke. Publishes nothing.
- **`push-images`** — logs in to GHCR and pushes both. Every layer is a gha cache hit from the preceding `build-scan-smoke`, so this re-materialises rather than rebuilds.

Callers in `.github/workflows/ci.yml`:

| Job       | Event                                                               | Runs                                                              |
| --------- | ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `docker`  | every PR, `merge_group`, `workflow_dispatch`                        | `build-scan-smoke` → Tier 1 round-trip                            |
| `publish` | PR (non-fork) + `workflow_dispatch`, `needs: [check, lint, docker]` | `push-images` → `sha-<pr-tip>` + `<branch-slug>`                  |
| `promote` | `push: main`                                                        | re-tag (see next section); fallback runs both composites in order |

- Neither job is path-filtered. A TypeScript change alters image contents without touching `Dockerfile`, so a filter ships stale images — and a skipped required check counts as met, which is how `main` accumulated commits whose container was first built post-merge (#355).
- `docker/login-action` authenticates to GHCR with the built-in `GITHUB_TOKEN` (no separate secret).
- `docker/build-push-action` with `cache-from: type=gha, cache-to: type=gha,mode=max` — warm builds ~10–15s.
- `publish` and `promote` declare `packages: write` (default is `contents: read`); `promote` additionally declares `pull-requests: read` for the PR-discovery API call. `docker` declares neither — it cannot publish even by mistake.
- **`publish` is a required status check on `main`**, alongside `check`, `lint` and `docker`. This is an ordering constraint, not a fourth gate. `publish` and auto-merge both become eligible the instant `check` + `lint` + `docker` go green, so without it a Renovate auto-merge advances `main` and deletes the head branch while `publish` is still pushing — and guard 3 then finds no `sha-<pr-tip>` and pays the full fallback rebuild on the repo's highest-volume merge path. It survived on a timing margin (`promote` re-runs `check` + `lint`, ~4 min, before guard 3 executes; `publish` takes ~1.5 min), not on ordering. Fork PRs are unaffected: their `publish` is skipped by its `if:`, and a skipped job satisfies a required check. The cost is that a GHCR outage blocks merges — correct, since `promote` could not publish through one either.
- `concurrency.cancel-in-progress` exempts `push`. On a PR the newer run re-validates the same branch, so cancelling is free; on `push: main` the run is the sole producer of that commit's artifact, and cancelling it leaves the commit unpublishable (#355 §5).

**Build once, promote on merge:**

Industry pattern (Vercel, Netlify, Cloudflare Pages, AWS CodePipeline, Heroku): build the artifact once during the PR/preview phase, then promote it to production by re-tagging — do not rebuild on merge. Named practice: **immutable artifact + tag promotion**. Aligns forward-looking with SLSA Level 2/3 single-build provenance.

**The build stage is CI's, not an operator's.** The first version of this ADR made step 1 a manual `gh workflow run ci.yml --ref <branch>`. A pipeline stage gated on a human remembering a CLI invocation is not a pipeline stage: the dispatch fired **0 times in 100 CI runs**, guard 3 therefore failed on **100% of merges**, and every merge paid the full rebuild this section exists to avoid (#355). The dispatch survives as an operator escape hatch for deploying a feature branch to the VPS — it is no longer load-bearing.

Flow:

```
PR ──► docker    build ─► scan ─► smoke            (required check, every PR)
       publish   push sha-<pr-tip> + <branch-slug> (required check; needs: check + lint + docker)

merge ──► promote  guard 1,2,3 ✓ ──► imagetools create ──► sha-<merge> + main   ~30s
                                 ✗ ──► build ─► scan ─► smoke ─► push           ~5 min
```

1. PR opens. `docker` builds both images, scans both, and smokes them. `publish` waits on `check`, `lint` **and** `docker`, then pushes `sha-<pr-tip>` + `<branch-slug>`. Nothing reaches GHCR that has not passed every gate.

   **Precondition: the promotable artifact is the one built from the _final_ PR tip.** Guard 3 resolves `sha-<pr-tip>` at merge time. Each push to the PR produces its own `sha-<tip>`, so this holds automatically — a force-push that discards the last-built tip is the one case that orphans the artifact and sends the merge down the rebuild path.

2. PR merges to `main` (squash — the only method enabled). `promote` fires on `push: main`. Three guards:
   - **PR discovery** — `gh api repos/.../commits/${GITHUB_SHA}/pulls` must return the PR's head SHA. Direct pushes to `main` (hot-fix) return empty → fallback.
   - **Tree equality** — `tree(merge-sha) == tree(pr-tip)`. Squash preserves the tree, but `strict_required_status_checks_policy` still permits `main` advancing between the last green run and the merge, folding those commits into the squash → fallback.
   - **Source image present on GHCR** — `docker manifest inspect ghcr.io/.../sha-<pr-tip>` must succeed. Fork PR, or a force-push after the last green run → fallback.
3. Happy path: `docker buildx imagetools create -t <new-tag> <src-tag>` for both images, creating `sha-<merge-sha>` + `main` from `sha-<pr-tip>`. ~30s. Registry-level copy — no pull, no daemon involvement, so the OCI image-index wrapper and the buildx-generated provenance/SBOM attestation manifests are preserved (a plain `docker pull/tag/push` cycle would drop the attestation entry; observed on the first promote run in #226). No rebuild, no rescan, no smoke — the artifact is bit-for-bit identical to what `docker` validated before the merge.
4. Fallback: `build-scan-smoke` then `push-images`, in that order, against the merge SHA. ~5 min on main's (cold-ish) cache scope. Operators see a `::warning::` in the run log explaining which guard failed.

PR-tip discovery is via GitHub's merge metadata (`gh api .../commits/<sha>/pulls`) and not via a PR label. A label channel would persist past a force-push-then-merge and could promote stale bytes; using the API ties discovery to the actual merge.

Promotion is exact-artifact only. `GIT_SHA` is baked into the client bundle for the footer version chip, so every commit yields distinct image bytes — there is no "close enough" ancestor to promote. Guard 3's exact-SHA lookup is the only sound key, and a rebuild when the tip moved after the last green run is correct behavior, not waste.

**Fork PRs do not publish.** `publish` carries a job-level `if:` requiring `head.repo.full_name == github.repository`. **That condition, not token scope, is what skips the job.** GitHub never skips a job over permissions — it hands a fork PR a read-only `GITHUB_TOKEN` regardless of the job's `permissions:` block ("The `GITHUB_TOKEN` has read-only permissions in pull requests from forked repositories") and lets the run fail. Delete the `if:` as redundant and every fork PR gets a red `publish` dying on `denied: permission_denied` at push time. `docker` still runs, so a fork PR is validated exactly like any other; its merge simply takes the fallback rebuild. Deliberate, not a gap.

**Publishing follows validation, never precedes it.** `build-scan-smoke` aliases the locally-built images to their GHCR refs (`docker tag`) before `compose up`. No compose file sets `pull_policy`, so compose defaults to `missing` and resolves both services from the local store — the smoke exercises the real compose config against the exact bytes just scanned, with nothing published. The earlier ordering pushed first so the smoke could exercise the `compose pull` path; that bought a registry round-trip at the price of publishing an unvalidated image, and a smoke failure left a pullable `sha-<commit>` behind (#355 §1). The round-trip is exercised by the next `scripts/deploy.sh` run regardless.

Trade-offs accepted:

- **Every PR pays the image build.** ~6–7 min for `docker` + `publish`, where the path filter previously skipped it on most PRs. Against that, the ~5 min post-merge rebuild is gone and the runtime smoke becomes a pre-merge gate. Roughly neutral per merged PR; strictly better per merged defect.
- **Trivy DB binds to PR time.** CVEs published between the last PR run and the merge slip past until the daily `security-scheduled.yml` catches them. Typically minutes to hours.
- **GHCR tag count.** Each push to a PR branch produces its own `sha-<pr-tip>` app+backup pair plus a moving `<branch-slug>` pair, on top of `sha-<merge-sha>` + `main` per merge — call it 5–10 immutable SHA tags per merged PR, plus everything left behind by PRs that never merge. The dispatch-driven design produced ~2× because the dispatch never fired. **Nothing reaps any of it** — see Retention below.
- **`publish` re-materialises rather than reusing `docker`'s bytes.** The two run on different runners, so the local image store does not carry over; `publish` rebuilds from the gha cache both jobs share. Identical build-args and cache keys make this a layer-for-layer cache hit, but it is a cache-identity assumption rather than a proof.

  The residual risk is narrower than "the bytes might differ", and worth naming exactly: both `FROM` lines are digest-pinned (`node:24.16.0-alpine@sha256:21f4…`) and the `GIT_SHA` / `APP_IMAGE_TAG` build-args are passed identically, so on a cache **hit** the bytes are identical by construction. The single nondeterministic input is `apk add --no-cache` (`Dockerfile:74`, `Dockerfile.backup:107`): on a cache **miss** between `docker` and `publish`, that layer can resolve Alpine package versions Trivy never scanned.

  Alternatives — uploading the ~400 MB OCI layout as a workflow artifact, or pushing from `docker` and gating the tag afterwards — cost more than the assumption is worth at this scale. Turning it into an assertion is cheap and is the tracked follow-up: `docker/build-push-action` emits an `imageid` output, so surfacing it from `build-scan-smoke` and comparing against `push-images` fails the run on divergence. It needs empirical confirmation first that `imageid` is stable across a `load: true` build and a `push: true` build carrying provenance attestations; if it is not, the same check works on the app layer digests.

- **`publish` is the first PR-triggered job in this repo holding `packages: write`.** It checks out and executes PR-authored code — `.github/actions/push-images/action.yml`, `Dockerfile`, `Dockerfile.backup` — with a GHCR write token in scope. **Accepted, and why:** the `if:` restricts the job to same-repo head branches, so the actor already holds push access here and could publish the same images by pushing a branch and dispatching the workflow. The boundary is genuinely wider than before; the capability it grants is not new. Fork PRs — the untrusted population — never reach the job. CONTRIBUTING § Security audit's trigger question reads yes for this change ("communicates externally"), so this is a recorded acceptance rather than an unasked question.

**Tagging:**

- **Immutable**: `ghcr.io/projekt-manager-org/projekt-manager:sha-<commit>` — one per commit, the rollback target.
- **Moving**: `ghcr.io/projekt-manager-org/projekt-manager:<branch-slug>` — latest on each branch, human-friendly fallback.

**Compose topology:**

- `docker-compose.yml` (prod): `app` uses `image: ghcr.io/projekt-manager-org/projekt-manager:<tag>`, no `build:` — pure runtime descriptor.
- `docker-compose.dev.yml` (dev overlay): reintroduces `build: .` so local dev builds from source.
- Deploy: `scripts/deploy.sh` runs `docker compose pull app && docker compose up -d` (see [ADR-0012](0012-manual-pull-based-deploy-over-wireguard.md)).

**Image visibility:** private, matching the repo. Re-examine if any component goes beyond the WG tunnel.

**Retention: intended, not configured.** The intent is GHCR's built-in "keep last 20 untagged versions", with branch-tagged versions retained until branch deletion. Neither half is in place today — no retention policy on the packages, and no cleanup workflow in `.github/workflows/` (`cache-cleanup.yml` reaps GHA caches only). The built-in policy would not touch `sha-` tags in any case: they are _tagged_ versions. Reaping them needs a scheduled `actions/delete-package-versions` job keyed on age. Open operational gap — see Consequences.

## Alternatives Considered

- **Build on VPS (status quo).** Simplest topology, no registry dependency. Ruled out on the resource math — co-locating build peaks with the running stack on 2 vCPU / 4 GB is not sustainable. "Foundation quality is the point."
- **Upgrade the VPS.** Hetzner CX32 (4 vCPU / 8 GB, ~€8/month). Does not solve the co-location problem, just hides it behind more RAM.
- **Self-hosted runner inside WG.** No external registry dependency. Rejected: adds a second stateful host to operate and a self-hosted runner is itself security-sensitive (executes arbitrary workflow code). Zero savings — GHCR is free and already authenticated.
- **Docker Hub.** Pull-rate limits on unauthenticated users (eventually affects deploy), separate account/token, nothing GHCR does not give for a GitHub-hosted project.
- **S3/R2-backed OCI registry (Distribution or Harbor).** S3 is not an OCI registry; a self-run registry adds a stateful component for zero benefit at this scale.

## Consequences

### Positive

- VPS stops doing build work during deploys; live requests are undisturbed by `npm ci` / `tsc` spikes.
- Deploy wall-clock drops from ~3 minutes to ~15 seconds (build moved, not disappeared — but paid on capacity we have).
- Rollback is `docker compose pull app:sha-<old> && docker compose up -d` — seconds, not a VPS rebuild.
- Image history lives in GHCR — free audit trail, inspectable from any `docker pull` client.
- VPS-loss recovery is trivial: fresh host pulls the desired SHA from GHCR and comes up.
- Build and runtime concerns cleanly separated — VPS is purely a runtime host.

### Negative

- GHCR becomes a runtime dependency for _deploying_ (not serving — the running image keeps running if GHCR is down). GitHub Actions is already the critical path, so no new SPOF in practice.
- CI cold build adds ~1–2 minutes; warm builds ~10–15s. Net system cost is lower, but individual CI runs feel slightly slower.
- Every commit produces a new image even on small deltas. GHA caching absorbs the redundant work; retention handles stale tags.
- Image retention is a new operational concern, and an unclosed one — stale SHA tags accumulate at 5–10 per merged PR with no policy and no cleanup job reaping them (see Decision § Retention).
- CI runner's Docker version is not pinned under ADR-0009. Controlled drift: OCI images are portable across reasonably-versioned daemons; only the manifest format needs to match. Upcoming security audit decides whether this needs explicit mitigation.

## Dep lifecycle health (as of 2026-05-15)

| Dep                              | Status                         | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub Actions                   | Active GitHub-managed platform | Action SHA pins live in `.github/workflows/`; Renovate maintains them under [ADR-0027](0027-continuous-dependency-updates-with-supply-chain-scanning.md). Every third-party action is SHA-pinned (regime established in [#187](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/187)); the current set is `actions/checkout`, `actions/setup-node`, `aquasecurity/trivy-action`, `docker/build-push-action`, `docker/login-action`, `docker/setup-buildx-action`, `google/osv-scanner-action`, `lycheeverse/lychee-action` — all on current latest, no published advisories. Two have left the set: `dorny/paths-filter` with the `changes` job (#355), and `ludeeus/action-shellcheck` for the runner's own `shellcheck` binary ([dep-management.md § Resolved](../ops/dep-management.md)). |
| GitHub Container Registry (GHCR) | Active GitHub-managed service  | Free for public repos and OSS; private retention controlled via repo settings. No published deprecation path; exit ramp would be Docker Hub or self-hosted Distribution (alternatives in this ADR).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## References

- [ADR-0003: Deployment infrastructure — VPS, Docker Compose, GitHub Actions](0003-deployment-infrastructure-vps-docker-compose-github-actions.md) — refines the CI/CD topology left open-ended there
- [ADR-0008: VPN-first network access](0008-vpn-first-network-access.md) — defines why a GitHub runner cannot reach the app directly
- [ADR-0009: Pin Docker Engine and Compose versions across environments](0009-pin-docker-versions-across-environments.md) — pin regime; this ADR introduces a controlled deviation for the CI builder
- [ADR-0012: Manual pull-based deploy over WireGuard](0012-manual-pull-based-deploy-over-wireguard.md) — replaces the distribution-to-host leg
