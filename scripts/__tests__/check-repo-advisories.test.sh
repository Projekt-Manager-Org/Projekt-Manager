#!/usr/bin/env bash
#
# Scenario tests for scripts/check-repo-advisories.mjs.
#
# The gate talks to the GitHub API, so the cases below stage a fake project
# tree ($PROJECT_ROOT) plus canned API responses ($ADVISORY_FIXTURE_DIR).
# No network, no token.
#
# Fixtures reproduce the REAL response shapes, verified against live calls
# to /repos/{owner}/{repo}/security-advisories and /advisories/{ghsa}:
#
#   repo-level    vulnerabilities[].patched_versions        string
#   global        vulnerabilities[].first_patched_version   string (NOT an
#                 object — the `{ identifier }` form is the Dependabot
#                 alerts API, which this script never calls)
#
# An invented fixture shape proves the code handles input the API does not
# produce, which is worse than no test. Both shapes above were previously
# wrong here and hid a live bug.
#
# Three cases carry most of the weight:
#
#   "global record narrows the range" is the regression that shaped the
#   script. GHSA-gpj5-g38j-94v9 splits drizzle-orm's two release lines in
#   BOTH records, but only the global one bounds them below. The
#   repo-level `<= 1.0.0-beta.19` is unbounded, so under semver it also
#   covers 0.45.2 — which is the patched release on its own line. Judging
#   on the repo-level range alone fails CI on a non-issue, and a gate that
#   cries wolf gets muted.
#
#   "repo-level only, split release lines" is the same shape with the
#   global record absent. The false positive stands, deliberately: the
#   only safe alternative is guessing a lower bound the publisher did not
#   write. Asserted here so the behaviour is a decision, not a surprise.
#
#   "repo-level only, no global record" is the reason the gate exists at
#   all. Nothing else in CI can see that advisory.
#
# Exits 0 when every case matches its expectation; 1 otherwise.
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

# Add a direct dep. $4 is the raw JSON value of the manifest's `repository`
# field, so npm's shorthand forms can be exercised as written.
add_dep() {
  local dir="$1" name="$2" version="$3" repository="$4"
  mkdir -p "$dir/node_modules/$name"
  cat >"$dir/node_modules/$name/package.json" <<JSON
{ "name": "$name", "version": "$version", "repository": $repository }
JSON
  node -e '
    const fs = require("fs");
    const [file, name, version] = process.argv.slice(1);
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    pkg.dependencies[name] = "^" + version;
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2));
  ' "$dir/package.json" "$name" "$version"
}

# One `vulnerabilities[]` entry in repo-level shape.
repo_vuln() {
  printf '{"package":{"ecosystem":"npm","name":"%s"},"vulnerable_version_range":"%s","patched_versions":"%s"}' \
    "${3:-drizzle-orm}" "$1" "${2:-}"
}

# A published repo-level advisory. $2 is the JSON array of `vulnerabilities`
# entries; $3 the state; $4 the repo fixture basename; $5 the ghsa id.
write_repo_advisory() {
  local dir="$1" vulns="$2" state="${3:-published}"
  local base="${4:-drizzle-team__drizzle-orm}" ghsa="${5:-GHSA-gpj5-g38j-94v9}"
  cat >"$dir/fixtures/repos/$base.json" <<JSON
[
  {
    "ghsa_id": "$ghsa",
    "state": "$state",
    "withdrawn_at": null,
    "severity": "high",
    "summary": "Drizzle ORM has SQL injection via improperly escaped SQL identifiers",
    "vulnerabilities": [$vulns]
  }
]
JSON
}

# The advisory exactly as /repos/drizzle-team/drizzle-orm/security-advisories
# returns it: two entries, one per release line, both unbounded below.
REAL_REPO_VULNS="$(repo_vuln '<= 0.45.1' '0.45.2'),$(repo_vuln '<= 1.0.0-beta.19' '1.0.0-beta.20')"

