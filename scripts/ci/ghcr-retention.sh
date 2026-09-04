#!/usr/bin/env bash
#
# Reap stale GHCR image versions for the app and backup packages.
#
# WHY NOT THE BUILT-IN POLICY OR actions/delete-package-versions
#   `provenance: mode=max` makes every published artifact an OCI *index*.
#   The tag lands on the index; the image manifest and the attestation
#   manifest beneath it are separate, UNTAGGED package versions. Measured
#   2026-09-04 on `projekt-manager`: of 295 untagged versions, 284 were
#   children of tagged indices and 11 were true orphans. So "delete
#   untagged" — GHCR's built-in policy, and the action's
#   `delete-only-untagged-versions` — would have broken 146 of the 147
#   tagged images, `main` included. Neither tool can express "keep this
#   digest *and everything its index references*", which is why this is a
#   script and not four lines of YAML.
#
# POLICY — keep, delete everything else:
#   1. `main`, and `sha-<c>` for the newest KEEP_MAIN commits on main:
#      the running deploy plus its rollback window (ADR-0012).
#   2. `sha-<head>` of every open PR: the artifact `promote`'s guard 3
#      looks for at merge time, and the one the operator deploys to test.
#   3. Anything younger than MIN_AGE_HOURS: a build whose PR is not open
#      yet, and the window between a push and this job's next run.
#   4. Every child manifest of anything kept by 1-3.
#
#   Branch-slug tags are deliberately NOT protected. They are moving
#   pointers; deleting one costs a re-push, and every push rebuilds
#   anyway. ADR-0011 § Retention carries the reasoning, including why
#   the PR-close reaping half of #373 was dropped.
#
# WHAT THIS DOES *NOT* PROTECT
#   The image the VPS is actually running. Rule 1 keeps the newest
#   KEEP_MAIN commits on `main`; the deploy is whatever the operator
#   last ran `deploy.sh` with, and that drifts arbitrarily far behind
#   (measured 2026-09-04: 70 commits). That is deliberate, and it is
#   `deploy.sh`'s job to survive it: it pulls `--policy missing`, so a
#   rollback to any image the host still caches never touches the
#   registry. See docs/ops/manual-deploy.md § Rollback.
#
# FAIL CLOSED
#   Every step that could silently under-populate the keep set aborts
#   instead: a shallow checkout, an unlistable PR set, an unreadable
#   manifest, a missing `main` tag, or a keep set that does not cover
#   `main`. A run that deletes nothing costs storage; a run that deletes
#   the wrong thing costs the deploy. Deleted versions are restorable
#   for 30 days — subject to the namespace still being free and admin on
#   the package — but only if someone notices, which is why
#   `notify.yml` monitors this workflow.
#
# CONTRACT
#   Reads from the environment:
#     GITHUB_REPOSITORY  owner/repo (set by Actions).
#     GH_TOKEN           token for `gh` and for the registry read.
#     PACKAGES           space-separated package names.
#                        Default: "projekt-manager projekt-manager-backup"
#     KEEP_MAIN          rollback window, in commits on main. Default 5.
#     MIN_AGE_HOURS      floor below which nothing is deleted. Default 24.
#     DRY_RUN            anything but "false" reports without deleting.
#                        Default "true" — arming is explicit.
#     MAIN_REF           ref to walk for rule 1. Default HEAD, which is
#                        main under the workflow's checkout.
#
# EXIT CODES
#   0  reaped (or reported, under DRY_RUN)
#   1  swept both packages, but one or more deletes were rejected
#   2  bad invocation: missing variable, missing tool, shallow checkout,
#      unlistable PR set
#   3  refused: an invariant protecting the `main` pointer did not hold
#
# Usage (local dry run, from a checkout with origin/main fetched):
#   GITHUB_REPOSITORY=Projekt-Manager-Org/Projekt-Manager \
#   GH_TOKEN=$(gh auth token) MAIN_REF=origin/main \
#   bash scripts/ci/ghcr-retention.sh

set -euo pipefail

: "${GITHUB_REPOSITORY:?unset — set by Actions; export it for local runs}"
: "${GH_TOKEN:?unset — needs read on the packages and packages:write to delete}"

