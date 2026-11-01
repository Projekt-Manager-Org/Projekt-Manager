#!/usr/bin/env bash
#
# Scenario tests for scripts/check-node-pin.sh.
#
# Each case stages copies of the REAL pin files (.nvmrc, package.json, both
# Dockerfiles) in a temp dir, points the check at it via $PIN_ROOT, and
# asserts the exit code: 1 for drift, 2 for a pin the check cannot find.
# One drift case per pin location, so a location the check stops reading
# turns a case red; plus the grouped bump, which must pass, or every
# Renovate Node PR would fail lint.
#
# Exits 0 when every case matches its expected code; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/check-node-pin.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHECK="$REPO_ROOT/scripts/check-node-pin.sh"
FILES=(.nvmrc package.json Dockerfile Dockerfile.backup)

for f in "$CHECK" "${FILES[@]/#/$REPO_ROOT/}"; do
  if [[ ! -f "$f" ]]; then
    echo "ERROR: $f not found." >&2
    exit 2
  fi
done

TMP_DIRS=()
# shellcheck disable=SC2317  # invoked via `trap cleanup EXIT`
cleanup() {
  local d
  for d in "${TMP_DIRS[@]:-}"; do
    [[ -n "${d:-}" && -d "$d" ]] && rm -rf "$d"
  done
}
trap cleanup EXIT

# A fresh set of copies per case, so a mutation cannot leak sideways.
stage() {
  local d f
  d="$(mktemp -d)"
  TMP_DIRS+=("$d")
  for f in "${FILES[@]}"; do cp "$REPO_ROOT/$f" "$d/$f"; done
  echo "$d"
}

pass=0
fail=0
failures=()

assert_case() {
  local expected="$1" label="$2" dir="$3"
  local actual
  PIN_ROOT="$dir" bash "$CHECK" >/dev/null 2>&1
  actual=$?
  if [[ "$actual" == "$expected" ]]; then
    pass=$((pass + 1))
    echo "  PASS — $label (exit $actual)"
  else
    fail=$((fail + 1))
    failures+=("$label: expected $expected, got $actual")
    echo "  FAIL — $label (expected $expected, got $actual)"
  fi
}

PIN="$(tr -d '[:space:]' <"$REPO_ROOT/.nvmrc")"
OTHER="99.0.0"

echo "Case: the real pin files agree"
assert_case 0 "real files" "$(stage)"

echo "Case: .nvmrc bumped alone"
d="$(stage)"
echo "$OTHER" >"$d/.nvmrc"
assert_case 1 ".nvmrc drift" "$d"

echo "Case: devEngines bumped alone"
d="$(stage)"
sed -i "s/\"version\": \"$PIN\"/\"version\": \"$OTHER\"/" "$d/package.json"
assert_case 1 "devEngines drift" "$d"

echo "Case: devEngines.runtime removed"
d="$(stage)"
node -e '
  const f = process.argv[1], pj = require(f);
  delete pj.devEngines;
  require("fs").writeFileSync(f, JSON.stringify(pj, null, 2));
' "$d/package.json"
assert_case 2 "devEngines missing" "$d"

# One case per stage: a check reading only the first or only the last
# `FROM node:` would pass one of them.
echo "Case: only the build stage of Dockerfile bumped"
d="$(stage)"
sed -i "/AS build/s/node:$PIN-/node:$OTHER-/" "$d/Dockerfile"
assert_case 1 "Dockerfile build-stage drift" "$d"

echo "Case: only the runtime stage of Dockerfile bumped"
d="$(stage)"
sed -i "/AS runtime/s/node:$PIN-/node:$OTHER-/" "$d/Dockerfile"
assert_case 1 "Dockerfile runtime-stage drift" "$d"

echo "Case: Dockerfile.backup bumped alone"
d="$(stage)"
sed -i "s/node:$PIN-/node:$OTHER-/" "$d/Dockerfile.backup"
assert_case 1 "Dockerfile.backup drift" "$d"

echo "Case: Dockerfile no longer names a node image"
# Presence: a FROM the pattern stops matching must not pass as "no drift".
d="$(stage)"
sed -i "s|FROM node:|FROM docker.io/library/node:|" "$d/Dockerfile"
assert_case 2 "no node FROM in Dockerfile" "$d"

echo "Case: all pins bumped together (Renovate's grouped Node PR)"
d="$(stage)"
echo "$OTHER" >"$d/.nvmrc"
sed -i "s/\"version\": \"$PIN\"/\"version\": \"$OTHER\"/" "$d/package.json"
sed -i "s/node:$PIN-/node:$OTHER-/" "$d/Dockerfile" "$d/Dockerfile.backup"
assert_case 0 "grouped bump" "$d"

echo
echo "Results: $pass passed, $fail failed"
if [[ "$fail" -gt 0 ]]; then
  printf '%s\n' "${failures[@]}" >&2
  exit 1
fi
exit 0
