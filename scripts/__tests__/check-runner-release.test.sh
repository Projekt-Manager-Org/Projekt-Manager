#!/usr/bin/env bash
#
# Scenario tests for scripts/check-runner-release.sh.
#
# Each case stages copies of the REAL docker/host-versions.txt and
# .github/workflows/*.yml in a temp dir, points the check at it via
# $RELEASE_ROOT, and asserts the exit code: 1 for drift, 2 when the check
# finds no host release or no `runs-on:` at all. Plus the grouped move (host
# pins and every runner together), which must pass, or the PR that moves the
# hosts would fail lint.
#
# Exits 0 when every case matches its expected code; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/check-runner-release.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHECK="$REPO_ROOT/scripts/check-runner-release.sh"
PINS=docker/host-versions.txt

for f in "$CHECK" "$REPO_ROOT/$PINS"; do
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
  local d
  d="$(mktemp -d)"
  TMP_DIRS+=("$d")
  mkdir -p "$d/docker" "$d/.github/workflows"
  cp "$REPO_ROOT/$PINS" "$d/$PINS"
  cp "$REPO_ROOT"/.github/workflows/*.yml "$d/.github/workflows/"
  echo "$d"
}

pass=0
fail=0
failures=()

# Optional 4th argument: a pattern stderr must contain, for cases whose
# exit code alone could come from another branch of the check.
assert_case() {
  local expected="$1" label="$2" dir="$3" pattern="${4:-}"
  local actual err
  err="$(RELEASE_ROOT="$dir" bash "$CHECK" 2>&1 >/dev/null)"
  actual=$?
  if [[ "$actual" == "$expected" && ( -z "$pattern" || "$err" == *"$pattern"* ) ]]; then
    pass=$((pass + 1))
    echo "  PASS — $label (exit $actual)"
  else
    fail=$((fail + 1))
    failures+=("$label: expected $expected${pattern:+ and '$pattern'}, got $actual")
    echo "  FAIL — $label (expected $expected${pattern:+ and '$pattern'}, got $actual)"
  fi
}

# The release the real pins encode, e.g. 24.04 from `~ubuntu.24.04~noble`.
REL="$(sed -nE 's/.*~ubuntu\.([0-9]+\.[0-9]+)~.*/\1/p' "$REPO_ROOT/$PINS" | head -n1)"
OTHER="99.04"

echo "Case: the real pins and workflows agree"
assert_case 0 "real files" "$(stage)"

echo "Case: one job back on ubuntu-latest"
d="$(stage)"
sed -i "0,/runs-on: ubuntu-$REL/s//runs-on: ubuntu-latest/" "$d/.github/workflows/ci.yml"
assert_case 1 "ubuntu-latest" "$d"

echo "Case: one job on another release"
d="$(stage)"
sed -i "0,/runs-on: ubuntu-$REL/s//runs-on: ubuntu-$OTHER/" "$d/.github/workflows/e2e.yml"
assert_case 1 "runner on another release" "$d"

echo "Case: a runner the check cannot read (expression)"
d="$(stage)"
sed -i "0,/runs-on: ubuntu-$REL/s//runs-on: \${{ matrix.os }}/" "$d/.github/workflows/ci.yml"
assert_case 1 "expression runner" "$d"

echo "Case: quoted key"
d="$(stage)"
sed -i "0,/runs-on: ubuntu-$REL/s//\"runs-on\": ubuntu-latest/" "$d/.github/workflows/ci.yml"
assert_case 1 "quoted key" "$d"

echo "Case: space before the colon"
d="$(stage)"
sed -i "0,/runs-on: ubuntu-$REL/s//runs-on : ubuntu-latest/" "$d/.github/workflows/e2e.yml"
assert_case 1 "space before colon" "$d"

echo "Case: a commented-out runs-on is not a runner"
d="$(stage)"
sed -i "0,/runs-on: ubuntu-$REL/s//&\n    # runs-on: ubuntu-latest/" "$d/.github/workflows/ci.yml"
assert_case 0 "commented runs-on" "$d"

echo "Case: quoted label with a trailing comment"
d="$(stage)"
sed -i "0,/runs-on: ubuntu-$REL/s//runs-on: 'ubuntu-$REL' # pinned/" "$d/.github/workflows/ci.yml"
assert_case 0 "quoted + comment" "$d"

echo "Case: host pins moved alone"
d="$(stage)"
sed -i "s/~ubuntu\.$REL~/~ubuntu.$OTHER~/" "$d/$PINS"
assert_case 1 "host pins drift" "$d"

echo "Case: host pins disagree among themselves"
d="$(stage)"
sed -i "0,/~ubuntu\.$REL~/s//~ubuntu.$OTHER~/" "$d/$PINS"
assert_case 1 "mixed host pins" "$d" "mixes Ubuntu releases"

echo "Case: host pins name no Ubuntu release"
# Presence: a pin format the pattern stops matching must not pass.
d="$(stage)"
sed -i "s/~ubuntu\.$REL~[a-z]*//" "$d/$PINS"
assert_case 2 "no release in pins" "$d"

echo "Case: no runs-on anywhere"
d="$(stage)"
sed -i '/runs-on:/d' "$d"/.github/workflows/*.yml
assert_case 2 "no runs-on" "$d"

echo "Case: hosts and every runner moved together (the upgrade PR)"
d="$(stage)"
sed -i "s/~ubuntu\.$REL~/~ubuntu.$OTHER~/" "$d/$PINS"
sed -i "s/runs-on: ubuntu-$REL/runs-on: ubuntu-$OTHER/" "$d"/.github/workflows/*.yml
assert_case 0 "grouped move" "$d"

echo
echo "Results: $pass passed, $fail failed"
if [[ "$fail" -gt 0 ]]; then
  printf '%s\n' "${failures[@]}" >&2
  exit 1
fi
exit 0
