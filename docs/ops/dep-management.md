# Dependency management

How the project tracks, updates, and audits external deps. Rationale: [ADR-0027](../adr/0027-continuous-dependency-updates-with-supply-chain-scanning.md).

## First-run setup

Renovate is a GitHub App. Until installed and onboarded, the `.github/renovate.json` in the repo does nothing.

**Optional pre-install validation:** to dry-run the config against the current repo state without going live, use Renovate's local platform:

```bash
# Verifies JSON syntax + cross-references against the schema.
npx --yes -p renovate renovate-config-validator --strict --no-global .github/renovate.json

# Optional fuller dry-run: lists what Renovate WOULD do if installed.
# Requires a GitHub token with read access to the repo; LOG_LEVEL=info
# keeps the output manageable.
LOG_LEVEL=info npx --yes -p renovate renovate \
  --platform=local --dry-run \
  Projekt-Manager-Org/Projekt-Manager
```

The dry-run is most useful after editing `customManagers` regex patterns — Renovate logs which files matched, which deps it would have proposed, and which regexes returned zero matches (a silent regex typo otherwise lands invisibly).

1. **Install via Mend.** Renovate is operated by Mend; the GitHub App install funnels through Mend's onboarding.
   1. From [github.com/apps/renovate](https://github.com/apps/renovate) → **Install** → **Only select repositories** → pick `Projekt-Manager-Org/Projekt-Manager` only. GitHub redirects to [developer.mend.io/install](https://developer.mend.io/install).
   2. Sign up to Mend (one-time; org pre-fills from the GitHub handle).
   3. Mend asks two questions:
      - **Product:** **Renovate only**. The bundled SAST/SCA options are Mend's paid tier and not used — OSV-Scanner + Trivy in CI cover the SCA surface per ADR-0027.
      - **Mode:** **Scan and Alert**, NOT "Scan Only". "Scan Only" runs Renovate in silent mode (no PRs/issues/checks; telemetry-only) and would defeat the whole point. The Mend dashboard later labels "Scan and Alert" as **"Interactive"** under _Default Engine Settings → Dependency Updates_.
   4. Mend drops you on the org dashboard. Confirm the repo shows **Renovate: Enabled** and **Renovate Status: onboarded** within a few minutes (first scan). The Mend dashboard is informational — the actual control surface is the repo (config + PRs + Dependency Dashboard issue); we do not operate from the Mend UI.

   The free **Community** plan is sufficient; paid tiers gate SAST/SCA/concurrent-jobs that we don't use.

2. **No onboarding PR is expected.** Per the [Renovate docs](https://docs.renovatebot.com/getting-started/installing-onboarding/), when `.github/renovate.json` is already committed at the default branch, Renovate skips the "Configure Renovate" onboarding PR and goes straight to opening dep PRs (or queuing them in the Dependency Dashboard if a `schedule` window applies). If an onboarding PR DOES appear, it means the config wasn't detected — investigate before merging.
3. **Enable auto-merge at the repo level.** Repo Settings → General → "Allow auto-merge" must be checked, otherwise `automerge: true` in the config silently no-ops.
4. **Configure branch protection on `main` via a Ruleset.** Classic branch protection is on GitHub's deprecation path — the banner at the top of Settings → Branches points at the replacement. Rulesets are now the single source of truth: Settings → **Rules → Rulesets → New branch ruleset**.
   - **Name:** `main protection`. **Enforcement:** Active. **Bypass list:** empty (admins included). **Target:** `Default branch`.
   - **Rules to enable:**
     - **Restrict deletions** + **Block force pushes** — prevent `main` loss / history rewrite.
     - **Require linear history** — repo policy is squash-merge only.
     - **Require a pull request before merging** — required approvals: 0 (solo dev; raise when a second human joins).
     - **Require status checks to pass:** add `lint`, `check`, and `docker` (job names — Rulesets match job-level checks, same as classic).
       - **`lint`** is the static-analysis pillar: lockfile-pin drift, allowlist schema, OSV-Scanner (lockfile vulns), Trivy filesystem-secret + IaC scans, lint, shellcheck, format, theme-token hygiene, type-check, env-drift, audit-write-path check, build. No DB, no MinIO — runs in parallel with the test pillar.
       - **`check`** is a 5-line aggregator that gates on the sharded `check-shard` matrix (`needs: check-shard`, fails if any shard failed). Stable required-check name across shard-count changes — only the matrix array in `ci.yml` moves when shards are added/removed; the Ruleset never has to be re-edited. The actual tests live in `check-shard` (postgres service + MinIO + integration tests, partitioned by `--shard=N/M`).
       - **`docker`** is path-filtered (Dockerfile / docker-compose / package-lock / patches / tsconfig / workflow changes) and pull-request-only. On non-image PRs the `if:` evaluates false → GitHub reports the job as **skipped**, which [counts as a successful required check](https://docs.github.com/en/actions/using-jobs/using-conditions-to-control-job-execution) — adding `docker` as required does NOT block non-image PRs. On image-affecting PRs, `docker` runs and the image-vuln scan blocks merge on HIGH/CRITICAL findings.
       - Do **NOT** add `check-shard`: matrix jobs surface as `check-shard (1)` / `check-shard (2)`, names that change when shard count changes — the aggregator `check` exists precisely so the Ruleset isn't entangled with the matrix shape.
       - Do **NOT** add `build-and-push`: it only fires on `push` / `workflow_dispatch` events; its post-merge image-scan-then-push step is the deploy-time safety net, not a PR gate.
       - Do **NOT** tick the sub-option "Require branches to be up to date before merging" — the merge queue (step 5) replaces it. Ticking both reintroduces the rebase cycle the queue is designed to eliminate.

   Without `lint`, `check`, and `docker` all as required contexts, Renovate's auto-merge bypasses the safety net this ADR adds; without `docker`, image-vuln gating becomes informational-only on PRs (the post-merge `build-and-push` scan is still the backstop). The full gating rationale is in [ADR-0027 §Operational](../adr/0027-continuous-dependency-updates-with-supply-chain-scanning.md#operational).

   **After saving the Ruleset**, delete the classic branch protection rule for `main` (Settings → Branches → ⋯ → Delete on the classic rule). Two protection layers are avoidable maintenance burden; the Ruleset is the supported path forward.

5. **Enable the merge queue rule on the same Ruleset.** Edit the `main protection` Ruleset → tick **Require merge queue**.
   - **Merge method:** Change from the default **Merge** to **Squash and merge**. Mandatory — the default `Merge` creates merge commits and conflicts with the `Require linear history` rule from step 4; the queue silently refuses to start a merge group in that state (PRs sit `CLEAN` forever, no `merge_group` workflow runs appear). Verify with `gh api repos/{owner}/{repo}/rulesets/{id} --jq '.rules[] | select(.type=="merge_queue") | .parameters.merge_method'` returning `"SQUASH"`.
   - **Merge limits:** min group 1, max group 5, build concurrency 5, max wait 5 min — defaults suit this repo's volume.
   - **Required status checks for the merge queue:** `lint`, `check`, `docker` (same as the PR-level gate; the queue re-runs them against the synthetic merge state).
   - **Workflow prerequisite (`.github/workflows/ci.yml`):** `on:` must include `merge_group:`. The queue fires `merge_group` events on a synthetic train branch (`refs/heads/gh-readonly-queue/main/pr-N-sha`); without this listener no required check fires on those events, and PRs sit `CLEAN` until `check_response_timeout_minutes` (60) then get rejected with no actionable signal. Verify with `grep -A1 '^on:' .github/workflows/ci.yml`.
   - **`docker` job's `if:` must include `merge_group`.** Branch protection treats a skipped required check as success — the merge queue does NOT. If the `docker` job stays `pull_request`-only it gets skipped on `merge_group`, the queue waits the full `check_response_timeout_minutes`, then rejects the PR. The fix is `if: (needs.changes.outputs.docker == 'true' && github.event_name == 'pull_request') || github.event_name == 'merge_group'` — path-filtered at PR time (skipped on docs-only PRs), runs unconditionally on `merge_group` so the required context reports SUCCESS. Cost: ~3 min per queue cycle on PRs that don't touch container-relevant files; acceptable trade for a working queue.

   Why: without a queue, "Require branches to be up to date" (the `strict` flag) serialises merges — every merge knocks all other open PRs BEHIND `main`, costing a manual rebase + full re-CI cycle. Renovate also refuses auto-rebase once a PR's last commit is human-authored ("Edited/Blocked" warning), so every wrangler-rebase poisons further auto-rebase on that PR. With ≥3 routine PRs in flight (a normal Monday after the Renovate window) the wrangler loses an hour to rebase clicks.

   The queue replaces that cycle: GitHub batches green PRs into a synthetic merge train, runs `lint` + `check` + `docker` against the would-be-merged state, squash-merges in order. The strict-equivalent safety guarantee (merged code was tested against the post-merge tip) is preserved without per-merge rebase tax.
   - **Daily use.** The PR merge button changes from "Squash and merge" to **"Merge when ready"**. Click it on a green PR; the PR joins the queue and merges itself once the queue-CI is green. Renovate's `platformAutomerge: true` queues auto-merge-flagged PRs automatically — no config change needed.
   - **Observability.** Repo → **Pull requests** → **Merge queue** tab shows the current train, positions, and per-PR queue-build status.
   - **Failure recovery.** A queued PR that fails the merge-state build returns to the operator with a failed `merge-queue` status check. Fix the branch and re-add via "Merge when ready"; the rest of the queue keeps moving.

6. **Pin the Dependency Dashboard issue.** Renovate auto-creates an issue titled "Dependency Dashboard" listing queue state; pin it so the weekly wrangler can find it without searching.

## Cadence

| Trigger                                         | Result                               | Latency                |
| ----------------------------------------------- | ------------------------------------ | ---------------------- |
| Renovate weekly window (Mon 09:00 Europe/Sofia) | Routine bumps as individual PRs      | ~30 min/week wrangler  |
| Dependabot Alert                                | Renovate opens a vuln PR out-of-band | Hours from publication |
| OSV-Scanner / Trivy CI fail                     | PR merge blocked                     | Per-PR                 |
| Quarterly review                                | Walk strategic-dep list (below)      | ~1 hour, 4×/year       |

## Weekly wrangler

1. Open the Renovate dashboard issue — queue state at a glance.
2. **Abandonment flags**: scan the dashboard's "Abandoned Dependencies" list for new entries. Verify each per [§ Abandonment-flag verdicts](#abandonment-flag-verdicts); record a verdict + (for false positives) add the package to `.github/renovate.json` `packageRules` in the same commit.
3. **Auto-merged PRs** (patch/minor + green CI) need no action; spot-check for surprises.
4. **Grouped PRs** (AWS SDK / ESLint cluster / Vitest pair / React pair / Fastify family / Drizzle pair): read combined changelog, merge.
5. **Major PRs**: read upstream migration guide, run `npm test` + `npm run test:e2e` locally on the bump branch, merge.
6. **Lockfile maintenance** PR: merge if green.
7. Red CI: triage the failure, patch or revert.

## CVE handling

- **High/Critical** — bypass schedule; merge on green CI even off-hours.
- **Medium/Low** — roll into the weekly batch.
- **False-positive on dead code** (cf. the original [ADR-0007](../adr/0007-suppress-esbuild-dev-server-advisory.md) case): add the advisory to the OSV-Scanner allowlist with a documented review trigger. Never `--omit=dev` blanket-suppress.
- **No-fix-yet OS-package CVE in a base image** (Alpine `node:22-alpine`, `postgresql17-alpine`, etc., where the upstream distro hasn't shipped a patched build yet): Trivy blocks the `docker` and `build-and-push` image scans on every run because `ignore-unfixed: true` is deliberately not set (per [ADR-0027 §Operational](../adr/0027-continuous-dependency-updates-with-supply-chain-scanning.md#operational); see also [§Allowlist](#allowlist-osv-scanner--trivy) for the schema). The deploy pipeline halts until either Alpine ships the fix or an operator writes a deliberate, time-bounded allowlist entry:

  ```text
  # owner: @<handle>
  # reason: <CVE-ID> — no upstream Alpine fix yet; exposure analysis at <link to triage>
  <CVE-ID> exp:<today+90d>
  ```

  90 days is the maximum permitted window; pick a shorter date if upstream has a target ship-date. The expiry forces a re-review and the entry stops suppressing automatically — there is no silent-forever suppression path. Track the upstream CVE in the Renovate dashboard so the entry gets removed (not renewed) when the fix lands.

### Allowlist (OSV-Scanner + Trivy)

Allowlist files: `osv-scanner.toml` (npm + git deps) and `.trivyignore` (container image scan), both at the repo root.

Per [ADR-0027 §Negative](../adr/0027-continuous-dependency-updates-with-supply-chain-scanning.md#negative), every entry MUST carry **id + owner (GitHub handle) + reason + expiry**, expressed in the format each scanner accepts. Both files are gated in CI by `scripts/check-allowlist-schema.sh` — entries that miss a field, encode an invalid handle, drift past 90 days, or use the wrong shape are rejected before the scanner step runs.

Per [CLAUDE.md "refuse to serve" principle](../../CLAUDE.md#principles), the correct response to a finding without a justified allowlist entry is to fix the underlying issue, not to write a suppression "for now." Allowlist entries are a structured exception, not a default.

**`osv-scanner.toml` example entry:**

OSV-Scanner has no dedicated `owner` field, so the handle is encoded as a `@<handle>:` prefix on `reason`. `ignoreUntil` MUST be a bare TOML date literal — a quoted `"YYYY-MM-DD"` parses as a string and is rejected, as is an offset datetime (`YYYY-MM-DDTHH:MM:SSZ`).

```toml
[[IgnoredVulns]]
id = "GHSA-67mh-4wv8-2f99"
ignoreUntil = 2026-08-16  # <= 90 days from add date 2026-05-18
reason = "@vlzware: esbuild dev-server only; prod build invokes the bundler API, not the server. Tracking upstream fix at <link>."
```

**`.trivyignore` example entry:**

`.trivyignore` has no `reason` field. Both fields go in the contiguous comment block immediately preceding the entry; the expiry goes as `exp:YYYY-MM-DD` SUFFIX on the entry line itself (not in the block).

```text
# owner: @vlzware
# reason: CVE on libfoo (image base layer) — exploit requires inbound TCP on 9000; our image binds only 8080.
CVE-2026-12345 exp:2026-08-16
```

Run `bash scripts/check-allowlist-schema.sh` locally to validate before pushing — the same script gates the CI `lint` job.

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

After the per-dep walk, do the **allowlist sweep** — same review, distinct surface:

- Open `osv-scanner.toml` and `.trivyignore`. For every active entry: is the original justification still true? Has the upstream landed a fix that makes the suppression obsolete? Is the owner still the right person? Drop entries that no longer hold.
- The script's `ignoreUntil` ≤90d window means stale entries auto-expire and fail CI — the sweep is the in-band check that catches entries that were merely renewed without re-justification.

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
| Frontend routing         | `react-router-dom` (v7, major churn surface)                                                    | [ADR-0002](../adr/0002-tech-stack-typescript-react-vite-zustand.md) — referenced in ARCHITECTURE.md routing section                                                                            |
| Backend                  | `fastify`, `drizzle-orm`, `pg`                                                                  | [ADR-0004](../adr/0004-backend-stack-fastify-drizzle-node-postgres.md)                                                                                                                         |
| HTTP security middleware | `@fastify/cookie`, `@fastify/cors`, `@fastify/helmet`, `@fastify/rate-limit`, `@fastify/static` | [ADR-0004](../adr/0004-backend-stack-fastify-drizzle-node-postgres.md), [ADR-0005](../adr/0005-session-management-httponly-cookies.md) — perimeter; CVEs here are session / CSRF / DoS classes |
| Schema validation        | `zod`                                                                                           | Input-validation default per [CLAUDE.md Principles](../../CLAUDE.md#principles); on the security perimeter for every mutating endpoint                                                         |
| Auth crypto              | `bcryptjs`, `web-push`                                                                          | [ADR-0006](../adr/0006-password-policy-nist-blocklist.md) for password hashing; `web-push` ships the VAPID + AES-GCM stack for push notifications                                              |
| Container stack          | Docker Engine, containerd, BuildKit, Compose plugin                                             | [ADR-0009](../adr/0009-pin-docker-versions-across-environments.md)                                                                                                                             |
| Base images              | `node:*-alpine`, `postgres:17-alpine`, `caddy:*`                                                | `Dockerfile*`, `docker-compose*.yml`                                                                                                                                                           |
| Caddy + plugin           | `caddy`, `caddy-dns/cloudflare`                                                                 | [ADR-0003](../adr/0003-deployment-infrastructure-vps-docker-compose-github-actions.md)                                                                                                         |
| CI/CD platform           | GitHub Actions, GHCR                                                                            | [ADR-0011](../adr/0011-build-images-in-ci-distribute-via-ghcr.md)                                                                                                                              |
| Storage SaaS             | Backblaze B2, Cloudflare R2                                                                     | [ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md), [ADR-0020](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md)                                       |
| Crypto tooling           | `age`                                                                                           | [ADR-0012](../adr/0012-manual-pull-based-deploy-over-wireguard.md)                                                                                                                             |
| LLM gateway              | OpenRouter + pinned model                                                                       | [ADR-0016](../adr/0016-llm-email-extraction-via-server-proxied-openrouter.md)                                                                                                                  |
| Invoice pipeline         | `@cantoo/pdf-lib`, `xmllint-wasm`, `fast-xml-parser`, `archiver`                                | [ARCHITECTURE.md § Invoices Module](../../ARCHITECTURE.md#dep-lifecycle-health-as-of-2026-05-15)                                                                                               |
| Native image processing  | `sharp`                                                                                         | Native libvips bindings; recurring CVE surface (image bombs, integer overflow); used in attachment pipeline                                                                                    |
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
| `docker/caddy/Dockerfile` | _(none — uses upstream `caddy:*-alpine` as-is)_                                         | n/a                                                                                                                                                  |

Per package, the same ≤5-min check as npm strategic deps: archived flag, last release date, CVE filing cadence (for niche projects, "no CVEs ever" can mean "no one filing them" more than "no vulnerabilities"). When introducing a new `apk add` line, add the package here in the same PR — same discipline as the per-ADR lifecycle-health entry.

After the review, update the "Last performed" date above.

## Adopting a new dep

Any ADR that commits to a specific named external dep must include a `## Dep lifecycle health (as of YYYY-MM-DD)` section ([ADR-0027 §Decision.3](../adr/0027-continuous-dependency-updates-with-supply-chain-scanning.md#3-lifecycle-health-entry-on-dep-introducing-adrs--quarterly-review)). For non-ADR-worthy picks (small libs at implementation time), the same check applies — the record goes in `ARCHITECTURE.md` or the relevant design doc.

Minimum at adoption time: last release date, license, maintainer count or archived flag, deps.dev link.

## Files

- `.github/renovate.json` — Renovate config: schedule (`before 9am on monday` Europe/Sofia), grouping clusters, auto-merge rules, manager set (`npm` + `dockerfile` + `docker-compose` + `github-actions` + `regex`).
- `.github/workflows/ci.yml` — adds OSV-Scanner step (every PR; blocks on any vuln, no severity flag in CLI v2.3.8) and Trivy steps (image vuln + filesystem secret + IaC misconfig on PRs touching image-affecting paths; blocks on HIGH/CRITICAL).
- `.github/workflows/security-scheduled.yml` — nightly OSV-Scanner run against `main` so newly-published advisories surface without waiting for a PR.
- `osv-scanner.toml` — allowlist for OSV-Scanner (npm + git deps). Schema in [§Allowlist](#allowlist-osv-scanner--trivy) above.
- `.trivyignore` — allowlist for Trivy (container image scan). Same schema discipline; comments carry the owner handle.
