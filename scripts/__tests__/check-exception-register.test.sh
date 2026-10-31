#!/usr/bin/env bash
#
# Scenario tests for scripts/check-exception-register.sh.
#
# Each case stages exception-register.yaml and the sources it covers in a
# fresh temp dir and runs the real check against it via $REGISTER_REPO_ROOT.
# A failure case also matches the finding: an exit code alone cannot tell
# which rule fired.
#
# Usage:
#   bash scripts/__tests__/check-exception-register.test.sh

set -u

# The check reads the local date; pin both sides to one clock so the
# boundary cases cannot straddle midnight between UTC and local time.
export TZ=UTC

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CHECK_SCRIPT="$SCRIPT_DIR/check-exception-register.sh"

if [[ ! -x "$CHECK_SCRIPT" ]]; then
  echo "ERROR: $CHECK_SCRIPT not executable. chmod +x and try again." >&2
  exit 2
fi

TODAY="$(date -u +%F)"
PLUS_30="$(date -u -d "$TODAY +30 days" +%F)"
PLUS_90="$(date -u -d "$TODAY +90 days" +%F)"
PLUS_91="$(date -u -d "$TODAY +91 days" +%F)"
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
  echo "$d"
}

pass=0
fail=0
failures=()

# $1 label, $2 dir, $3 base dir (empty: no --base-dir).
run_check() {
  if [[ -n "$3" ]]; then
    REGISTER_REPO_ROOT="$2" bash "$CHECK_SCRIPT" --base-dir "$3" 2>/dev/null
  else
    REGISTER_REPO_ROOT="$2" bash "$CHECK_SCRIPT" 2>/dev/null
  fi
}

assert_ok() {
  local label="$1" dir="$2" base="${3:-}"
  local out rc
  out="$(run_check "$label" "$dir" "$base")"
  rc=$?
  if [[ "$rc" == 0 ]]; then
    pass=$((pass + 1))
    echo "  PASS — $label (exit 0)"
  else
    fail=$((fail + 1))
    failures+=("$label: expected exit 0, got $rc: $out")
    echo "  FAIL — $label (expected exit 0, got $rc)"
  fi
}

