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
- **Test confidence is high.** Unit + integration + Playwright E2E gates every PR. Auto-merge on green CI is a credible default for non-major bumps.
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
- **Lockfile maintenance** PR weekly to bound transitive drift.
- **Managers:** `npm`, `dockerfile`, `docker-compose`, `github-actions`, and four `customManagers` of type `regex`: Caddy version (`xcaddy build vN.N.N` in `docker/caddy/Dockerfile`), the `caddy-dns/cloudflare` plugin SHA in the same Dockerfile, and MinIO `mc`/`minio` image tags in `scripts/sync-*.sh` and `.github/workflows/*.yml` (Renovate's built-in `github-actions` manager doesn't see Docker images inside `run:` blocks). **Out of scope for Renovate:** Alpine `apk add` packages on top of base images (unpinned versions; surface enumerated and walked in [`docs/ops/dep-management.md` § Quarterly lifecycle review](../ops/dep-management.md#quarterly-lifecycle-review)) and Docker Engine apt packages on the VPS (tracked manually per [ADR-0009](0009-pin-docker-versions-across-environments.md) lifecycle table).

Dependabot Alerts stays on at the GH Security tab — it remains the CVE notification surface; Renovate is the **action** surface. The Renovate config also enables `osvVulnerabilityAlerts: true`, so Renovate raises vulnerability PRs against the OSV database in parallel — slight overlap with Dependabot is intentional belt-and-braces.

### 2. Supply-chain scanning in CI (blocking)

- **OSV-Scanner** (CLI v2.3.8 pinned by SHA256) — scans the npm tree against the OSV database. Free, OSS, broader DB than `npm audit`. **Blocks merge on any vuln**: the v2.3.8 CLI has no severity flag, so the implementation gates on every advisory OSV.dev publishes. This is stricter than originally drafted (HIGH/CRITICAL) and matches the project's "refuse-or-block, never downgrade" principle. False positives go through `osv-scanner.toml` with the owner/reason/expiry schema in §Negative.
- **Trivy** (`aquasecurity/trivy-action`) — scans the built Docker image, including OS packages (`apk`, `apt`) that OSV-Scanner can't see; plus filesystem secret scan and IaC misconfig scan. **Blocks merge on `HIGH` / `CRITICAL`** (Trivy supports `--severity` and the noisier surfaces it scans benefit from the filter). Runs on PRs that touch image-affecting paths (`Dockerfile*`, `package.json`, `package-lock.json`, `docker-compose*`, `docker/**`, `.github/workflows/ci.yml`); post-merge backstop in `build-and-push`.

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
- **CVE time-to-merge measured in hours.** Vulnerability PRs bypass schedule; with auto-merge on green CI for patch/minor, the median CVE patch lands the same day it is published.
- **Dying-upstream signal at decision time.** The mandatory lifecycle-health section converts "the agent recommended MinIO" into "the agent recommended MinIO; here is its archive flag, last release, license, deps.dev score at adoption time." A future reader has an evaluable trail.
- **Quarterly review catches BSL/SSPL relicensings and bus-factor erosion** without depending on someone happening to notice during routine work.
- **Existing artifacts cooperate.** Dependabot Alerts is unchanged. ADR-0009's Docker version table doubles as the lifecycle table for that ADR's deps.
- **Aligned with the project's "refuse to serve" principle** — CVE scanning in CI blocks the merge, not deferring it to a runtime probe.

### Negative

- **PR queue volume.** A weekly window with grouping should land 3–8 PRs/week in steady state. The "weekly wrangler" hat is ~30 min/week.
- **Auto-merge depends on CI confidence.** If Playwright E2E flakes, auto-merge produces false-green merges. No flake-quarantine practice is documented today — explicit gap. Interim mitigation: auto-merge stays off for major PRs (the highest-risk class). A future iteration revisits this once a quarter of CI history is available, at which point a tuning rule and its implementing mechanism land together — committing to a numeric threshold here without the calculator that enforces it would be exactly the placeholder-as-policy class the project avoids.
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
  - **`docker` job** (path-filtered to image-byte-affecting paths, PR-only, required by branch protection): compose validation + app image build + Trivy app-image-vuln scan (HIGH/CRITICAL) + OCI-layout export + backup image build (FROM aliased to the exported layout via buildx `build-contexts`) + Trivy backup-image-vuln scan. Reported as Skipped on non-image PRs.
  - **`build-and-push` job** (post-merge / `workflow_dispatch`, never runs on PRs): build app → Trivy scan → push app → build backup → Trivy scan → push backup (in that order — a failed scan never publishes the tag, so `scripts/deploy.sh` cannot resolve a bad SHA).
- `.github/workflows/security-scheduled.yml` — nightly OSV-Scanner run against `main` so newly-published advisories surface without waiting for a PR.
- `osv-scanner.toml` (repo root) — allowlist file; empty on landing, schema documented in `docs/ops/dep-management.md`.
- `.trivyignore` (repo root) — allowlist file for Trivy; empty on landing, same schema discipline.
- [docs/ops/dep-management.md](../ops/dep-management.md) — runbook (first-run setup, weekly wrangler, quarterly review, allowlist schema).
- `scripts/check-allowlist-schema.sh` + `scripts/__tests__/check-allowlist-schema.test.sh` — wired into the `lint` job; rejects allowlist entries missing owner/reason/expiry per §Negative.

**Gating model rationale.** Trivy fs-secret + IaC scans live in `lint` (not `docker`) because `docker` is path-filtered — placing the scans there would skip them on every TS-only / docs / e2e PR, leaving large coverage gaps. Image-vuln scanning stays in `docker` (needs the built image, and the image only changes on image-affecting paths) and in `build-and-push` (post-merge backstop with build-before-publish ordering). Branch protection requires `lint`, `check`, and `docker`; on a non-image PR `docker` is reported as Skipped which [counts as a successful required check on GitHub](https://docs.github.com/en/actions/using-jobs/using-conditions-to-control-job-execution), so adding it as required does not block PRs that don't touch image bytes. `build-and-push` is post-merge only (never runs on PRs), so it cannot be a PR gate by construction — its scan-before-publish ordering is the deploy-time safety net.

**Backup image at PR time (#219).** `Dockerfile.backup`'s `FROM ghcr.io/.../projekt-manager:${APP_IMAGE_TAG}` references the GHCR copy of the app image — which only exists post-merge (`build-and-push` runs on push/dispatch, not on `pull_request`). Without indirection, the backup image's CVE surface (its own `apk add` layers on top of `node:22-alpine`, plus everything the app image carries) can only be scanned after merge. That mode put `main` red in #218 — a base-layer CVE landed via a Renovate auto-merge that passed PR-CI (which only built+scanned the app image), then `build-and-push`'s post-merge backup scan failed. To close it, the `docker` job now exports the app image as an OCI layout and aliases the GHCR reference via buildx's `build-contexts` (`oci-layout://`), so the backup build resolves locally and gets scanned before merge. No `Dockerfile.backup` change, no driver downgrade, no registry round-trip; the `APP_IMAGE_TAG=oci` build-arg is a sentinel that lines up with the `build-contexts` suffix and is never pushed anywhere.

Acknowledged tradeoff: PR-time image-vuln gating coverage is the union of `docker`'s path filter. If a PR changes image bytes through a path NOT in the filter (the filter explicitly covers `Dockerfile*`, `docker/**`, `package*.json`, `patches/**`, `tsconfig*.json`, `docker-compose*` and this workflow), the image-vuln scan is deferred to `build-and-push`'s post-merge run, where a failing scan blocks the push and therefore the deploy (`scripts/deploy.sh` resolves images by SHA tag — a never-published tag cannot be deployed).

`ignore-unfixed` is NOT set on any image scan: a no-fix-yet CVE is still a finding, and an operationally-tolerable case goes in `.trivyignore` with owner/reason/exp ≤90d. This makes the failure mode visible — when an unfixable upstream CVE lands, the deploy pipeline halts until either the upstream fixes it or an operator writes a deliberate, time-bounded allowlist entry; the `ignore-unfixed: true` shortcut would have suppressed it silently forever. The runbook's [§CVE handling](../ops/dep-management.md#cve-handling) covers the operator procedure.

- The `vv-adr` skill template is updated; retrofits to the existing ADRs in the included set land in the same change as this ADR.
- No env-var or schema impact.

## Dep lifecycle health (as of 2026-05-15)

Renovate, OSV-Scanner, and Trivy are the adopted _tooling_; the choice is reversible (move to Dependabot-only or to commercial SCA later). Concrete tool-version pinning lives in `.github/workflows/*.yml` and `.github/renovate.json` and is tracked by Renovate's own self-update path.

| Dep                                | Last release     | License    | Maintainership                   | Notes                                                                                |
| ---------------------------------- | ---------------- | ---------- | -------------------------------- | ------------------------------------------------------------------------------------ |
| Renovate (`renovatebot/renovate`)  | active, weekly   | AGPL-3.0   | Mend, very active                | [deps.dev](https://deps.dev/npm/renovate) — industry default; self-hosted optional   |
| OSV-Scanner (`google/osv-scanner`) | active           | Apache-2.0 | Google OSS Security Team, active | [OSV-Scanner repo](https://github.com/google/osv-scanner) — backed by OSV.dev DB     |
| Trivy (`aquasecurity/trivy`)       | active, frequent | Apache-2.0 | Aqua Security, very active       | [Trivy repo](https://github.com/aquasecurity/trivy) — de-facto OSS container scanner |

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
