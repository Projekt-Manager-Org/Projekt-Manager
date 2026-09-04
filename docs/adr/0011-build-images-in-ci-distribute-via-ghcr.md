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

Three composite actions in `.github/actions/`, split at the **naming** boundary rather than the push boundary. The distinction is the whole design: bytes reach GHCR as an untagged digest, and a separate action — gated on every other check — is what gives them a name.

- **`build-scan-smoke`** — builds each image **once**, pushing it straight to GHCR with `push-by-digest=true`, then pulls the manifest back to Trivy-scan it, boot the stack and run the smoke against those exact bytes. A digest-only manifest carries no tag: nothing can `docker pull` it by name, `scripts/deploy.sh` cannot deploy it, and `promote`'s guard 3 cannot find it. Publishing, in the sense that matters, has not happened — which is what lets the push come first and makes "the scanned bytes are the published bytes" an identity rather than an argument about two builds.
- **`trivy-image`** — the image-scan policy (severity floor, unfixed handling, allowlist, cache location) stated once instead of once per call site.
- **`tag-images`** — points `sha-<commit>` and `<branch-slug>` at an existing GHCR digest via `docker buildx imagetools create`. Registry-side manifest copy: no pull, no build, no daemon. Both immutable `sha-` tags are written before either moving `<branch-slug>` tag, so an interrupted run leaves guard 3 satisfiable and at worst a stale slug the next run overwrites.

Callers in `.github/workflows/ci.yml`:

| Job       | Event                                                               | Runs                                                                      |
| --------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `docker`  | every PR, `merge_group`, `workflow_dispatch`                        | computes the tag triple → `build-scan-smoke` → Tier 1 round-trip          |
| `publish` | PR (non-fork) + `workflow_dispatch`, `needs: [check, lint, docker]` | `tag-images` → `sha-<pr-tip>` + `<branch-slug>`                           |
| `promote` | `push: main`                                                        | `tag-images` (see next section); fallback rebuilds then names the digests |

`scripts/ci/image-refs.sh` is the single derivation of the tag triple (`sha_tag`, `branch_slug`, `git_sha`) and the two GHCR repository paths. `docker` exposes its output as job outputs and `publish` consumes those rather than re-deriving them; `promote` runs the same script against the merge commit. `git_sha` is part of the image cache key, so two independent expressions of it can drift into naming bytes `docker` never validated — and the slug expression previously existed in five places, only one of which refused a branch whose slug is `main`. Lowercasing means a branch called `Main` lands on the production pointer, and since #355 a PR is a writer of the slug tag, not just an operator dispatch. The guard has a scenario table (`scripts/__tests__/image-refs.test.sh`) because its failure mode is publishing over production rather than a red build.