assert_finding() {
  local label="$1" dir="$2" needle="$3" base="${4:-}"
  local out rc
  out="$(run_check "$label" "$dir" "$base")"
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

pkg_override() {
  printf '{ "name": "x", "overrides": { "left-pad": "^1.0.0" } }\n'
}

# One valid row; failure cases derive from it by editing one line.
register_row() {
  cat <<EOF
exceptions:
  - covers:
      - ${1:-npm-override:left-pad}
    owner: '@vlzware'
    reason: lifts left-pad above its parent's vulnerable pin
    drop_when: the parent pins a fixed left-pad
    review_by: ${2:-$PLUS_30}
EOF
}

renovate() {
  mkdir -p "$1/.github"
  cat > "$1/.github/renovate.json"
}

# -------------------------------------------------------------
# Baseline
# -------------------------------------------------------------
dir="$(mktmp)"
assert_ok "OK-no-register-no-exceptions" "$dir"

dir="$(mktmp)"
pkg_override > "$dir/package.json"
register_row > "$dir/exception-register.yaml"
assert_ok "OK-override-with-row" "$dir"

# -------------------------------------------------------------
# Completeness: an exception needs a row, a row needs its exception.
# -------------------------------------------------------------
dir="$(mktmp)"
pkg_override > "$dir/package.json"
assert_finding "FAIL-no-register" "$dir" "npm-override:left-pad: unregistered"

dir="$(mktmp)"
pkg_override > "$dir/package.json"
register_row npm-override:other > "$dir/exception-register.yaml"
assert_finding "FAIL-override-unregistered" "$dir" "npm-override:left-pad: unregistered"
assert_finding "FAIL-row-stale" "$dir" "covers: npm-override:other: no such exception"

dir="$(mktmp)"
register_row > "$dir/exception-register.yaml"
assert_finding "FAIL-row-stale-no-sources" "$dir" "covers: npm-override:left-pad: no such exception"

# npm scopes an override by nesting; each leaf is its own exception, so a
# second child under a registered parent needs a row too. "." is the
# parent itself.
dir="$(mktmp)"
printf '{ "overrides": { "a": { "b": "1.0.0", "c": "2.0.0" } } }\n' > "$dir/package.json"
register_row "npm-override:a>b" > "$dir/exception-register.yaml"
assert_finding "FAIL-nested-override-sibling-unregistered" "$dir" "npm-override:a>c: unregistered"

dir="$(mktmp)"
printf '{ "overrides": { "a": { ".": "3.0.0", "b": "1.0.0" } } }\n' > "$dir/package.json"
register_row "npm-override:a" | sed '3a\      - npm-override:a>b' > "$dir/exception-register.yaml"
assert_ok "OK-nested-override-dot-and-child" "$dir"

# -------------------------------------------------------------
# Type shims: an ambient `declare module '<pkg>'` in a script .d.ts
# replaces the package's own types. Not shims: a .d.ts with a top-level
# import/export (a module: `declare module` augments), a wildcard
# (`'*.css'`), and anything under node_modules or .claude (worktrees).
# -------------------------------------------------------------
dir="$(mktmp)"
mkdir -p "$dir/src/types"
printf "declare module 'archiver' {\n  import * as stream from 'node:stream';\n}\n" > "$dir/src/types/archiver.d.ts"
assert_finding "FAIL-type-shim-unregistered" "$dir" "type-shim:archiver: unregistered"
register_row type-shim:archiver > "$dir/exception-register.yaml"
assert_ok "OK-type-shim-with-row" "$dir"

dir="$(mktmp)"
mkdir -p "$dir/src" "$dir/node_modules/x" "$dir/.claude/worktrees/w/src"
printf "import 'fastify';\ndeclare module 'fastify' {\n  interface FastifyRequest { user: string }\n}\n" > "$dir/src/augment.d.ts"
printf "declare module '*.module.css' {\n  const c: Record<string, string>;\n  export default c;\n}\n" > "$dir/src/css.d.ts"
printf "declare module 'vendored' {}\n" > "$dir/node_modules/x/index.d.ts"
printf "declare module 'old-branch-shim' {}\n" > "$dir/.claude/worktrees/w/src/shim.d.ts"
assert_ok "OK-not-shims" "$dir"

# -------------------------------------------------------------
# Renovate: anything it is told to skip. A package rule is keyed on the
# packages it names; a setting on its path (`/lockFileMaintenance`).
# -------------------------------------------------------------
dir="$(mktmp)"
renovate "$dir" <<'EOF'
{ "ignoreDeps": ["baz"],
  "packageRules": [ { "matchPackageNames": ["foo/bar"], "enabled": false },
                    { "matchPackageNames": ["ok"], "groupName": "g" } ] }
EOF
assert_finding "FAIL-renovate-rule-disabled-unregistered" "$dir" "renovate-disabled:foo/bar: unregistered"
assert_finding "FAIL-renovate-ignoreDeps-unregistered" "$dir" "renovate-disabled:baz: unregistered"
register_row renovate-disabled:foo/bar | sed '3a\      - renovate-disabled:baz' > "$dir/exception-register.yaml"
assert_ok "OK-renovate-with-row" "$dir"

dir="$(mktmp)"
renovate "$dir" <<'EOF'
{ "packageRules": [ { "matchDatasources": ["docker"], "enabled": false } ] }
EOF
assert_finding "FAIL-renovate-rule-disabled-unnamed" "$dir" "enabled: false must list matchPackageNames"

dir="$(mktmp)"
renovate "$dir" <<'EOF'
{ "lockFileMaintenance": { "enabled": false, "schedule": ["before 9am"] },
  "ignorePaths": ["docker/**"],
  "enabledManagers": ["npm"],
  "includePaths": ["src/**"] }
EOF
assert_finding "FAIL-renovate-setting-disabled" "$dir" "renovate-disabled:/lockFileMaintenance: unregistered"
assert_finding "FAIL-renovate-ignorePaths" "$dir" "renovate-disabled:/ignorePaths/docker/**: unregistered"
assert_finding "FAIL-renovate-enabledManagers" "$dir" "renovate-disabled:/enabledManagers: unregistered"
assert_finding "FAIL-renovate-includePaths" "$dir" "renovate-disabled:/includePaths: unregistered"

dir="$(mktmp)"
renovate "$dir" <<'EOF'
{ "enabled": false, "lockFileMaintenance": { "enabled": true } }
EOF
assert_finding "FAIL-renovate-off-entirely" "$dir" "renovate-disabled:/: unregistered"

# -------------------------------------------------------------
# Row contract
# -------------------------------------------------------------
reg_case() {
  local label="$1" needle="$2" edit="$3"
  local d
  d="$(mktmp)"
  pkg_override > "$d/package.json"
  register_row | sed "$edit" > "$d/exception-register.yaml"
  assert_finding "$label" "$d" "$needle"
}
reg_case "FAIL-no-owner" "owner: must be" "/owner:/d"
reg_case "FAIL-bad-owner" "owner: must be" "s/'@vlzware'/'@-x'/"
reg_case "FAIL-no-reason" "reason: missing or empty" "/reason:/d"
reg_case "FAIL-no-drop_when" "drop_when: missing or empty" "/drop_when:/d"
reg_case "FAIL-no-review_by" "review_by: missing" "/review_by:/d"
reg_case "FAIL-quoted-date" "review_by: must be a bare YYYY-MM-DD date" "s/review_by: .*/review_by: '$PLUS_30'/"
reg_case "FAIL-lapsed" "review_by: lapsed" "s/review_by: .*/review_by: $YESTERDAY/"
reg_case "FAIL-too-far" "review_by: too far" "s/review_by: .*/review_by: $PLUS_91/"
reg_case "FAIL-unknown-key" "scope: unknown key" "\$a\    scope: dev"
reg_case "FAIL-unknown-kind" "covers: shim:left-pad: unknown kind" "s/npm-override:left-pad/shim:left-pad/"
reg_case "FAIL-empty-covers" "covers: must be a non-empty list" "/      - npm-override/d"
reg_case "FAIL-top-level-key" "rows: top-level key not allowed" "1i\rows: []"
reg_case "FAIL-covered-twice" "npm-override:left-pad: covered more than once" "\$a\  - covers: [npm-override:left-pad]\n    owner: '@vlzware'\n    reason: r\n    drop_when: d\n    review_by: $PLUS_30"

dir="$(mktmp)"
pkg_override > "$dir/package.json"
register_row npm-override:left-pad "$TODAY" > "$dir/exception-register.yaml"
assert_ok "OK-boundary-today" "$dir"
register_row npm-override:left-pad "$PLUS_90" > "$dir/exception-register.yaml"
assert_ok "OK-boundary-plus-90" "$dir"

# -------------------------------------------------------------
# --base-dir: a lapsed row unchanged from the base passes the PR gate
# (the nightly owns it); an edited one does not.
# -------------------------------------------------------------
dir="$(mktmp)"
mkdir -p "$dir/base"
pkg_override > "$dir/package.json"
register_row npm-override:left-pad "$YESTERDAY" > "$dir/exception-register.yaml"
cp "$dir/exception-register.yaml" "$dir/base/exception-register.yaml"
assert_ok "OK-base-lapsed-unchanged" "$dir" "$dir/base"
assert_finding "FAIL-lapsed-unchanged-without-base" "$dir" "review_by: lapsed"
register_row npm-override:left-pad "$(date -u -d "$TODAY -2 days" +%F)" > "$dir/base/exception-register.yaml"
assert_finding "FAIL-base-lapsed-edited" "$dir" "review_by: lapsed" "$dir/base"

dir="$(mktmp)"
REGISTER_REPO_ROOT="$dir" bash "$CHECK_SCRIPT" --base-dir >/dev/null 2>&1
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
