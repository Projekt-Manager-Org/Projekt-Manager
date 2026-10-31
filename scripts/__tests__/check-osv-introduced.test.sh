#!/usr/bin/env bash
#
# Scenario tests for scripts/check-osv-introduced.mjs.
#
# A stub `osv-scanner` on PATH stands in for the CLI: for the lockfile it is
# given, it copies the sibling `osv.json` to --output-file and exits with the
# code in the sibling `osv.rc` (default 0). No network, no binary.
#
# The stub writes the shape the pinned CLI (v2.3.8) writes, measured with
# `scan source --format=json --output-file`: `results[].packages[]` with
# `package.{name,version,ecosystem}` and `vulnerabilities[].id`; on exit 0
# `results: []`; on exit 127 (error) and 128 (no packages) no file at all.
#
# The case that carries the weight: "advisory already on the base" — a
# finding the change did not introduce must not fail it, even when the
# change bumps the affected package to another still-vulnerable version.
#
# Exits 0 when every case matches its expectation; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/check-osv-introduced.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHECK="$REPO_ROOT/scripts/check-osv-introduced.mjs"

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

# A fresh tree per case: head lockfile + allowlist at the root, the stub on
# $d/bin. Each case stages the stub's answers next to each lockfile.
stage() {
  local d
  d="$(mktemp -d)"
  TMP_DIRS+=("$d")
  mkdir -p "$d/bin" "$d/base"
  printf '{"lockfileVersion":3,"packages":{}}\n' >"$d/package-lock.json"
  printf '{"lockfileVersion":3,"packages":{}}\n' >"$d/base/package-lock.json"
  printf '# empty allowlist\n' >"$d/osv-scanner.toml"
  cat >"$d/bin/osv-scanner" <<'SH'
#!/usr/bin/env bash
lf="" out=""
for a in "$@"; do
  case "$a" in
    --lockfile=*) lf="${a#--lockfile=}" ;;
    --output-file=*) out="${a#--output-file=}" ;;
  esac
done
dir="$(dirname "$lf")"
[[ -f "$dir/osv.json" ]] && cp "$dir/osv.json" "$out"
exit "$(cat "$dir/osv.rc" 2>/dev/null || echo 0)"
SH
  chmod +x "$d/bin/osv-scanner"
  echo "$d"
}

# One package with its vulnerability ids, in the CLI's result shape.
pkg() {
  local name="$1" version="$2"
  shift 2
  local ids="" id
  for id in "$@"; do ids+="${ids:+,}{\"id\":\"$id\"}"; done
  printf '{"package":{"name":"%s","version":"%s","ecosystem":"npm"},"vulnerabilities":[%s]}' \
    "$name" "$version" "$ids"
}

# Stub answer for the lockfile in $1: exit code $2, then the packages.
answer() {
  local dir="$1" rc="$2"
  shift 2
  local pkgs
  pkgs="$(IFS=,; echo "$*")"
  echo "$rc" >"$dir/osv.rc"
  if [[ -z "$pkgs" ]]; then
    printf '{"results":[]}\n' >"$dir/osv.json"
  else
    printf '{"results":[{"source":{"path":"%s/package-lock.json","type":"lockfile"},"packages":[%s]}]}\n' \
      "$dir" "$pkgs" >"$dir/osv.json"
  fi
}

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

# $2 = "base" to judge against $1/base/package-lock.json, else absolute.
run_check() {
  local dir="$1" mode="$2"
  local args=()
  [[ "$mode" == "base" ]] && args=(--base-lockfile "$dir/base/package-lock.json")
  PATH="$dir/bin:$PATH" PROJECT_ROOT="$dir" node "$CHECK" "${args[@]}" 2>&1
}

assert_output() {
  local expected="$1" label="$2" dir="$3" mode="$4" pattern="$5"
  local out actual
  out="$(run_check "$dir" "$mode")"
  actual=$?
  if [[ "$actual" != "$expected" ]]; then
    record no "$label" "expected exit $expected, got $actual"
  elif ! grep -qF -- "$pattern" <<<"$out"; then
    record no "$label" "output missing '$pattern'"
  else
    record yes "$label (exit $actual, matched '$pattern')" ""
  fi
}

echo "Case: no base, clean"
d="$(stage)"
answer "$d" 0
assert_output 0 "absolute, clean" "$d" none "OK"

echo "Case: no base, a finding"
# Without a base (workflow_dispatch) the gate is the old absolute one.
d="$(stage)"
answer "$d" 1 "$(pkg glob 13.0.6 GHSA-3g3m-2fjr-6pw4)"
assert_output 1 "absolute, finding" "$d" none "GHSA-3g3m-2fjr-6pw4"

echo "Case: advisory already on the base"
# The trigger of #668: published against what main already ships.
d="$(stage)"
answer "$d" 1 "$(pkg glob 13.0.6 GHSA-3g3m-2fjr-6pw4)"
answer "$d/base" 1 "$(pkg glob 13.0.6 GHSA-3g3m-2fjr-6pw4)"
assert_output 0 "pre-existing finding" "$d" base "already on the base"