pass=0
fail=0
failures=()

record() {
  local ok="$1" label="$2" detail="$3"
  if [[ "$ok" == "yes" ]]; then
    pass=$((pass + 1))
    echo "  PASS — $label"
  else
    fail=$((fail + 1))
    failures+=("$label: $detail")
    echo "  FAIL — $label ($detail)"
  fi
}

run_check() {
  PROJECT_ROOT="$1" ADVISORY_FIXTURE_DIR="$1/fixtures" node "$CHECK" 2>&1
}

assert_case() {
  local expected="$1" label="$2" dir="$3"
  local actual
  run_check "$dir" >/dev/null
  actual=$?
  if [[ "$actual" == "$expected" ]]; then
    record yes "$label (exit $actual)" ""
  else
    record no "$label" "expected exit $expected, got $actual"
  fi
}

# Exit code AND a substring of the combined output. Used where the code
# alone cannot tell "did not match" apart from "was never checked".
assert_output() {
  local expected="$1" label="$2" dir="$3" pattern="$4"
  local out actual
  out="$(run_check "$dir")"
  actual=$?
  if [[ "$actual" != "$expected" ]]; then
    record no "$label" "expected exit $expected, got $actual"
  elif ! grep -qF -- "$pattern" <<<"$out"; then
    record no "$label" "output missing '$pattern'"
  else
    record yes "$label (exit $actual, matched '$pattern')" ""
  fi
}

echo "Case: no advisories published for the repo"
# Fixture absent => 404 => advisories disabled or none filed. Must not fail.
assert_case 0 "no advisories" "$(stage)"

echo "Case: repo-level only, installed version in range"
# The reason this gate exists. No global record, so the repo-level range is
# the only evidence there is — and it matches.
d="$(stage)"
write_repo_advisory "$d" "$(repo_vuln '<= 1.0.0-beta.19' '1.0.0-beta.20')"
assert_output 1 "repo-level only, in range" "$d" "REPO-LEVEL ONLY"

echo "Case: repo-level only, installed version out of range"
d="$(stage)"
write_repo_advisory "$d" "$(repo_vuln '< 0.40.0' '0.40.0')"
assert_case 0 "repo-level only, out of range" "$d"

echo "Case: global record narrows the range"
# THE regression, in the real shape. Both records split the release lines;
# only the global one bounds the 1.x range below, and that lower bound is
# what shows 0.45.2 is the patched release on its own line. Global wins, so
# this must pass — and must say the repo-level range still matched.
d="$(stage)"
write_repo_advisory "$d" "$REAL_REPO_VULNS"
cat >"$d/fixtures/advisories/GHSA-gpj5-g38j-94v9.json" <<'JSON'
{
  "ghsa_id": "GHSA-gpj5-g38j-94v9",
  "vulnerabilities": [
    {
      "package": { "ecosystem": "npm", "name": "drizzle-orm" },
      "vulnerable_version_range": "< 0.45.2",
      "first_patched_version": "0.45.2"
    },
    {
      "package": { "ecosystem": "npm", "name": "drizzle-orm" },
      "vulnerable_version_range": ">= 1.0.0-beta.2, < 1.0.0-beta.20",
      "first_patched_version": "1.0.0-beta.20"
    }
  ]
}
JSON
assert_output 0 "global record narrows the range" "$d" "cleared by the global DB"

echo "Case: global record still matches"
# Same precedence, opposite outcome: when the curated range DOES cover the
# installed version the finding stands. Guards against the narrowing rule
# turning into a blanket exemption for anything with a global record. The
# patched version must survive into the report — `first_patched_version` is
# a bare string, and reading `.identifier` off it silently dropped the most
# actionable line of the finding.
d="$(stage)"
write_repo_advisory "$d" "$REAL_REPO_VULNS"
cat >"$d/fixtures/advisories/GHSA-gpj5-g38j-94v9.json" <<'JSON'
{
  "ghsa_id": "GHSA-gpj5-g38j-94v9",
  "vulnerabilities": [
    {
      "package": { "ecosystem": "npm", "name": "drizzle-orm" },
      "vulnerable_version_range": "<= 0.45.2",
      "first_patched_version": "0.45.3"
    }
  ]
}
JSON
assert_output 1 "global record still matches" "$d" "patched: 0.45.3"

