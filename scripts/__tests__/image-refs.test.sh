#!/usr/bin/env bash
#
# Scenario tests for scripts/ci/image-refs.sh.
#
# The script is the only place that decides what a commit's images are
# called, so every job's tags are wrong together or right together. Two
# things are worth asserting: the slug rules (case, separators, illegal
# characters), and the `main` guard — the one rule whose failure mode is
# publishing over the production pointer rather than a red build.
#
# Exits 0 when every case matches; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/image-refs.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/ci/image-refs.sh"

if [[ ! -f "$SCRIPT" ]]; then
  echo "ERROR: $SCRIPT not found." >&2
  exit 2
fi

SHA=0123456789abcdef0123456789abcdef01234567

pass=0
fail=0
failures=()

# Runs the script with one scenario's environment and asserts both the
# exit code and — when it succeeded — one `key=value` line of its output.
# `expect_line` empty means "only the exit code matters".
assert_case() {
  local label="$1" expected_rc="$2" expect_line="$3" branch="$4" ref="$5"
  local out rc

  out=$(
    BRANCH_REF="$branch" \
      HEAD_SHA="$SHA" \
      GITHUB_REPOSITORY_OWNER="Projekt-Manager-Org" \
      GITHUB_REF="$ref" \
      bash "$SCRIPT" 2>&1
  )
  rc=$?

  if [[ "$rc" -ne "$expected_rc" ]]; then
    fail=$((fail + 1))
    failures+=("$label: expected exit $expected_rc, got $rc")
    return
  fi
  if [[ -n "$expect_line" ]] && ! grep -qxF "$expect_line" <<<"$out"; then
    fail=$((fail + 1))
    failures+=("$label: expected output line '$expect_line'; got:"$'\n'"$out")
    return
  fi
  pass=$((pass + 1))
}

# --- slug rules -----------------------------------------------------
assert_case "slash becomes dash" 0 \
  'branch_slug=fix-355-pipeline-topology' 'fix/355-pipeline-topology' 'refs/pull/372/merge'
assert_case "uppercase is folded" 0 \
  'branch_slug=feature-bar' 'Feature/Bar' 'refs/pull/1/merge'
assert_case "illegal characters become dashes" 0 \
  'branch_slug=feat-uni-code' 'feat/uni#code' 'refs/pull/1/merge'
assert_case "dots and dashes survive" 0 \
  'branch_slug=release-1.2.3-rc' 'release/1.2.3-rc' 'refs/pull/1/merge'

# --- repository paths -----------------------------------------------
assert_case "owner is lowercased in the app repo" 0 \
  'app_repo=ghcr.io/projekt-manager-org/projekt-manager' 'topic' 'refs/pull/1/merge'
assert_case "backup repo is derived from the same owner" 0 \
  'backup_repo=ghcr.io/projekt-manager-org/projekt-manager-backup' 'topic' 'refs/pull/1/merge'
assert_case "sha tag carries the head SHA" 0 \
  "sha_tag=sha-$SHA" 'topic' 'refs/pull/1/merge'
assert_case "app ref joins repo and sha tag" 0 \
  "app_ref=ghcr.io/projekt-manager-org/projekt-manager:sha-$SHA" 'topic' 'refs/pull/1/merge'

# --- the main guard -------------------------------------------------
assert_case "a branch slugifying to main is refused" 1 \
  '' 'Main' 'refs/pull/1/merge'
assert_case "a branch literally named main is refused off main" 1 \
  '' 'main' 'refs/pull/1/merge'
assert_case "main on refs/heads/main is allowed" 0 \
  'branch_slug=main' 'main' 'refs/heads/main'

# --- required inputs ------------------------------------------------
rc=0
out=$(BRANCH_REF="" HEAD_SHA="$SHA" GITHUB_REPOSITORY_OWNER="X" bash "$SCRIPT" 2>&1) || rc=$?
if [[ "$rc" -eq 2 ]]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  failures+=("empty BRANCH_REF: expected exit 2, got $rc")
fi

echo "image-refs.sh: $pass passed, $fail failed"
if [[ "$fail" -gt 0 ]]; then
  printf '  %s\n' "${failures[@]}" >&2
  exit 1
fi
