#!/usr/bin/env bash
#
# Scenario tests for scripts/generate-openapi.ts --check (AC-351).
#
# Unlike the permissions-doc check (markers inside a hand-authored file),
# docs/api/openapi.json is entirely generated, so "drift" means the whole
# file differs from a fresh generation. Each case points the generator at
# a fixture path via $OPENAPI_DOC_PATH; the route schemas themselves are
# always read from the real src/server/routes/ — that's the source of
# truth the check protects, not something to fake. Exits 0 when every
# case matches its expected exit code; 1 otherwise.
#
# $OPENAPI_DOC_PATH redirects the destination only — Prettier's config is
# resolved from the canonical in-repo path regardless, which is what makes
# a fixture in `mktemp -d` byte-identical to the published artifact. Why
# that matters: the $OPENAPI_DOC_PATH note in the generator's header.
#
# Usage:
#   bash scripts/__tests__/check-openapi-doc.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GENERATOR="$REPO_ROOT/scripts/generate-openapi.ts"

if [[ ! -f "$GENERATOR" ]]; then
  echo "ERROR: $GENERATOR not found." >&2
  exit 2
fi

TMP_DIRS=()
# shellcheck disable=SC2317  # invoked via `trap cleanup EXIT`
cleanup() {
  local d
  for d in "${TMP_DIRS[@]:-}"; do
    [[ -n "${d:-}" && -d "$d" ]] && rm -rf "$d"
  done
}
trap cleanup EXIT

mktmp_dir() {
  local d
  d="$(mktemp -d)"
  TMP_DIRS+=("$d")
  echo "$d"
}

pass=0
fail=0
failures=()

# Set INJECT_INVALID=1 or INJECT_ORPHAN=1 before a call to corrupt the
# generated document inside the generator; both cleared after each case.
assert_case() {
  local expected="$1" label="$2" doc="$3"
  local actual
  (
    cd "$REPO_ROOT" || exit 2
    [[ -n "${INJECT_INVALID:-}" ]] && export OPENAPI_INJECT_INVALID=1
    [[ -n "${INJECT_ORPHAN:-}" ]] && export OPENAPI_INJECT_ORPHAN_OPERATION=1
    [[ -n "${INJECT_DROP:-}" ]] && export OPENAPI_INJECT_DROP_OPERATION=1
    OPENAPI_DOC_PATH="$doc" npx --no-install tsx "$GENERATOR" --check
  ) >/dev/null 2>&1
  actual=$?
  unset INJECT_INVALID INJECT_ORPHAN INJECT_DROP
  if [[ "$actual" == "$expected" ]]; then
    pass=$((pass + 1))
    echo "  PASS — $label (exit $actual)"
  else
    fail=$((fail + 1))
    failures+=("$label: expected $expected, got $actual")
    echo "  FAIL — $label (expected $expected, got $actual)"
  fi
}

echo "Case: freshly generated doc passes --check"
in_sync_dir="$(mktmp_dir)"
in_sync="$in_sync_dir/openapi.json"
(cd "$REPO_ROOT" && OPENAPI_DOC_PATH="$in_sync" npx --no-install tsx "$GENERATOR") >/dev/null 2>&1
if [[ ! -f "$in_sync" ]]; then
  echo "ERROR: generator did not produce $in_sync — cannot continue." >&2
  exit 2
fi
assert_case 0 "in-sync doc" "$in_sync"

echo "Case: hand-edited doc fails --check"
drifted_dir="$(mktmp_dir)"
drifted="$drifted_dir/openapi.json"
cp "$in_sync" "$drifted"
# The check compares the whole file, so any byte-level difference is
# equivalent evidence — the cheapest stable anchor wins, and info.title
# is the one string guaranteed present regardless of which routes exist.
# It is not a stand-in for a route-schema edit; whole-file comparison is
# what makes the two indistinguishable here.
sed -i 's/"Projekt-Manager API"/"Hand-Edited API"/' "$drifted"
assert_case 1 "drifted doc" "$drifted"

echo "Case: missing target fails with a toolchain error, not a false pass"
missing_dir="$(mktmp_dir)"
missing="$missing_dir/does-not-exist.json"
assert_case 2 "missing target" "$missing"

echo "Case: a structurally invalid document fails the validity gate"
# The drift check alone would stay green on an invalid document — it only
# compares generated against committed, and both sides would be equally
# wrong. $OPENAPI_INJECT_INVALID drops `info` from the generated document
# so the 3.1 schema rejects it. Without that seam the gate is
# unfalsifiable: the document is built from the real routes and is always
# valid, so a broken or silently-removed validator would look exactly
# like a working one.
#
# Expects 2 (toolchain error), not 1 (drift): the target file is
# byte-identical to what a clean run produces, so a pass here would mean
# the validator never ran.
invalid_dir="$(mktmp_dir)"
invalid="$invalid_dir/openapi.json"
cp "$in_sync" "$invalid"
INJECT_INVALID=1
assert_case 2 "invalid document" "$invalid"

echo "Case: an operation with no backing route fails the security-coverage gate"
# AC-353's derivation is total: every published operation must trace back
# to a route the factory registered, or the generator cannot know whether
# a session is required and would publish it carrying no requirement at
# all — a protected endpoint advertised as public. That is the fail-open
# direction, so it exits 2 instead.
#
# $OPENAPI_INJECT_ORPHAN_OPERATION adds a path no route backs. Same
# argument as the invalid-document seam above: every operation in a real
# run matches by construction, so without the seam a deleted or
# short-circuited guard would look exactly like a working one.
orphan_dir="$(mktmp_dir)"
orphan="$orphan_dir/openapi.json"
cp "$in_sync" "$orphan"
INJECT_ORPHAN=1
assert_case 2 "orphaned operation" "$orphan"

echo "Case: a registered route missing from the document fails the coverage gate"
# The mirror of the case above, and the one AC-351 asserted without
# enforcing: a route the factory registered that never reaches the
# document. That is how `HEAD /api/import-jobs/:id/archive` went missing
# — @fastify/swagger drops HEAD routes unless the route opts in, and
# nothing was checking. Automatic HEAD companions and routes carrying
# `schema: { hide: true }` are excluded structurally, not by name.
dropped_dir="$(mktmp_dir)"
dropped="$dropped_dir/openapi.json"
cp "$in_sync" "$dropped"
INJECT_DROP=1
assert_case 2 "unpublished route" "$dropped"

echo
echo "Results: $pass passed, $fail failed"
if [[ "$fail" -gt 0 ]]; then
  printf '%s\n' "${failures[@]}" >&2
  exit 1
fi
exit 0
