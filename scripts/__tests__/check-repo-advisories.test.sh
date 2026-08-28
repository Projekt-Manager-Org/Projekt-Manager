#!/usr/bin/env bash
#
# Scenario tests for scripts/check-repo-advisories.mjs.
#
# The gate talks to the GitHub API, so the cases below stage a fake project
# tree ($PROJECT_ROOT) plus canned API responses ($ADVISORY_FIXTURE_DIR).
# No network, no token.
#
# Two cases carry most of the weight:
#
#   "global record narrows the range" is the regression that shaped the
#   script. Repo-level advisories are written by the publisher and are often
#   coarser than the curated global record. GHSA-gpj5-g38j-94v9 files one
#   `<= 1.0.0-beta.19` range across both drizzle-orm release lines; the
#   global record splits it, and the installed 0.45.2 is the PATCHED release
#   on its line. Judging on the repo-level range alone fails CI on a
#   non-issue, and a gate that cries wolf gets muted.
#
#   "repo-level only, no global record" is the reason the gate exists at
#   all. Nothing else in CI can see that advisory.
#
# Exits 0 when every case matches its expected code; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/check-repo-advisories.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHECK="$REPO_ROOT/scripts/check-repo-advisories.mjs"

if [[ ! -f "$CHECK" ]]; then
  echo "ERROR: $CHECK not found." >&2
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

# A fresh tree per case, so a mutation cannot leak sideways. The default
# tree has one direct dep (drizzle-orm@0.45.2 from drizzle-team/drizzle-orm)
# and an empty allowlist; each case layers fixtures on top.
stage() {
  local d
  d="$(mktemp -d)"
  TMP_DIRS+=("$d")
  mkdir -p "$d/node_modules/drizzle-orm" "$d/fixtures/repos" "$d/fixtures/advisories"

  cat >"$d/package.json" <<'JSON'
{ "name": "fixture", "dependencies": { "drizzle-orm": "^0.45.2" } }
JSON

  cat >"$d/node_modules/drizzle-orm/package.json" <<'JSON'
{
  "name": "drizzle-orm",
  "version": "0.45.2",
  "repository": { "type": "git", "url": "git+https://github.com/drizzle-team/drizzle-orm.git" }
}
JSON

  printf '# empty allowlist\n' >"$d/osv-scanner.toml"
  echo "$d"
}

# A published repo-level advisory naming drizzle-orm. $1 is the vulnerable
# range, $2 (optional) the advisory state.
write_repo_advisory() {
  local dir="$1" range="$2" state="${3:-published}"
  cat >"$dir/fixtures/repos/drizzle-team__drizzle-orm.json" <<JSON
[
  {
    "ghsa_id": "GHSA-gpj5-g38j-94v9",
    "state": "$state",
    "withdrawn_at": null,
    "severity": "high",
    "summary": "Drizzle ORM has SQL injection via improperly escaped SQL identifiers",
    "vulnerabilities": [
      {
        "package": { "ecosystem": "npm", "name": "drizzle-orm" },
        "vulnerable_version_range": "$range",
        "patched_versions": "1.0.0-beta.20"
      }
    ]
  }
]
JSON
}

pass=0
fail=0
failures=()

