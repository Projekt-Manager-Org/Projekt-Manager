# ADR-0028: Dependency CI: a coverage matrix, change-scoped gates and a gated deploy

- **Status:** Accepted
- **Date:** 2026-11-07
- **Confidence:** Medium-High. The scan placement, deploy gate and alert path each ran against real and seeded findings before this was written. Two things are unproven: whether a Dependabot PR passes CI (none has opened since 2026-08-06), and the quarterly review, which has never completed a loop.
- **Supersedes:** in [ADR-0027](0027-continuous-dependency-updates-with-supply-chain-scanning.md), the scan placement (§Decision.2, §Operational) and the mechanics of its nine amendments; in [ADR-0011](0011-build-images-in-ci-distribute-via-ghcr.md), the `base_ref` line and the scan placement. ADR-0027 keeps the tool choices and their rationale.

## Context

The operator wants one thing from dependency CI: to be told when something is wrong. [#740](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/740) measured the opposite:

- **Silent holds.** Renovate ignored all of Postgres 18 from May, after a closed PR, and the health check called that benign. The `lychee` binary matched no manager.
- **No deploy gate.** `deploy.sh` read no CI result. Image scans did not follow the deployed bytes: PRs scanned two of four images, and Caddy is built on the VPS.
- **Unreliable machinery.** On 2026-11-03, five `fix(ci)` PRs each repaired the previous one's side effect. The findings comparison in `notify.yml` (~900 lines with its action and tests) had never run in production.
- **No single description.** Current behaviour was spread over ADR-0027's decision and nine amendments, so nobody could answer "what tells me about X" without reading all of them.

## Decision

**1. The coverage matrix is the contract.** Every dependency source has an update path and an alert path, or is a named, accepted gap: [dep-management.md § Coverage matrix](../ops/dep-management.md#coverage-matrix). A new source adds a row.

**2. No hold is silent.** Majors wait in the dashboard's Pending Approval. Any other hold needs a dated row in `exception-register.yaml`; a closed Renovate PR turns `Renovate health` red.

**3. Each check judges one question, at one place.**

```
PR, queue  lint    OSV, repo advisories, release age: head − base    ─▶ red blocks the merge
           docker  image secrets only                                ─▶ red blocks the merge
push       scan    Trivy + Grype, every deployed image at sha-<C>    ─▶ ci-red; deploy.sh refuses C
nightly            OSV, repo advisories, inventory scan: main        ─▶ ci-red; deploy.sh warns
```

An advisory against what `main` already ships never blocks a PR: that removes no exposure and blocks the fix. Image vulnerabilities are judged once, on the commit that can be deployed; the image base comparison (`trivy-gate.sh` against `:main`, and ADR-0011's `base_ref`) is gone.

**4. Deploy requires the scanned commit.** `deploy.sh` refuses a red or missing push run for the target SHA, and refuses when the API cannot answer. `--accept-red-ci <reason>` overrides and logs. A red nightly only warns: it flags a new advisory against what already runs, so refusing would stop the fix deploy.

**5. One alert path.** A red run goes through `notify.yml`: a PR is assigned to the maintainer, `main` opens a `ci-red` issue that closes on the next green. A repeat names the failed jobs and steps with their annotations; nothing compares runs. `check-notify-coverage.sh` keeps every unattended workflow hooked in. Besides that path: `deploy-asap` merges open a Deploy pending issue, and Dependabot emails critical and high alerts.

**6. A guard earns its place.** It stays if it caught something, protects an AC or spec rule, or is the only signal of a failure that would otherwise be silent. Anything else is deleted, because its failure is already loud elsewhere: [dep-management.md § Guards](../ops/dep-management.md#guards) lists every one.

**7. Buy before build.** Renovate, Dependabot, OSV-Scanner, Trivy and Grype do the detecting. Owned code stays only where no tool covers the case; the same table gives each reason.

ADR-0027's amendments stay as the history and rationale. Their decisions stand unless the table says otherwise; what runs today is here and in `dep-management.md`, not there.

| Amendment                                                                                                                                                                        | Now                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [2026-07-25 E2E not a PR gate](0027-continuous-dependency-updates-with-supply-chain-scanning.md#2026-07-25--e2e-is-not-a-pr-gate)                                                | Stands                                                                              |
| [2026-08-06 transitive deps](0027-continuous-dependency-updates-with-supply-chain-scanning.md#2026-08-06--renovate-does-not-remediate-transitive-deps)                           | Stands: lockfile maintenance and Dependabot security updates                        |
| [2026-08-28 cooldown](0027-continuous-dependency-updates-with-supply-chain-scanning.md#2026-08-28--release-age-cooldown-and-its-limits)                                          | Stands                                                                              |
| [2026-08-28 repo-level advisories](0027-continuous-dependency-updates-with-supply-chain-scanning.md#2026-08-28--repo-level-advisories-and-what-no-layer-covers)                  | Stands, including its list of what no layer covers                                  |
| [2026-09-17 release-age gate](0027-continuous-dependency-updates-with-supply-chain-scanning.md#2026-09-17--a-release-age-gate-on-the-lockfile-complementing-the-resolver-cutoff) | Stands                                                                              |
| [2026-10-29 outside npm](0027-continuous-dependency-updates-with-supply-chain-scanning.md#2026-10-29--security-releases-outside-npm)                                             | Stands; control 3 now also runs in the push run                                     |
| [2026-10-31 merge queue](0027-continuous-dependency-updates-with-supply-chain-scanning.md#2026-10-31--merge-queue-replaces-strict-up-to-date)                                    | Stands                                                                              |
| [2026-10-31 PR gates judge the change](0027-continuous-dependency-updates-with-supply-chain-scanning.md#2026-10-31--pr-gates-judge-the-change-not-main)                          | Stands for `lint`; its image half is replaced by point 3, its comparison by point 5 |
| [2026-11-01 Docker host advisories](0027-continuous-dependency-updates-with-supply-chain-scanning.md#2026-11-01--docker-host-advisories-the-per-component-exception)             | Stands                                                                              |

No new dependency, so no lifecycle table: [ADR-0027's](0027-continuous-dependency-updates-with-supply-chain-scanning.md#dep-lifecycle-health-as-of-2026-07-27) still applies.

## Alternatives Considered

### Turn off Dependabot security updates, keep the alerts

Its runs kept failing from 2026-10-31, all on `minimatch` or `glob` with no in-range fix, and the three PRs found (#320, #321, #322) were closed unmerged. Rejected by the owner: on a project this unreliable, removing an external check is tape over a warning light. A failed run is an accepted gap instead, since a non-allowlisted advisory still turns the nightly OSV scan red.

### Trivy alone

Grype costs a second scanner and a second allowlist. Kept because it caught what Trivy missed: GO-2026-6865 in Caddy, and the day-one Node 24.16.0 and PostgreSQL 17.9 binaries. A false finding such as CVE-2026-4738 becomes a dated waiver.

### Dependabot alerts in place of the owned gates

Would delete `check-repo-advisories.mjs`, the OSV gate and `check-release-age.mjs`. Rejected: alerts fire only for GitHub-reviewed advisories and carry no malicious-package records, repo-level advisories reach no lockfile scanner (three caught on 2026-11-03), and Renovate's cooldown covers only its own PRs.

### Keep the image vulnerability gate on PRs

Absolute, it blocks fixes ([#668](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/668)). Against `:main` it needs comparison code, and `:main` lags the true base. Scanning the merged commit answers the question that matters, whether this commit may be deployed, with neither problem.

### A red nightly refuses the deploy

Refuses the very deploy that would carry the fix, without reducing exposure. Rejected. The next merge's push run scans the same images, so a finding left untriaged still blocks.

## Consequences

### Positive

- One page answers "how does X get updated, and what tells me".
- What gets deployed was scanned at that commit, or the operator logged why not. Caddy is the one image built on the host: the scan covers CI's build of the same pinned inputs.
- `notify.yml` went from 612 to 150 lines and `lint` from 71 to 38 steps.

### Negative

- CI code shrank only from 19,017 to 17,605 lines (workflows, actions, CI scripts, guards and their tests, Renovate and Dependabot config). The budgets were for `notify.yml` and `lint`, not the total, and most of what remains is tested owned gates kept on purpose.
- Batch-intermediate, evicted and feature-branch SHAs have no push run, so deploying one needs the override.
- A red nightly blocks deploys after the next merge, so triage cannot wait for a quiet week.
- The accepted gaps stay open by choice. Each one fails silently until a human looks.
- A guard kept as the only signal of a silent failure may never fire. That is the point of it, and also why nothing but this rule stops such guards from accumulating.

## References

- [#740](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/740), [#637](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/637), [#668](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/668)
- [ADR-0027](0027-continuous-dependency-updates-with-supply-chain-scanning.md), [ADR-0011](0011-build-images-in-ci-distribute-via-ghcr.md), [ADR-0009](0009-pin-docker-versions-across-environments.md)
- [docs/ops/dep-management.md](../ops/dep-management.md)
- [docs/ops/manual-deploy.md § CI check](../ops/manual-deploy.md#ci-check)