ORG="${GITHUB_REPOSITORY%%/*}"
# GHCR rejects uppercase in the registry path; the org is mixed-case.
# Same lowercasing scripts/ci/image-refs.sh does for the push side.
OWNER="${ORG,,}"
PACKAGES="${PACKAGES:-projekt-manager projekt-manager-backup}"
KEEP_MAIN="${KEEP_MAIN:-5}"
MIN_AGE_HOURS="${MIN_AGE_HOURS:-24}"
DRY_RUN="${DRY_RUN:-true}"
MAIN_REF="${MAIN_REF:-HEAD}"

# An index and its children are one artifact split across three package
# versions, so the manifest read is load-bearing, not decorative.
ACCEPT='application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json'

for tool in gh jq curl git; do
  command -v "$tool" > /dev/null || {
    echo "::error::ghcr-retention: $tool not found" >&2
    exit 2
  }
done

# --- Keep tags (rules 1 and 2) ----------------------------------------
# Resolved once and shared by both packages: the app and backup images
# are built and tagged as a pair, so anything worth keeping in one is
# worth keeping in the other.
mapfile -t main_shas < <(git rev-list -n "$KEEP_MAIN" "$MAIN_REF")
if [ "${#main_shas[@]}" -lt "$KEEP_MAIN" ]; then
  echo "::error::ghcr-retention: $MAIN_REF yields ${#main_shas[@]} commits, need $KEEP_MAIN — deepen the checkout (fetch-depth)" >&2
  exit 2
fi

# Captured into a variable first: `mapfile < <(...)` discards the
# producer's exit status — neither `set -e` nor `pipefail` covers process
# substitution — so a 5xx or a rate-limited `gh` would yield an empty
# list and silently reap every open PR's image. Rule 2 is the one keep
# input with no downstream invariant to catch it.
if ! pr_list=$(gh pr list --repo "$GITHUB_REPOSITORY" --state open --limit 100 \
  --json headRefOid --jq '.[].headRefOid'); then
  echo "::error::ghcr-retention: cannot list open PRs — refusing to delete anything" >&2
  exit 2
fi
mapfile -t pr_shas < <(printf '%s' "$pr_list")

keep_tags=(main)
for sha in "${main_shas[@]}" ${pr_shas[@]+"${pr_shas[@]}"}; do
  keep_tags+=("sha-${sha}")
done
keep_tags_json=$(printf '%s\n' "${keep_tags[@]}" | jq -R . | jq -sc .)

cutoff=$(date -u -d "-${MIN_AGE_HOURS} hours" +%Y-%m-%dT%H:%M:%SZ)

echo "org=${ORG}  keep_main=${KEEP_MAIN} (${#main_shas[@]} commits)  open_prs=${#pr_shas[@]}  age_floor=${cutoff}  dry_run=${DRY_RUN}"