assert_case() {
  local expected="$1" label="$2" dir="$3"
  local actual
  PROJECT_ROOT="$dir" ADVISORY_FIXTURE_DIR="$dir/fixtures" \
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

echo "Case: no advisories published for the repo"
# Fixture absent => 404 => advisories disabled or none filed. Must not fail.
assert_case 0 "no advisories" "$(stage)"

echo "Case: repo-level only, installed version in range"
# The reason this gate exists. No global record, so the repo-level range is
# the only evidence there is — and it matches.
d="$(stage)"
write_repo_advisory "$d" "<= 1.0.0-beta.19"
assert_case 1 "repo-level only, in range" "$d"

echo "Case: repo-level only, installed version out of range"
d="$(stage)"
write_repo_advisory "$d" "< 0.40.0"
assert_case 0 "repo-level only, out of range" "$d"

echo "Case: global record narrows the range"
# THE regression. The coarse repo-level range says 0.45.2 is affected; the
# curated global record splits the release lines and shows 0.45.2 IS the
# patched version. Global wins, so this must pass.
d="$(stage)"
write_repo_advisory "$d" "<= 1.0.0-beta.19"
cat >"$d/fixtures/advisories/GHSA-gpj5-g38j-94v9.json" <<'JSON'
{
  "ghsa_id": "GHSA-gpj5-g38j-94v9",
  "vulnerabilities": [
    {
      "package": { "ecosystem": "npm", "name": "drizzle-orm" },
      "vulnerable_version_range": "< 0.45.2",
      "first_patched_version": { "identifier": "0.45.2" }
    },
    {
      "package": { "ecosystem": "npm", "name": "drizzle-orm" },
      "vulnerable_version_range": ">= 1.0.0-beta.2, < 1.0.0-beta.20",
      "first_patched_version": { "identifier": "1.0.0-beta.20" }
    }
  ]
}
JSON
assert_case 0 "global record narrows the range" "$d"

echo "Case: global record still matches"
# Same precedence, opposite outcome: when the curated range DOES cover the
# installed version the finding stands. Guards against the narrowing rule
# turning into a blanket exemption for anything with a global record.
d="$(stage)"
write_repo_advisory "$d" "<= 1.0.0-beta.19"
cat >"$d/fixtures/advisories/GHSA-gpj5-g38j-94v9.json" <<'JSON'
{
  "ghsa_id": "GHSA-gpj5-g38j-94v9",
  "vulnerabilities": [
    {
      "package": { "ecosystem": "npm", "name": "drizzle-orm" },
      "vulnerable_version_range": "<= 0.45.2",
      "first_patched_version": { "identifier": "0.45.3" }
    }
  ]
}
JSON
assert_case 1 "global record still matches" "$d"

echo "Case: matching advisory is allowlisted"
d="$(stage)"
write_repo_advisory "$d" "<= 1.0.0-beta.19"
cat >"$d/osv-scanner.toml" <<'TOML'
[[IgnoredVulns]]
id = "GHSA-gpj5-g38j-94v9"
ignoreUntil = 2026-11-26
reason = "@vlzware: fixture entry"
TOML
assert_case 0 "allowlisted" "$d"

echo "Case: allowlist id inside a comment does not count"
# The allowlist scan is deliberately dumb; it must at least not honour a
# commented-out entry, which would silently disable the gate.
d="$(stage)"
write_repo_advisory "$d" "<= 1.0.0-beta.19"
cat >"$d/osv-scanner.toml" <<'TOML'
# [[IgnoredVulns]]
# id = "GHSA-gpj5-g38j-94v9"
TOML
assert_case 1 "commented-out allowlist entry" "$d"

echo "Case: advisory is a draft"
# Drafts are not claims about shipped code.
d="$(stage)"
write_repo_advisory "$d" "<= 1.0.0-beta.19" "draft"
assert_case 0 "draft advisory" "$d"

echo "Case: vulnerable range is not valid semver"
# Reported, not skipped. An unevaluated advisory that passes silently is
# the exact failure this gate was written to remove.
d="$(stage)"
write_repo_advisory "$d" "everything before the rewrite"
assert_case 1 "unparseable range" "$d"

echo "Case: a direct dep is not installed"
# Structural: the check reads versions from the installed tree, so an
# un-run `npm ci` must not read as clean.
d="$(stage)"
rm -rf "$d/node_modules/drizzle-orm"
assert_case 2 "dependency not installed" "$d"

echo ""
echo "passed: $pass   failed: $fail"
if [[ "$fail" -gt 0 ]]; then
  echo ""
  echo "Failures:"
  for f in "${failures[@]}"; do echo "  - $f"; done
  exit 1
fi
exit 0