echo "Case: global record carries a null vulnerable range"
# GitHub types the GLOBAL `vulnerable_version_range` as string-or-null, same
# as the repo-level one. Mapping a null straight into the range list threw
# out of the top level, so a structural failure exited 1 — the code this
# script reserves for "a matching advisory" — printing a stack trace and no
# finding. Null entries drop out, so the publisher's range is what judges.
d="$(stage)"
write_repo_advisory "$d" "$(repo_vuln '<= 1.0.0-beta.19' '1.0.0-beta.20')"
cat >"$d/fixtures/advisories/GHSA-gpj5-g38j-94v9.json" <<'JSON'
{
  "ghsa_id": "GHSA-gpj5-g38j-94v9",
  "vulnerabilities": [
    {
      "package": { "ecosystem": "npm", "name": "drizzle-orm" },
      "vulnerable_version_range": null,
      "first_patched_version": null
    }
  ]
}
JSON
assert_output 1 "null global vulnerable range" "$d" "range from: repo-level advisory"

echo "Case: advisory for an installed dep is filed on a sibling repo"
# Orgs that publish one package per repo still file some advisories centrally.
# Requiring the filing repo to BE the package's own repo discarded those in
# silence and printed OK — a false negative in the gate whose subject is
# false negatives. The link must point at the repo that holds the advisory,
# not at the package's own repo, or triage lands on a 404.
d="$(stage)"
add_dep "$d" "fastify" "5.12.0" '"fastify/fastify"'
add_dep "$d" "@fastify/rate-limit" "10.0.0" '"fastify/fastify-rate-limit"'
write_repo_advisory "$d" "$(repo_vuln '<= 10.0.0' '10.0.1' '@fastify/rate-limit')" \
  published "fastify__fastify" "GHSA-sibl-ing0-0000"
assert_output 1 "advisory filed on a sibling repo" "$d" \
  "https://github.com/fastify/fastify/security/advisories/GHSA-sibl-ing0-0000"

echo "Case: repo-level only, split release lines"
# Documented false positive. Same two-entry advisory, no global record to
# supply the lower bound, so `<= 1.0.0-beta.19` matches the patched 0.45.2.
# Auto-narrowing it would mean inventing a bound the publisher did not
# write — wrong in the false-NEGATIVE direction. Reds loudly instead, and
# says why, so triage is fast.
d="$(stage)"
write_repo_advisory "$d" "$REAL_REPO_VULNS"
assert_output 1 "repo-level only, split lines" "$d" "files 2 ranges for drizzle-orm"

echo "Case: npm shorthand repository forms resolve to GitHub"
# `owner/repo` and `github:owner/repo` are npm's documented shorthands and
# carry no host. Matching only the literal `github.com` dropped six direct
# deps — including tsx and eslint — into "NOT CHECKED" with no advisory
# lookup at all. Exit code alone cannot distinguish that from a clean run,
# so this asserts the finding itself.
d="$(stage)"
add_dep "$d" "eslint" "9.0.0" '"eslint/eslint"'
add_dep "$d" "patch-package" "8.0.0" '"github:ds300/patch-package"'
write_repo_advisory "$d" "$(repo_vuln '<= 9.0.0' '9.0.1' 'eslint')" published "eslint__eslint" "GHSA-eeee-eeee-eeee"
write_repo_advisory "$d" "$(repo_vuln '<= 8.0.0' '8.0.1' 'patch-package')" published "ds300__patch-package" "GHSA-pppp-pppp-pppp"
assert_output 1 "npm shorthand repository forms" "$d" "GHSA-pppp-pppp-pppp"

