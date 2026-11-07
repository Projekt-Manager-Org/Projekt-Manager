# Dependency management

What tracks, updates and audits external deps, and how a problem reaches you. Current mechanics: [ADR-0028](../adr/0028-dependency-ci-coverage-matrix-and-gated-deploy.md). Tool choices: [ADR-0027](../adr/0027-continuous-dependency-updates-with-supply-chain-scanning.md).

## Coverage matrix

Every dependency source has an update path and an alert path, or a row under [§ Accepted gaps](#accepted-gaps). A new source adds a row.

| Source                                                          | Pinned in                                                                                                                           | Update path                                                                                                                                                    | Alert path                                                                                                                                                                                                                                                |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm, direct                                                     | `package.json`                                                                                                                      | Renovate: non-majors auto-merged once 3 days old; majors in Pending Approval; a vulnerability PR out of band within hours                                      | OSV-Scanner and repo-level advisories: red PR on what a change introduces, ci-red nightly on `main`. Dependabot email                                                                                                                                     |
| npm, transitive                                                 | `package-lock.json`                                                                                                                 | `lockFileMaintenance` daily; Dependabot security update, or by hand ([§ CVE handling](#cve-handling))                                                          | OSV-Scanner as above, every severity. Dependabot email. Repo-level advisories read direct deps only                                                                                                                                                       |
| Node runtime                                                    | `.nvmrc`, `package.json` `devEngines`, `Dockerfile`, `Dockerfile.backup`                                                            | Renovate, one grouped PR; majors in Pending Approval                                                                                                           | Grype's binary match in the inventory scan. It waits on NVD enrichment, so staying current is the first line ([ADR-0027 § 2026-10-29](../adr/0027-continuous-dependency-updates-with-supply-chain-scanning.md#2026-10-29--security-releases-outside-npm)) |
| Runtime images: `node`, `postgres`, `caddy`, Caddy builder      | `Dockerfile`, `Dockerfile.backup`, `docker/caddy/Dockerfile`, `docker-compose.yml`, `docker-compose.http.yml`, CI postgres services | Renovate, `linux/amd64` digest, auto-merged in hours; majors in Pending Approval                                                                               | Inventory scan: red push run (`deploy.sh` refuses), ci-red nightly. `deploy-asap` opens Deploy pending                                                                                                                                                    |
| Alpine packages in our images                                   | Unpinned `apk upgrade` and `apk add` in `Dockerfile`, `Dockerfile.backup`; the `postgresql17*` major by regex                       | Every image build takes the latest; the Postgres major with `postgres`                                                                                         | Inventory scan                                                                                                                                                                                                                                            |
| Caddy and its Go modules                                        | `docker/caddy/Dockerfile`: `xcaddy build`, `--with`                                                                                 | Renovate, auto-merged: Caddy in hours, the `--with` modules once 3 days old; majors in Pending Approval                                                        | Inventory scan, `caddy` job                                                                                                                                                                                                                               |
| GitHub Actions                                                  | `uses:` at a 40-hex SHA, in workflows and composite actions                                                                         | Renovate, auto-merged once 3 days old; majors in Pending Approval                                                                                              | None: accepted gap                                                                                                                                                                                                                                        |
| CI binaries: OSV-Scanner, actionlint, ripgrep, `age`, Grype     | URL + SHA256 with a `# renovate:` annotation, in workflows and composite actions                                                    | Renovate, auto-merged once 3 days old; majors in Pending Approval                                                                                              | None: accepted gap                                                                                                                                                                                                                                        |
| CI tool images: Renovate validator, `lychee`, Dockerfile syntax | `docker://` digest in `ci.yml`; `# syntax=` in `docker/caddy/Dockerfile`                                                            | Renovate                                                                                                                                                       | None: accepted gap                                                                                                                                                                                                                                        |
| Docker host packages                                            | `docker/host-versions.txt`                                                                                                          | Renovate: one grouped PR a quarter, never auto-merged; on the VPS after a deliberate bump ([ADR-0009](../adr/0009-pin-docker-versions-across-environments.md)) | `docker-host-advisories.yml`: an issue per upstream advisory, nightly                                                                                                                                                                                     |

Renovate's vulnerability PRs are [direct-dependency-only by design](https://docs.renovatebot.com/configuration-options/#osvvulnerabilityalerts), hence the transitive row. Dependabot emails critical and high alerts only; lower severities reach you through the nightly OSV scan.

### Accepted gaps

| Gap                                                                                                | Why accepted                                                                                                                                         | What bounds it                                                                                                              |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Advisories on SHA-pinned actions                                                                   | Dependabot alerts [match semantic versions, not SHAs](https://docs.github.com/en/code-security/dependabot/dependabot-alerts/about-dependabot-alerts) | Renovate raises every update; a major waits for approval                                                                    |
| Advisories on CI binaries and CI tool images                                                       | No scan looks at them; they run in CI and never ship                                                                                                 | Renovate raises every update; a major waits for approval                                                                    |
| Alpine fixes without a base bump                                                                   | The `postgres` image is taken as published, not rebuilt here                                                                                         | The inventory scan reports the finding                                                                                      |
| EOL of a held major                                                                                | Nothing alerts on it                                                                                                                                 | The support-window check in [§ Quarterly lifecycle review](#quarterly-lifecycle-review), which has not yet completed a loop |
| Vendored Factur-X and EN 16931 schemas                                                             | No feed exists; `src/server/services/invoice/xsd/`, `src/test/en16931/`                                                                              | A deliberate update when the standard changes                                                                               |
| A future pin with no annotation                                                                    | Nothing can flag what no manager knows about                                                                                                         | Code review; [§ Two-way check](#two-way-check) when adding sources                                                          |
| Runner images (`ubuntu-latest`) and their tools (`shellcheck`, `jq`)                               | GitHub maintains them                                                                                                                                | A breaking change shows as a red run                                                                                        |
| Pending Status Checks forever-hold                                                                 | A release that never gets a timestamp would wait forever                                                                                             | Prevented by config: the first editing rule under [§ Release-age cooldown](#release-age-cooldown)                           |
| A failed `Dependabot Updates` run                                                                  | It has no alert of its own                                                                                                                           | A non-allowlisted advisory still turns the nightly OSV scan red                                                             |
| Frozen MinIO images (`minio`, `mc`)                                                                | Dev and CI emulator, archived upstream, no real data ([ADR-0003](../adr/0003-deployment-infrastructure-vps-docker-compose-github-actions.md))        | `exception-register.yaml` row with a `review_by` date                                                                       |
| Tools each machine installs by apt: `python3-boto3` (CI, dev, VPS sync), `age`, `shellcheck` (dev) | They follow that machine's distribution and ship in no image                                                                                         | A break shows as a red run or a failed script                                                                               |
| Playwright's browser in E2E                                                                        | CI only; it follows `@playwright/test`                                                                                                               | A break shows as a red nightly                                                                                              |
| Stock Caddy in `docker-compose.http.yml`                                                           | Evaluation mode, no real data ([ADR-0013](../adr/0013-http-only-evaluation-mode.md)); not in the deployed inventory, so not scanned                  | Renovate updates it                                                                                                         |
| Pinned LLM model (`OPENROUTER_MODEL`)                                                              | A provider's model id; no feed exists                                                                                                                | [§ Quarterly lifecycle review](#quarterly-lifecycle-review)                                                                 |

**Open, not accepted:** VPS OS packages, including `wireguard-tools`. `unattended-upgrades` owns them, and its failure alerts nobody ([#740](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/740) § Track separately).

### Two-way check

Last run 2026-11-07 at `680249d1`, Dependency Dashboard ([#201](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/201)) against a repo-wide sweep for pins and installs.

- **Detected → matrix.** Every entry under Detected Dependencies has a row: `docker-compose`, `dockerfile`, `github-actions`, `npm`, `nvm` and the nine `regex` files.
- **Repo → Detected.** Every pin or install missing from Detected Dependencies is named above: MinIO, the apt tools, Playwright's browser, the LLM model, the unpinned `apk` packages, `wireguard-tools` and `qrencode`, and the runner images.

Repeat it when adding a source: compare the dashboard's list with `git grep -nE 'sha256:|@[0-9a-f]{40}|apt(-get)? install|apk add|playwright install|runs-on'`; anything else pinned by name, such as a model id, only the strategic list below shows.

### What reaches you

| Signal                     | Means                                         | Do                                                                 |
| -------------------------- | --------------------------------------------- | ------------------------------------------------------------------ |
| PR assigned to you         | That PR is red right now                      | Fix it; the assignment clears on green                             |
| `ci-red` issue             | A run on `main` is red: push or nightly       | [§ CVE handling](#cve-handling); it closes on the next green run   |
| Deploy pending issue       | A merged fix is not running yet               | [§ Deploy urgency](#deploy-urgency)                                |
| Docker host advisory issue | An upstream advisory on a pinned host package | [server-setup.md](server-setup.md#triaging-a-docker-host-advisory) |
| Dependabot email           | Critical or high advisory on an npm dep       | Expect the PR; else [§ CVE handling](#cve-handling)                |
| `deploy.sh` refuses        | The target commit's push run is not green     | [manual-deploy.md § CI check](manual-deploy.md#ci-check)           |

Why the checks sit where they do: [ADR-0028](../adr/0028-dependency-ci-coverage-matrix-and-gated-deploy.md#decision).

## Guards

Every check CI runs, and why it is here. The rule ([ADR-0028](../adr/0028-dependency-ci-coverage-matrix-and-gated-deploy.md#decision)): a guard stays if it caught something, protects an AC or spec rule, or is the only signal of a failure that would otherwise be silent.

Evidence read 2026-11-07: the red `lint` runs whose logs survive (12 of the 23 since 2026-07-22, none before), plus issues and PRs. So "no catch on record" does not prove "never".

**Bought**, no logic of ours:

| Guard                                                                | Protects                            | Evidence                                                                                                                                                                                                                   |
| -------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ESLint (and our route-registration rule), Prettier, `tsc`, the build | Code                                | Prettier and `tsc` red on real problems, 2026-08 and 2026-09                                                                                                                                                               |
| shellcheck, actionlint                                               | Scripts and workflows               | A red actionlint on a new check is usually right ([§ Weekly wrangler](#weekly-wrangler))                                                                                                                                   |
| `renovate-config-validator`                                          | Renovate config                     | Silent otherwise: a bad config stops updates                                                                                                                                                                               |
| OSV-Scanner                                                          | npm advisories                      | Red on real advisories, 2026-07 and 2026-08. Dependabot alerts carry only GitHub-reviewed advisories and no malicious-package records                                                                                      |
| Trivy, Grype (images)                                                | What ships                          | Grype alone caught GO-2026-6865 in Caddy, and the Node and Postgres binaries of [ADR-0027 § 2026-10-29](../adr/0027-continuous-dependency-updates-with-supply-chain-scanning.md#2026-10-29--security-releases-outside-npm) |
| Trivy (filesystem secrets, IaC)                                      | Committed secrets, misconfiguration | Security default                                                                                                                                                                                                           |
| lychee                                                               | AC-348                              | Protects the AC                                                                                                                                                                                                            |

**Owned, kept.** The last column says why no bought tool does it:

| Guard                                                                                                | Protects                                                            | Why ours                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/check-repo-advisories.mjs`                                                                  | Advisories never promoted to the global DB                          | No lockfile scanner or Dependabot sees them. Three caught on 2026-11-03                                                                                    |
| `scripts/check-release-age.mjs`                                                                      | Young versions in any PR's lockfile                                 | Renovate's cooldown covers only its own PRs                                                                                                                |
| `scripts/check-osv-introduced.mjs`                                                                   | OSV verdict on the change, not on `main`                            | OSV-Scanner has no base comparison                                                                                                                         |
| `scripts/check-allowlist-schema.sh`                                                                  | Waiver owner, reason, expiry ≤ 90 days                              | No scanner checks this, and Grype ignores `expires`                                                                                                        |
| `scripts/check-exception-register.sh`                                                                | No exception or hold without a dated row                            | Nothing else holds a Renovate hold to account                                                                                                              |
| `scripts/ci/renovate-health.mjs`                                                                     | Closed PRs, stalled branches, a stopped updater                     | Renovate does not alert on itself. Silent otherwise: Postgres 18 was ignored for months                                                                    |
| `scripts/check-renovate-annotations.mjs`                                                             | A pin no manager matches                                            | Silent: the pin just stops advancing; Renovate does not warn. No catch on record                                                                           |
| `scripts/check-notify-coverage.sh`                                                                   | A workflow unhooked from `notify.yml`                               | Silent: it fails red with nobody told. No catch on record                                                                                                  |
| `scripts/check-env-drift.sh`                                                                         | A variable not forwarded to the app container                       | Silent: the app takes its default. #57 shipped it. No catch on record                                                                                      |
| `scripts/check-node-pin.sh`                                                                          | One Node across dev, CI and images                                  | Silent: a split leaves everything green. Added 2026-11-01, too young to judge                                                                              |
| _Validate Compose file references_ (`ci.yml`)                                                        | An unset `${FOO}`                                                   | Silent: `docker compose config` exits 0 and it renders blank. No catch on record                                                                           |
| `scripts/check-doc-paths.sh`, `scripts/check-links.sh`                                               | AC-347, AC-348                                                      | Project rule; `check-doc-paths` red 2026-10-31                                                                                                             |
| `scripts/check-audit-mutations.sh`                                                                   | AC-179                                                              | Project rule; no tool knows it                                                                                                                             |
| `scripts/check-theme-tokens.sh`                                                                      | AC-108, AC-113                                                      | Project rule; no tool knows it                                                                                                                             |
| `scripts/check-traceability.sh`                                                                      | S-ACTR, S-TRAC                                                      | Project rule; no tool knows it                                                                                                                             |
| `check:openapi`, `check:api-surface`                                                                 | AC-351, AC-352                                                      | Generated from our routes                                                                                                                                  |
| `check:baseline`                                                                                     | Migration baseline matches its generator                            | Data integrity; generated from our migrations                                                                                                              |
| `scripts/check-spec-change.sh`, `spec-change.yml`                                                    | [CONTRIBUTING.md § Workflow](../../CONTRIBUTING.md#workflow) step 1 | Required check                                                                                                                                             |
| `scripts/ci/docker-host-advisories.sh`, its workflow                                                 | Docker host packages                                                | No feed covers them ([ADR-0009](../adr/0009-pin-docker-versions-across-environments.md))                                                                   |
| `scripts/ops/deploy-ci-gate.sh`                                                                      | Deploy only what was scanned                                        | Exercised on the real path: green, refused, override                                                                                                       |
| `.github/actions/build-scan-smoke`, `docker` job                                                     | Image boots; Tier 1 backup round-trip                               | Runs the real compose config against the real bytes                                                                                                        |
| `check-shard`, `check`                                                                               | AC-37: unit, component and API integration tests                    | The project's own test suite                                                                                                                               |
| `publish`, `promote` guards (_Refuse a commit already on main_, _Is this commit still main's head?_) | An image name only on the commit that was tested                    | [ADR-0011](../adr/0011-build-images-in-ci-distribute-via-ghcr.md#decision)                                                                                 |
| `e2e.yml`                                                                                            | AC-37 and the browser journeys                                      | Nightly, not a PR gate ([ADR-0027 § 2026-07-25](../adr/0027-continuous-dependency-updates-with-supply-chain-scanning.md#2026-07-25--e2e-is-not-a-pr-gate)) |
| `notify.yml`, `deploy-pending.yml`, `scripts/ci/deploy-pending.sh`                                   | The alert path                                                      | GitHub's Actions email reaches only the run's triggering actor, a bot on most merges                                                                       |

**Plumbing**, serving the above, not guards themselves: `scripts/ci/` `run-self-tests.sh`, `trivy-gate.sh`, `grype-gate.sh`, `gate-base.sh`, `deploy-inventory.sh`, `image-refs.sh`; `scripts/lib/deploy-compose.sh`; the actions `trivy-image`, `tag-images`, `install-age`, `install-osv-scanner`, `start-minio`; the workflows `security-scheduled.yml`, `inventory-scan.yml`, `renovate-health.yml`. Housekeeping: `ghcr-retention.yml`, `scripts/ci/ghcr-retention.sh` (registry space) and `cache-cleanup.yml` (unmonitored on purpose: a failure costs disk only).

**Deleted:**

| Guard                                               | Why                                                                                                                                                                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workflow drift check (`ci.yml` ↔ `e2e.yml`)         | No catch on record, no AC. Renovate moves both postgres pins in one PR. A different `env`, `ports` or `options` either leaves each workflow self-consistent or fails its next run; a dropped `install-age` call fails the next E2E nightly |
| Lockfile-pin drift step                             | Never fired in the surviving logs, no AC. `npm ci`, the next step, fails on the same drift; the step only worded it better                                                                                                                 |
| `notify.yml` findings comparison, `upload-findings` | ~900 lines that never ran in production. A repeat red now lists its failed steps and annotations                                                                                                                                           |
| Action metadata check                               | Existed only for `upload-findings`; the pre-merge dispatch catches the same failure                                                                                                                                                        |
| Trivy image base comparison                         | Replaced by the scan on the merged commit                                                                                                                                                                                                  |

## Weekly wrangler

1. Open the Renovate dashboard issue — queue state at a glance.
2. **Abandonment flags**: scan the dashboard's "Abandoned Dependencies" list for new entries. Verify each per [§ Abandonment-flag verdicts](#abandonment-flag-verdicts); record a verdict + (for false positives) add the package to `.github/renovate.json` `packageRules` in the same commit.
3. **Auto-merged PRs** (patch/minor/digest + green CI — grouped clusters and lockfile maintenance included) need no action; spot-check for surprises.
4. **Majors** wait under Pending Approval on the dashboard: read the upstream migration guide, tick to create the PR, run `npm test` + `npm run test:e2e` locally on the bump branch, merge.
5. **Open Docker host advisory issues**: is the fix in Docker's apt repo yet? If so, bump per [server-setup.md § Triaging a Docker host advisory](server-setup.md#triaging-a-docker-host-advisory).
6. **Exception register** ([§ Exception register](#exception-register)): act on rows whose `review_by` falls before the next pass; the nightly security scan turns red the day after.
7. Red CI: triage the failure, patch or revert. `.github/workflows/notify.yml` raises the signal — a red PR assigns itself to the maintainer and clears the assignment once green, so **assigned to you = red right now**, not "was red at some point"; a red `main` (post-merge `push` or the nightly scan) opens a `ci-red` issue instead, closed automatically on the next green run. The issue and each later red run's comment list the failed jobs and steps with their error annotations, so compare them to see what is new; GitHub keeps 10 annotations per step, flagged when possibly capped. A timeout on `main` counts as red, though GitHub shows it as `cancelled`; so does cancelling a started run there by hand. The wrangler pass is the backstop, not the discovery mechanism — its remaining jobs are the cases that alert nobody: a run that never queued, a `startup_failure` (`workflow_run` does not fire, measured on #349; it cannot merge, as the required checks never report), and a PR run that timed out (it concludes `cancelled`, like a superseded run; a Renovate PR surfaces after 7 days via `Renovate health`). `Cache cleanup` is unmonitored on purpose: a failure costs disk only. Do not rely on GitHub's Actions email here: it reaches only the run's triggering actor, which on a bot-merged PR is the bot, on the post-merge push too.

**Pinned CLI binaries** (OSV-Scanner, actionlint, ripgrep, age) bump version _and_ SHA256 in one PR — never hand-edit a checksum. A red PR from one is usually correct and load-bearing, e.g. a new actionlint check firing on an existing workflow. Fix the finding, don't pin back. A new OSV-Scanner build that reports a fresh advisory does not red its own PR (both scans use it, so the finding is on the base too); the nightly does.

`age` has **one** pin, in the composite action `.github/actions/install-age`, called from `ci.yml`'s `check-shard`, from `e2e.yml` and from the `build-scan-smoke` composite (the smoke test's throwaway identity — an unpinned `apt-get install age` until #374). It used to be two hand-synced copies plus that apt install, guarded by a drift check over the first two; the objection to deduplicating them — Renovate's customManager scanned `.github/workflows/**` only, so a composite would have hidden the pin — was removed by extending manager 4 and `scripts/check-renovate-annotations.mjs` to `.github/actions/*/*.{yml,yaml,sh}`. The pin sits in the `.sh` half: a composite's procedure goes in a sibling script (`install-age.sh`, `start-minio.sh`) so CI's shellcheck gate covers it — actionlint does not read `action.yml`, so an inline `run:` body is linted by nothing. The runner evaluates `${{` even in a metadata description, failing the action's load (#736); for an action only nightlies use, the pre-merge dispatch ([CONTRIBUTING.md](../../CONTRIBUTING.md#workflow)) catches that. `action.yml` stays in scope regardless, since a composite may still hold one. **Any new checksum-pinned binary in a composite action is tracked and gated the same way.**

Editing an install step, two constraints fail silently: keep the version in the `version` variable exactly once, as the literal git tag with the `v` prefix and all or neither (`v`-prefixed for OSV-Scanner, unprefixed for ripgrep); and keep the annotation, `version=` and `expected_sha=` on consecutive lines. `scripts/check-renovate-annotations.mjs` enforces both.

## CVE handling

- **New advisory against what `main` already ships** — the change-scoped PR gates stay green: they fail only on findings a change introduces ([ADR-0027 § 2026-10-31](../adr/0027-continuous-dependency-updates-with-supply-chain-scanning.md#2026-10-31--pr-gates-judge-the-change-not-main)). The nightlies (`Security (scheduled)`, `Inventory scan`) go red; triage per the bullets below — fix, or allowlist when unreachable or unfixed. A red image nightly only warns at deploy, but the next merge's push run scans the same images and `deploy.sh` then refuses that commit, so triage is the normal path and [the override](manual-deploy.md#ci-check) is for emergencies.
- **High/Critical** — non-majors auto-merge; merge a major on green CI, even off-hours.
- **Medium/Low** — majors at the next wrangler pass.
- **Unrated (Trivy `UNKNOWN`, Grype `Unknown`)** — triaged like High: fix, or allowlist. Not yet scored is not low ([ADR-0027 §Decision.2](../adr/0027-continuous-dependency-updates-with-supply-chain-scanning.md#2-supply-chain-scanning-in-ci-blocking)); Go vuln DB records carry no severity by design. When a waiver on a Go binary needs a reachability verdict, run `govulncheck -mode=binary <binary>` by hand.
- **Transitive-only npm dep** (vulnerable package is in `package-lock.json`, absent from `package.json`) — Renovate will never file this PR. Expect Dependabot's; if it hasn't appeared by the time the nightly OSV scan goes red, bump by hand — `npm update <pkg>…`, which touches the lockfile only. Confirm the new version is clean before opening the PR:

  ```bash
  curl -s -X POST https://api.osv.dev/v1/query \
    -d '{"package":{"name":"undici","ecosystem":"npm"},"version":"7.29.0"}'
  ```

- **False-positive on dead code** (cf. the original [ADR-0007](../adr/0007-suppress-esbuild-dev-server-advisory.md) case): add the advisory to the OSV-Scanner allowlist with a documented review trigger. Never `--omit=dev` blanket-suppress.
- **No-fix-yet OS-package CVE in a base image** (Alpine `node:22-alpine`, `postgresql17-alpine`, etc., where the upstream distro hasn't shipped a patched build yet): the push run and the nightly inventory scan stay red, so `deploy.sh` refuses, because `ignore-unfixed: true` is deliberately not set (per [ADR-0027 §Operational](../adr/0027-continuous-dependency-updates-with-supply-chain-scanning.md#operational); see also [§Allowlist](#allowlist) for the schema). It stays so until either Alpine ships the fix or an operator writes a deliberate, time-bounded allowlist entry in `.trivyignore.yaml` (and `.grype.yaml` if Grype reports it too), scoped to the package.

  90 days is the maximum permitted window; pick a shorter date if upstream has a target ship-date. The expiry forces a re-review and the entry stops suppressing automatically — there is no silent-forever suppression path. Track the upstream CVE in the Renovate dashboard so the entry gets removed (not renewed) when the fix lands.

- **`Inventory scan is red on main`** (ci-red issue from `inventory-scan.yml`).
  - **`allowlists` job** — an allowlist entry expired or is malformed. The scans still run; Grype still applies a lapsed `.grype.yaml` entry.
  - **`inventory` job** — the inventory cannot be derived (an image holding a variable other than `APP_IMAGE_TAG`, a build with args/target). No image is scanned until it is fixed.
  - **`scan (<service>)` finding with a fix upstream** — the Renovate update that carries it is the fix; do not bump by hand. Check the Dependency Dashboard, including Pending Approval, for the image or module that carries it. Only a component no manager claims needs a `renovate.json` change.
  - **Unreachable or no fix** — allowlist entry, scoped to the package or path ([§Allowlist](#allowlist)).

- **`Renovate health is red on main`** (`renovate-health.yml`; the job log lists each finding).
  - **Awaiting Schedule: `<branch>`** — a scheduled branch outside `AWAITING_EXEMPT`: exempt a deliberate new schedule there, else fix the config. Never a manual bump.
  - **Other Branches: `<branch>` has no PR** — an update outside `OTHER_EXEMPT`: read the Mend job log.
  - **No lockfile PR merged in 7 days** — lockfile maintenance has stopped landing: read the Mend job log. A failed generation (`ETARGET`, [§ When resolution ETARGETs](#when-resolution-etargets)) produces no PR.
  - **Dashboard section `"PR Closed (Blocked)"`** — a closed Renovate PR: Renovate ignores that update from then on. To release it, rename the closed PR; it then follows the normal rules, so a major waits in Pending Approval. The dashboard's recreate box skips that approval. To keep holding it, use `allowedVersions` with a register row ([§ Exception register](#exception-register)), then rename.
  - **Dashboard section `"<title>"`** — any other heading outside `BENIGN_SECTIONS` in `scripts/ci/renovate-health.mjs` (Errored, Repository Problems, Rate-Limited, PR Edited (Blocked), or a new one): read the dashboard and the Mend job log ([developer.mend.io](https://developer.mend.io)). A new heading that needs no action goes into that set.
  - **Dependency lookup failed / no or several dashboards / no "manual job" box** — a Renovate config or Mend app problem: read the Mend job log.
  - **"manual job" box still ticked** — no Renovate job ran since the last check. Check the repo's status and job log on the Mend portal. A manual re-run shortly after the nightly reports this too, until Renovate's job lands.
  - **Renovate PR `#n` open since …** — merge or fix it; a stuck PR also holds a PR-limit slot. Closing it raises `PR Closed (Blocked)`.

- **`Deploy pending is red on main`** — a pushed commit could not be resolved to a PR after retries (#716; the `Last answer:` line shows what the lookup saw), or an API call failed. One push can carry several merge-queue PRs: check every PR the run's `::error::` lines name (or, if the commit list failed, every PR of that push) for `deploy-asap` by hand, then close the issue: a later green run does not close it.

- **`Docker host advisories is red on main`** — the run's `::error::` lines name the cause. An upstream repo that could not be read (a 404: misspelled, deleted or private — fix the row; check its advisories by hand) or an issue that could not be opened or reopened (check the named advisory by hand) skips only that item. Any other cause reports nothing: a pinned package without a row in `docker/host-advisory-repos.txt` (add it), an unreadable pins or mapping file, an invalid `lookback_days`, or the reported-issue list unreadable (its line names the advisories it held back). Red for more than 7 days: once fixed, dispatch with `lookback_days` covering the gap.

### Deploy urgency

`deploy-asap` means _what runs is exposed until this is deployed_. Renovate sets it ([ADR-0027 § 2026-10-29](../adr/0027-continuous-dependency-updates-with-supply-chain-scanning.md#2026-10-29--security-releases-outside-npm)), and so does Dependabot on its security updates (`.github/dependabot.yml`); **add it by hand, before merging, to a hand-written security fix** (the run at merge time reads the labels once). Merging opens, or comments on, the **Deploy pending** issue, assigned to the operator: deploy ([manual-deploy.md](manual-deploy.md)), then close it. A lockfile-maintenance fix carries no label: the close of the nightly OSV ci-red issue is the cue to deploy. Everything else rides along with the next deploy.

A digest update should mean the image we run changed, so `node`, `postgres` and `caddy` pins name the `linux/amd64` manifest, not the tag's index: the index digest changes each time another architecture lands (#780). Renovate keeps a platform pin on its architecture. For a new pin, take the `linux/amd64` digest from `docker buildx imagetools inspect --raw <image>`.

### Allowlist

The contract — id, owner, reason, expiry ≤ 90 days, scope and nothing else (YAML files) — is [ADR-0027 §Negative](../adr/0027-continuous-dependency-updates-with-supply-chain-scanning.md#negative); this section is its single home for formats. `scripts/check-allowlist-schema.sh` enforces it in `lint` (before OSV-Scanner), in `Security (scheduled)` (before the repo-level check) and in `Inventory scan`'s own `allowlists` job, beside the scans. In `lint` an expired entry the PR does not touch only warns: the nightlies fail on it, so a lapse opens a ci-red issue instead of blocking every merge.

| Field  | `osv-scanner.toml` (npm, git)   | `.trivyignore.yaml` (all Trivy scans)                     | `.grype.yaml` (inventory scan)  |
| ------ | ------------------------------- | --------------------------------------------------------- | ------------------------------- |
| id     | `id`                            | `id`                                                      | `vulnerability`                 |
| owner  | `@<handle>:` prefix on `reason` | `owner: '@<handle>'`                                      | `owner: '@<handle>'`            |
| reason | `reason`                        | `statement`                                               | `reason`                        |
| expiry | `ignoreUntil`                   | `expired_at` (Trivy honours it)                           | `expires` (Grype ignores it)    |
| scope  | —                               | `paths` (no leading `/`) / `purls` (vulnerabilities only) | `package` (`location` absolute) |

Expiries are bare `YYYY-MM-DD` dates (a quoted string or a datetime is rejected). Scopes are literal: the scanners read `paths` and `location` as globs and Grype's `name` / `upstream-name` as a regex, so a wildcard would ignore everywhere. A name containing `+` (e.g. `libstdc++`) is a regex to Grype; scope such a package by `location`. A Grype `package` holds a `name`, `upstream-name` or `location`: type and version alone match many packages. `osv-scanner.toml` holds `[[IgnoredVulns]]` only: `[[PackageOverrides]]` (`ignore = true` per package) would suppress with no owner or expiry.

Per [CLAUDE.md "refuse to serve" principle](../../CLAUDE.md#principles), the correct response to a finding without a justified allowlist entry is to fix the underlying issue, not to write a suppression "for now." Allowlist entries are a structured exception, not a default.

```toml
# osv-scanner.toml
[[IgnoredVulns]]
id = "GHSA-67mh-4wv8-2f99"
ignoreUntil = <today+≤90d>
reason = "@vlzware: esbuild dev-server only; prod build invokes the bundler API, not the server. Tracking upstream fix at <link>."
```

```yaml
# .trivyignore.yaml — sections: vulnerabilities, misconfigurations, secrets, licenses
vulnerabilities:
  - id: CVE-2026-12345
    paths:
      - usr/local/bin/gosu
    owner: '@vlzware'
    statement: Go stdlib CVE in gosu, unreachable on its privilege-drop path
    expired_at: <today+≤90d>
```

A run of entries sharing scope, owner and reason uses a YAML anchor and merge keys (`- <<: *gosu` + `id:`); see the file.

```yaml
# .grype.yaml — `ignore:` only; the file is also Grype's config
ignore:
  - vulnerability: CVE-2026-12345
    package:
      name: libxml2
      type: apk
    owner: '@vlzware'
    reason: <why it does not apply here; link to the triage>
    expires: <today+≤90d>
```

Go's stdlib is compiled into every Go binary (gosu, Caddy), so a waiver scoped by package would hide the CVE in all of them. Grype reports it as the synthetic package `stdlib`, Trivy as `pkg:golang/stdlib@…`; scope it by the binary's path (Grype `location`, Trivy `paths`). The schema check rejects a `stdlib` scope without one.

Run `bash scripts/check-allowlist-schema.sh` locally to validate before pushing — the same script gates the CI `lint` job.

### Exception register

`exception-register.yaml` lists every exception with no expiry of its own. Allowlist entries ([§ Allowlist](#allowlist)) and `release-age-allowlist.json` carry owner, reason and expiry themselves and are not repeated there.

| `covers` key                      | Discovered from                                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `npm-override:<path>`             | each leaf of `package.json` `overrides`, nested keys joined by `>` (`@esbuild-kit/core-utils>esbuild`); `.` is the parent itself     |
| `type-shim:<module>`              | ambient `declare module '<module>'` in a declaration file with no top-level import/export                                            |
| `renovate-disabled:<pkg>`         | `.github/renovate.json` `ignoreDeps`; a `packageRules` entry with `enabled: false` (must list `matchPackageNames`)                   |
| `renovate-disabled:/<setting>`    | any other `enabled: false` (`/lockFileMaintenance`; `/` is Renovate off); `/ignorePaths/<glob>`; `/enabledManagers`, `/includePaths` |
| `renovate-allowed-versions:<pkg>` | a `packageRules` entry with `allowedVersions` (must list `matchPackageNames`)                                                        |

A row holds `covers`, `owner`, `reason`, `drop_when` (the external event that makes it removable) and `review_by` (≤ 90 days). `scripts/check-exception-register.sh` reads the sources, so an exception without a row fails, and so does a row whose exception is gone: the PR that adds or removes an exception edits its row. It runs in `lint` against the base, like the allowlist check, and in the nightly security scan, where a lapsed `review_by` turns red. To review a row: check `drop_when`, then drop the exception or renew the date. Renovate presets in `extends` (`docker:disable`) are not expanded: review those with the config.

Not registered, being policy or bounded on their own: `abandonmentThreshold` (3 years still flags real abandonment; [§ Abandonment-flag verdicts](#abandonment-flag-verdicts)); the `xcaddy --with` raises in `docker/caddy/Dockerfile` (Renovate-tracked; a Caddy needing newer fails the build); the `AWAITING_EXEMPT` schedules in `scripts/ci/renovate-health.mjs`. In-code suppressions (`eslint-disable`, `shellcheck disable`) are reviewed with the code around them.

## Repo-level advisories

`scripts/check-repo-advisories.mjs` reads each direct dep's `GET /repos/{owner}/{repo}/security-advisories` and matches published advisories against the installed versions. In `lint` it blocks the PR on a match the change introduces (`--base-lockfile`, [ADR-0027 § 2026-10-31](../adr/0027-continuous-dependency-updates-with-supply-chain-scanning.md#2026-10-31--pr-gates-judge-the-change-not-main)); nightly in `security-scheduled.yml` it fails on any match.

It exists because OSV-Scanner and `npm audit` both key on `(ecosystem, name, version)`, so an advisory with no npm-ecosystem record is invisible to both — [ADR-0027 § 2026-08-28 amendment](../adr/0027-continuous-dependency-updates-with-supply-chain-scanning.md#2026-08-28--repo-level-advisories-and-what-no-layer-covers) has the fastify worked example.

Run it locally:

```bash
GITHUB_TOKEN="$(gh auth token)" node scripts/check-repo-advisories.mjs
# As the PR gate judges it, against main:
git show origin/main:package-lock.json > /tmp/base-lock.json
GITHUB_TOKEN="$(gh auth token)" node scripts/check-repo-advisories.mjs --base-lockfile /tmp/base-lock.json
```

**Triage.** Bump past the patched version — that is nearly always the fix. Two wrinkles show up more often than with the global-DB scanners:

- **The fix may only exist on a newer major.** Publishers patch the current line and let old ones lapse; `@fastify/rate-limit`'s IPv6 bypass was fixed in 11.2.0 with no 10.x patch. Renovate never auto-merges majors, so this lands as manual work.
- **A finding on a version the global DB considers patched.** Publishers split release lines but write each range unbounded below, so a `<= 2.x` written for the newer line also matches every `1.x` under semver. The curated global record adds the missing lower bound; when there is no global record — the case this gate exists for — nothing does, and the gate reds on a patched version. The finding says `NOTE: this advisory files N ranges` when that shape is in play. Verify the line you are on is really affected, then allowlist.

Runs also print **`cleared by the global DB`** — the reverse: the publisher says vulnerable, the curated record says patched, and the curated one won. When GitHub's review of the global record is at or after the publisher's last edit, the line says `reviewed since the last repo edit` and needs nothing. When it says **`global review predates the last repo edit`**, the global DB may be lagging — the risk this layer exists for — so check the advisory page before trusting the pass. The review timestamp is the first review only, so once that line appears for an advisory, it stays.

No fix available yet? Add the GHSA id to `osv-scanner.toml` with owner + reason + `ignoreUntil` (≤90 days) per [§ Allowlist](#allowlist). Do not weaken the check.

**Read the "NOT CHECKED" lines.** Every run prints the direct deps with no GitHub repository and the repos whose advisories endpoint 404s. Those are live coverage gaps, not noise. The amendment above carries the full list of what no layer covers — transitive deps most notably.

## Release-age cooldown

A newly-published npm version is not resolvable here until it is **3 days** old. This is the malicious-publish window (`event-stream`, `ua-parser-js`, `chalk`+`debug`), not the buggy-release window — the point is to let researchers and scanners see the package before we do.

Three layers, because none covers the others' path:

| Layer                                                  | Set where                              | Covers                                                                                |
| ------------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------- |
| Renovate `minimumReleaseAge: 3 days` + `strict` filter | inherited from `config:best-practices` | Whether a **direct**-dep bump PR is raised at all. No branch until the age passes.    |
| npm `min-release-age=3`                                | `.npmrc`                               | What **npm itself resolves** — lockfile maintenance, transitives, local + CI installs |
| Release-age gate                                       | `scripts/check-release-age.mjs`, CI    | Every version in the candidate lockfile that is **not already in `main`**             |

The gate **complements** the `.npmrc` cutoff, it does not replace it. The cutoff prevents — young versions never enter the lockfile, which is what lets a daily regeneration converge. The gate reports — it names the package and can be overruled. Dropping the cutoff was measured and rejected: a cooldown-free regeneration introduces 70 new versions, 33 under 3 days, a fresh crop daily, which would leave the auto-merged branch permanently red ([ADR-0027 § 2026-09-17](../adr/0027-continuous-dependency-updates-with-supply-chain-scanning.md#2026-09-17--a-release-age-gate-on-the-lockfile-complementing-the-resolver-cutoff)).

Waive a finding by adding `{ package, version, reason, ignoreUntil }` to `release-age-allowlist.json` — same `reason`/`ignoreUntil` rules and 90-day ceiling as the [scanner allowlist](#allowlist), validated by the gate itself rather than by `check-allowlist-schema.sh`, which exists for files third-party scanners read. `security`-labelled PRs waive age findings automatically, matching Renovate's own vulnerability carve-out.

Renovate cannot enforce its half on `lockFileMaintenance` (or `pin`, `bump`, `rollback`, `lockfileUpdate`, `replacement`): those update types are [documented as unsupported](https://docs.renovatebot.com/key-concepts/minimum-release-age/) because it delegates the resolution to the package manager. `lockFileMaintenance` runs daily here and auto-merges — so it is precisely the path that needs the npm-side half.

Editing rules:

- **Never** add `minimumReleaseAge` to a `packageRules` entry matching `lockFileMaintenance` or `pin`. The preset sets it to `null` there on purpose; a local rule sorts after the preset and overrides the carve-out, and under `minimumReleaseAgeBehaviour=timestamp-required` a missing timestamp reads as not-yet-passed — the branch is never created and the daily transitive refresh stops silently.
- **Keep both values at 3.** Renovate skips its `--before` flag when it sees `min-release-age` in `.npmrc` and lets npm own the cutoff, so they should not disagree. Raising the npm value widens the ETARGET window below (`min-release-age=60` fails on `@fastify/static@^10.1.2` today).
- **Security updates bypass the Renovate half only.** npm has no exemption — `min-release-age` flattens to `before = now - 3 days` for every resolution. A fix published inside the window ETARGETs.

**The cutoff can also select a broken release.** It takes the newest version older than the cutoff, which may be one a newer patch already fixes. When a lockfile-maintenance PR goes red, check the chosen version's recency before debugging the dep itself — see [ADR-0027 § 2026-08-28 amendment](../adr/0027-continuous-dependency-updates-with-supply-chain-scanning.md#2026-08-28--release-age-cooldown-and-its-limits) for the worked case.

`npm ci` replays the lockfile and ignores the setting, so image builds and CI installs are unaffected.

### When resolution ETARGETs

```
npm error code ETARGET
npm error notarget No matching version found for <pkg>@<range> with a date before <date>.
```

A direct range's floor is newer than the cutoff. Only a **re-resolution** trips it; an install whose lockfile already satisfies the range does not:

```bash
npm install --package-lock-only               # lock already holds the version → up to date
rm package-lock.json && npm install …         # re-resolves the whole tree     → ETARGET
```

The second shape is what `lockFileMaintenance` does, so the recovery differs by which branch is broken:

| Broken branch         | Cause                                                           | Do                                                                                                                                                                                                                                                             |
| --------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vulnerability         | The PR's own range floor sits inside the window                 | **Verify the release** (below), then `npm install <pkg>@<patched> --min-release-age-exclude=<pkg>` and commit the lockfile onto the branch. `<patched>` is the advisory's version — the newest in range may be a later same-day release it does not vouch for. |
| `lockFileMaintenance` | A same-day bump landed on `main`; the rebase inherits its floor | **Wait it out.** Never `--min-release-age=0` here: this path discards the lockfile, so it would re-resolve _every_ transitive at zero cooldown — the exposure the setting exists to prevent.                                                                   |

**Before bypassing** — otherwise wait. The bypass is where a malicious "fix" would aim. `--min-release-age-exclude` exempts only the names it lists; everything else keeps the cutoff. If the ETARGET moves to a dependency of `<pkg>@<patched>` (monorepo releases: `@aws-sdk/*` needs `@smithy/*`), exclude that too and verify it like `<pkg>`. The flag repeats and takes globs. It needs the npm bundled with `.nvmrc`'s Node; older npm warns `Unknown cli config` and still ETARGETs.

1. **Only excluded names are younger than the cutoff** in `git diff package-lock.json`. `security` PRs waive the release-age gate, so this check is the one left.
2. **Each excluded tarball is upstream's build**: npm provenance naming the upstream repo at the release-tag commit, or `npm pack <name>@<version> --min-release-age-exclude=<name>` matches the tag checkout (`diff -r`, no `Only in package/`; unbuilt packages only).

The window clears 3 days after the blocking version's publish, not 3 days after the failure.

**There is no automatic recovery** either way. Renovate retries without `--before` on ETARGET, but the retry is guarded on that flag being set and Renovate deliberately leaves it empty when `.npmrc` carries `min-release-age`. `--before` is refused as mutually exclusive with `--min-release-age`.

[#514](https://github.com/Projekt-Manager-Org/Projekt-Manager/pull/514) is the worked example of the checks — no provenance, so the tag match. [#413](https://github.com/Projekt-Manager-Org/Projekt-Manager/pull/413) is the worked example of row 2 — see [ADR-0027 § 2026-08-28 amendment](../adr/0027-continuous-dependency-updates-with-supply-chain-scanning.md#2026-08-28--release-age-cooldown-and-its-limits).

**Outside npm:** Renovate also holds digest-pinned Actions, the checksum-pinned CLI binaries and Go modules for 3 days (`.github/renovate.json`). Docker images and Docker host packages have no delay: no release timestamp reaches Renovate for them — see [ADR-0027 § 2026-10-29](../adr/0027-continuous-dependency-updates-with-supply-chain-scanning.md#2026-10-29--security-releases-outside-npm).

## Abandonment-flag verdicts

Renovate's `abandonmentThreshold` heuristic uses **last-release date**, which produces false positives for libraries in stable / maintenance mode (release cadence reflects upstream maturity, not abandonment). The Renovate / Mend Dependency Dashboard's "Abandoned Dependencies" heading mixes real cases with these false positives. Every flag needs ≤5 min of upstream verification (last commit, issue triage, archive flag, recent-commit authorship); never trust the heuristic alone — and never trust "last release date" alone either, because a stream of Dependabot-only merges can mask the absence of human attention.

Each flag lands in one of three states:

- **Suppressed** — confirmed false positive; `.github/renovate.json` overrides `abandonmentThreshold` per-package to **3 years**, high enough that genuine abandonment still trips, low enough that we don't suppress the signal forever.
- **Monitoring** — borderline (bus-factor concern, or dev-tooling whose flag is recurring noise we accept). The override is intentionally NOT applied; the flag re-surfaces on every weekly scan and the row is re-evaluated quarterly.
- **Resolved** — replaced. Per [CLAUDE.md "refuse to serve" principle](../../CLAUDE.md#principles), confirmed-abandoned deps are swapped, not suppressed.

New flags are evaluated during the weekly wrangler pass; the verdict lands in the matching table below and (only for **Suppressed**) the `matchPackageNames` entry lands in the Renovate config in the same commit.

**Suppressed (last walked 2026-05-19, after first Renovate scan):**

| Package                       | Last release | Last commit | Verdict        | Rationale                                                                              |
| ----------------------------- | ------------ | ----------- | -------------- | -------------------------------------------------------------------------------------- |
| `@fastify/cookie`             | 2025-01-05   | 2026-05-12  | maintenance    | Fastify family; refactor commit one week ago; 297 stars                                |
| `@fastify/rate-limit`         | 2025-05-18   | 2026-04-29  | maintenance    | Fastify family; active commits 3 weeks ago; 593 stars                                  |
| `@testing-library/user-event` | 2025-01-21   | 2025-08-25  | mature, stable | 2.3k stars; 119 open issues actively triaged; user-event API has been stable for years |
| `client-zip`                  | 2025-03-14   | 2025-03-14  | done           | Single-purpose lib (client-side zip streaming); 7 open issues; nothing to add          |

**Monitoring (flag continues; re-evaluate quarterly):**

| Package    | Last human commit | Concern     | Why not suppress                                                                                                                                                                                                                                                                                                                                                              |
| ---------- | ----------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `husky`    | 2026-03-19        | dev-tooling | Non-strategic per § strategic-deps note (dev-convenience tooling explicitly excluded). The flag is recurring noise, acted on only if husky materially changes (archive flag, security issue) — suppressing felt like an opinion the project shouldn't pretend to have.                                                                                                        |
| `web-push` | 2024-01-16        | bus-factor  | Wraps fixed RFCs 8291/8292 so feature work is genuinely scarce — BUT every commit since the 3.6.7 release (2024-01-16) is `dependabot[bot]`. No human commit in 16 months. On the Auth-crypto strategic row; a CVE response would depend on a solo maintainer (Marco Castelluccio). The flag is retained deliberately as a quarterly re-evaluation prompt, not as live noise. |

**Resolved (kept for audit trail; remove after one quarterly cycle without regression):**

| Package                     | Verdict                           | Resolution                                         |
| --------------------------- | --------------------------------- | -------------------------------------------------- |
| `spark-md5`                 | abandoned                         | Swapped → `@noble/hashes/legacy.js` `md5`          |
| `ludeeus/action-shellcheck` | replaced — not formally abandoned | Swapped → direct `shellcheck` binary on the runner |

- `spark-md5` is the genuine first-scan case: last code commit 2021-08-25 (4.5 years), 14 unaddressed open issues, no maintainer activity.
- `ludeeus/action-shellcheck` is NOT abandoned by the project's own evidence threshold — the repo isn't archived, has 12 open PRs and 18 open issues, and the README documents real value-adds (the `version` input pins a specific Shellcheck release; `additional_files` and `ignore_paths` widen file detection; `-s ksh|dash|...` tests shell flavors). What forced the swap was Renovate's inability to determine the action's digest (last release 2023-01-29) combined with our usage exercising none of those value-adds. **Trade-off accepted:** the runner-provided shellcheck can drift between ubuntu-latest image refreshes; deterministic version-pinning is no longer enforced at this gate. Drift exposure is bounded — shellcheck rules evolve predictably between releases and a new false-positive would surface as a CI failure, not as silent miss.

## Quarterly lifecycle review

**Last performed:** _not yet_ — first review due **2026-08-17** (Monday; 2026-08-15 falls on a Saturday, aligned with the weekly wrangler cadence).

For each strategic dep below, check (≤5 min each):

- **deps.dev / Snyk Advisor** — last release date, maintainer count.
- **GitHub repo** — archived flag, issue triage, license file (BSL/SSPL/Elastic relicensings).
- **Renovate dashboard** — stuck/abandoned PRs on the dep.
- **Support window** — is the line we run, or hold in Pending Approval, still supported? ([endoflife.date](https://endoflife.date) for runtimes and images.)

After the per-dep walk, do the **allowlist sweep** — same review, distinct surface:

- Open `osv-scanner.toml`, `.trivyignore.yaml` and `.grype.yaml`. For every active entry: is the original justification still true? Has the upstream landed a fix that makes the suppression obsolete? Is the owner still the right person? Drop entries that no longer hold.
- The script's ≤90d expiry window means stale entries auto-expire and turn the nightlies red — the sweep is the in-band check that catches entries that were merely renewed without re-justification.

Then the **abandonment-verdict sweep** — same review, distinct surface:

- Walk the [§ Abandonment-flag verdicts](#abandonment-flag-verdicts) **Suppressed** table. For each entry, re-check upstream activity. If the false-positive verdict still holds, leave it. If the upstream actually did go quiet since the last walk, drop the package from `.github/renovate.json` `packageRules` so Renovate flags it again on the next scan — then decide swap-or-monitor per the same procedure that produced the original verdict.
- Walk the **Monitoring** table. Each row represents an intentional non-suppression (bus-factor or dev-tooling noise). Re-check whether the original concern still holds at the same severity; if a Monitoring entry materially worsens (archive flag, license change, security incident, maintainer-departure signal), promote it to **Resolved** by swapping the dep in the same quarterly cycle.
- For **Resolved** entries: drop the row after one quarter without regression. The audit trail lives in git history.

When something changes (archive, relicense, bus-factor drop), update the relevant ADR's lifecycle table and open an issue. Do not panic-migrate — same week is fine, same month usually is too.

**Strategic deps:**

A dep is "strategic" if it is load-bearing for security, runtime correctness, or is a major framework / language-level dep. Dev-convenience tooling (e.g., `concurrently`, `husky`) is not listed.

| Domain                   | Deps                                                                                            | Source of truth                                                                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language + frontend      | `typescript`, `react`, `react-dom`, `vite`, `zustand`, `date-fns`, `vitest`, `@playwright/test` | [ADR-0002](../adr/0002-tech-stack-typescript-react-vite-zustand.md)                                                                                                                            |
| Frontend routing         | `react-router` (v8, major churn surface)                                                        | [ARCHITECTURE.md § Design Decisions](../../ARCHITECTURE.md#design-decisions-not-adr-worthy)                                                                                                    |
| Backend                  | `fastify`, `drizzle-orm`, `pg`                                                                  | [ADR-0004](../adr/0004-backend-stack-fastify-drizzle-node-postgres.md)                                                                                                                         |
| HTTP security middleware | `@fastify/cookie`, `@fastify/cors`, `@fastify/helmet`, `@fastify/rate-limit`, `@fastify/static` | [ADR-0004](../adr/0004-backend-stack-fastify-drizzle-node-postgres.md), [ADR-0005](../adr/0005-session-management-httponly-cookies.md) — perimeter; CVEs here are session / CSRF / DoS classes |
| Schema validation        | `zod`                                                                                           | Input-validation default per [CLAUDE.md Principles](../../CLAUDE.md#principles); on the security perimeter for every mutating endpoint                                                         |
| Auth crypto              | `bcryptjs`, `web-push`                                                                          | [ADR-0006](../adr/0006-password-policy-nist-blocklist.md) for password hashing; `web-push` ships the VAPID + AES-GCM stack for push notifications                                              |
| Container stack          | Docker Engine, containerd, BuildKit, Compose plugin                                             | [ADR-0009](../adr/0009-pin-docker-versions-across-environments.md)                                                                                                                             |
| Base images              | `node:*-alpine`, `postgres:17-alpine`, `caddy:*`                                                | `Dockerfile*`, `docker-compose*.yml`                                                                                                                                                           |
| Caddy + plugin           | `caddy`, `caddy-dns/cloudflare`                                                                 | [ADR-0003](../adr/0003-deployment-infrastructure-vps-docker-compose-github-actions.md)                                                                                                         |
| CI/CD platform           | GitHub Actions, GHCR                                                                            | [ADR-0011](../adr/0011-build-images-in-ci-distribute-via-ghcr.md)                                                                                                                              |
| Storage SaaS             | Backblaze B2, Cloudflare R2                                                                     | [ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md), [ADR-0020](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md)                                       |
| Dev/CI storage mirror    | MinIO `minio`, `mc` (frozen, archived upstream, self-hosted on GHCR)                            | [ADR-0003](../adr/0003-deployment-infrastructure-vps-docker-compose-github-actions.md) § Dep lifecycle health — accepted risk, no scanner gate behind it                                       |
| Crypto tooling           | `age`                                                                                           | [ADR-0012](../adr/0012-manual-pull-based-deploy-over-wireguard.md)                                                                                                                             |
| LLM gateway              | OpenRouter + pinned model                                                                       | [ADR-0016](../adr/0016-llm-email-extraction-via-server-proxied-openrouter.md)                                                                                                                  |
| Invoice pipeline         | `@cantoo/pdf-lib`, `xmllint-wasm`, `archiver`, big.js                                           | [ADR-0026](../adr/0026-invoices-immutability-and-zugferd.md#dep-lifecycle-health-as-of-2026-05-15)                                                                                             |
| Native image processing  | `sharp`                                                                                         | Native libvips bindings; recurring CVE surface (image bombs, integer overflow); regenerates takeout-import thumbnails; server decodes JPEG/PNG/WebP only (#460)                                |
| PDF parsing              | `unpdf`                                                                                         | Replacement for the abandoned `pdf-parse`; on the email/invoice ingestion path                                                                                                                 |
| Build / dev runtime      | `esbuild` (server bundle in `build:server`), `tsx` (dev / e2e server entry)                     | `package.json` scripts; `esbuild` ships the production server artifact, `tsx` is the dev-time TS loader                                                                                        |
| VPN                      | WireGuard kernel + clients                                                                      | [ADR-0008](../adr/0008-vpn-first-network-access.md)                                                                                                                                            |
| Storage SDK              | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`                                           | [ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md)                                                                                                                            |

**OS packages installed in our Dockerfiles** (added per [#199](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/199), which surfaced that the apk-package layer was not covered by either Renovate or this review):

Renovate's `dockerfile` manager tracks base-image tags, not the individual packages added via `apk add` on top. OSV-Scanner and Trivy catch published CVEs in OS packages, but stagnant-but-not-yet-vulnerable (the dcron case: no CVE filed, no maintainer to file one) is invisible to both gates. Treat every explicit `apk add` line as a strategic-dep adoption and walk it during this review.

| Dockerfile                | Explicit `apk add` packages                                                             | Upstream notes                                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile`              | `age`, `findmnt`, `bash`                                                                | `age` = FiloSottile/age (active); `findmnt` from util-linux (kernel.org, very active); `bash` from GNU (very active).                                |
| `Dockerfile.backup`       | `postgresql17`, `postgresql17-client`, `postgresql17-contrib`, `age`, `bash`, `findmnt` | `postgresql17*` from postgres.org (active). Scheduler moved in-process to `croner` in #199; `dcron`, `tzdata`, `su-exec`, `jq`, `coreutils` dropped. |
| `docker/caddy/Dockerfile` | _(none — `scratch` runtime: static binary + CA bundle)_                                 | n/a                                                                                                                                                  |

Per package, the same ≤5-min check as npm strategic deps: archived flag, last release date, CVE filing cadence (for niche projects, "no CVEs ever" can mean "no one filing them" more than "no vulnerabilities"). When introducing a new `apk add` line, add the package here in the same PR — same discipline as the per-ADR lifecycle-health entry.

After the review, update the "Last performed" date above.

## Adopting a new dep

Any ADR that commits to a specific named external dep must include a `## Dep lifecycle health (as of YYYY-MM-DD)` section ([ADR-0027 §Decision.3](../adr/0027-continuous-dependency-updates-with-supply-chain-scanning.md#3-lifecycle-health-entry-on-dep-introducing-adrs--quarterly-review)). For non-ADR-worthy picks (small libs at implementation time), the same check applies — the record goes in `ARCHITECTURE.md` or the relevant design doc.

Minimum at adoption time: last release date, license, maintainer count or archived flag, deps.dev link.

## First-run setup

Renovate is a GitHub App. Until installed and onboarded, the `.github/renovate.json` in the repo does nothing.

**Validation and dry-run.** `lint` runs the validator on every PR. Locally, use the image `ci.yml`'s _Validate Renovate config_ step pins:

```bash
IMG=$(grep -oP 'docker://\K\S+' .github/workflows/ci.yml)

# Schema and cross-references; the same check as in `lint`.
docker run --rm -v "$PWD:/w:ro" -w /w --entrypoint renovate-config-validator "$IMG" \
  --strict --no-global .github/renovate.json

# Dry-run against the local checkout: what Renovate extracts and which
# updates it finds. The token resolves github-hosted datasources;
# LOG_LEVEL=debug shows per-dependency lookups.
docker run --rm -v "$PWD:/usr/src/app:ro" -e GITHUB_COM_TOKEN="$(gh auth token)" \
  -e LOG_LEVEL=info -e RENOVATE_PLATFORM=local -e RENOVATE_DRY_RUN=lookup "$IMG"
```

The dry-run is most useful after editing `customManagers` regex patterns — Renovate logs which files matched, which deps it would have proposed, and which regexes returned zero matches (a silent regex typo otherwise lands invisibly). The local platform stops after lookup: schedule, approval and release-age decisions show only on the Dependency Dashboard after Mend's next run. Images with over 1,000 Docker Hub tags (`node`, `postgres`) get no release timestamp: anonymous paging stops there.

1. **Install via Mend.** Renovate is operated by Mend; the GitHub App install funnels through Mend's onboarding.
   1. From [github.com/apps/renovate](https://github.com/apps/renovate) → **Install** → **Only select repositories** → pick `Projekt-Manager-Org/Projekt-Manager` only. GitHub redirects to [developer.mend.io/install](https://developer.mend.io/install).
   2. Sign up to Mend (one-time; org pre-fills from the GitHub handle).
   3. Mend asks two questions:
      - **Product:** **Renovate only**. The bundled SAST/SCA options are Mend's paid tier and not used — OSV-Scanner and the Trivy + Grype inventory scan cover the SCA surface per [§ Coverage matrix](#coverage-matrix).
      - **Mode:** **Scan and Alert**, NOT "Scan Only". "Scan Only" runs Renovate in silent mode (no PRs/issues/checks; telemetry-only) and would defeat the whole point. The Mend dashboard later labels "Scan and Alert" as **"Interactive"** under _Default Engine Settings → Dependency Updates_. The repo also pins `"mode": "full"` in `.github/renovate.json` so Interactive is enforced from the config, independent of the Mend UI: an org-level "All repositories" install (and org transfers that re-onboard under it) defaults repos to **Silent**, which suppresses all PRs. The in-repo pin survives that. If the Mend dashboard still shows Silent after the config lands, flip the repo to Interactive in the UI and trigger one manual run — a UI-level Silent setting can override repo config.
   4. Mend drops you on the org dashboard. Confirm the repo shows **Renovate: Enabled** and **Renovate Status: onboarded** within a few minutes (first scan). The Mend dashboard is informational — the actual control surface is the repo (config + PRs + Dependency Dashboard issue); we do not operate from the Mend UI.

   The free **Community** plan is sufficient; paid tiers gate SAST/SCA/concurrent-jobs that we don't use.

2. **No onboarding PR is expected.** Per the [Renovate docs](https://docs.renovatebot.com/getting-started/installing-onboarding/), when `.github/renovate.json` is already committed at the default branch, Renovate skips the "Configure Renovate" onboarding PR and goes straight to opening dep PRs (or queuing them in the Dependency Dashboard if a `schedule` window applies). If an onboarding PR DOES appear, it means the config wasn't detected — investigate before merging.
3. **Enable auto-merge at the repo level.** Repo Settings → General → "Allow auto-merge" must be checked, otherwise `automerge: true` in the config silently no-ops.
4. **Create the labels the config references, with colors.** `.github/renovate.json` applies `dependencies` (`labels`) and `security` (`vulnerabilityAlerts.labels`). GitHub's add-labels endpoint **auto-creates** an unknown label as grey `#ededed` with no description, so a missing one is cosmetic, not a failure — Renovate PRs still land. Creating them up front just gives them a real color and description:

   ```bash
   gh label create security --color D93F0B --description "Vulnerability fix — out-of-band"
   ```

   `security` is what makes out-of-band vuln PRs filterable apart from routine updates. Note the `gh` CLI is stricter than the API: `gh pr create --label <unknown>` aborts without creating the PR.

5. **Configure branch protection on `main` via a Ruleset.** Classic branch protection is on GitHub's deprecation path — the banner at the top of Settings → Branches points at the replacement. Rulesets are now the single source of truth: Settings → **Rules → Rulesets → New branch ruleset**.
   - **Name:** `main protection`. **Enforcement:** Active. **Bypass list:** empty (admins included). **Target:** `Default branch`.
   - **Rules to enable:**
     - **Restrict deletions** + **Block force pushes** — prevent `main` loss / history rewrite.
     - **Require linear history** — repo policy is squash-merge only.
     - **Require a pull request before merging** — required approvals: 0 (solo dev; raise when a second human joins).
     - **Require merge queue** — settings in step 6.
     - **Require status checks to pass:** add `lint`, `check`, `docker`, `publish` and `Spec-change declaration` (job names — Rulesets match job-level checks, same as classic).
       - **`Spec-change declaration`** (`spec-change.yml`): a PR touching `docs/spec/**` declares why in its body ([CONTRIBUTING.md § Workflow](../../CONTRIBUTING.md#workflow) step 1).
       - **`lint`** is the static-analysis pillar: Renovate config validation, allowlist schema, OSV-Scanner (lockfile vulns), Trivy filesystem-secret + IaC scans, compose-reference validation, lint, shellcheck, format, theme-token hygiene, type-check, env-drift, audit-write-path check, build. No DB, no MinIO — runs in parallel with the test pillar.
       - **`check`** is a 5-line aggregator that gates on the sharded `check-shard` matrix (`needs: check-shard`, fails if any shard failed). Stable required-check name across shard-count changes — only the matrix array in `ci.yml` moves when shards are added/removed; the Ruleset never has to be re-edited. The actual tests live in `check-shard` (postgres service + MinIO + integration tests, partitioned by `--shard=N/M`).
       - **`docker`** is the image gate: both images built and scanned for secrets (a finding blocks merge; vulnerabilities are the push run's), the runtime smoke, and the Tier 1 backup round-trip. It runs on **every** PR and publishes nothing. It used to be path-filtered, which made it report **skipped** on non-image PRs — and a skipped job [counts as a successful required check](https://docs.github.com/en/actions/using-jobs/using-conditions-to-control-job-execution), so requiring it gated nothing for the majority of PRs (#355).
       - Do **NOT** add `check-shard`: matrix jobs surface as `check-shard (1)` / `check-shard (2)`, names that change when shard count changes — the aggregator `check` exists precisely so the Ruleset isn't entangled with the matrix shape.
       - **`publish`** orders the land after the image is named; it is not an image gate (`docker` is). Rationale: [ADR-0011 § Decision](../adr/0011-build-images-in-ci-distribute-via-ghcr.md#decision) and [#683](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/683).

         This reverses the earlier "do NOT add `publish`" note, whose reasoning ("a required check that is legitimately skipped for a whole class of PRs cannot gate anything") contradicted the load-bearing fact one bullet up: [a skipped job reports success](https://docs.github.com/en/actions/using-jobs/using-conditions-to-control-job-execution) and satisfies a required check. Requiring `publish` therefore gates non-fork PRs — the only population with images to name — and is a no-op for forks, where its `if:` skips it. The real cost is coupling merge to GHCR availability, which is the honest behaviour: if GHCR is down, `promote` cannot publish either.

       - **Leave "Require branches to be up to date before merging" unticked** (`strict_required_status_checks_policy: false`). The merge queue (step 6) is the safety net against semantic merge conflicts, e.g. a `package-lock.json` collision between two PRs that each pass their own CI: it tests every PR against `main`'s head. Strict on top only adds a rebase per merge.
       - **`renovate.json` sets `rebaseWhen: "conflicted"` _explicitly_.** A PR that is only behind needs no rebase; the queue tests it against `main`'s head. Renovate's `auto` [resolves to the same](https://docs.renovatebot.com/configuration-options/#rebasewhen) under a merge queue; explicit, so it does not depend on Renovate detecting the queue at runtime. Never click "Update branch" on a Renovate PR: it stamps a non-`renovate[bot]` author and trips Renovate's edited-PR guard ("does not recognize the last commit author"), which stops Renovate managing that PR. To refresh one, tick the rebase box in its body.

   Without `lint`, `check`, `docker` and `publish` all as required contexts, Renovate's auto-merge bypasses the safety net this ADR adds. `docker` runs on every PR and publishes nothing, so it is a real gate rather than an advisory scan — that was not true while it was path-filtered (#355). `publish` is the ordering constraint, not a gate: it is what stops the merge landing before the artifact `promote` will look for exists. The full gating rationale is in [ADR-0027 §Operational](../adr/0027-continuous-dependency-updates-with-supply-chain-scanning.md#operational).

   **After saving the Ruleset**, delete the classic branch protection rule for `main` (Settings → Branches → ⋯ → Delete on the classic rule). Two protection layers are avoidable maintenance burden; the Ruleset is the supported path forward.

6. **Merge queue: on** (since 2026-10-31, [#668](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/668)). A `merge_queue` rule on `main protection`; strict off (step 5).

   Why, and the cost accepted: [ADR-0027 § 2026-10-31](../adr/0027-continuous-dependency-updates-with-supply-chain-scanning.md#2026-10-31--merge-queue-replaces-strict-up-to-date).

   ```
   PR green ─▶ queue: CI on main + group (merge_group event) ─▶ green: main fast-forwards to that commit
                                                             └▶ red:   PR leaves the queue
   ```

   **Settings:**
   - `merge_method: SQUASH`. The default `MERGE` conflicts with `required_linear_history`: PRs sit `CLEAN` forever and no `merge_group` runs appear.
   - `grouping_strategy: ALLGREEN` ("only merge non-failing pull requests"): every entry needs its own green required checks, which step 5's `publish` ordering depends on. `min_entries_to_merge: 1`, `max_entries_to_merge: 5`, `max_entries_to_build: 5`, `min_entries_to_merge_wait_minutes: 5`, `check_response_timeout_minutes: 60`.

   Verify:

   ```bash
   gh api repos/{owner}/{repo}/rulesets/{id} --jq '.rules[] | select(.type=="merge_queue" or .type=="required_status_checks") | {type, merge_method: .parameters.merge_method, grouping: .parameters.grouping_strategy, strict: .parameters.strict_required_status_checks_policy}'
   ```

   **Workflows:** every required check's workflow listens on `merge_group` (`ci.yml`, `spec-change.yml`). Without the trigger the check never reports and the queue times out. A job skipped by its `if:` reports success, in the queue as in the merge box: #666 merged on 2026-10-31 with `Spec-change declaration` skipped (#214 had reported the opposite).

   **Operating it:** "Merge when ready" or `gh pr merge` queues a PR; Renovate's auto-merge requests enter on their own. An admin puts a PR first with the GraphQL `enqueuePullRequest` mutation (`jump: true`), after `dequeuePullRequest` if it is already queued.

7. **Pin the Dependency Dashboard issue.** Renovate auto-creates an issue titled "Dependency Dashboard" listing queue state; pin it so the weekly wrangler can find it without searching.

8. **Enable the GitHub security surface — all three switches.** Settings → Advanced Security. Alerts alone only notify; the third switch is what opens PRs, and it is the only automated path for transitive npm advisories (see [§ Coverage matrix](#coverage-matrix)).

   | Switch                          | Why                                                                                                                       |
   | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
   | Dependency graph                | Prerequisite for the other two, and for Renovate reading GitHub alerts                                                    |
   | Dependabot alerts               | CVE notification surface; also the input Renovate's `vulnerabilityAlerts` reads (needs the app's `read` permission on it) |
   | **Dependabot security updates** | Raises the fix PR. For npm it bumps a lockfile-only dep, updating the parent if that is the only route                    |

   Verify (both must report enabled — the second returned `{"enabled":false}` from install until 2026-08-06, which is why three transitive advisories were cleared by hand):

   ```bash
   gh api repos/{owner}/{repo}/vulnerability-alerts --silent && echo "alerts: enabled"
   gh api repos/{owner}/{repo}/automated-security-fixes
   ```
