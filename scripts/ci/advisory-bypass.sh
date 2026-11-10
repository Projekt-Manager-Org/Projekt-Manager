#!/usr/bin/env bash
#
# Whether `lint`'s release-age gate waives age findings: the change's PR
# carries the `security` label (#422, ADR-0027 § 2026-09-17).
#
# WHY THIS EXISTS
#   A `merge_group` run has no `pull_request` payload, so a waiver read
#   from `github.event.pull_request.labels` is always off in the queue: an
#   in-cooldown security PR passes its PR run and is dropped from the queue
#   until the cooldown ends (#828). Here, not in a `run:` block, so it is
#   tested.
#
# CONTRACT
#   Reads from the environment (set by the `lint` step):
#     EVENT                 github.event_name
#     PR_LABELS             JSON array of label names    (pull_request)
#     MERGE_GROUP_HEAD_REF  merge_group.head_ref         (merge_group)
#     REPO                  github.repository            (merge_group)
#     GH_TOKEN              read access to the PR        (merge_group, via gh)
#
#   Labels per event:
#     pull_request       the event's labels.
#     merge_group        the queued PR's, from the API. The PR number comes
#                        from the queue branch, `gh-readonly-queue/<base>/
#                        pr-<N>-<sha>`. The group run judges `main` plus every
#                        PR ahead of PR N, but under ALLGREEN each entry needs
#                        its own green run: an unlabelled PR ahead with a young
#                        version fails its own entry and leaves the group.
#     anything else      no waiver.
#
#   On stdout, for `>> "$GITHUB_OUTPUT"`: `bypass=1` or `bypass=0`.
#
# EXIT CODES
#   0  decided
#   1  could not decide (labels not JSON, not a queue branch, lookup failed):
#      never a guessed answer either way
#   2  a required variable is unset or empty
#
# Usage:
#   EVENT=… PR_LABELS=… bash scripts/ci/advisory-bypass.sh >> "$GITHUB_OUTPUT"

set -euo pipefail

need() {
  if [[ -z "${!1:-}" ]]; then
    echo "ERROR: $1 is required${EVENT:+ on '$EVENT'}" >&2
    exit 2
  fi
}

die() {
  echo "ERROR: $1" >&2
  exit 1
}

need EVENT

case "$EVENT" in
  pull_request)
    need PR_LABELS
    labels="$(jq -er '.[]' <<<"$PR_LABELS" 2>/dev/null)" ||
      [[ "$(jq -e 'length' <<<"$PR_LABELS" 2>/dev/null)" == 0 ]] ||
      die "PR_LABELS is not a JSON array of names: $PR_LABELS"
    ;;
  merge_group)
    need MERGE_GROUP_HEAD_REF
    need REPO
    re='^refs/heads/gh-readonly-queue/.+/pr-([0-9]+)-[0-9a-f]{40}$'
    [[ "$MERGE_GROUP_HEAD_REF" =~ $re ]] ||
      die "not a merge queue branch: $MERGE_GROUP_HEAD_REF"
    pr="${BASH_REMATCH[1]}"
    labels="$(gh api --paginate "repos/$REPO/issues/$pr/labels" --jq '.[].name')" ||
      die "could not read the labels of PR #$pr"
    ;;
  *)
    labels=""
    ;;
esac

if grep -qxF security <<<"${labels:-}"; then
  echo "bypass=1"
else
  echo "bypass=0"
fi