echo "Case: change bumps a package that stays vulnerable"
# Keyed on (id, ecosystem, name), not version: the bump did not introduce it.
d="$(stage)"
answer "$d" 1 "$(pkg glob 13.0.7 GHSA-3g3m-2fjr-6pw4)"
answer "$d/base" 1 "$(pkg glob 13.0.6 GHSA-3g3m-2fjr-6pw4)"
assert_output 0 "bump keeps a pre-existing finding" "$d" base "already on the base"

echo "Case: new advisory id on a package already on the base"
d="$(stage)"
answer "$d" 1 "$(pkg glob 12.0.0 GHSA-3g3m-2fjr-6pw4 GHSA-5j98-mcp5-4vw2)"
answer "$d/base" 1 "$(pkg glob 13.0.6 GHSA-3g3m-2fjr-6pw4)"
assert_output 1 "introduced id" "$d" base "GHSA-5j98-mcp5-4vw2"

echo "Case: same advisory id on a package the base did not have"
# One advisory can name several packages; a new package carrying it is new.
d="$(stage)"
answer "$d" 1 "$(pkg glob 13.0.6 GHSA-3g3m-2fjr-6pw4)" "$(pkg other 1.0.0 GHSA-3g3m-2fjr-6pw4)"
answer "$d/base" 1 "$(pkg glob 13.0.6 GHSA-3g3m-2fjr-6pw4)"
assert_output 1 "introduced package" "$d" base "other@1.0.0"

echo "Case: change fixes a finding on the base"
d="$(stage)"
answer "$d" 0
answer "$d/base" 1 "$(pkg glob 13.0.6 GHSA-3g3m-2fjr-6pw4)"
assert_output 0 "fixed by the change" "$d" base "OK"

echo "Case: head scan errors"
# 127 = the CLI's general error. It writes no results; never read as clean.
d="$(stage)"
echo 127 >"$d/osv.rc"
answer "$d/base" 0
assert_output 2 "head scan error" "$d" base "exited 127"

echo "Case: base scan errors"
# A base that cannot be scanned must not make every head finding pre-existing,
# nor every one new: the comparison is impossible, so fail closed.
d="$(stage)"
answer "$d" 0
echo 127 >"$d/base/osv.rc"
assert_output 2 "base scan error" "$d" base "exited 127"

echo "Case: no packages found"
# 128: the lockfile parsed to nothing. Never a clean result.
d="$(stage)"
echo 128 >"$d/osv.rc"
assert_output 2 "no packages" "$d" none "exited 128"

echo "Case: findings reported but no results file"
d="$(stage)"
echo 1 >"$d/osv.rc"
assert_output 2 "missing results file" "$d" none "results"

echo "Case: results file is not the expected shape"
d="$(stage)"
echo 1 >"$d/osv.rc"
printf '{"results":"nope"}\n' >"$d/osv.json"
assert_output 2 "malformed results" "$d" none "results"

echo "Case: findings under a renamed field"
# A CLI bump that renames `vulnerabilities` must not read as clean.
d="$(stage)"
echo 1 >"$d/osv.rc"
printf '{"results":[{"packages":[{"package":{"name":"glob","version":"1","ecosystem":"npm"},"vulns":[{"id":"GHSA-x"}]}]}]}\n' >"$d/osv.json"
assert_output 2 "renamed vulnerabilities field" "$d" none "expected shape"

echo "Case: vulnerability without an id"
# Missing ids would collapse head and base keys to `undefined|…` and match.
d="$(stage)"
echo 1 >"$d/osv.rc"
printf '{"results":[{"packages":[{"package":{"name":"glob","version":"1","ecosystem":"npm"},"vulnerabilities":[{"ID":"GHSA-x"}]}]}]}\n' >"$d/osv.json"
assert_output 2 "missing vulnerability id" "$d" none "expected shape"

echo "Case: exit code disagrees with the results"
d="$(stage)"
answer "$d" 1
assert_output 2 "exit 1, no findings" "$d" none "but the head results hold 0"
d="$(stage)"
answer "$d" 0 "$(pkg glob 13.0.6 GHSA-3g3m-2fjr-6pw4)"
assert_output 2 "exit 0, findings" "$d" none "but the head results hold 1"

echo "Case: every instance is printed"
d="$(stage)"
answer "$d" 1 "$(pkg minimatch 10.2.6 GHSA-g3hv-75wg-m249)" "$(pkg minimatch 10.2.5 GHSA-g3hv-75wg-m249)"
answer "$d/base" 1 "$(pkg minimatch 10.2.6 GHSA-g3hv-75wg-m249)"
assert_output 0 "second copy listed" "$d" base "minimatch@10.2.5"

echo "Case: base lockfile does not exist"
d="$(stage)"
answer "$d" 0
rm "$d/base/package-lock.json"
assert_output 2 "missing base lockfile" "$d" base "base lockfile"

echo "Case: --base-lockfile without a path"
d="$(stage)"
answer "$d" 0
out="$(PATH="$d/bin:$PATH" PROJECT_ROOT="$d" node "$CHECK" --base-lockfile 2>&1)"
rc=$?
if [[ "$rc" == 2 ]]; then record yes "flag without a path (exit 2)" ""; else record no "flag without a path" "expected exit 2, got $rc: $out"; fi

echo ""
echo "passed: $pass   failed: $fail"
if [[ "$fail" -gt 0 ]]; then
  echo ""
  echo "Failures:"
  for f in "${failures[@]}"; do echo "  - $f"; done
  exit 1
fi
exit 0
