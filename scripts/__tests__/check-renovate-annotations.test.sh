#!/usr/bin/env bash
#
# Scenario tests for scripts/check-renovate-annotations.mjs.
#
# A drift check that cannot fail is worse than no check: it reports green
# forever and everyone stops reading it. Each case below stages copies of
# the REAL workflows and the REAL renovate.json in a temp dir, points the
# check at them via $WORKFLOW_DIR / $RENOVATE_CONFIG, and asserts the exit
# code.
#
# The first failing case is the regression that motivated the check: the
# ripgrep pin shipped with two explanatory comments between its annotation
# and `version=`, which the customManager's `\s+` join does not tolerate.
# Renovate reports nothing when it fails to match an annotation, so that
# pin was untracked and CI stayed green.
#
# The must-pass cases matter just as much: a check that fires on prose
# placed correctly would get muted the first time someone documents a pin.
#
# Exits 0 when every case matches its expected code; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/check-renovate-annotations.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHECK="$REPO_ROOT/scripts/check-renovate-annotations.mjs"
REAL_WORKFLOWS="$REPO_ROOT/.github/workflows"
REAL_CONFIG="$REPO_ROOT/.github/renovate.json"

for f in "$CHECK" "$REAL_CONFIG"; do
  if [[ ! -f "$f" ]]; then
    echo "ERROR: $f not found." >&2
    exit 2
  fi
done
if [[ ! -d "$REAL_WORKFLOWS" ]]; then
  echo "ERROR: $REAL_WORKFLOWS not found." >&2
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

# A fresh copy per case, so a mutation cannot leak sideways.
stage() {
  local d
  d="$(mktemp -d)"
  TMP_DIRS+=("$d")
  mkdir -p "$d/workflows"
  cp "$REAL_WORKFLOWS"/*.yml "$d/workflows/" 2>/dev/null
  cp "$REAL_CONFIG" "$d/renovate.json"
  echo "$d"
}

pass=0
fail=0
failures=()

assert_case() {
  local expected="$1" label="$2" dir="$3"
  local actual
  WORKFLOW_DIR="$dir/workflows" RENOVATE_CONFIG="$dir/renovate.json" \
    node "$CHECK" >/dev/null 2>&1
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

# Guard against a staging typo silently making every case vacuous.
assert_mutated() {
  local dir="$1" file="$2" label="$3"
  if diff -q "$REAL_WORKFLOWS/$file" "$dir/workflows/$file" >/dev/null 2>&1; then
    fail=$((fail + 1))
    failures+=("$label: staging produced no change — the case proves nothing")
    echo "  FAIL — $label (staging did not mutate $file)"
    return 1
  fi
  return 0
}

echo "Case: the real workflows are tracked"
assert_case 0 "in-sync annotations" "$(stage)"

echo "Case: a comment interposed between the annotation and version="
# THE regression. Renovate silently stops seeing the pin.
d="$(stage)"
sed -i 's|^          # renovate: datasource=github-release-attachments depName=BurntSushi/ripgrep$|          # renovate: datasource=github-release-attachments depName=BurntSushi/ripgrep\n          # An explanatory note in exactly the wrong place.|' "$d/workflows/ci.yml"
assert_mutated "$d" ci.yml "interposed comment" && assert_case 1 "interposed comment" "$d"

echo "Case: prose placed ABOVE the annotation"
# Must pass — this is the correct way to document a pin, and the fix the
# check's error message tells you to apply.
d="$(stage)"
sed -i 's|^          # renovate: datasource=github-release-attachments depName=BurntSushi/ripgrep$|          # An explanatory note in the right place.\n          # renovate: datasource=github-release-attachments depName=BurntSushi/ripgrep|' "$d/workflows/ci.yml"
assert_mutated "$d" ci.yml "prose above annotation" && assert_case 0 "prose above annotation" "$d"

echo "Case: the annotation is missing entirely"
# A pin added with no update path at all — the plainest form of the
# failure ADR-0027 exists to retire.
d="$(stage)"
sed -i '/^          # renovate: datasource=github-release-attachments depName=FiloSottile\/age$/d' "$d/workflows/e2e.yml"
assert_mutated "$d" e2e.yml "missing annotation" && assert_case 1 "missing annotation" "$d"

echo "Case: the datasource is misspelled"
# Shape-based detection, not datasource-string matching: a typo that stops
# the regex matching must fail even though an annotation is present.
d="$(stage)"
sed -i 's|datasource=github-release-attachments depName=rhysd/actionlint|datasource=github-release-attachment depName=rhysd/actionlint|' "$d/workflows/ci.yml"
assert_mutated "$d" ci.yml "misspelled datasource" && assert_case 1 "misspelled datasource" "$d"

echo "Case: the version is hardcoded a second time in the URL"
# Renovate rewrites only the span its regex matched. A second literal use
# survives the bump, so the step fetches the old asset and fails the
# checksum compare on the next release.
d="$(stage)"
sed -i 's|url="https://github.com/FiloSottile/age/releases/download/${version}/age-${version}-linux-amd64.tar.gz"|url="https://github.com/FiloSottile/age/releases/download/v1.3.1/age-${version}-linux-amd64.tar.gz"|' "$d/workflows/e2e.yml"
assert_mutated "$d" e2e.yml "hardcoded version in URL" && assert_case 1 "hardcoded version in URL" "$d"

echo "Case: a comment inside the step names the version"
# Must pass — the mirror of the case above. Renovate rewrites only the
# `version=` span, but a comment that names the version is prose, not a
# fetch: leaving it stale is a docs nit, and failing on it would make the
# rule unsatisfiable short of rewording the comment. The version is read
# out of the file so this case survives the next bump.
d="$(stage)"
ver="$(sed -n 's|^ *version="\([^"]*\)".*|\1|p' "$d/workflows/e2e.yml" | head -1)"
sed -i "s|^\( *expected_sha=\"[a-f0-9]\{64\}\"\)$|\1\n          # Note: $ver is the first release carrying a Sigsum proof asset.|" \
  "$d/workflows/e2e.yml"
assert_mutated "$d" e2e.yml "version named in a comment" && assert_case 0 "version named in a comment" "$d"

echo "Case: the customManager is gone from renovate.json"
# Structural, not drift. Every pin in every workflow is untracked; the
# check must say so rather than compare against an empty manager list and
# report "in sync".
d="$(stage)"
node -e '
  const fs = require("fs");
  const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  c.customManagers = (c.customManagers ?? []).filter(
    (m) => !(m.matchStrings ?? []).some((s) => s.includes("(?<currentDigest>")),
  );
  fs.writeFileSync(process.argv[1], JSON.stringify(c, null, 2));
' "$d/renovate.json"
assert_case 2 "no digest-capturing manager" "$d"

echo "Case: renovate.json is unreadable"
d="$(stage)"
echo 'not json {' > "$d/renovate.json"
assert_case 2 "malformed renovate.json" "$d"

echo
echo "Results: $pass passed, $fail failed"
if [[ "$fail" -gt 0 ]]; then
  printf '%s\n' "${failures[@]}" >&2
  exit 1
fi
exit 0
