#!/usr/bin/env bash
#
# Tells the operator about upstream security advisories for the Docker
# host packages (#699; ADR-0009).
#
# WHY THIS EXISTS
#   The host packages are pinned and bumped once a quarter (ADR-0009), so
#   "current by default" (ADR-0027 § 2026-10-29, control 1) does not cover
#   them, and nothing else carries their advisories: Renovate's deb
#   datasource has no vulnerability data, the inventory scan reads images,
#   unattended-upgrades skips held packages. GHSA-7cfq-22r6-qp73 was found
#   by hand 8 days after publishing (#495).
#
# CONTRACT
#   Reads from the environment:
#     GITHUB_REPOSITORY    owner/repo
#     MAINTAINER           the operator to assign
#     LOOKBACK_DAYS        optional, default 7; a dispatch widens it after an outage
#     DOCKER_PINS_FILE     optional, default docker/host-versions.txt
#     ADVISORY_REPOS_FILE  optional, default docker/host-advisory-repos.txt
#
#   Every repo mapped to a pinned package is read in full
#   (GET /repos/{owner}/{repo}/security-advisories?state=published). An
#   advisory is reported when it is not MEDIUM or LOW (unrated counts), its
#   updated_at falls within the lookback (so one raised to HIGH later
#   still counts), and no issue titled "Docker host advisory: <GHSA id>",
#   open or closed, was opened by this workflow's token. A look-alike
#   opened by anyone else suppresses nothing.
#
#   An advisory edited after its issue was last touched, while that issue
#   is closed, reopens it with a comment: a corrected range or severity
#   can overturn a "not applicable". Closing it again is the
#   acknowledgement; the next edit reopens it again.
#
#   Upstream text is untrusted: the summary and CVE id go into code
#   spans, their own backticks dropped, so they cannot @mention or #link
#   anything. An advisory without a date counts as within the lookback.
#
# EXIT CODES
#   0  done, reported or not
#   1  the pins or mapping file is unreadable or the pins name nothing, a
#      pin has no mapping row, the lookback is unreadable, an upstream
#      repo could not be read or parsed (404 included: a mapped repo files
#      advisories, so a 404 means the row watches nothing), the issue
#      list could not be read, or an issue could not be opened or
#      reopened. Red, so notify.yml raises it; every cause has its
#      ::error:: line. An unreadable repo or a failed write is named and
#      skipped, the others still reported; any other cause reports nothing.

set -euo pipefail

TITLE_PREFIX='Docker host advisory: '
BOT_LOGIN='github-actions[bot]'
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PINS_FILE="${DOCKER_PINS_FILE:-$REPO_ROOT/docker/host-versions.txt}"
MAP_FILE="${ADVISORY_REPOS_FILE:-$REPO_ROOT/docker/host-advisory-repos.txt}"
LOOKBACK="${LOOKBACK_DAYS:-7}"

: "${GITHUB_REPOSITORY:?}" "${MAINTAINER:?}"
api="repos/${GITHUB_REPOSITORY}"
triage="https://github.com/${GITHUB_REPOSITORY}/blob/main/docs/ops/server-setup.md#triaging-a-docker-host-advisory"