- Neither job is path-filtered. A TypeScript change alters image contents without touching `Dockerfile`, so a filter ships stale images — and a skipped required check counts as met, which is how `main` accumulated commits whose container was first built post-merge (#355).
- `docker/login-action` authenticates to GHCR with the built-in `GITHUB_TOKEN` (no separate secret).
- `docker/build-push-action` with `cache-from: type=gha, cache-to: type=gha,mode=max` — warm builds ~10–15s.
- `docker`, `publish` and `promote` all declare `packages: write` (default is `contents: read`); `promote` additionally declares `pull-requests: read` for the PR-discovery API call. `docker` holds it because it is where the digest push happens — see Trade-offs for why that boundary moved and what bounds it.
- **`publish` is a required status check on `main`**, alongside `check`, `lint` and `docker`. This is an ordering constraint, not a fourth gate. `publish` and auto-merge both become eligible the instant `check` + `lint` + `docker` go green, so without it a Renovate auto-merge advances `main` and deletes the head branch while `publish` is still pushing — and guard 3 then finds no `sha-<pr-tip>` and pays the full fallback rebuild on the repo's highest-volume merge path. It survived on a timing margin (`promote` re-runs `check` + `lint`, ~4 min, before guard 3 executes; `publish` takes ~1.5 min), not on ordering. Fork PRs do not arise here: they fail at `docker`, so nothing downstream is reached and the merge is blocked at the image gate rather than at this one. The cost is that a GHCR outage blocks merges — correct, since `promote` could not publish through one either.

  Branch protection and the merge queue disagree about skipped checks: branch protection counts one as met, the queue counts it as _not yet_ met and times out after 60 min (#214). A required `publish` therefore cannot be `if:`-skipped on `merge_group`. It runs there and skips its own steps instead — the job reports, publishes nothing, and the queue's train SHA (which nothing deploys) stays untagged.

- `concurrency.cancel-in-progress` is **on** for `pull_request` and `merge_group`, off for `push` and `workflow_dispatch`. Cancelling a PR run can no longer tear anything: the digest push has no tag to leave mismatched, and `tag-images` writes both `sha-<tip>` halves — the pair guard 3 requires — before either moving slug tag. `push: main` stays exempt because `promote` is the sole producer of that commit's artifact and a kill between the `sha-<merge>` and `main` writes leaves production's pointer behind with nothing to repair it (#355 §5); a `workflow_dispatch` is an operator explicitly asking for a deployable image. This reverses #355's blanket exemption, which cost a full pipeline per superseded PR push to protect a window the tag ordering now closes.

**Build once, promote on merge:**

Industry pattern (Vercel, Netlify, Cloudflare Pages, AWS CodePipeline, Heroku): build the artifact once during the PR/preview phase, then promote it to production by re-tagging — do not rebuild on merge. Named practice: **immutable artifact + tag promotion**. Aligns forward-looking with SLSA Level 2/3 single-build provenance.

**The build stage is CI's, not an operator's.** The first version of this ADR made step 1 a manual `gh workflow run ci.yml --ref <branch>`. A pipeline stage gated on a human remembering a CLI invocation is not a pipeline stage: the dispatch fired **0 times in 100 CI runs**, guard 3 therefore failed on **100% of merges**, and every merge paid the full rebuild this section exists to avoid (#355). The dispatch survives as an operator escape hatch for deploying a feature branch to the VPS — it is no longer load-bearing.

Flow:

```
PR ──► docker    build ─► scan ─► smoke ─► push by digest   (required check, every PR)
                                           └─ untagged: unpullable, undeployable
       publish   tag sha-<pr-tip> + <branch-slug>           (required check; needs: check + lint + docker)

merge ──► promote  guard 1,2,3 ✓ ──► imagetools create ──► sha-<merge> + main   ~30s
                                 ✗ ──► build ─► scan ─► smoke ─► push ─► tag    ~5 min
```

1. PR opens. `docker` builds both images once, scans both, smokes them, and pushes them by digest. `publish` waits on `check`, `lint` **and** `docker`, then names those exact digests `sha-<pr-tip>` + `<branch-slug>`. No _name_ resolves to bytes that have not passed every gate — and because the names are applied to a digest rather than to the output of a second build, the named bytes are the scanned bytes by identity rather than by assumption.

   **Precondition: the promotable artifact is the one built from the _final_ PR tip.** Guard 3 resolves `sha-<pr-tip>` at merge time. Each push to the PR produces its own `sha-<tip>`, so this holds automatically — a force-push that discards the last-built tip is the one case that orphans the artifact and sends the merge down the rebuild path.

2. PR merges to `main` (squash — the only method enabled). `promote` fires on `push: main`. Three guards:
   - **PR discovery** — `gh api repos/.../commits/${GITHUB_SHA}/pulls` must return the PR's head SHA. Direct pushes to `main` (hot-fix) return empty → fallback.
   - **Tree equality** — `tree(merge-sha) == tree(pr-tip)`. Squash preserves the tree, but `strict_required_status_checks_policy` still permits `main` advancing between the last green run and the merge, folding those commits into the squash → fallback.
   - **Source image present on GHCR** — `docker manifest inspect ghcr.io/.../sha-<pr-tip>` must succeed. Fork PR, or a force-push after the last green run → fallback.
3. Happy path: `docker buildx imagetools create -t <new-tag> <src-tag>` for both images, creating `sha-<merge-sha>` + `main` from `sha-<pr-tip>`. ~30s. Registry-level copy — no pull, no daemon involvement, so the OCI image-index wrapper and the buildx-generated provenance/SBOM attestation manifests are preserved (a plain `docker pull/tag/push` cycle would drop the attestation entry; observed on the first promote run in #226). No rebuild, no rescan, no smoke — the artifact is bit-for-bit identical to what `docker` validated before the merge.
4. Fallback: `build-scan-smoke` (which ends in the digest push) then `tag-images`, against the merge SHA. ~4 min on main's (cold-ish) cache scope. Operators see a `::warning::` in the run log explaining which guard failed.

PR-tip discovery is via GitHub's merge metadata (`gh api .../commits/<sha>/pulls`) and not via a PR label. A label channel would persist past a force-push-then-merge and could promote stale bytes; using the API ties discovery to the actual merge.

Promotion is exact-artifact only. `GIT_SHA` is baked into the client bundle for the footer version chip, so every commit yields distinct image bytes — there is no "close enough" ancestor to promote. Guard 3's exact-SHA lookup is the only sound key, and a rebuild when the tip moved after the last green run is correct behavior, not waste.

**Fork PRs do not publish.** `publish` carries a job-level `if:` requiring `head.repo.full_name == github.repository`. **That condition, not token scope, is what skips the job.** GitHub never skips a job over permissions — it hands a fork PR a read-only `GITHUB_TOKEN` regardless of the job's `permissions:` block ("The `GITHUB_TOKEN` has read-only permissions in pull requests from forked repositories") and lets the run fail. Delete the `if:` as redundant and every fork PR gets a red `publish` dying on `denied: permission_denied` at push time. `docker` still runs, so a fork PR is validated exactly like any other; its merge simply takes the fallback rebuild. Deliberate, not a gap.

**Publishing follows validation, never precedes it.** `build-scan-smoke` aliases the locally-built images to their GHCR refs (`docker tag`) before `compose up`. No compose file sets `pull_policy`, so compose defaults to `missing` and resolves both services from the local store — the smoke exercises the real compose config against the exact bytes just scanned, with nothing pushed. The digest push runs only after the smoke passes, and even then produces nothing pullable by name. The earlier ordering pushed a _tagged_ image first so the smoke could exercise the `compose pull` path; that bought a registry round-trip at the price of publishing an unvalidated image, and a smoke failure left a pullable `sha-<commit>` behind (#355 §1). The round-trip is exercised by the next `scripts/deploy.sh` run regardless.

Trade-offs accepted:

- **Every PR pays the image build**, where the path filter previously skipped it on most PRs. Against that, the ~5 min post-merge rebuild is gone and the runtime smoke becomes a pre-merge gate.

  Measured on run [33424054809](https://github.com/Projekt-Manager-Org/Projekt-Manager/actions/runs/33424054809), the last run of the two-build design: 6m45s wall-clock — `lint` 3m47s, `check-shard` 3m43s and `docker` 3m17s in parallel, then `publish` 2m48s serially behind them. `publish` was 41% of the run and was rebuilding, not re-materialising (see below). With `publish` reduced to a manifest copy and the push moved into `docker`, the serial tail is seconds rather than minutes. An earlier revision of this ADR claimed the change was "roughly neutral per merged PR" while omitting `publish` from the arithmetic entirely; it was not.

- **Trivy DB binds to PR time.** CVEs published between the last PR run and the merge slip past until the daily `security-scheduled.yml` catches them. Typically minutes to hours.
- **GHCR tag count.** Each push to a PR branch produces its own `sha-<pr-tip>` app+backup pair plus a moving `<branch-slug>` pair, on top of `sha-<merge-sha>` + `main` per merge — call it 5–10 immutable SHA tags per merged PR, plus everything left behind by PRs that never merge. The dispatch-driven design produced ~2× because the dispatch never fired. Digest-first publishing adds a second class: when a run's `docker` pushes but `publish` never names the result (a red `check`/`lint`, a cancelled run), the digest stays on GHCR untagged. That class was assumed to be what GHCR's built-in "keep last N untagged versions" policy covers — measurement says otherwise: it is 11 versions of 295, the other 284 being the children of tagged indices, which the built-in policy would also delete. Reaped since #373 by `ghcr-retention.yml`; see Retention below.
- **The push is in `docker`, not in a second job that re-derives the bytes.** #355's first shape had `publish` rebuild both images from the gha cache and Trivy-scan them again before pushing, on the theory that a warm cache made the rebuild a layer-for-layer hit and the rescan covered the cold case. **Both halves were false**, and the logs of run 33424054809 say so:

  | `publish` step                  | wall | what happened                                                                                                     |
  | ------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------- |
  | Build app image (load for scan) | 23s  | every layer `CACHED`, context 8.16 MB                                                                             |
  | Trivy app scan                  | 19s  | 110 MiB vuln DB download                                                                                          |
  | Push app image                  | 71s  | `npm ci` 18.1s, `COPY . .` 6.5s, `npm run build` 17.9s, `npm prune` 10.4s — **push itself 5.6s**; context 1.33 GB |

  Two problems, one of them structural:

  1. **The scan poisoned the build context.** `trivy-action` defaults `TRIVY_CACHE_DIR` to `$GITHUB_WORKSPACE/.cache/trivy` and unpacks ~1.3 GB there, and `.dockerignore` had no `.cache` entry. Every build after a scan therefore saw a different context and could not hit `COPY . .` again — the 1.33 GB in the table is the vuln DB.
  2. **The scan and the push were different builds, so the scan did not cover what was published.** `push-images` scanned the `load: true` build's output and then pushed a second build's output. Even where the two agree, the guarantee was an argument about cache identity rather than a fact about the artifact — and the single nondeterministic input, `apk upgrade --no-cache` (`Dockerfile:74`), resolves whatever Alpine versions are current at that instant whenever the cache misses.

  Fixed at the root rather than tuned — but not on the first attempt, and the first attempt is the more useful record. It kept the validation build and the pushing build, and argued they were identical because they shared a cache. They were not. In the push invocation `COPY . .` missed, so `npm run build` (16.5s) and `npm prune` (9.1s) re-executed and produced a different snapshot from the one Trivy had scanned; `apk upgrade --no-cache` (`Dockerfile:73`) sat live behind that as a genuinely nondeterministic input. Worse, the published **backup** image resolved its `FROM` through `build-contexts` to the _validation_ app build while the published **app** image was the _push_ build, so the `sha-<commit>` pair did not come from one app build at all — precisely the skew `Dockerfile.backup` exists to prevent.

  **Push first.** Each image is built exactly once, straight to GHCR by digest, and is then pulled back to be scanned and smoked. The identity claim — the named bytes are the scanned bytes — is now a fact about one artifact rather than an argument about two. `.github/actions/trivy-image` redirects the cache under `$RUNNER_TEMP` and `.dockerignore` carries `.cache` as the durable guard.

  The safety property does not come from the push being late; it comes from the **naming** boundary. `push-by-digest=true` leaves the manifest untagged: `scripts/deploy.sh` cannot pull it, `promote`'s guard 3 cannot find it, nothing on the VPS can run it. `tag-images` is what gives the digests names, and it runs only after `check`, `lint`, the Tier 1 round-trip and the smoke have passed. So the push can precede all of them without weakening anything.

  **Attestations.** `provenance: mode=max` is uniform across both builds. It could not be while a validation build existed: an attestation makes the build result a manifest list, and the `docker` exporter cannot write one — `ERROR: failed to build: docker exporter does not currently support exporting manifest lists`. GitHub's runners use the classic image store, where that is fatal, so the validation builds had to set `provenance: false` while the pushes set `mode=max`. Push-first has no `docker` exporter in any build — the local copy arrives by `docker pull`, not by an exporter — so the constraint and the asymmetry are gone together.

  A note on how that was established, because it is the kind of thing this project's methodology exists for. A revision of this ADR asserted that the attestation asymmetry was itself a cause of the rebuild, on the strength of a local experiment. The experiment was run against a daemon with the **containerd image store** enabled, where `type=docker` accepts a manifest list; GitHub's runners do not, and CI rejected the resulting workflow in 14 seconds. The claim was corrected to the one the runner agreed with — and then the topology moved past it, which is the ordinary fate of a finding about a shape that no longer exists.

  Two shapes were rejected along the way. Putting all three exporters in one build: `type=image,push-by-digest` alongside `type=oci` leaves the OCI layout's index referencing a digest the layout does not hold, and a backup `FROM` resolving through that layout then fails. And keeping a separate non-pushing path for fork PRs: it is the build-twice topology again, reintroduced for a population this repo does not accept contributions from. See the `docker` bullet below for what a fork PR does instead.

- **`docker` is a PR-triggered job holding `packages: write`.** It checks out and executes PR-authored code — `.github/actions/build-scan-smoke/action.yml`, `Dockerfile`, `Dockerfile.backup` — with a GHCR write token in scope. `publish` already did (#355); this moves the same grant one job earlier, to where the push now happens. **Accepted, and why:** fork PRs — the untrusted population — get a read-only `GITHUB_TOKEN` from GitHub regardless of the `permissions:` block, so the grant never reaches them. For everyone else the actor already holds push access and could publish the same images by pushing a branch and dispatching the workflow. What the grant can produce is also narrower than before: an untagged digest, which nothing deploys until `publish` names it. CONTRIBUTING § Security audit's trigger question reads yes for this change ("communicates externally"), so this is a recorded acceptance rather than an unasked question.

  **A fork PR therefore fails at `docker` and cannot merge.** The push is unconditional; a read-only token makes it red. That is the intended behaviour. This repo takes no fork contributions, and a fork has nothing to gain from publishing images — so the alternative, carrying a second non-pushing build shape for a hypothetical contributor, buys back the exact defect this decision removes. Blocking the merge is what § Principles prescribes for an environment that cannot meet a requirement. If fork contributions are ever wanted, that is a decision to record here first, not a gap to paper over in the workflow.

**Tagging:**

- **Immutable**: `ghcr.io/projekt-manager-org/projekt-manager:sha-<commit>` — one per commit, the rollback target.
- **Moving**: `ghcr.io/projekt-manager-org/projekt-manager:<branch-slug>` — latest on each branch, human-friendly fallback.

**Compose topology:**

- `docker-compose.yml` (prod): `app` uses `image: ghcr.io/projekt-manager-org/projekt-manager:<tag>`, no `build:` — pure runtime descriptor.
- `docker-compose.dev.yml` (dev overlay): reintroduces `build: .` so local dev builds from source.
- Deploy: `scripts/deploy.sh` runs `docker compose pull app && docker compose up -d` (see [ADR-0012](0012-manual-pull-based-deploy-over-wireguard.md)).

**Image visibility:** public, matching the repo. Private until 2026-09-04, when the clause "matching the repo" stopped being true in the other direction — the repo had gone public, the packages had not followed. The gain is that the VPS pulls anonymously and the `read:packages` PAT leaves the deploy path entirely; it is _not_ a storage saving, since GHCR is free either way (below). The app is still WG-only; what is public is the image, whose source already was. The cost, which only surfaced during review: GitHub refuses to delete a version of a public package past 5,000 downloads, so retention can be permanently blocked on a popular version — handled by counting rather than aborting.

**Retention:** `ghcr-retention.yml` runs daily and keeps, per package — `main`; `sha-<c>` for the newest **5** commits on `main`; `sha-<head>` of every open PR; anything under **24 h** old; and every child manifest of those. Everything else is deleted. Policy rationale and the fail-closed invariants are in `scripts/ci/ghcr-retention.sh`.

The window is 5 commits because `scripts/deploy.sh <sha>` is the rollback mechanism (ADR-0012) — the floor is "how far back can we roll back", not "how much storage". It is deliberately deeper than the host-side `DEPLOY_IMAGE_RETENTION=3`: the registry is what the host restores _from_.

**The window is not the running deploy.** The two were conflated in review and they are not the same: rule 1 tracks `main`, the deploy tracks whatever the operator last shipped, and on 2026-09-04 the VPS was 70 commits behind. Retention would have deleted the registry copy of the running image. The container survives — the image is on the host — but the rollback target does not. Pin it with the `GHCR_KEEP_EXTRA` repository variable; `manual-deploy.md` § Rollback carries the procedure.

**What the earlier intent got wrong**, recorded because the correction only came from measuring. This section used to prescribe GHCR's built-in "keep last 20 untagged versions". That policy is not insufficient here, it is destructive — it would delete the untagged children of every tagged index, `main` included, and `actions/delete-package-versions`' `delete-only-untagged-versions` is the same predicate. Retention has to be digest-aware, which is why this is a script. The measurement is in `scripts/ci/ghcr-retention.sh`'s header.

[#373](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/373)'s second open specific — reaping `<branch-slug>` tags on branch deletion — is answered "no". A daily sweep subsumes it, and a moving pointer costs a re-push to restore.

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
- Image retention is a new operational concern. Left unclosed it reached 457 versions on `projekt-manager` and 453 on its backup sibling in 3.5 months; `ghcr-retention.yml` closes it (Decision § Retention, [#373](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/373)). Since GHCR storage is free, the cost was manageability and blast radius, not spend. The residual concern is that retention is now code the project owns rather than a registry setting — it can break, and it deletes, which is why `notify.yml` monitors it.
- CI runner's Docker version is not pinned under ADR-0009. Controlled drift: OCI images are portable across reasonably-versioned daemons; only the manifest format needs to match. Upcoming security audit decides whether this needs explicit mitigation.

## Dep lifecycle health (as of 2026-05-15)

| Dep                              | Status                         | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub Actions                   | Active GitHub-managed platform | Action SHA pins live in `.github/workflows/`; Renovate maintains them under [ADR-0027](0027-continuous-dependency-updates-with-supply-chain-scanning.md). Every third-party action is SHA-pinned (regime established in [#187](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/187)); the current set is `actions/checkout`, `actions/setup-node`, `aquasecurity/trivy-action`, `docker/build-push-action`, `docker/login-action`, `docker/setup-buildx-action`, `google/osv-scanner-action`, `lycheeverse/lychee-action` — all on current latest, no published advisories. Two have left the set: `dorny/paths-filter` with the `changes` job (#355), and `ludeeus/action-shellcheck` for the runner's own `shellcheck` binary ([dep-management.md § Resolved](../ops/dep-management.md)). |
| GitHub Container Registry (GHCR) | Active GitHub-managed service  | "Container image storage and bandwidth for the Container registry is currently free" — public or private alike, so accumulation costs no money, only manageability. Retention is ours to run — see § Retention. No published deprecation path; exit ramp would be Docker Hub or self-hosted Distribution (alternatives in this ADR).                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## References

- [ADR-0003: Deployment infrastructure — VPS, Docker Compose, GitHub Actions](0003-deployment-infrastructure-vps-docker-compose-github-actions.md) — refines the CI/CD topology left open-ended there
- [ADR-0008: VPN-first network access](0008-vpn-first-network-access.md) — defines why a GitHub runner cannot reach the app directly
- [ADR-0009: Pin Docker Engine and Compose versions across environments](0009-pin-docker-versions-across-environments.md) — pin regime; this ADR introduces a controlled deviation for the CI builder
- [ADR-0012: Manual pull-based deploy over WireGuard](0012-manual-pull-based-deploy-over-wireguard.md) — replaces the distribution-to-host leg