# --- Per package ------------------------------------------------------
reap_package() {
  local pkg="$1"
  local versions total regtok raw digest child id tags created
  local -A keep=()
  local -a doomed=()

  versions=$(gh api --paginate "/orgs/${ORG}/packages/container/${pkg}/versions?per_page=100")
  total=$(jq 'length' <<< "$versions")

  # Rules 1 and 2: a version is kept if ANY of its tags is a keep tag.
  # Deleting a version deletes all of its tags at once, so one match is
  # enough — and is why `promote`'s re-tagging (which puts `main`,
  # `sha-<pr-tip>` and `sha-<merge-sha>` on a single digest) collapses
  # into one kept version rather than three.
  while read -r digest; do
    [ -n "$digest" ] && keep["$digest"]=tagged
  done < <(jq -r --argjson kt "$keep_tags_json" \
    '.[] | select(any(.metadata.container.tags[]; . as $t | $kt | index($t) != null)) | .name' <<< "$versions")

  # Rule 3.
  while read -r digest; do
    [ -n "$digest" ] && keep["$digest"]=recent
  done < <(jq -r --arg c "$cutoff" '.[] | select(.created_at > $c) | .name' <<< "$versions")

  # Rule 4. The packages are public, so an anonymous pull token would do;
  # basic auth is used anyway so this keeps working if visibility is ever
  # narrowed again.
  regtok=$(curl -fsS -u "${GITHUB_ACTOR:-x}:${GH_TOKEN}" \
    "https://ghcr.io/token?service=ghcr.io&scope=repository:${OWNER}/${pkg}:pull" | jq -r '.token')

  # Expanded before the loop body runs, so adding children inside is
  # safe — a child manifest is never itself an index.
  for digest in "${!keep[@]}"; do
    if ! raw=$(curl -fsS -H "Authorization: Bearer ${regtok}" -H "Accept: ${ACCEPT}" \
      "https://ghcr.io/v2/${OWNER}/${pkg}/manifests/${digest}"); then
      echo "::error::ghcr-retention: cannot read manifest ${digest} of ${pkg} — refusing to delete anything" >&2
      exit 3
    fi
    # `?` because one tagged version predates uniform provenance
    # (sha-6f9ce01, 2026-05-20): a plain manifest, no children.
    while read -r child; do
      [ -n "$child" ] && keep["$child"]=child
    done < <(jq -r '.manifests[]?.digest' <<< "$raw")
  done

  # Invariant: whatever else this deletes, the `main` pointer survives.
  # NOT the same as "the running deploy survives" — see WHAT THIS DOES
  # NOT PROTECT in the header.
  #
  # Exactly one match required: two `main`-tagged versions would make
  # this a multiline string and the keep lookup below miss, so assert
  # rather than rely on the registry never doing that.
  local main_digest main_count
  main_digest=$(jq -r '.[] | select(.metadata.container.tags | index("main")) | .name' <<< "$versions")
  main_count=$(grep -c . <<< "$main_digest" || true)
  if [ "$main_count" -ne 1 ]; then
    echo "::error::ghcr-retention: ${pkg} has ${main_count} versions tagged 'main', expected 1 — refusing" >&2
    exit 3
  fi
  if [ -z "${keep[$main_digest]:-}" ]; then
    echo "::error::ghcr-retention: ${pkg}'s 'main' version ${main_digest} is not in the keep set — refusing" >&2
    exit 3
  fi

  # Tab is IFS whitespace, so a run of tabs collapses to one delimiter:
  # an empty tags field from `@tsv` — 2 versions in 3 are untagged —
  # would shift `created` into `tags` and blank the last column. jq
  # emits the placeholder so the field is never empty. The dry run is
  # the only human review surface before this is armed; it has to read
  # correctly.
  while IFS=$'\t' read -r id digest tags created; do
    [ -n "${keep[$digest]:-}" ] && continue
    doomed+=("$id")
    printf '  - %s  %s  %s\n' "${digest:7:12}" "$created" "$tags"
  done < <(jq -r '.[] | [
      (.id|tostring),
      .name,
      (.metadata.container.tags | if length == 0 then "<untagged>" else join(",") end),
      .created_at
    ] | @tsv' <<< "$versions")

  echo "${pkg}: ${total} versions — keep ${#keep[@]}, delete ${#doomed[@]}"

  if [ "${#doomed[@]}" -eq "$total" ]; then
    echo "::error::ghcr-retention: ${pkg} would lose every version — refusing" >&2
    exit 3
  fi

  if [ "$DRY_RUN" != "false" ]; then
    echo "  dry run — nothing deleted"
    return 0
  fi

  # Count and continue rather than abort on the first error. `set -e`
  # would stop the loop dead, and one PERMANENTLY undeletable version
  # would then wedge every future run at the same point: GitHub refuses
  # to delete a version of a PUBLIC package with more than 5,000
  # downloads, and the versions payload carries no download count to
  # pre-check. A non-zero exit at the end still turns the run red, and
  # `notify.yml` still raises it.
  local failed=0
  for id in "${doomed[@]}"; do
    gh api -X DELETE "/orgs/${ORG}/packages/container/${pkg}/versions/${id}" > /dev/null || {
      echo "::warning::ghcr-retention: ${pkg} version ${id} would not delete"
      failed=$((failed + 1))
    }
    # GitHub asks for a second between mutating requests; the first run
    # deletes ~260 versions per package and would otherwise trip the
    # secondary rate limit partway through.
    sleep 1
  done
  echo "  deleted $((${#doomed[@]} - failed)) versions, ${failed} failed"
  [ "$failed" -eq 0 ] || return 1
}

read -ra pkgs <<< "$PACKAGES"
if [ "${#pkgs[@]}" -eq 0 ]; then
  echo "::error::ghcr-retention: PACKAGES is empty — nothing to sweep" >&2
  exit 2
fi

# A package whose deletes partly failed must not stop the next package
# from being swept, so the non-zero return is collected rather than left
# to `set -e`. Refusals (exit 3) and bad invocations (exit 2) still abort
# immediately — those mean the keep set itself is untrustworthy.
rc=0
for pkg in "${pkgs[@]}"; do
  reap_package "$pkg" || rc=1
done
exit "$rc"
