#!/usr/bin/env bash
#
# Scenario tests for scripts/ci/trivy-gate.sh (#725).
#
# The gate reads a Trivy JSON report and fails on every finding, one
# `::error::` line each.
#
# Reports follow Trivy's JSON shape (pkg/types/report.go, v0.70.0):
# `SchemaVersion: 2`, `Results[]` of {Target, Class, Type, Vulnerabilities[]};
# `Results`, `Vulnerabilities` and `PkgPath` are `omitempty`. OS-package
# results carry the image reference in `Target`. Secrets, the other scanner
# the image scans use, are in `Results[].Secrets` with `Class: secret`.
#
# Exits 0 when every case matches its expected code; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/trivy-gate.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GATE="$REPO_ROOT/scripts/ci/trivy-gate.sh"

if ! command -v jq > /dev/null 2>&1; then
  echo "ERROR: jq is required." >&2
  exit 2
fi
if [[ ! -f "$GATE" ]]; then
  echo "ERROR: $GATE not found." >&2
  exit 2
fi

TMP_ROOT="$(mktemp -d)"
# shellcheck disable=SC2317  # invoked via `trap cleanup EXIT`
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

# os <image> <id> <pkg> <version> — an OS-package result; Target names the image.
os() {
  jq -n --arg img "$1" --arg id "$2" --arg pkg "$3" --arg ver "$4" '{
    Target: "\($img) (alpine 3.24.1)", Class: "os-pkgs", Type: "alpine",
    Vulnerabilities: [{VulnerabilityID: $id, PkgName: $pkg, InstalledVersion: $ver, Severity: "HIGH"}]
  }'
}

# gobin <binary> <id> — a Go binary's stdlib finding; Target is the binary.
gobin() {
  jq -n --arg bin "$1" --arg id "$2" '{
    Target: $bin, Class: "lang-pkgs", Type: "gobinary",
    Vulnerabilities: [{VulnerabilityID: $id, PkgName: "stdlib", InstalledVersion: "v1.24.6", Severity: "UNKNOWN"}]
  }'
}

# node <pkgpath> <id> <version> — a node package; located by PkgPath.
node() {
  jq -n --arg path "$1" --arg id "$2" --arg ver "$3" '{
    Target: "Node.js", Class: "lang-pkgs", Type: "node-pkg",
    Vulnerabilities: [{VulnerabilityID: $id, PkgName: "glob", PkgPath: $path, InstalledVersion: $ver, Severity: "HIGH"}]
  }'
}

# secret <file> <rule> — a secret Trivy found in an image file.
secret() {
  jq -n --arg f "$1" --arg rule "$2" '{
    Target: $f, Class: "secret",
    Secrets: [{RuleID: $rule, Category: "AsymmetricPrivateKey", Severity: "HIGH", Title: "t", StartLine: 1, EndLine: 1}]
  }'
}

# clean <target> — a scanned target with nothing found: no Vulnerabilities key.
clean() {
  jq -n --arg t "$1" '{Target: $t, Class: "lang-pkgs", Type: "gobinary"}'
}

# report <results-json-array> — `[]` writes a report with no Results key.
report() {
  local f="$TMP_ROOT/report-$RANDOM$RANDOM.json"
  jq -n --argjson r "$1" '{SchemaVersion: 2, ArtifactName: "x", ArtifactType: "container_image"}
    + (if $r == [] then {} else {Results: $r} end)' > "$f"
  echo "$f"
}

IMG="ghcr.io/o/projekt-manager:sha-abc"

pass=0
fail=0
failures=()

# assert_case <expected-exit> <label> <gate-args...>
assert_case() {
  local expected="$1" label="$2"
  shift 2
  local actual
  bash "$GATE" "$@" > "$TMP_ROOT/out" 2>&1
  actual=$?
  if [[ "$actual" == "$expected" ]]; then
    pass=$((pass + 1))
    echo "  PASS — $label (exit $actual)"
  else
    fail=$((fail + 1))
    failures+=("$label: expected $expected, got $actual")
    echo "  FAIL — $label (expected $expected, got $actual)"
    sed 's/^/    /' "$TMP_ROOT/out"
  fi
}

# assert_error <label> <line> <report>: the report fails, with this exact line.
assert_error() {
  bash "$GATE" "$3" > "$TMP_ROOT/out" 2>&1
  if grep -qxF -- "$2" "$TMP_ROOT/out"; then
    pass=$((pass + 1))
    echo "  PASS — $1"
  else
    fail=$((fail + 1))
    failures+=("$1: no line '$2'")
    echo "  FAIL — $1"
    sed 's/^/    /' "$TMP_ROOT/out"
  fi
}

echo "Case: a clean report passes"
assert_case 0 "no Results key" "$(report '[]')"
assert_case 0 "clean target, no Vulnerabilities key" "$(report "[$(clean usr/bin/caddy)]")"

