#!/usr/bin/env bash
#
# Scenario tests for scripts/ci/gate-base.sh.
#
# The base decides what `lint`'s vulnerability gates call introduced, so a
# wrong base passes a vulnerable change in silence. Each case runs the
# script in a clone of a throwaway bare "origin":
#
#   c0 ── c1 (main) ── M   M = test merge of c1 and c2, as GitHub builds
#    (no    \         /        refs/pull/N/merge
#   lock)    c2 ────┘          c2 = the PR head
#
# The case that carries the weight: "pull_request on a head-SHA checkout" —
# without the two-parent guard the PR's own parent becomes the base, and a
# PR whose first commit adds a vulnerable dep passes.
#
# Exits 0 when every case matches; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/gate-base.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/ci/gate-base.sh"

if [[ ! -f "$SCRIPT" ]]; then
  echo "ERROR: $SCRIPT not found." >&2
  exit 2
fi

TMP="$(mktemp -d)"
# shellcheck disable=SC2317  # invoked via `trap cleanup EXIT`
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export GIT_CONFIG_NOSYSTEM=1 HOME="$TMP"

git init -q --bare -b main "$TMP/origin.git"
# GitHub serves any reachable commit by SHA; a local bare repo needs telling.
git -C "$TMP/origin.git" config uploadpack.allowAnySHA1InWant true
git clone -q "$TMP/origin.git" "$TMP/work" 2>/dev/null
W="$TMP/work"
cd "$W" || exit 2

echo readme >README && git add README && git commit -qm c0
C0="$(git rev-parse HEAD)"
echo '{"base":1}' >package-lock.json
echo '# base toml' >osv-scanner.toml
git add . && git commit -qm c1
C1="$(git rev-parse HEAD)"
git push -q origin main
git switch -qc feature
echo '{"head":1}' >package-lock.json
git commit -qam c2
C2="$(git rev-parse HEAD)"
git switch -q --detach "$C1"
git merge -q --no-ff -m M "$C2"

pass=0
fail=0
failures=()

# $1 label, $2 expected exit, $3 expected `sha=` value (empty: unchecked),
# rest: VAR=value environment for the run.
assert_case() {
  local label="$1" expected="$2" sha="$3"
  shift 3
  local out rc
  rm -rf "$TMP/out"
  out="$(env "$@" bash "$SCRIPT" 2>/dev/null)"
  rc=$?
  if [[ "$rc" != "$expected" ]]; then
    fail=$((fail + 1))
    failures+=("$label: expected exit $expected, got $rc")
  elif [[ -n "$sha" ]] && ! grep -qxF "sha=$sha" <<<"$out"; then
    fail=$((fail + 1))
    failures+=("$label: expected sha=$sha, got: $out")
  else
    pass=$((pass + 1))
    echo "  PASS — $label (exit $rc)"
  fi
}

OUT="OUT_DIR=$TMP/out"

echo "Case: pull_request on the test merge"
assert_case "pull_request" 0 "$C1" EVENT=pull_request PR_HEAD_SHA="$C2" "$OUT"
if [[ "$(cat "$TMP/out/package-lock.json")" == '{"base":1}' && -f "$TMP/out/osv-scanner.toml" && ! -e "$TMP/out/.grype.yaml" ]]; then
  pass=$((pass + 1))
  echo "  PASS — base files written, absent ones skipped"
else
  fail=$((fail + 1))
  failures+=("pull_request: base files not as expected")
fi

echo "Case: pull_request whose second parent is not the PR head"
assert_case "foreign merge" 1 "" EVENT=pull_request PR_HEAD_SHA="$C0" "$OUT"

echo "Case: pull_request on a head-SHA checkout"
git switch -q --detach "$C2"
assert_case "single-parent HEAD" 1 "" EVENT=pull_request PR_HEAD_SHA="$C2" "$OUT"
git switch -q --detach -

echo "Case: push"
assert_case "push" 0 "$C1" EVENT=push PUSH_BEFORE="$C1" "$OUT"

echo "Case: push with an all-zero before"
assert_case "push, zero before" 1 "" EVENT=push PUSH_BEFORE=0000000000000000000000000000000000000000 "$OUT"

echo "Case: merge_group"
assert_case "merge_group" 0 "$C1" EVENT=merge_group MERGE_GROUP_BASE="$C1" "$OUT"

echo "Case: workflow_dispatch judges against the default branch"
assert_case "workflow_dispatch" 0 "$C1" EVENT=workflow_dispatch DEFAULT_BRANCH=main "$OUT"

echo "Case: base without a lockfile"
assert_case "no lockfile at base" 1 "" EVENT=push PUSH_BEFORE="$C0" "$OUT"

echo "Case: base not on origin"
assert_case "unfetchable base" 1 "" EVENT=push PUSH_BEFORE=1111111111111111111111111111111111111111 "$OUT"

echo "Case: unknown event"
assert_case "unknown event" 1 "" EVENT=schedule "$OUT"

echo "Case: missing inputs"
assert_case "no OUT_DIR" 2 "" EVENT=push PUSH_BEFORE="$C1"
assert_case "no PR_HEAD_SHA" 2 "" EVENT=pull_request "$OUT"

echo ""
echo "passed: $pass   failed: $fail"
if [[ "$fail" -gt 0 ]]; then
  echo ""
  echo "Failures:"
  for f in "${failures[@]}"; do echo "  - $f"; done
  exit 1
fi
exit 0
