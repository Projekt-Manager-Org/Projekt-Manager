#!/usr/bin/env bash
#
# Scenario tests for scripts/ci/trivy-gate.sh (#725).
#
# The gate reads a Trivy JSON report of the head image and, in the PR gate,
# one of the base image (`:main`) scanned with the same DB and allowlist. It
# fails on head findings the base does not have, keyed on (advisory id,
# package, location in the image); version is not part of the key. Without
# a base every finding fails (the nightly).
#
# Reports follow Trivy's JSON shape (pkg/types/report.go, v0.70.0):
# `SchemaVersion: 2`, `Results[]` of {Target, Class, Type, Vulnerabilities[]};
# `Results`, `Vulnerabilities` and `PkgPath` are `omitempty`. OS-package
# results carry the image reference in `Target`, so base and head differ
# there by construction.
#
# Secrets are the image scan's other default scanner: keyed on (rule, file),
# in `Results[].Secrets` with `Class: secret`.
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

HEAD_IMG="ghcr.io/o/projekt-manager@sha256:aaaa"
BASE_IMG="ghcr.io/o/projekt-manager:main"

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

echo "Case: no base (nightly) — absolute"
assert_case 0 "clean report, no Results key" "$(report '[]')"
assert_case 0 "clean target, no Vulnerabilities key" "$(report "[$(clean usr/bin/caddy)]")"
assert_case 1 "any finding fails" "$(report "[$(clean usr/bin/caddy),$(os "$HEAD_IMG" CVE-1 openssl 3.5.0-r0)]")"

echo "Case: no base — a secret fails"
assert_case 1 "secret in the image" "$(report "[$(secret app/.env private-key)]")"

echo "Case: with a base — a finding main already ships passes"
assert_case 0 "same OS finding, image ref differs" \
  "$(report "[$(os "$HEAD_IMG" CVE-1 openssl 3.5.0-r0)]")" \
  "$(report "[$(os "$BASE_IMG" CVE-1 openssl 3.5.0-r0)]")"
assert_case 0 "bump that stays vulnerable" \
  "$(report "[$(os "$HEAD_IMG" CVE-1 openssl 3.5.1-r0)]")" \
  "$(report "[$(os "$BASE_IMG" CVE-1 openssl 3.5.0-r0)]")"
assert_case 0 "same Go binary finding" \
  "$(report "[$(gobin usr/local/bin/gosu CVE-2)]")" \
  "$(report "[$(gobin usr/local/bin/gosu CVE-2)]")"
assert_case 0 "same node package copy" \
  "$(report "[$(node app/node_modules/glob/package.json GHSA-g 13.0.6)]")" \
  "$(report "[$(node app/node_modules/glob/package.json GHSA-g 13.0.6)]")"
assert_case 0 "same secret" \
  "$(report "[$(secret app/.env private-key)]")" \
  "$(report "[$(secret app/.env private-key)]")"
assert_case 0 "clean targets on both sides" \
  "$(report "[$(clean usr/bin/caddy)]")" \
  "$(report "[$(clean usr/bin/caddy)]")"
assert_case 0 "change fixes a base finding" \
  "$(report '[]')" \
  "$(report "[$(os "$BASE_IMG" CVE-1 openssl 3.5.0-r0)]")"

echo "Case: with a base — a finding the change introduces fails"
assert_case 1 "new advisory id" \
  "$(report "[$(os "$HEAD_IMG" CVE-1 openssl 3.5.0-r0),$(os "$HEAD_IMG" CVE-3 openssl 3.5.0-r0)]")" \
  "$(report "[$(os "$BASE_IMG" CVE-1 openssl 3.5.0-r0)]")"
assert_case 1 "same id, another package" \
  "$(report "[$(os "$HEAD_IMG" CVE-1 libcrypto3 3.5.0-r0)]")" \
  "$(report "[$(os "$BASE_IMG" CVE-1 openssl 3.5.0-r0)]")"
# Location is in the key because the allowlist is path-scoped: gosu's stdlib
# CVE must not hide the same CVE in Caddy.
assert_case 1 "same Go stdlib CVE, another binary" \
  "$(report "[$(gobin usr/local/bin/gosu CVE-2),$(gobin usr/bin/caddy CVE-2)]")" \
  "$(report "[$(gobin usr/local/bin/gosu CVE-2)]")"
assert_case 1 "same node package CVE, another copy" \
  "$(report "[$(node app/node_modules/glob/package.json GHSA-g 13.0.6),$(node app/node_modules/x/node_modules/glob/package.json GHSA-g 13.0.6)]")" \
  "$(report "[$(node app/node_modules/glob/package.json GHSA-g 13.0.6)]")"

