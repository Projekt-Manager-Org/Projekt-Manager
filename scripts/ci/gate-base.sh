#!/usr/bin/env bash
#
# The base `lint`'s vulnerability gates judge a change against (#668), and
# that base's copies of the files they compare.
#
# WHY THIS EXISTS
#   The gates fail on findings a change introduces, not on what `main`
#   already ships (ADR-0027 § 2026-10-31). The base decides what counts as
#   introduced, so a wrong base silently passes a vulnerable change. Here,
#   not in a `run:` block, so it is tested.
#
# CONTRACT
#   Reads from the environment (set by the `lint` step):
#     EVENT              github.event_name
#     PR_HEAD_SHA        pull_request.head.sha        (pull_request)
#     MERGE_GROUP_BASE   merge_group.base_sha         (merge_group)
#     PUSH_BEFORE        event.before                 (push)
#     DEFAULT_BRANCH     repository.default_branch    (workflow_dispatch)
#     OUT_DIR            where the base's files go
#
#   Base per event:
#     pull_request       first parent of the checked-out test merge commit:
#                        the base of the tree under test. Must be a two-parent
#                        merge whose second parent is the PR head; anything
#                        else (a head-SHA checkout) would make the PR's own
#                        earlier commit the base.
#     merge_group        the queue's base: the whole group is judged.
#     push               the previous tip.
#     workflow_dispatch  the default branch's tip: a branch deployed by hand
#                        is judged against what production would run instead.
#     anything else      exit 1: no event goes unjudged by accident.
#
#   Writes into OUT_DIR the base's package-lock.json (required) and those of
#   osv-scanner.toml, .trivyignore.yaml, .grype.yaml it has. On stdout, for
#   `>> "$GITHUB_OUTPUT"`: `sha=<base>` and `dir=<OUT_DIR>`.
#
# EXIT CODES
#   0  base resolved, files written
#   1  no usable base (unknown event, bad SHA, not a test merge, fetch failed,
#      no lockfile at the base)
#   2  a required variable is unset or empty
#
# Usage:
#   EVENT=… OUT_DIR=… bash scripts/ci/gate-base.sh >> "$GITHUB_OUTPUT"

set -euo pipefail

need() {
  if [[ -z "${!1:-}" ]]; then
    echo "ERROR: $1 is required${EVENT:+ on '$EVENT'}" >&2
    exit 2
  fi
}

need EVENT
need OUT_DIR

die() {
  echo "ERROR: $1" >&2
  exit 1
}

case "$EVENT" in
  pull_request)
    need PR_HEAD_SHA
    mapfile -t parents < <(git cat-file -p HEAD | awk '/^parent /{print $2}')
    if [[ "${#parents[@]}" -ne 2 || "${parents[1]}" != "$PR_HEAD_SHA" ]]; then
      die "HEAD is not the test merge of $PR_HEAD_SHA (parents: ${parents[*]:-none})"
    fi
    base="${parents[0]}"
    ;;
  merge_group)
    need MERGE_GROUP_BASE
    base="$MERGE_GROUP_BASE"
    ;;
  push)
    need PUSH_BEFORE
    base="$PUSH_BEFORE"
    ;;
  workflow_dispatch)
    need DEFAULT_BRANCH
    git fetch --no-tags --depth=1 origin "refs/heads/$DEFAULT_BRANCH" >&2 ||
      die "cannot fetch $DEFAULT_BRANCH"
    base="$(git rev-parse FETCH_HEAD)"
    ;;
  *)
    die "no base defined for '$EVENT'"
    ;;
esac

if [[ ! "$base" =~ ^[0-9a-f]{40}$ || "$base" =~ ^0+$ ]]; then
  die "no usable base SHA on '$EVENT' (got '$base')"
fi
git fetch --no-tags --depth=1 origin "$base" >&2 || die "cannot fetch base $base"

mkdir -p "$OUT_DIR"
git cat-file -e "$base:package-lock.json" 2>/dev/null || die "base $base has no package-lock.json"
for f in package-lock.json osv-scanner.toml .trivyignore.yaml .grype.yaml; do
  if git cat-file -e "$base:$f" 2>/dev/null; then
    git show "$base:$f" >"$OUT_DIR/$f"
  fi
done

echo "Base on '$EVENT': $base" >&2
echo "sha=$base"
echo "dir=$OUT_DIR"