echo "Case: non-GitHub shorthand is a reported gap, not a GitHub lookup"
# `gitlab:`/`bitbucket:` shorthands and non-GitHub URLs must not be coerced
# into a slug. They belong in NOT CHECKED.
d="$(stage)"
add_dep "$d" "elsewhere" "1.0.0" '"gitlab:group/elsewhere"'
add_dep "$d" "selfhosted" "1.0.0" '{ "url": "git+https://git.example.com/team/selfhosted.git" }'
assert_output 0 "non-GitHub repositories" "$d" "NOT CHECKED — no GitHub repository (2)"

echo "Case: advisory listing spans more than one page"
# `per_page=100` with no pagination silently truncates at 100, and a
# truncated listing prints the same OK as a complete one. The match is
# parked on page 2 so only a paginating reader finds it.
d="$(stage)"
node -e '
  const fs = require("fs");
  const [dir] = process.argv.slice(1);
  const filler = Array.from({ length: 100 }, (_, i) => ({
    ghsa_id: `GHSA-fill-0000-${String(i).padStart(4, "0")}`,
    state: "published",
    withdrawn_at: null,
    severity: "low",
    summary: "unrelated sibling package",
    vulnerabilities: [
      {
        package: { ecosystem: "npm", name: "drizzle-kit" },
        vulnerable_version_range: "< 0.1.0",
        patched_versions: "0.1.0",
      },
    ],
  }));
  fs.writeFileSync(`${dir}/fixtures/repos/drizzle-team__drizzle-orm.json`, JSON.stringify(filler));
  fs.writeFileSync(
    `${dir}/fixtures/repos/drizzle-team__drizzle-orm.p2.json`,
    JSON.stringify([
      {
        ghsa_id: "GHSA-page-two0-0000",
        state: "published",
        withdrawn_at: null,
        severity: "high",
        summary: "only reachable by following pagination",
        vulnerabilities: [
          {
            package: { ecosystem: "npm", name: "drizzle-orm" },
            vulnerable_version_range: "<= 0.45.2",
            patched_versions: "0.45.3",
          },
        ],
      },
    ]),
  );
' "$d"
assert_output 1 "paginated advisory listing" "$d" "GHSA-page-two0-0000"

echo "Case: advisories endpoint returns a non-list body"
# A 200 that is not an array used to be skipped in silence. It is a
# structural failure — the listing was not read.
d="$(stage)"
printf '{ "message": "Moved Permanently" }\n' >"$d/fixtures/repos/drizzle-team__drizzle-orm.json"
assert_case 2 "non-list listing body" "$d"

echo "Case: matching advisory is allowlisted"
d="$(stage)"
write_repo_advisory "$d" "$(repo_vuln '<= 1.0.0-beta.19' '1.0.0-beta.20')"
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
write_repo_advisory "$d" "$(repo_vuln '<= 1.0.0-beta.19' '1.0.0-beta.20')"
cat >"$d/osv-scanner.toml" <<'TOML'
# [[IgnoredVulns]]
# id = "GHSA-gpj5-g38j-94v9"
TOML
assert_case 1 "commented-out allowlist entry" "$d"

echo "Case: advisory is a draft"
# Drafts are not claims about shipped code.
d="$(stage)"
write_repo_advisory "$d" "$(repo_vuln '<= 1.0.0-beta.19' '1.0.0-beta.20')" "draft"
assert_case 0 "draft advisory" "$d"

echo "Case: vulnerable range is not valid semver"
# Reported, not skipped. An unevaluated advisory that passes silently is
# the exact failure this gate was written to remove.
d="$(stage)"
write_repo_advisory "$d" "$(repo_vuln 'everything before the rewrite' '')"
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