assert_case 1 "same secret rule, another file" \
  "$(report "[$(secret app/.env private-key),$(secret app/dist/key.pem private-key)]")" \
  "$(report "[$(secret app/.env private-key)]")"

echo "Case: an introduced finding is named, a pre-existing one is not an error"
bash "$GATE" \
  "$(report "[$(os "$HEAD_IMG" CVE-1 openssl 3.5.0-r0),$(gobin usr/bin/caddy CVE-2)]")" \
  "$(report "[$(os "$BASE_IMG" CVE-1 openssl 3.5.0-r0)]")" > "$TMP_ROOT/out" 2>&1
if grep -q '^::error::CVE-2 .*usr/bin/caddy' "$TMP_ROOT/out" && ! grep -q '^::error::CVE-1' "$TMP_ROOT/out"; then
  pass=$((pass + 1))
  echo "  PASS — only the introduced finding is an error, with its location"
else
  fail=$((fail + 1))
  failures+=("introduced finding not named, or pre-existing one reported as error")
  echo "  FAIL — output:"
  sed 's/^/    /' "$TMP_ROOT/out"
fi

echo "Case: malformed input or arguments fail closed"
good="$(report '[]')"
echo 'not json' > "$TMP_ROOT/garbage.json"
echo '{"SchemaVersion": 3}' > "$TMP_ROOT/schema3.json"
echo '{"SchemaVersion": 2, "Results": {}}' > "$TMP_ROOT/results-object.json"
jq -n '{SchemaVersion: 2, Results: [{Target: "t", Class: "os-pkgs", Type: "alpine",
  Vulnerabilities: [{VulnerabilityId: "CVE-1", PkgName: "openssl"}]}]}' > "$TMP_ROOT/renamed-field.json"
jq -n '{SchemaVersion: 2, Results: [{Target: "t", Class: "os-pkgs", Type: "alpine",
  Vulnerabilities: [{VulnerabilityID: "CVE-1", PackageName: "openssl"}]}]}' > "$TMP_ROOT/no-pkgname.json"
jq -n '{SchemaVersion: 2, Results: [{Target: "t", Class: "os-pkgs", Type: "alpine",
  Vulnerabilities: [{VulnerabilityID: "", PkgName: "openssl"}]}]}' > "$TMP_ROOT/empty-id.json"
assert_case 2 "head not JSON" "$TMP_ROOT/garbage.json" "$good"
assert_case 2 "base not JSON" "$good" "$TMP_ROOT/garbage.json"
assert_case 2 "missing base" "$good" "$TMP_ROOT/absent.json"
assert_case 2 "unknown schema version" "$TMP_ROOT/schema3.json"
assert_case 2 "Results not a list" "$TMP_ROOT/results-object.json"
# A renamed field after a Trivy bump must not collapse every key to the
# same empty value and make head findings match the base.
assert_case 2 "finding without VulnerabilityID (head)" "$TMP_ROOT/renamed-field.json" "$good"
assert_case 2 "finding without VulnerabilityID (base)" "$good" "$TMP_ROOT/renamed-field.json"
assert_case 2 "finding without PkgName" "$TMP_ROOT/no-pkgname.json" "$good"
assert_case 2 "finding with an empty VulnerabilityID" "$TMP_ROOT/empty-id.json" "$good"
jq -n '{SchemaVersion: 2, Results: [{Target: "app/.env", Class: "secret",
  Secrets: [{Rule: "private-key", Severity: "HIGH"}]}]}' > "$TMP_ROOT/secret-no-rule.json"
assert_case 2 "secret without RuleID" "$TMP_ROOT/secret-no-rule.json" "$good"
# A scanner this gate does not read must not pass unjudged.
jq -n '{SchemaVersion: 2, Results: [{Target: "Dockerfile", Class: "config",
  Misconfigurations: [{ID: "DS002", Severity: "HIGH"}]}]}' > "$TMP_ROOT/misconfig.json"
jq -n '{SchemaVersion: 2, Results: [{Target: "OS Packages", Class: "license",
  Licenses: [{Name: "AGPL-3.0", Severity: "HIGH"}]}]}' > "$TMP_ROOT/license.json"
assert_case 2 "misconfiguration findings" "$TMP_ROOT/misconfig.json"
assert_case 2 "license findings" "$TMP_ROOT/license.json"
assert_case 2 "no arguments"

echo
echo "Result: $pass passed, $fail failed"
if ((fail > 0)); then
  printf '  - %s\n' "${failures[@]}"
  exit 1
fi
