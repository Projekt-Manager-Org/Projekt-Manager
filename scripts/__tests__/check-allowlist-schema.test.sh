#!/usr/bin/env bash
#
# Scenario tests for scripts/check-allowlist-schema.sh.
#
# Each case stages osv-scanner.toml, .trivyignore.yaml and/or .grype.yaml in a fresh
# temp dir and runs the real check against it via $ALLOWLIST_REPO_ROOT.
# Exits 0 when every case matches its expected exit code; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/check-allowlist-schema.test.sh

set -u

# The check reads the local date; pin both sides to one clock so the
# boundary cases cannot straddle midnight between UTC and local time.
export TZ=UTC

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CHECK_SCRIPT="$SCRIPT_DIR/check-allowlist-schema.sh"

if [[ ! -x "$CHECK_SCRIPT" ]]; then
  echo "ERROR: $CHECK_SCRIPT not executable. chmod +x and try again." >&2
  exit 2
fi

# Anchor dates to "today" so the suite stays green as the wall clock
# advances. The accepted window is [today, today+90d] (closed-closed
# per the script docstring); today-1 expires, today+91 is too-far.
TODAY="$(date -u +%F)"
PLUS_30="$(date -u -d "$TODAY +30 days" +%F)"
PLUS_90="$(date -u -d "$TODAY +90 days" +%F)"
PLUS_91="$(date -u -d "$TODAY +91 days" +%F)"
PLUS_100="$(date -u -d "$TODAY +100 days" +%F)"
YESTERDAY="$(date -u -d "$TODAY -1 day" +%F)"

TMP_DIRS=()
# shellcheck disable=SC2317  # invoked via `trap cleanup EXIT`
cleanup() {
  local d
  for d in "${TMP_DIRS[@]:-}"; do
    [[ -n "${d:-}" && -d "$d" ]] && rm -rf "$d"
  done
}
trap cleanup EXIT

mktmp() {
  local d
  d="$(mktemp -d)"
  TMP_DIRS+=("$d")
  # An empty osv-scanner.toml and no YAML allowlists, so a case stages
  # just the file it cares about.
  : > "$d/osv-scanner.toml"
  echo "$d"
}

pass=0
fail=0
failures=()