echo "Case: any finding fails, named with its location"
assert_case 1 "a vulnerability beside a clean target" "$(report "[$(clean usr/bin/caddy),$(os "$IMG" CVE-1 openssl 3.5.0-r0)]")"
assert_error "an OS package names the OS type" '::error::CVE-1 HIGH: openssl@3.5.0-r0 (os:alpine)' \
  "$(report "[$(os "$IMG" CVE-1 openssl 3.5.0-r0)]")"
assert_error "a Go binary names the binary" '::error::CVE-2 UNKNOWN: stdlib@v1.24.6 (usr/bin/caddy)' \
  "$(report "[$(gobin usr/bin/caddy CVE-2)]")"
assert_error "a node package names its copy" '::error::GHSA-g HIGH: glob@13.0.6 (app/node_modules/glob/package.json)' \
  "$(report "[$(node app/node_modules/glob/package.json GHSA-g 13.0.6)]")"
assert_error "a secret names the file" '::error::private-key HIGH: secret (app/.env)' \
  "$(report "[$(secret app/.env private-key)]")"
assert_error "two findings, two lines" '::error::CVE-2 UNKNOWN: stdlib@v1.24.6 (usr/bin/caddy)' \
  "$(report "[$(os "$IMG" CVE-1 openssl 3.5.0-r0),$(gobin usr/bin/caddy CVE-2)]")"
if [[ "$(grep -c '^::error::' "$TMP_ROOT/out")" == 2 ]]; then
  pass=$((pass + 1))
  echo "  PASS — one line per finding"
else
  fail=$((fail + 1))
  failures+=("one line per finding")
  sed 's/^/    /' "$TMP_ROOT/out"
fi

echo "Case: malformed input or arguments fail closed"
echo 'not json' > "$TMP_ROOT/garbage.json"
echo '{"SchemaVersion": 3}' > "$TMP_ROOT/schema3.json"
echo '{"SchemaVersion": 2, "Results": {}}' > "$TMP_ROOT/results-object.json"
jq -n '{SchemaVersion: 2, Results: [{Target: "t", Class: "os-pkgs", Type: "alpine",
  Vulnerabilities: [{VulnerabilityId: "CVE-1", PkgName: "openssl"}]}]}' > "$TMP_ROOT/renamed-field.json"
jq -n '{SchemaVersion: 2, Results: [{Target: "t", Class: "os-pkgs", Type: "alpine",
  Vulnerabilities: [{VulnerabilityID: "CVE-1", PackageName: "openssl"}]}]}' > "$TMP_ROOT/no-pkgname.json"
jq -n '{SchemaVersion: 2, Results: [{Target: "t", Class: "os-pkgs", Type: "alpine",
  Vulnerabilities: [{VulnerabilityID: "", PkgName: "openssl"}]}]}' > "$TMP_ROOT/empty-id.json"
assert_case 2 "not JSON" "$TMP_ROOT/garbage.json"
assert_case 2 "missing report" "$TMP_ROOT/absent.json"
assert_case 2 "unknown schema version" "$TMP_ROOT/schema3.json"
assert_case 2 "Results not a list" "$TMP_ROOT/results-object.json"
# A renamed field after a Trivy bump must not read as clean.
assert_case 2 "finding without VulnerabilityID" "$TMP_ROOT/renamed-field.json"
assert_case 2 "finding without PkgName" "$TMP_ROOT/no-pkgname.json"
assert_case 2 "finding with an empty VulnerabilityID" "$TMP_ROOT/empty-id.json"
jq -n '{SchemaVersion: 2, Results: [{Target: "app/.env", Class: "secret",
  Secrets: [{Rule: "private-key", Severity: "HIGH"}]}]}' > "$TMP_ROOT/secret-no-rule.json"
assert_case 2 "secret without RuleID" "$TMP_ROOT/secret-no-rule.json"
# A scanner this gate does not read must not pass unjudged.
jq -n '{SchemaVersion: 2, Results: [{Target: "Dockerfile", Class: "config",
  Misconfigurations: [{ID: "DS002", Severity: "HIGH"}]}]}' > "$TMP_ROOT/misconfig.json"
jq -n '{SchemaVersion: 2, Results: [{Target: "OS Packages", Class: "license",
  Licenses: [{Name: "AGPL-3.0", Severity: "HIGH"}]}]}' > "$TMP_ROOT/license.json"
assert_case 2 "misconfiguration findings" "$TMP_ROOT/misconfig.json"
assert_case 2 "license findings" "$TMP_ROOT/license.json"
assert_case 2 "no arguments"
assert_case 2 "two arguments" "$(report '[]')" "$(report '[]')"

echo
echo "Result: $pass passed, $fail failed"
if ((fail > 0)); then
  printf '  - %s\n' "${failures[@]}"
  exit 1
fi
