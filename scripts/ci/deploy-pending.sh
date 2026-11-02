#!/usr/bin/env bash
#
# Tells the operator that a merged change is exposed until deployed
# (ADR-0027 § 2026-10-29, control 4; #637).
#
# WHY THIS EXISTS
#   Merging a fix does not deploy it: a host runs what was last deployed
#   there. For a security fix that gap is the exposure. A PR labelled
#   `deploy-asap` — by Renovate (vulnerability PRs, runtime-image updates)
#   or by a human (hand-written security fixes) — opens, or comments on,
#   one "Deploy pending" issue assigned to the operator, who closes it
#   after deploying. Everything else rides along with the next deploy.
#
# CONTRACT
#   Reads from the environment:
#     GITHUB_REPOSITORY  owner/repo
#     BEFORE_SHA         main before the push
#     HEAD_SHA           main after the push
#     MAINTAINER         the operator to assign
#
#   Every commit in BEFORE_SHA...HEAD_SHA counts: the merge queue lands a
#   batch of PRs in one push, one squash commit each. A commit's PR is the
#   one whose merge produced it (merged_at set, merge_commit_sha == the
#   commit); for a commit on the default branch, commits/{sha}/pulls lists
#   exactly that PR. All labelled PRs of the push go into one write.
#
#   GitHub appears to link the commit to its PR asynchronously: a lookup
#   ~9 s after the merge found none, the same call resolved minutes later
#   (#716). An empty or failed lookup is retried after each of RETRY_DELAYS
#   seconds before it counts as missing; a resolved retry logs what the
#   first try saw, to size the delays.
#
#   The pending issue is matched by exact title among issues opened by this
#   workflow's token, so a human's look-alike is never commented on.
#
# EXIT CODES
#   0  done, or no pushed PR carries `deploy-asap`
#   1  a pushed commit has no merged PR or its lookup failed, or another
#      API call failed. Red, so notify.yml raises it: main only takes PR
#      merges (ruleset), and a lost deploy-asap signal must not read as
#      "nothing to do". A commit that fails is named and skipped; the
#      labelled PRs of the other commits are still reported.

set -euo pipefail

LABEL='deploy-asap'
TITLE='Deploy pending'
BOT_LOGIN='github-actions[bot]'
# 35 s of waits per commit; a merge-queue push of 5 stays inside the job's
# 5-minute timeout even if none resolves.
RETRY_DELAYS=(5 10 20)

: "${GITHUB_REPOSITORY:?}" "${BEFORE_SHA:?}" "${HEAD_SHA:?}" "${MAINTAINER:?}"
api="repos/${GITHUB_REPOSITORY}"

shas=$(gh api "${api}/compare/${BEFORE_SHA}...${HEAD_SHA}" | jq -r '.commits[].sha')
if [ -z "$shas" ]; then
  echo "::error::No commits between ${BEFORE_SHA} and ${HEAD_SHA}."
  exit 1
fi

entries=()
missing=0
for sha in $shas; do
  pr='' pulls='' failed=0 tries=0 first=''
  for delay in 0 "${RETRY_DELAYS[@]}"; do
    [ "$delay" -eq 0 ] || sleep "$delay"
    tries=$((tries + 1))
    if pulls=$(gh api "${api}/commits/${sha}/pulls") \
      && pr=$(jq -c --arg sha "$sha" \
        'map(select(.merged_at != null and .merge_commit_sha == $sha)) | first // empty' <<< "$pulls"); then
      failed=0
      [ -z "$pr" ] || break
    else
      failed=1
    fi
    # An unlinked commit (empty) reads differently from a PR not yet merged.
    if [ "$tries" -eq 1 ]; then
      if [ "$failed" -eq 1 ]; then first='lookup failed'
      else first=$(jq -c 'map({number, merged_at, merge_commit_sha})' <<< "$pulls"); fi
    fi
  done

  if [ "$failed" -eq 1 ]; then
    echo "::error::PR lookup failed for ${sha} (${tries} tries). Check its PR for ${LABEL} by hand."
    missing=1
    continue
  fi

  if [ -z "$pr" ]; then
    echo "::error::No merged PR produced ${sha} (${tries} tries). If it was a merge, check its labels for ${LABEL} by hand."
    echo "Last answer: $(jq -c 'map({number, merged_at, merge_commit_sha})' <<< "$pulls")"
    missing=1
    continue
  fi
  [ "$tries" -eq 1 ] || echo "::notice::${sha} resolved on try ${tries}; try 1 saw: ${first}"

  number=$(jq -r '.number' <<< "$pr")
  if ! jq -e --arg l "$LABEL" 'any(.labels[]; .name == $l)' <<< "$pr" > /dev/null; then
    echo "::notice::#${number} has no ${LABEL} label — rides along with the next deploy."
    continue
  fi
  entries+=("- #${number} $(jq -r '.title' <<< "$pr")")
done

[ "${#entries[@]}" -gt 0 ] || exit "$missing"
list=$(printf '%s\n' "${entries[@]}")

# --paginate concatenates one array per page; -s + add joins them.
existing=$(gh api --paginate "${api}/issues?state=open&creator=github-actions%5Bbot%5D&per_page=100" \
  | jq -rs --arg t "$TITLE" --arg bot "$BOT_LOGIN" \
    'add // [] | map(select(.pull_request == null and .user.login == $bot and .title == $t)) | first | .number // empty')

if [ -n "$existing" ]; then
  # A comment re-notifies the assignee: one issue per undeployed backlog.
  gh api -X POST "${api}/issues/${existing}/comments" -f "body=$(printf 'Also pending:\n%s' "$list")" > /dev/null
  echo "::notice::${#entries[@]} PR(s) added to #${existing}"
else
  # printf, not a multi-line literal, so no indentation leaks into the body.
  body=$(printf '%s\n' \
    "Merged with \`${LABEL}\`: what runs is exposed until this is deployed." \
    '' \
    "$list" \
    '' \
    "Deploy ([manual-deploy.md](https://github.com/${GITHUB_REPOSITORY}/blob/main/docs/ops/manual-deploy.md)), then close this issue. Later \`${LABEL}\` merges are added here as comments until then.")
  gh api -X POST "${api}/issues" \
    -f "title=${TITLE}" -f "body=${body}" -f "assignees[]=${MAINTAINER}" > /dev/null
  echo "::notice::${#entries[@]} PR(s) — opened \"${TITLE}\" for ${MAINTAINER}"
fi

exit "$missing"
