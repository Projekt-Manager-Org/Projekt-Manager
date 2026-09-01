#!/usr/bin/env bash
#
# Single source of truth for the GHCR repository paths and the tag triple
# every image-producing CI step derives from (branch ref, commit SHA).
#
# WHY THIS EXISTS
#   The slugification expression and the owner-lowercasing lived in five
#   places across ci.yml and the composite actions. Only one of them
#   carried the `main` guard below, so the other four would happily
#   compute the production pointer for a branch that must never own it.
#   One definition cannot drift, and living under scripts/ puts it in the
#   `lint` job's shellcheck sweep — which no `run:` block copy was in.
#
# CONTRACT
#   Reads from the environment (all set by Actions):
#     BRANCH_REF                the deployable branch name. On a
#                               pull_request that is head.ref, NOT
#                               GITHUB_REF_NAME (`<n>/merge` is not a
#                               branch anyone can deploy).
#     HEAD_SHA                  the commit the images are built from. On a
#                               pull_request that is head.sha, not the
#                               synthetic merge commit.
#     GITHUB_REPOSITORY_OWNER   org name, any case.
#     GITHUB_REF                used only by the `main` guard below.
#
#   Writes `key=value` lines on stdout, for `>> "$GITHUB_OUTPUT"`:
#     owner, sha_tag, branch_slug, git_sha, app_repo, backup_repo,
#     app_ref, backup_ref
#
# EXIT CODES
#   0  values printed
#   1  the branch slugifies onto `main` without being `main`
#   2  a required variable is unset or empty
#
# Usage:
#   BRANCH_REF=… HEAD_SHA=… bash scripts/ci/image-refs.sh >> "$GITHUB_OUTPUT"

set -euo pipefail

for var in BRANCH_REF HEAD_SHA GITHUB_REPOSITORY_OWNER; do
  if [ -z "${!var:-}" ]; then
    echo "::error::image-refs.sh: $var is unset or empty" >&2
    exit 2
  fi
done

# GHCR rejects uppercase in the repository path; the org is mixed-case.
owner="${GITHUB_REPOSITORY_OWNER,,}"

# Slugify for Docker tag legality: lowercase, '/' to '-', anything left
# outside [a-z0-9._-] to '-'.
branch_slug=$(echo "${BRANCH_REF}" | tr '[:upper:]/' '[:lower:]-' | sed 's/[^a-z0-9._-]/-/g')

# `main` is the production pointer `promote` owns, and since #355 a PR run
# — not just an operator dispatch — writes the slug tag. Lowercasing means
# a branch called `Main` slugifies onto it, so an unmerged branch could
# overwrite production's pointer. Refuse rather than publish over it.
if [ "$branch_slug" = "main" ] && [ "${GITHUB_REF:-}" != "refs/heads/main" ]; then
  echo "::error::branch '${BRANCH_REF}' slugifies to 'main', the tag promote publishes on merge — rename the branch" >&2
  exit 1
fi

app_repo="ghcr.io/${owner}/projekt-manager"
backup_repo="ghcr.io/${owner}/projekt-manager-backup"

cat <<EOF
owner=${owner}
sha_tag=sha-${HEAD_SHA}
branch_slug=${branch_slug}
git_sha=${HEAD_SHA}
app_repo=${app_repo}
backup_repo=${backup_repo}
app_ref=${app_repo}:sha-${HEAD_SHA}
backup_ref=${backup_repo}:sha-${HEAD_SHA}
EOF