if [[ ! "$LOOKBACK" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::LOOKBACK_DAYS must be a positive integer, got '${LOOKBACK}'."
  exit 1
fi
cutoff=$(date -u -d "${LOOKBACK} days ago" +%Y-%m-%dT%H:%M:%SZ)

for file in "$PINS_FILE" "$MAP_FILE"; do
  [[ -r "$file" ]] || { echo "::error::Cannot read ${file}."; exit 1; }
done
# A command substitution, not `< <(...)`: set -e sees its failure.
pins=$(sed -E 's/#.*//; s/=.*//' "$PINS_FILE" | awk 'NF { print $1 }')
if [[ -z "$pins" ]]; then
  echo "::error::No pinned packages in ${PINS_FILE}: nothing would be watched."
  exit 1
fi

# repo → the pinned packages it covers, space-separated.
declare -A packages_of=()
unmapped=0
while read -r pkg; do
  repos=$(awk -v p="$pkg" '{ sub(/#.*/, "") } $1 == p { $1 = ""; print }' "$MAP_FILE")
  if [[ -z "${repos// /}" ]]; then
    echo "::error::${pkg} is pinned in $(basename "$PINS_FILE") but has no row in $(basename "$MAP_FILE"): its advisories are not watched."
    unmapped=1
    continue
  fi
  for repo in $repos; do
    packages_of[$repo]="${packages_of[$repo]:+${packages_of[$repo]} }${pkg}"
  done
done <<< "$pins"
[[ "$unmapped" -eq 0 ]] || exit 1

failed=0
found=()
for repo in $(printf '%s\n' "${!packages_of[@]}" | sort); do
  # --paginate concatenates one array per page; -s + add joins them.
  # Filtered inside the `if !`, so a listing jq cannot read is red, never
  # an empty one. Below the floor means MEDIUM or LOW, named: any other
  # value, null included, cannot be judged below it and is reported.
  if ! hits=$(gh api --paginate "repos/${repo}/security-advisories?state=published&per_page=100" \
    | jq -c -s --arg cutoff "$cutoff" --arg pkgs "${packages_of[$repo]}" 'add // [] | .[]
      | select(.state == "published" and .withdrawn_at == null)
      | select(.severity != "medium" and .severity != "low")
      | select((.updated_at // .published_at // $cutoff) >= $cutoff)
      | . + {packages: $pkgs}'); then
    echo "::error::Could not read ${repo}'s security advisories. Check them by hand: https://github.com/${repo}/security/advisories"
    failed=1
    continue
  fi
  [[ -z "$hits" ]] || mapfile -t -O "${#found[@]}" found <<< "$hits"
done

[[ "${#found[@]}" -gt 0 ]] || exit "$failed"

if ! reported=$(gh api --paginate "${api}/issues?state=all&creator=github-actions%5Bbot%5D&per_page=100" \
  | jq -cs --arg bot "$BOT_LOGIN" --arg p "$TITLE_PREFIX" \
    'add // [] | map(select(.pull_request == null and .user.login == $bot and (.title | startswith($p)))
      | {title, number, state, updated_at})'); then
  echo "::error::Could not read the reported issues; nothing opened. New advisories: $(printf '%s\n' "${found[@]}" | jq -rs 'map(.ghsa_id) | join(" ")')"
  exit 1
fi

for adv in "${found[@]}"; do
  id=$(jq -r '.ghsa_id' <<< "$adv")
  title="${TITLE_PREFIX}${id}"
  # "open", "reopen <number>" (closed, advisory edited since), or "closed".
  # A race may have opened two: any open one is the live one.
  seen=$(jq -r --arg t "$title" --argjson adv "$adv" '
    map(select(.title == $t)) | select(length > 0)
    | if any(.state == "open") then "open"
      else max_by(.updated_at)
        | if ($adv.updated_at // $adv.published_at // "") > .updated_at
          then "reopen \(.number)" else "closed" end
      end' <<< "$reported")
  case "$seen" in
    open | closed)
      echo "::notice::${id} already reported."
      continue
      ;;
    reopen\ *)
      number="${seen#reopen }"
      comment=$(jq -r '"Upstream edited \(.ghsa_id) after this issue was closed: re-check the range and severity against the triage rule."' <<< "$adv")
      if gh api -X PATCH "${api}/issues/${number}" -f state=open > /dev/null \
        && gh api -X POST "${api}/issues/${number}/comments" -f "body=${comment}" > /dev/null; then
        echo "::notice::Reopened #${number}: ${id} was edited upstream."
      else
        echo "::error::Could not reopen #${number} for ${id}: $(jq -r '.html_url' <<< "$adv")"
        failed=1
      fi
      continue
      ;;
  esac

  body=$(jq -r --arg triage "$triage" '
    "**\(.severity // "unrated" | ascii_upcase)** upstream advisory for \(.packages | split(" ") | map("`\(.)`") | join(", ")): [\(.ghsa_id)](\(.html_url))\(if .cve_id then " (`\(.cve_id | gsub("[`\\r\\n]"; " "))`)" else "" end)",
    "",
    "`\(.summary | gsub("[`\\r\\n]"; " "))`",
    "",
    "Triage per [server-setup.md § Triaging a Docker host advisory](\($triage)): close as not applicable with the reason, or follow it to a deploy."' <<< "$adv")
  if gh api -X POST "${api}/issues" -f "title=${title}" -f "body=${body}" \
    -f "assignees[]=${MAINTAINER}" -f 'labels[]=security' > /dev/null; then
    echo "::notice::Opened \"${title}\" for ${MAINTAINER}"
  else
    echo "::error::Could not open the issue for ${id}: $(jq -r '.html_url' <<< "$adv")"
    failed=1
  fi
done

exit "$failed"