assert_case() {
  local expected="$1" label="$2" dir="$3"
  local actual
  ALLOWLIST_REPO_ROOT="$dir" bash "$CHECK_SCRIPT" >/dev/null 2>&1
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

# Exit code 1 plus the finding: an exit code alone cannot tell which
# rule fired.
assert_finding() {
  local label="$1" dir="$2" needle="$3"
  local out rc
  out="$(ALLOWLIST_REPO_ROOT="$dir" bash "$CHECK_SCRIPT" 2>/dev/null)"
  rc=$?
  if [[ "$rc" == 1 && "$out" == *"$needle"* ]]; then
    pass=$((pass + 1))
    echo "  PASS — $label (exit 1, '$needle')"
  else
    fail=$((fail + 1))
    failures+=("$label: expected exit 1 with '$needle', got $rc: $out")
    echo "  FAIL — $label (expected exit 1 with '$needle', got $rc)"
  fi
}

# -------------------------------------------------------------
# OK: empty files (current repo baseline) → exit 0
# -------------------------------------------------------------
dir="$(mktmp)"
assert_case 0 "OK: empty osv-scanner.toml, no YAML allowlists" "$dir"

# -------------------------------------------------------------
# FAIL-osv-missing-reason
# -------------------------------------------------------------
dir="$(mktmp)"
cat > "$dir/osv-scanner.toml" <<EOF
[[IgnoredVulns]]
id = "GHSA-xxxx-xxxx-xxxx"
ignoreUntil = $PLUS_30
EOF
assert_case 1 "FAIL-osv-missing-reason" "$dir"

# -------------------------------------------------------------
# FAIL-osv-no-owner-prefix
# -------------------------------------------------------------
dir="$(mktmp)"
cat > "$dir/osv-scanner.toml" <<EOF
[[IgnoredVulns]]
id = "GHSA-xxxx-xxxx-xxxx"
ignoreUntil = $PLUS_30
reason = "dead code path"
EOF
assert_case 1 "FAIL-osv-no-owner-prefix" "$dir"

# -------------------------------------------------------------
# FAIL-osv-string-date — quoted date deserializes as str, not date
# -------------------------------------------------------------
dir="$(mktmp)"
cat > "$dir/osv-scanner.toml" <<EOF
[[IgnoredVulns]]
id = "GHSA-xxxx-xxxx-xxxx"
ignoreUntil = "$PLUS_30"
reason = "@vlzware: dead code"
EOF
assert_case 1 "FAIL-osv-string-date" "$dir"

# -------------------------------------------------------------
# FAIL-osv-expired — yesterday
# -------------------------------------------------------------
dir="$(mktmp)"
cat > "$dir/osv-scanner.toml" <<EOF
[[IgnoredVulns]]
id = "GHSA-xxxx-xxxx-xxxx"
ignoreUntil = $YESTERDAY
reason = "@vlzware: dead code"
EOF
assert_case 1 "FAIL-osv-expired" "$dir"

# -------------------------------------------------------------
# FAIL-osv-too-far — 100 days
# -------------------------------------------------------------
dir="$(mktmp)"
cat > "$dir/osv-scanner.toml" <<EOF
[[IgnoredVulns]]
id = "GHSA-xxxx-xxxx-xxxx"
ignoreUntil = $PLUS_100
reason = "@vlzware: dead code"
EOF
assert_case 1 "FAIL-osv-too-far" "$dir"

# -------------------------------------------------------------
# OK-osv-real-entry — fully valid
# -------------------------------------------------------------
dir="$(mktmp)"
cat > "$dir/osv-scanner.toml" <<EOF
[[IgnoredVulns]]
id = "GHSA-xxxx-xxxx-xxxx"
ignoreUntil = $PLUS_30
reason = "@vlzware: dead code path — function bundled but never reached at runtime"
EOF
assert_case 0 "OK-osv-real-entry" "$dir"

# -------------------------------------------------------------
# Boundary cases — exact window edges
# -------------------------------------------------------------

# OK-osv-boundary-today — ignoreUntil = today is the inclusive lower edge.
dir="$(mktmp)"
cat > "$dir/osv-scanner.toml" <<EOF
[[IgnoredVulns]]
id = "GHSA-xxxx-xxxx-xxxx"
ignoreUntil = $TODAY
reason = "@vlzware: dead code"
EOF
assert_case 0 "OK-osv-boundary-today" "$dir"

# OK-osv-boundary-plus-90 — exact inclusive upper edge.
dir="$(mktmp)"
cat > "$dir/osv-scanner.toml" <<EOF
[[IgnoredVulns]]
id = "GHSA-xxxx-xxxx-xxxx"
ignoreUntil = $PLUS_90
reason = "@vlzware: dead code"
EOF
assert_case 0 "OK-osv-boundary-plus-90" "$dir"

# FAIL-osv-boundary-plus-91 — first day past the window.
dir="$(mktmp)"
cat > "$dir/osv-scanner.toml" <<EOF
[[IgnoredVulns]]
id = "GHSA-xxxx-xxxx-xxxx"
ignoreUntil = $PLUS_91
reason = "@vlzware: dead code"
EOF
assert_case 1 "FAIL-osv-boundary-plus-91" "$dir"

# -------------------------------------------------------------
# TOML datetime — caused an uncaught TypeError pre-fix
# -------------------------------------------------------------
dir="$(mktmp)"
cat > "$dir/osv-scanner.toml" <<EOF
[[IgnoredVulns]]
id = "GHSA-xxxx-xxxx-xxxx"
ignoreUntil = ${PLUS_30}T00:00:00Z
reason = "@vlzware: dead code"
EOF
assert_case 1 "FAIL-osv-datetime-not-date" "$dir"

# -------------------------------------------------------------
# id validation — empty string and non-string must be rejected
# -------------------------------------------------------------

dir="$(mktmp)"
cat > "$dir/osv-scanner.toml" <<EOF
[[IgnoredVulns]]
id = ""
ignoreUntil = $PLUS_30
reason = "@vlzware: dead code"
EOF
assert_case 1 "FAIL-osv-id-empty" "$dir"

dir="$(mktmp)"
cat > "$dir/osv-scanner.toml" <<EOF
[[IgnoredVulns]]
id = 12345
ignoreUntil = $PLUS_30
reason = "@vlzware: dead code"
EOF
assert_case 1 "FAIL-osv-id-nonstring" "$dir"

# PackageOverrides (`ignore = true` per package) and every other top-level
# key would suppress with no owner or expiry: IgnoredVulns only.
dir="$(mktmp)"
cat > "$dir/osv-scanner.toml" <<EOF
[[PackageOverrides]]
name = "left-pad"
ecosystem = "npm"
ignore = true
EOF
assert_finding "FAIL-osv-package-overrides" "$dir" "PackageOverrides: top-level key not allowed"

# -------------------------------------------------------------
# GitHub handle validation — `@` with no body, hyphen edges, double
# hyphens, length over 39 must all be rejected.
# -------------------------------------------------------------

dir="$(mktmp)"
cat > "$dir/osv-scanner.toml" <<EOF
[[IgnoredVulns]]
id = "GHSA-xxxx-xxxx-xxxx"
ignoreUntil = $PLUS_30
reason = "@: dead code"
EOF
assert_case 1 "FAIL-osv-handle-empty" "$dir"

dir="$(mktmp)"
cat > "$dir/osv-scanner.toml" <<EOF
[[IgnoredVulns]]
id = "GHSA-xxxx-xxxx-xxxx"
ignoreUntil = $PLUS_30
reason = "@-: dead code"
EOF
assert_case 1 "FAIL-osv-handle-leading-hyphen" "$dir"

dir="$(mktmp)"
cat > "$dir/osv-scanner.toml" <<EOF
[[IgnoredVulns]]
id = "GHSA-xxxx-xxxx-xxxx"
ignoreUntil = $PLUS_30
reason = "@vlz-: dead code"
EOF
assert_case 1 "FAIL-osv-handle-trailing-hyphen" "$dir"

dir="$(mktmp)"
cat > "$dir/osv-scanner.toml" <<EOF
[[IgnoredVulns]]
id = "GHSA-xxxx-xxxx-xxxx"
ignoreUntil = $PLUS_30
reason = "@vl--ware: dead code"
EOF
assert_case 1 "FAIL-osv-handle-consecutive-hyphens" "$dir"

# -------------------------------------------------------------
# YAML allowlists — .trivyignore.yaml and .grype.yaml. One contract
# (owner, reason, expiry within [today, today+90d], an id on every entry,
# no unknown keys), spelt in each scanner's native key names so the
# scanner itself reads the same fields:
#
#   file               id key         reason key  expiry key  scope key
#   .trivyignore.yaml  id             statement   expired_at  paths
#   .grype.yaml        vulnerability  reason      expires     package
#
# Both scanners silently accept unknown keys (measured: Trivy v0.70.0,
# Grype v0.120.1). A misspelt scope key (`path:`, `packge:`) therefore
# loads without error and widens a gosu-only ignore to every package;
# a missing id leaves a scope-only rule — on Grype measured to suppress
# every finding of that package type. Grype also honours no expiry.
# The schema check is the only thing standing between a typo and a
# blanket ignore.
# -------------------------------------------------------------

# Valid entries; failure cases derive from them by editing one line.
# shellcheck disable=SC2317  # invoked indirectly via yaml_cases "$entry"
trivy_entry() {
  cat <<EOF
vulnerabilities:
  - id: CVE-2026-12345
    paths:
      - usr/local/bin/gosu
    owner: '@vlzware'
    statement: Go stdlib CVE in gosu; gosu runs once at container start to drop privileges
    expired_at: $PLUS_30
EOF
}
grype_entry() {
  cat <<EOF
ignore:
  - vulnerability: CVE-2026-12345
    package:
      name: gosu
    owner: '@vlzware'
    reason: Go stdlib CVE in gosu; gosu runs once at container start to drop privileges
    expires: $PLUS_30
EOF
}

# $1 file, $2 entry fn, $3 id key, $4 reason key, $5 expiry key, $6 scope key
yaml_cases() {
  local file="$1" entry="$2" id="$3" reason="$4" exp="$5" scope="$6" dir

  dir="$(mktmp)"; "$entry" > "$dir/$file"
  assert_case 0 "OK-$file-valid-entry" "$dir"

  dir="$(mktmp)"; "$entry" | sed "/^  - $id:/d; s/^    $scope:/  - $scope:/" > "$dir/$file"
  assert_case 1 "FAIL-$file-missing-id (scope-only blanket rule)" "$dir"

  dir="$(mktmp)"; "$entry" | sed "s/^  - $id: .*/  - $id: ''/" > "$dir/$file"
  assert_case 1 "FAIL-$file-empty-id" "$dir"

  # The valid scope stays, so only the unknown-key rule can catch this.
  dir="$(mktmp)"; "$entry" | sed "s/^    owner:/    ${scope:0:3}${scope:4}: x\n    owner:/" > "$dir/$file"
  assert_case 1 "FAIL-$file-misspelt-key-beside-scope" "$dir"

  # Scope is mandatory: an entry without one is ignored in every image.
  dir="$(mktmp)"; "$entry" | sed "/^    $scope:/,+1d" > "$dir/$file"
  assert_case 1 "FAIL-$file-missing-scope" "$dir"

  dir="$(mktmp)"; "$entry" | sed '/^    owner:/d' > "$dir/$file"
  assert_case 1 "FAIL-$file-missing-owner" "$dir"

  dir="$(mktmp)"; "$entry" | sed "s/'@vlzware'/'@-vlzware'/" > "$dir/$file"
  assert_case 1 "FAIL-$file-owner-invalid-handle" "$dir"

  dir="$(mktmp)"; "$entry" | sed "/^    $reason:/d" > "$dir/$file"
  assert_case 1 "FAIL-$file-missing-reason" "$dir"

  dir="$(mktmp)"; "$entry" | sed "/^    $exp:/d" > "$dir/$file"
  assert_case 1 "FAIL-$file-missing-expiry" "$dir"

  dir="$(mktmp)"; "$entry" | sed "s/^    $exp: .*/    $exp: $YESTERDAY/" > "$dir/$file"
  assert_case 1 "FAIL-$file-expired" "$dir"

  dir="$(mktmp)"; "$entry" | sed "s/^    $exp: .*/    $exp: $PLUS_91/" > "$dir/$file"
  assert_case 1 "FAIL-$file-too-far" "$dir"

  dir="$(mktmp)"; printf '%s\n' "x: [unclosed" > "$dir/$file"
  assert_case 1 "FAIL-$file-unparseable" "$dir"

  # The file is also the scanner's config: Grype reads every top-level
  # key of .grype.yaml (`exclude:`, `only-fixed:`), and one such key
  # silenced all nine node findings (measured, v0.120.1). Only the
  # allowlist sections are allowed.
  dir="$(mktmp)"; { "$entry"; echo "exclude: [/usr/local/bin/node]"; } > "$dir/$file"
  assert_case 1 "FAIL-$file-unknown-top-level-key" "$dir"
}

yaml_cases .trivyignore.yaml trivy_entry id statement expired_at paths
yaml_cases .grype.yaml grype_entry vulnerability reason expires package

# An empty scope is no scope: both scanners read `paths: []` / `package: {}`
# as "everywhere", the same widening a misspelt key causes.
dir="$(mktmp)"
trivy_entry | sed '/^      - usr\/local\/bin\/gosu/d; s/^    paths:$/    paths: []/' > "$dir/.trivyignore.yaml"
assert_case 1 "FAIL-.trivyignore.yaml-empty-scope" "$dir"

dir="$(mktmp)"
grype_entry | sed '/^      name: gosu/d; s/^    package:$/    package: {}/' > "$dir/.grype.yaml"
assert_case 1 "FAIL-.grype.yaml-empty-scope" "$dir"

# Grype's package selector is itself a map; a misspelt key inside it is
# dropped the same way and widens the rule just as far.
dir="$(mktmp)"
grype_entry | sed 's/^      name: gosu/      nmae: gosu/' > "$dir/.grype.yaml"
assert_case 1 "FAIL-.grype.yaml-misspelt-package-key" "$dir"

# A scope whose values are empty is no scope: Trivy matches an empty path
# against every OS package (their pkgPath is empty), Grype skips empty
# package fields. Measured: each of these ignored the CVE in every image.
dir="$(mktmp)"
trivy_entry | sed "s|^      - usr/local/bin/gosu|      - ''|" > "$dir/.trivyignore.yaml"
assert_case 1 "FAIL-.trivyignore.yaml-empty-string-path" "$dir"

dir="$(mktmp)"
trivy_entry | sed "s|^      - usr/local/bin/gosu|      -|" > "$dir/.trivyignore.yaml"
assert_case 1 "FAIL-.trivyignore.yaml-null-path" "$dir"

dir="$(mktmp)"
grype_entry | sed 's/^      name: gosu/      name:/' > "$dir/.grype.yaml"
assert_case 1 "FAIL-.grype.yaml-null-package-name" "$dir"

# Only vulnerability findings carry a PURL; Trivy matches a purls-only
# entry in the other sections against everything.
dir="$(mktmp)"
cat > "$dir/.trivyignore.yaml" <<EOF
secrets:
  - id: aws-access-token
    purls:
      - pkg:golang/example.com/x
    owner: '@vlzware'
    statement: purls cannot scope a secret finding
    expired_at: $PLUS_30
EOF
assert_case 1 "FAIL-.trivyignore.yaml-purls-outside-vulnerabilities" "$dir"

# Scopes are literal. Trivy reads `paths` and Grype `location` as globs,
# Grype `name` as a regex; a pattern that matches everything is a global
# ignore. Measured: each of these suppressed musl's CVE in postgres. The
# brace form reads like a real path in review.
dir="$(mktmp)"
trivy_entry | sed "s|^      - usr/local/bin/gosu|      - '{,usr/local/bin/gosu}'|" > "$dir/.trivyignore.yaml"
assert_case 1 "FAIL-.trivyignore.yaml-brace-glob-path" "$dir"

dir="$(mktmp)"
trivy_entry | sed "s|^      - usr/local/bin/gosu|      - '**'|" > "$dir/.trivyignore.yaml"
assert_case 1 "FAIL-.trivyignore.yaml-wildcard-path" "$dir"

dir="$(mktmp)"
grype_entry | sed "s|^      name: gosu|      location: '**'|" > "$dir/.grype.yaml"
assert_case 1 "FAIL-.grype.yaml-wildcard-location" "$dir"

dir="$(mktmp)"
grype_entry | sed "s|^      name: gosu|      name: '.*'|" > "$dir/.grype.yaml"
assert_case 1 "FAIL-.grype.yaml-regex-name" "$dir"

dir="$(mktmp)"
grype_entry | sed "s|^      name: gosu|      name: '.+'|" > "$dir/.grype.yaml"
assert_case 1 "FAIL-.grype.yaml-regex-name-dot-plus" "$dir"

# `+` alone switches Grype to regex mode; `.+u.+` matched musl and
# musl-utils. `upstream-name` is regex-matched the same way as `name`.
dir="$(mktmp)"
grype_entry | sed "s|^      name: gosu|      name: '.+u.+'|" > "$dir/.grype.yaml"
assert_case 1 "FAIL-.grype.yaml-regex-name-plus" "$dir"

dir="$(mktmp)"
grype_entry | sed "s|^      name: gosu|      upstream-name: '.*'|" > "$dir/.grype.yaml"
assert_case 1 "FAIL-.grype.yaml-regex-upstream-name" "$dir"

# Go's stdlib is linked into every Go binary: scoped by name or purl, a
# gosu waiver would hide the same CVE in Caddy. Only the binary's path
# tells them apart.
dir="$(mktmp)"
grype_entry | sed "s|^      name: gosu|      name: stdlib|" > "$dir/.grype.yaml"
assert_case 1 "FAIL-.grype.yaml-stdlib-without-location" "$dir"

dir="$(mktmp)"
grype_entry | sed "s|^      name: gosu|      upstream-name: stdlib|" > "$dir/.grype.yaml"
assert_case 1 "FAIL-.grype.yaml-stdlib-upstream-name-without-location" "$dir"

dir="$(mktmp)"
grype_entry | sed "s|^      name: gosu|      name: stdlib\n      location: /usr/local/bin/gosu|" > "$dir/.grype.yaml"
assert_case 0 "OK-.grype.yaml-stdlib-with-location" "$dir"

dir="$(mktmp)"
trivy_entry | sed "s|^    paths:|    purls:|; s|^      - usr/local/bin/gosu|      - pkg:golang/stdlib@v1.24.6|" > "$dir/.trivyignore.yaml"
assert_case 1 "FAIL-.trivyignore.yaml-stdlib-purl" "$dir"

# Trivy ANDs `paths` and `purls`: beside a path, the purl only narrows.
dir="$(mktmp)"
trivy_entry | sed "s|^    paths:|    purls:\n      - pkg:golang/stdlib@v1.24.6\n    paths:|" > "$dir/.trivyignore.yaml"
assert_case 0 "OK-.trivyignore.yaml-stdlib-purl-with-paths" "$dir"

# Type and version identify no package: this is the stdlib of every
# binary built with Go 1.24.6.
dir="$(mktmp)"
grype_entry | sed "s|^      name: gosu|      type: go-module\n      version: go1.24.6|" > "$dir/.grype.yaml"
assert_case 1 "FAIL-.grype.yaml-type-and-version-only" "$dir"

# Dots do not trigger regex mode: a Go module path stays an exact match.
dir="$(mktmp)"
grype_entry | sed "s|^      name: gosu|      name: github.com/go-jose/go-jose/v3|" > "$dir/.grype.yaml"
assert_case 0 "OK-.grype.yaml-dotted-module-name" "$dir"

# Trivy's other sections feed the PR gate's secret and IaC scans and
# carry the same accountability.
dir="$(mktmp)"
cat > "$dir/.trivyignore.yaml" <<EOF
misconfigurations:
  - id: DS-0002
    paths:
      - Dockerfile
    statement: no owner on this one
    expired_at: $PLUS_30
EOF
assert_case 1 "FAIL-.trivyignore.yaml-misconfiguration-missing-owner" "$dir"

dir="$(mktmp)"
cat > "$dir/.trivyignore.yaml" <<EOF
secrets:
  - id: aws-access-token
    paths:
      - fixtures/dev.env
    owner: '@vlzware'
    statement: dev fixture key, not a credential
    expired_at: $PLUS_30
EOF
assert_case 0 "OK-.trivyignore.yaml-secret-entry" "$dir"

# -------------------------------------------------------------
# --base-dir (#668): an expired entry unchanged from the base is main's
# state, owned by the nightlies, and passes the PR gate. One the change
# adds or edits is held to the full contract. Without the flag (the
# nightlies) every expired entry fails.
# -------------------------------------------------------------
assert_base_case() {
  local expected="$1" label="$2" dir="$3"
  local actual
  ALLOWLIST_REPO_ROOT="$dir" bash "$CHECK_SCRIPT" --base-dir "$dir/base" >/dev/null 2>&1
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

osv_expired() {
  cat <<EOF
[[IgnoredVulns]]
id = "GHSA-xxxx-xxxx-xxxx"
ignoreUntil = ${1:-$YESTERDAY}
reason = "@vlzware: dead code"
EOF
}

dir="$(mktmp)"
mkdir -p "$dir/base"
osv_expired > "$dir/osv-scanner.toml"
osv_expired > "$dir/base/osv-scanner.toml"
assert_base_case 0 "OK-base-osv-expired-unchanged" "$dir"
assert_case 1 "FAIL-osv-expired-unchanged-without-base" "$dir"

dir="$(mktmp)"
mkdir -p "$dir/base"
osv_expired > "$dir/osv-scanner.toml"
assert_base_case 1 "FAIL-base-osv-expired-added" "$dir"

dir="$(mktmp)"
mkdir -p "$dir/base"
osv_expired > "$dir/osv-scanner.toml"
osv_expired "$(date -u -d "$TODAY -2 days" +%F)" > "$dir/base/osv-scanner.toml"
assert_base_case 1 "FAIL-base-osv-expired-edited" "$dir"

dir="$(mktmp)"
mkdir -p "$dir/base"
trivy_entry | sed "s/expired_at: .*/expired_at: $YESTERDAY/" > "$dir/.trivyignore.yaml"
cp "$dir/.trivyignore.yaml" "$dir/base/.trivyignore.yaml"
grype_entry | sed "s/expires: .*/expires: $YESTERDAY/" > "$dir/.grype.yaml"
cp "$dir/.grype.yaml" "$dir/base/.grype.yaml"
assert_base_case 0 "OK-base-yaml-expired-unchanged" "$dir"

dir="$(mktmp)"
mkdir -p "$dir/base"
trivy_entry | sed "s/expired_at: .*/expired_at: $YESTERDAY/" > "$dir/.trivyignore.yaml"
trivy_entry | sed -e "s/expired_at: .*/expired_at: $YESTERDAY/" -e "s#usr/local/bin/gosu#usr/bin/caddy#" > "$dir/base/.trivyignore.yaml"
assert_base_case 1 "FAIL-base-trivy-expired-rescoped" "$dir"

dir="$(mktmp)"
mkdir -p "$dir/base"
osv_expired > "$dir/osv-scanner.toml"
printf 'not = [valid\n' > "$dir/base/osv-scanner.toml"
assert_base_case 1 "FAIL-base-unreadable-base-copy" "$dir"

dir="$(mktmp)"
ALLOWLIST_REPO_ROOT="$dir" bash "$CHECK_SCRIPT" --base-dir >/dev/null 2>&1
rc=$?
if [[ "$rc" == 2 ]]; then
  pass=$((pass + 1)); echo "  PASS — --base-dir without a directory (exit 2)"
else
  fail=$((fail + 1)); failures+=("--base-dir without a directory: expected 2, got $rc")
fi

echo ""
echo "-------------------------------------------------------------"
echo "  Passed: $pass"
echo "  Failed: $fail"
if [[ "$fail" -gt 0 ]]; then
  for f in "${failures[@]}"; do
    echo "    - $f"
  done
  exit 1
fi
echo "All cases passed."
exit 0
