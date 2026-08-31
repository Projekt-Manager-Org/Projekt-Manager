# ADR-0027: Continuous dependency updates with supply-chain scanning

- **Status:** Accepted
- **Date:** 2026-05-15
- **Confidence:** Medium-High — the design rests on established industry patterns (Renovate + OSV-Scanner + Trivy is the OSS-tier supply-chain baseline at this stage). Renovate is installed and actively raising and merging dependency PRs, but the allowlist schema has only been exercised against the empty baseline and the quarterly-review cadence has not yet completed a full loop. Promote to High once a quarterly review walk completes and the allowlist has been exercised against a real advisory.

## Context

Dependency hygiene has so far been a **manual audit** triggered by guilt rather than schedule. The most recent pass ([#187](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/187), 2026-05-15) accumulated in under two months:

- ~25 patch/minor bumps batched into one omnibus PR
- One ESLint major cluster (`eslint` 9→10, `@eslint/js`, `globals` 14→17, `typescript-eslint`, `lint-staged` 16→17)
- One Node base-image bump (3 CVEs)
- One Docker Engine bump (2 CVEs, including in-container privesc)
- Two **non-drop-in migrations** carved into separate issues:
  - [#191](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/191) — `minio/minio` upstream-archived 2026-04-24, caught ~3 weeks late
  - [#192](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/192) — `libxmljs2` README literally `# NO LONGER MAINTAINED`, caught only by this audit
- Two driver-level switches (`pdf-lib` → `@cantoo/pdf-lib`, `pdf-parse` → `unpdf`)
- A patch deletion (`@aws-sdk+xml-builder` patch rendered obsolete by upstream rewrite)

This pattern is structurally fragile in three ways:

1. **Batching correlates risk.** A regression in one of 25 bumps becomes a bisect through the whole batch. Each bump's CI signal is invisible.
2. **CVE time-to-merge is weeks, not hours.** The Caddy admin-socket and FastCGI advisories, the Docker `containerd` DoS, and the MinIO session-policy privesc all sat unpatched until a human noticed.
3. **Dying upstreams surface late.** MinIO's archive flag flipped on 2026-04-24; the project found out three weeks later during a routine audit. The agent that originally recommended MinIO (during initial stack selection) did **not** check upstream lifecycle — a known LLM failure mode. The fix is a process bar, not a "be more careful" rule.

Constraints:

- **No commercial budget.** Snyk / Mend / Sonatype IQ tiers are out of scope for an LLM-driven solo project.
- **Single-tenant dev/eval environment.** SLSA / SBOM / `cosign` provenance are appropriate when shipping to enterprise customers or distributing artifacts publicly; the trigger for adopting them is going multi-tenant or third-party-distributing, neither of which is the current state.
- **Test confidence is high for unit + integration, absent for E2E.** `ci.yml`'s `lint` + `check` gate unit + integration on every PR. Playwright is `workflow_dispatch`-only ([`e2e.yml`](../../.github/workflows/e2e.yml)), so **no PR carries an E2E signal**. Auto-merge on green CI is a credible default for patch/minor; majors need the E2E run performed by hand ([dep-management.md § Weekly wrangler](../ops/dep-management.md#weekly-wrangler) step 4).
- **Dependabot Alerts is already on** at the repo Security tab.

Forces:

- The standard commercial baseline for a single-tenant Node project is **Renovate or Dependabot for updates + a vuln scanner in CI + ADR-discipline at dep adoption time**. We currently have one of three (Alerts).
- The MinIO failure mode is not a tooling gap alone — it is a **decision-time discipline gap**: no record of "what was the upstream health of MinIO on the day we adopted it." Adding that record creates a re-evaluation trigger that does not depend on someone remembering.

## Decision

We will adopt **three coupled changes**:

### 1. Renovate as the primary update bot

`.github/renovate.json` with:

- **Schedule:** weekly window (e.g. `before 9am on monday`) for routine bumps. Vulnerability PRs bypass the schedule and the PR concurrency/hourly limits.
- **Grouping:** seven lockstep clusters, one PR per cluster — AWS SDK (`@aws-sdk/**`), ESLint cluster (`eslint` + `@eslint/js` + `globals` + `typescript-eslint` + `eslint-plugin-react-hooks` + `eslint-plugin-react-refresh`), Vitest pair (`vitest` + `@vitest/coverage-v8`), React quartet (`react` + `react-dom` + `@types/react` + `@types/react-dom`), Fastify family (`fastify` + `@fastify/**`), Drizzle pair (`drizzle-orm` + `drizzle-kit`), and Caddy (the two `caddy` base-image FROM tags and the `xcaddy build` version all track the `caddy` Docker image, grouped into one PR so all three advance to the same version together; sharing one datasource keeps them in lockstep. The `caddy-dns/cloudflare` plugin SHA tracks separately via git-refs).
- **Per-major-version PRs.** No grouping across majors; each major bump gets its own PR with the changelog inline.
- **Auto-merge** for patch + minor (plus digest/pin/lockfile) when CI is green, including the lockstep clusters — grouping consolidates one PR per cluster, it does not gate the merge. Majors never auto-merge.
- **Release-age cooldown, 3 days, npm only.** Inherited from `config:best-practices` → `security:minimumReleaseAgeNpm` on the Renovate side; set again in `.npmrc` (`min-release-age=3`) for the resolution paths Renovate hands to npm. Security updates bypass the Renovate half only — npm has no exemption. See the [2026-08-28 amendment](#2026-08-28--release-age-cooldown-and-its-limits) for why both halves are needed, what the npm half costs, and why non-npm datasources are excluded.
- **Lockfile maintenance** PR daily to bound transitive drift, exempt from the PR limits (see the [2026-08-06 amendment](#2026-08-06--renovate-does-not-remediate-transitive-deps)).
- **Managers:** `npm`, `dockerfile`, `docker-compose`, `github-actions`, and six `customManagers` of type `regex`, each covering a pin the built-in managers cannot see:

  | #   | Surface                                                                                                               | Datasource                   |
  | --- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
  | 1   | Caddy version (`xcaddy build vN.N.N`, `docker/caddy/Dockerfile`)                                                      | `docker`                     |
  | 2   | `caddy-dns/cloudflare` plugin SHA, same Dockerfile                                                                    | `git-refs`                   |
  | 3   | MinIO `mc` image tag in `scripts/sync-*.sh`                                                                           | `docker`                     |
  | 4   | MinIO `minio`/`mc` image tags in `.github/workflows/*.yml` and `.github/actions/<name>/*.{yml,sh}`                    | `docker`                     |
  | 5   | PostgreSQL major in `Dockerfile.backup` apk pins                                                                      | `docker`                     |
  | 6   | CLI binaries installed by URL + SHA256 in a workflow or composite-action step (OSV-Scanner, actionlint, ripgrep, age) | `github-release-attachments` |

  Manager 6 closes a gap this ADR had left open: a binary pinned by checksum with no update path is the same "adopted-already-dying" failure this ADR was written to retire, and it is worse on a **scanner** — a stale OSV-Scanner keeps reporting green while no longer knowing about new advisories. The `github-release-attachments` datasource locates the release's checksums asset from the current digest and re-reads it on the next release, so version and SHA256 advance in one PR; no checksum is ever hand-edited. When no checksums asset matches — `age` ships only Sigsum `.proof` files — it falls back to hashing the release assets directly and matching on the digest, so a checksum-less upstream is still tracked. It is driven by an inline `# renovate:` annotation at the call site, and requires `currentValue` to be the literal git tag, `v` prefix and all or neither (`v2.3.8` for OSV-Scanner, `15.2.0` for ripgrep), because the digest lookup calls `GET /releases/tags/{currentValue}` verbatim.

  `github-releases` is the wrong datasource for this manager even though the shape looks identical: its digest is the release tag's **commit** SHA, not an asset checksum, so it would overwrite a 64-hex `expected_sha` with a 40-hex value — failing the workflow's checksum compare and then falling out of the manager's `[a-f0-9]{64}` match entirely, leaving the pin untracked.

  **Out of scope for Renovate:** Alpine `apk add` packages on top of base images (unpinned versions; surface enumerated and walked in [`docs/ops/dep-management.md` § Quarterly lifecycle review](../ops/dep-management.md#quarterly-lifecycle-review)) and Docker Engine apt packages on the VPS (tracked manually per [ADR-0009](0009-pin-docker-versions-across-environments.md) lifecycle table). Both are deliberate exclusions with a documented manual review; **no pin is left both unautomated and unreviewed.**

Dependabot Alerts stays on at the GH Security tab as the CVE **notification** surface. Renovate is the **action** surface for **direct** deps only — its vulnerability PRs, whether sourced from GitHub alerts or from `osvVulnerabilityAlerts: true`, are [direct-dependency-only by design](https://docs.renovatebot.com/configuration-options/#osvvulnerabilityalerts) ("You will only get OSV-based vulnerability alerts for _direct_ dependencies"). Transitive npm deps are owned by two other mechanisms:

- **Dependabot security updates** (the PR-raising half, distinct from Alerts) — for npm it raises a fix PR even when the vulnerable package exists only in the lockfile, [updating the parent dependency when that is the only route](https://docs.github.com/en/code-security/dependabot/dependabot-security-updates/about-dependabot-security-updates).
- **Daily `lockFileMaintenance`** — bounds transitive drift to ~24h for advisories neither bot files a PR for.

Overlap between the two bots is intentional belt-and-braces.

### 2. Supply-chain scanning in CI (blocking)

- **OSV-Scanner** (CLI v2.3.8 pinned by SHA256) — scans the npm tree against the OSV database. Free, OSS, broader DB than `npm audit`, but **not a superset of it** — both key on `(ecosystem, name, version)` and each carries records the other lacks (see the [2026-08-28 amendment](#2026-08-28--repo-level-advisories-and-what-no-layer-covers)). **Blocks merge on any vuln**: the v2.3.8 CLI has no severity flag, so the implementation gates on every advisory OSV.dev publishes. This is stricter than originally drafted (HIGH/CRITICAL) and matches the project's "refuse-or-block, never downgrade" principle. False positives go through `osv-scanner.toml` with the owner/reason/expiry schema in §Negative.
- **Repo-level GitHub advisories** (`scripts/check-repo-advisories.mjs`) — reads each direct dep's `/security-advisories` endpoint, where advisories that were never promoted to the global database do exist. Covers what neither lockfile scanner structurally can. **Blocks merge on a match**; fails closed on API errors. Added by the [2026-08-28 amendment](#2026-08-28--repo-level-advisories-and-what-no-layer-covers), which also states what all three layers leave uncovered.
- **Trivy** (`aquasecurity/trivy-action`) — scans the built Docker image, including OS packages (`apk`, `apt`) that OSV-Scanner can't see; plus filesystem secret scan and IaC misconfig scan. **Blocks merge on `HIGH` / `CRITICAL`** (Trivy supports `--severity` and the noisier surfaces it scans benefit from the filter). Runs on every PR in the `docker` job, before anything is published.

Exceptions to blocking go in a documented allowlist with a review trigger (the pattern from the superseded [ADR-0007](0007-suppress-esbuild-dev-server-advisory.md) is the right shape).

### 3. Lifecycle-health entry on dep-introducing ADRs + quarterly review

- The `vv-adr` skill now requires a `## Dep lifecycle health (as of YYYY-MM-DD)` section on any ADR that commits to a specific named external dep (npm package, container image, SaaS service, source-built binary). Pattern/policy ADRs omit it — for this codebase the excluded set is **0001, 0007 (superseded), 0010, 0013, 0014, 0015, 0017, 0018, 0019, 0021, 0023, 0025**. New ADRs apply the same test: if no named external dep is committed, omit the section. If the ADR delegates lib choice to a design doc (e.g., `ARCHITECTURE.md`), the table lives in the design doc — one source of truth per dep.
- ADRs 0002–0026 are retrofitted in the same change as this ADR (excluding the superseded 0007 and the pattern-only ones listed above). The retrofit landed across two batches — **2026-05-15** for the bulk and **2026-05-18** for ADRs touched during PR review (notably 0005, 0006, and a re-stamp of 0020 when [#199](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/199) introduced `croner`). The `(as of YYYY-MM-DD)` timestamp on each ADR reflects the day that ADR's table was last verified; per the as-of policy, individual table dates need not match. ADR-0008's prose maintenance notes are reshaped into a structured table during the retrofit. ADR-0009 carries both a "Pinned versions" table (version surface) and a separate lifecycle-health section added during retrofit — the two are distinct.
- A **quarterly strategic-dep review** walks the headline deps (framework, ORM, storage SaaS, base images, build tooling) and asks: alive? funded? still our best option? exit ramp documented? Outcomes feed superseding ADRs when warranted. Tracked in [docs/ops/dep-management.md](../ops/dep-management.md).

## Alternatives Considered

### Dependabot-only as the primary update bot

GitHub-native, already half-configured (Alerts on). Ruled out: weaker grouping (no expression-based clusters across ecosystems), no Docker-tag regex manager for arbitrary files (Caddy plugin SHA, apk pins, `download.docker.com` package list), no `lockFileMaintenance` equivalent, no schedule windows. Renovate covers the project's mixed-ecosystem pinning surface; Dependabot would leave half of [#187](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/187)'s scope outside automation. Dependabot Alerts remains on for the CVE notification surface — the two cooperate.

### Manual audits tightened to monthly cadence

The status quo with more discipline. Ruled out: the failure mode is structural, not effort-based. Even monthly audits produce a batched omnibus PR that hides individual signal; CVE time-to-merge stays in weeks. The MinIO archival timing is the proof — a once-a-month audit would still have caught it three weeks late.

### Commercial SCA (Snyk Open Source / Mend / Sonatype IQ)

Best dashboards, license compliance, supply-chain anomaly detection. Ruled out for the current stage: paid tier is not justifiable against an OSS-tier alternative (Renovate + OSV-Scanner + Trivy) that covers the same primary use cases. Revisit if the project distributes artifacts to enterprise customers — that is the trigger that justifies the cost.

### SBOM + provenance now (`syft` + `cosign`)

Generate CycloneDX SBOMs on each release, sign images with `cosign`, target SLSA Level 2+. Ruled out for now: appropriate when an external party consumes the artifact (enterprise customer, regulated industry, distro/registry publishing). The current artifact has one consumer — the VPS — and is built in CI. Recorded as a future-work seam for the multi-tenant / public-distribution transition.

### `npm audit` in CI only

The lightest possible option. Ruled out: covers only the npm tree, no OS-package or container coverage, advisory database lags GHSA, noise floor is high (transitive devDeps trigger constantly). The superseded ADR-0007 is direct evidence of the npm-audit-only path failing in practice.

## Consequences

### Positive

- **Continuous, individually-tested bumps.** Each Renovate PR gets its own CI signal. Regressions surface against the single bump that caused them.
- **CVE time-to-merge measured in hours — for direct deps.** Vulnerability PRs bypass schedule; with auto-merge on green CI for patch/minor, the median CVE patch lands the same day it is published. Transitive-only advisories run on a different path (Dependabot security updates + daily `lockFileMaintenance`, backstopped by the nightly OSV scan) — see the [2026-08-06 amendment](#2026-08-06--renovate-does-not-remediate-transitive-deps).
- **Dying-upstream signal at decision time.** The mandatory lifecycle-health section converts "the agent recommended MinIO" into "the agent recommended MinIO; here is its archive flag, last release, license, deps.dev score at adoption time." A future reader has an evaluable trail.
- **Quarterly review catches BSL/SSPL relicensings and bus-factor erosion** without depending on someone happening to notice during routine work.
- **Existing artifacts cooperate.** Dependabot Alerts is unchanged. ADR-0009's Docker version table doubles as the lifecycle table for that ADR's deps.
- **Aligned with the project's "refuse to serve" principle** — CVE scanning in CI blocks the merge, not deferring it to a runtime probe.

### Negative

- **PR queue volume.** A weekly window with grouping should land 3–8 PRs/week in steady state. The "weekly wrangler" hat is ~30 min/week.
- **Auto-merge runs with no E2E signal.** Playwright is not in the PR gate, so an auto-merged patch/minor lands on unit + integration evidence alone; a browser-level regression reaches `main` and surfaces only at the next manual E2E run. Mitigations today: auto-merge stays off for majors (the highest-risk class), and § Weekly wrangler step 4 makes the manual E2E run mandatory for them — both leave the patch/minor stream uncovered. **Open gap, not a settled trade:** the real fix is Playwright in the PR gate, blocked on the runtime + flake-surface argument recorded in `e2e.yml`'s header, which in turn is blocked on a flake-quarantine practice that does not exist yet.
- **Renovate config drift.** A `.github/renovate.json` that goes stale (new dep types, ecosystem changes) silently degrades coverage. Mitigated by the quarterly review explicitly checking the config.
- **OSV-Scanner / Trivy false positives** for advisories on dead code paths (cf. the original ADR-0007 case). Mitigated by a structured allowlist — never a blanket `--omit=dev`. The two scanners use different file formats but the same review-contract fields; both are enforced in CI by `scripts/check-allowlist-schema.sh` (~100ms; runs before the scanner gates so a sloppy entry fails fast). Required fields per entry:
  - **`id`** — the advisory or rule identifier (any non-empty string; Trivy and OSV-Scanner validate the ID shape themselves).
  - **`reason`** — why the advisory doesn't apply here. The GitHub handle of the entry's owner is mandatory. The handle must be a real GitHub username (1-39 alnum chars + non-leading/trailing/consecutive hyphens) — `@`, `@-`, `@a--b` and similar are rejected:
    - `osv-scanner.toml` has no dedicated `owner` field. The `reason` string MUST start with `@<handle>:` so the handle is encoded.
    - `.trivyignore` has no `reason` field at all. A `# owner: @<handle>` comment AND a `# reason: <free text>` comment in the contiguous comment block immediately preceding the entry are required.
  - **`expiry`** — at most **90 days from creation**, forces a re-review:
    - `osv-scanner.toml`: `ignoreUntil = YYYY-MM-DD` as a bare TOML date literal (the script rejects both quoted strings and offset datetimes — only the bare date is accepted).
    - `.trivyignore`: `exp:YYYY-MM-DD` as a suffix on the entry line itself (not in the comment block).

  See [docs/ops/dep-management.md § Allowlist (OSV-Scanner + Trivy)](../ops/dep-management.md#allowlist-osv-scanner--trivy) for copy-pasteable examples that pass the CI gate.

### Operational

Implementation ships in this ADR's PR:

- `.github/renovate.json` — schedule, grouping, auto-merge rules, manager set.
- `.github/workflows/ci.yml` — OSV-Scanner step (blocks on any vuln; CLI has no severity flag) + Trivy steps placed by gating role:
  - **`check` job** (always runs, required by branch protection): Trivy filesystem-secret scan (no `severity:` filter — many of Trivy's built-in secret rules, e.g. `jwt-token`, `age-secret-key`, `slack-web-hook`, ship at MEDIUM and would be silently dropped by HIGH/CRITICAL; within scanned files any rule match blocks the PR) and Trivy IaC-misconfig scan (HIGH/CRITICAL — IaC has the noisiest baseline of the three Trivy scans, the filter keeps the signal-to-noise workable). Trivy's built-in skip list (`node_modules`, `.git`, lockfiles, binary extensions, paths matching test/example/vendor/`.md`) applies; it is a known residual coverage gap.
  - **`docker` job** (every PR, required by branch protection): compose validation + app image build + Trivy app-image-vuln scan (HIGH/CRITICAL) + OCI-layout export + backup image build (FROM aliased to the exported layout via buildx `build-contexts`) + Trivy backup-image-vuln scan + runtime smoke. Publishes nothing.
  - **`publish` job** (`needs: [check, lint, docker]`): pushes only what the `docker` job already scanned and smoked, and re-scans each image immediately before pushing it. The re-scan is not redundant — `publish` runs on a different runner and rebuilds from the shared gha cache, whose export is best-effort, so a cold start would otherwise re-resolve the `apk` layers unscanned. A failed scan never publishes the tag, so `scripts/deploy.sh` cannot resolve a bad SHA.
- `.github/workflows/security-scheduled.yml` — nightly OSV-Scanner run against `main` so newly-published advisories surface without waiting for a PR.
- `osv-scanner.toml` (repo root) — allowlist file; empty on landing, schema documented in `docs/ops/dep-management.md`.
- `.trivyignore` (repo root) — allowlist file for Trivy; empty on landing, same schema discipline.
- [docs/ops/dep-management.md](../ops/dep-management.md) — runbook (first-run setup, weekly wrangler, quarterly review, allowlist schema).
- `scripts/check-allowlist-schema.sh` + `scripts/__tests__/check-allowlist-schema.test.sh` — wired into the `lint` job; rejects allowlist entries missing owner/reason/expiry per §Negative.

**Gating model rationale.** Trivy fs-secret + IaC scans live in `lint` rather than `docker` because they need no built image and `lint` is the cheaper job to reach. Image-vuln scanning lives in `docker`, which needs the built image. Branch protection requires `lint`, `check`, and `docker`, and all three now run on every PR.

This job was originally path-filtered, and the filter was load-bearing in the wrong direction: a skipped required check [counts as successful on GitHub](https://docs.github.com/en/actions/using-jobs/using-conditions-to-control-job-execution), so any PR outside the filter merged with its image neither built nor scanned — and `src/**`, which changes image bytes on nearly every PR, was excluded on purpose. The filter is gone (#355); the acknowledged tradeoff below went with it.

**Backup image at PR time (#219).** `Dockerfile.backup`'s `FROM ghcr.io/.../projekt-manager:${APP_IMAGE_TAG}` references the GHCR copy of the app image, which does not exist while the PR is still open. Without indirection the backup image's CVE surface (its own `apk add` layers on top of `node:22-alpine`, plus everything the app image carries) could only be scanned after publish. That mode put `main` red in #218 — a base-layer CVE landed via a Renovate auto-merge that passed PR-CI, then the post-merge backup scan failed. To close it, `build-scan-smoke` exports the app image as an OCI layout and aliases the GHCR reference via buildx's `build-contexts` (`oci-layout://`), so the backup build resolves locally and gets scanned before anything is pushed. No `Dockerfile.backup` change, no driver downgrade, no registry round-trip.

The same aliasing is what lets the whole build → scan → smoke sequence run ahead of the publish (#355): `push-images` is a separate composite that only ever runs after it.

Acknowledged tradeoff: every PR now pays the image build (~6–7 min) instead of most PRs skipping it. That is the price of the gate being a gate; the ~5 min post-merge rebuild it replaces makes it roughly neutral per merged PR.

`ignore-unfixed` is NOT set on any image scan: a no-fix-yet CVE is still a finding, and an operationally-tolerable case goes in `.trivyignore` with owner/reason/exp ≤90d. This makes the failure mode visible — when an unfixable upstream CVE lands, the deploy pipeline halts until either the upstream fixes it or an operator writes a deliberate, time-bounded allowlist entry; the `ignore-unfixed: true` shortcut would have suppressed it silently forever. The runbook's [§CVE handling](../ops/dep-management.md#cve-handling) covers the operator procedure.

- The `vv-adr` skill template is updated; retrofits to the existing ADRs in the included set land in the same change as this ADR.
- No env-var or schema impact.

## Amendments

### 2026-08-28 — Repo-level advisories, and what no layer covers

Raised in [#345](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/345) §1. `main` ran a fastify release with a known high-impact advisory and every gate was green.

**Why both scanners missed it.** OSV-Scanner and `npm audit` key on `(ecosystem, name, version)`. `CVE-2026-16732` (trustProxy hop-count `X-Forwarded-*` spoofing, the exact `trustProxy: 1` shape `main` was running) has an OSV record carrying a **GIT range and no `package` field at all** — `POST /v1/query` for `npm/fastify@5.12.0` returns `{}`. `GHSA-3m5p-2c4r-xxw2` 404s on GitHub's _global_ advisory API because it is still a repo-level advisory, so the GitHub Advisory DB does not carry it either. What caught it was `tsc` rejecting a removed type-union member. Luck, not a control.

Not a fluke: the same fastify release fixed a second repo-level-only advisory, `GHSA-w2qp-rph6-63g4`.

**§Decision.2's premise was wrong.** It described OSV as a strict superset of `npm audit` for npm. Neither database is a superset of the other, and neither is a superset of what upstream publishes at its own repo. A GIT-only OSV record is invisible to lockfile scanning by construction. Corrected in-place, along with the same claim in `ci.yml`'s comment.

**Added.** `scripts/check-repo-advisories.mjs`, gating `lint` on every PR and running nightly in `security-scheduled.yml`. For each direct dependency whose upstream is on GitHub it reads `GET /repos/{owner}/{repo}/security-advisories` and fails on a published, non-withdrawn advisory whose vulnerable range the installed version satisfies. Monorepos resolve correctly — the match is on the advisory's own `vulnerabilities[].package.name`, not on the repo. It fails closed: a network error or missing token exits 2, never "clean".

Resolving "whose upstream is on GitHub" is the load-bearing step, and three of npm's four `repository` shapes omit the host because GitHub is npm's default (`eslint/eslint`, `github:ds300/patch-package`). Matching the literal `github.com` alone silently skips them.

Allowlisting reuses `osv-scanner.toml`'s `[[IgnoredVulns]]` ids rather than adding a third allowlist file — same advisory namespace, same owner/reason/`ignoreUntil` contract, already gated by `scripts/check-allowlist-schema.sh`. That script owns the expiry: unlike OSV-Scanner, this gate does not read `ignoreUntil`, so **every caller must run it first** or a lapsed entry suppresses a match forever. Both callers do.

**Range precedence.** Repo-level ranges are publisher-written; global ones are curated on promotion. Usually the same split, written differently — and the difference decides the verdict. `GHSA-gpj5-g38j-94v9` on `drizzle-orm` splits the two release lines in **both** records; only the global one bounds them:

| Source     | Ranges for `drizzle-orm`                        |
| ---------- | ----------------------------------------------- |
| repo-level | `<= 0.45.1` · `<= 1.0.0-beta.19`                |
| global     | `< 0.45.2` · `>= 1.0.0-beta.2, < 1.0.0-beta.20` |

`<= 1.0.0-beta.19` is unbounded below, so under plain semver it also covers every `0.x` release — `semver.satisfies('0.45.2', '<=1.0.0-beta.19')` is `true`. The installed `0.45.2` is the patched release on its own line, and the global record's `>= 1.0.0-beta.2` is what says so. When a global record exists its ranges win; when it does not, the repo-level range is all there is and is used. Advisories with a global record are still evaluated rather than skipped, because OSV-Scanner replaced `npm audit` here and the two databases are not supersets of one another either.

The corollary is a false positive with no mitigation: when a split-line advisory is **repo-level-only** — the case this gate exists for — nothing supplies the missing lower bound, and the gate reds on a version that is in fact patched. Left unmitigated on purpose. Inferring a bound the publisher did not write would guess in the false-**negative** direction, and `@fastify/rate-limit`'s unbounded `< 11.2.0` below was a true positive of exactly that shape. The finding output flags the shape and the allowlist is the escape.

**What this layer does NOT cover.** §Decision.2 previously read as complete; it was not, and neither is this. Stated plainly so the next reader does not have to rediscover it:

| Not covered                                         | Why                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Transitive** deps                                 | Only direct deps are walked. A repo-level advisory on a lockfile-only package is invisible.                                                                                                                                                                                                                                          |
| Packages with no GitHub repository                  | **0 today** — all 58 direct deps resolve to 50 GitHub repos. The check lists any that stop resolving, by name, on every run.                                                                                                                                                                                                         |
| Repos with advisories disabled, renamed, or deleted | The endpoint 404s; listed by name on every run. 0 today.                                                                                                                                                                                                                                                                             |
| A stale **global** record overriding a repo match   | Global ranges win, so a global record that has not caught up silently clears a repo-level match. The run prints every such disagreement rather than passing in silence; nothing auto-fails it.                                                                                                                                       |
| A global range **wider** than the publisher's       | The global record is probed only to correct a repo-level match, never to find one — detection against the global DB is OSV-Scanner's job, in the same CI job. A curated range widened before OSV ingests it falls between the two. Keeps the probe at 1 request/run instead of 24, which matters given the anonymous fallback below. |
| Advisories upstream never files anywhere            | A silently-patched bug is invisible to all three layers. Nothing in CI can close this.                                                                                                                                                                                                                                               |
| Non-npm ecosystems                                  | Docker images, pinned Actions and CLI binaries have no equivalent gate. Trivy covers published OS/image CVEs only.                                                                                                                                                                                                                   |
| Malicious publishes with no advisory at all         | Different threat, different control — the release-age cooldown below.                                                                                                                                                                                                                                                                |

**The CI token cannot express "not in the global database."** `${{ github.token }}` is a GitHub App installation token, and on `/advisories/{ghsa_id}` it answers differently from a PAT. Measured on the same three ids — PAT and anonymous locally, App token in CI:

|                        | in global DB | **not** in global DB |
| ---------------------- | ------------ | -------------------- |
| PAT / anonymous        | 200          | 404                  |
| App installation token | 200          | **403**              |

A repo-level-only advisory is by definition one that 404s there, so the gate's own subject matter is the case CI cannot read. The first CI run died at exit 2 on `GHSA-3m5p-2c4r-xxw2` — one of the two fastify advisories that motivated this amendment. Likely cause rather than confirmed: GitHub's App-permissions table lists no global-advisory permission, and 403-instead-of-404 is the usual shape of "cannot confirm this does not exist"; the 200s show the endpoint is not refused outright.

Handled by downgrading a non-quota 403 to an anonymous request, which returns the honest 404. Anonymous quota is 60/h per IP, hence the lazy probe above. A scopeless PAT in `secrets` would lift it to 5000/h; not added, since only a repo admin can create one and 1 request/run is far from the ceiling.

**Landed red, deliberately.** The gate found two live repo-level-only advisories on its first real run — `GHSA-grpc-p53c-r64v` (`@fastify/rate-limit`, rate-limit bypass via IPv6 address rotation, fixed only in the 11.x line) and `GHSA-82fw-gwwq-j7x9` (`vitest`, path traversal, fixed in 4.1.11). Both had been open with CI green. Tracked and fixed alongside this change; a gate that ships with its own findings suppressed is not a gate.

### 2026-08-28 — Release-age cooldown, and its limits

Raised in [#345](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/345) §2 as "no release-age cooldown under auto-merge". Half of it was already there; the other half was in a place Renovate structurally cannot reach.

**Already covered.** `config:best-practices` extends `security:minimumReleaseAgeNpm` (`minimumReleaseAge: 3 days` + `internalChecksFilter: strict` for the npm datasource). This repo has extended `config:best-practices` since the ADR landed, so direct npm bumps have never been raised inside the 3-day window.

**The actual gap.** Renovate's `security:minimumReleaseAgeNpm` sets `minimumReleaseAge: null` for `lockFileMaintenance`, `pin`, `bump`, `rollback`, `lockfileUpdate` and `replacement`, because it delegates those to the package manager and has no release timestamp to age against. `lockFileMaintenance` is the daily, PR-limit-exempt, auto-merged path this project relies on for **all** transitive refresh (§2026-08-06 amendment) — so the one update type carrying the most unreviewed surface had no cooldown at all.

**Changed.** `.npmrc` sets `min-release-age=3`. npm applies it during resolution, which is the step Renovate hands off, so it covers the paths the preset carves out — plus local and CI installs. Renovate detects the key and skips its own `--before` flag rather than conflicting. Measured on the lockfile at `a32d900`: a full regeneration under `min-release-age=3` resolves 63 packages to older versions than an unconstrained run, transitives included.

**Rejected: adding `minimumReleaseAge` to a local `packageRule` matching `lockFileMaintenance`** (the fix #345 proposed). Local `packageRules` sort after preset rules, so it overrides the carve-out rather than complementing it; with `minimumReleaseAgeBehaviour=timestamp-required` (default since Renovate 42) an absent timestamp counts as not-yet-passed, and `internalChecksFilter: strict` then suppresses branch creation entirely. The likely outcome is lockfile maintenance silently stopping — reopening the exact gap §2026-08-06 was written to close. `.github/renovate.json`'s top-level `description` carries this warning at the config itself.

**Documented non-goal: non-npm cooldown.** `docker`, `github-tags`, `github-release-attachments` and `git-refs` pins carry no release-age delay. Docker Hub and `github-tags` do expose timestamps, so extending is technically possible, but GHCR and Quay do not — and under `timestamp-required` an un-ageable digest is held _indefinitely_ rather than raised, which turns a hardening step into a stalled update path. Revisit if a pin's threat profile changes; do not extend blindly.

**Accepted cost: the security-update bypass only exists on the Renovate half.** Renovate skips `minimumReleaseAge` for vulnerability PRs by design. npm has no equivalent — `min-release-age` flattens to `before = now - 3 days` with no exclusion list, and is `exclusive` with `--before`. So a fix published inside the window still resolves against the cutoff:

```
npm error code ETARGET
npm error notarget No matching version found for <pkg>@<range> with a date before <date>.
```

Renovate's own recovery is dead here. It retries lockfile generation without `--before` on ETARGET, but the retry is guarded on the flag being set (`if (beforeFlag && …)`) — and it deliberately leaves the flag empty when it sees `min-release-age` in `.npmrc`. The PR just stays broken until a human runs `npm install --min-release-age=0` (`--before` is refused as exclusive) or waits out the window.

Accepted because the alternative is worse: dropping `.npmrc` reopens the `lockFileMaintenance` gap, which is the daily auto-merged path carrying the most unreviewed surface. The failure is loud, bounded at 3 days, and has a one-command manual override. Revisit if it fires in practice.

### 2026-08-06 — Renovate does not remediate transitive deps

Three incidents cleared transitive npm advisories by hand: [#183](https://github.com/Projekt-Manager-Org/Projekt-Manager/pull/183) (`fast-uri`), [#272](https://github.com/Projekt-Manager-Org/Projekt-Manager/pull/272) (`undici`, 21 days after the alert opened), [#318](https://github.com/Projekt-Manager-Org/Projekt-Manager/pull/318) (`brace-expansion`, `fast-uri`, `undici`). §Consequences.Positive promised hours; the measured latency was days to weeks.

Cause, in two parts:

1. Renovate raises vulnerability PRs for **direct** deps only. None of the affected packages are in `package.json`, and none appear in the Dependency Dashboard's Detected Dependencies list — Renovate never saw them. Its `[security]` PRs on this repo ([#290](https://github.com/Projekt-Manager-Org/Projekt-Manager/pull/290), [#294](https://github.com/Projekt-Manager-Org/Projekt-Manager/pull/294)) were both direct deps.
2. The only fallback that would have caught them, `lockFileMaintenance`, was starved. One weekly window behind `prConcurrentLimit: 1` yields ~3 PRs/week against a 29-item queue; no lockfile-maintenance PR had landed since 2026-06-03.

Changed: Dependabot **security updates** enabled at the repo (Alerts alone only notify — they fired correctly on all seven and nothing acted on them); `lockFileMaintenance` moved to a daily schedule with its own unlimited PR budget, the same per-branch exemption `vulnerabilityAlerts` uses. §Decision.1 and §Consequences.Positive corrected in-place. The nightly OSV scan is unchanged and remains the backstop — it detected all three incidents.

Global `prConcurrentLimit` deliberately stays at 1. Raising it is a documented merge-queue revisit trigger ([dep-management.md § First-run setup step 6](../ops/dep-management.md#first-run-setup)), and the routine-update backlog it throttles is a throughput question, not a security one. Tracked as open, not closed.

### 2026-07-25 — E2E is not a PR gate

§Constraints and §Negative both assumed Playwright gates every PR. It does not — [`e2e.yml`](../../.github/workflows/e2e.yml) is `workflow_dispatch`-only, so auto-merged patch/minor bumps carry no E2E signal. Both passages corrected in-place; no decision changed.

## Dep lifecycle health (as of 2026-07-27)

Renovate, OSV-Scanner, Trivy and actionlint are the adopted _tooling_; the choice is reversible (move to Dependabot-only or to commercial SCA later). Concrete tool-version pinning lives in `.github/workflows/*.yml`, `.github/actions/*/`, and `.github/renovate.json`, and every pin is now on a Renovate update path (customManager 6 above closed the last gap). `scripts/check-renovate-annotations.mjs` scans both roots and fails the build on a pin no manager claims, so the "update path" is enforced rather than asserted.

| Dep                                | Last release        | License    | Maintainership                   | Notes                                                                                                                                                                                                                                                                             |
| ---------------------------------- | ------------------- | ---------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Renovate (`renovatebot/renovate`)  | active, weekly      | AGPL-3.0   | Mend, very active                | [deps.dev](https://deps.dev/npm/renovate) — industry default; self-hosted optional                                                                                                                                                                                                |
| OSV-Scanner (`google/osv-scanner`) | v2.4.0, 2026-06-18  | Apache-2.0 | Google OSS Security Team, active | [OSV-Scanner repo](https://github.com/google/osv-scanner) — backed by OSV.dev DB                                                                                                                                                                                                  |
| Trivy (`aquasecurity/trivy`)       | active, frequent    | Apache-2.0 | Aqua Security, very active       | [Trivy repo](https://github.com/aquasecurity/trivy) — de-facto OSS container scanner                                                                                                                                                                                              |
| actionlint (`rhysd/actionlint`)    | v1.7.12, 2026-03-30 | MIT        | **single maintainer** (`rhysd`)  | 4.1k stars, repo active (pushed 2026-07-16). Bus factor is the risk, not abandonment: next human contributor is 19 commits to rhysd's 2030. Exit ramp is cheap — it gates workflow files only, so dropping the step costs no runtime behaviour. Re-check at the quarterly review. |

## References

- [ADR-0007 (superseded)](0007-suppress-esbuild-dev-server-advisory.md) — `npm audit`-only baseline that proved insufficient; the suppression pattern is reused for OSV-Scanner allowlists.
- [ADR-0009](0009-pin-docker-versions-across-environments.md) — Docker version pinning; its existing version table is the lifecycle-health surface for the Docker stack.
- [Issue #187](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/187) — the omnibus audit this ADR is responding to.
- [Issue #191](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/191) — MinIO archival; the canonical failure case for "adopted-already-dying."
- [Issue #192](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/192) — libxmljs2 unmaintained replacement.
- [docs/ops/dep-management.md](../ops/dep-management.md) — runbook complement: cadence, wrangler procedure, lifecycle-review process.
- [Renovate docs](https://docs.renovatebot.com/) — configuration reference.
- [OSV-Scanner](https://google.github.io/osv-scanner/) — scanner + database.
- [Trivy](https://trivy.dev/) — container/image scanner.
- [deps.dev](https://deps.dev/) — Google's dep metadata aggregator (the canonical "is this package alive" lookup).
