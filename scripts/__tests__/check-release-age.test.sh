#!/usr/bin/env bash
#
# Scenario tests for scripts/check-release-age.mjs.
#
# Each case stages a head lockfile, a baseline lockfile, an optional
# allowlist and a publish-time fixture in a fresh temp dir, then runs
# the real check against them. No network: RELEASE_AGE_TIMES replaces
# the registry and RELEASE_AGE_NOW pins the clock, so the suite is
# deterministic and stays green as the wall clock advances.
#
# Usage:
#   bash scripts/__tests__/check-release-age.test.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CHECK_SCRIPT="$SCRIPT_DIR/check-release-age.mjs"

if [[ ! -f "$CHECK_SCRIPT" ]]; then
  echo "ERROR: $CHECK_SCRIPT not found." >&2
  exit 2
fi

# Pinned clock. Everything below is expressed relative to it.
#   cutoff at 3 days = 2026-09-15T00:00:00Z
#   OLD   published 2026-09-10 → 8 days  → passes
#   YOUNG published 2026-09-17 → 1 day   → violates
NOW='2026-09-18T00:00:00Z'
EXPIRES_OK='2026-10-01'     # inside [today, today+90d]
EXPIRES_PAST='2026-09-17'   # yesterday
EXPIRES_FAR='2027-01-30'    # > today+90d

TMP_DIRS=()
# shellcheck disable=SC2317  # invoked via `trap cleanup EXIT`
cleanup() {
  local d
  for d in "${TMP_DIRS[@]:-}"; do
    [[ -n "${d:-}" && -d "$d" ]] && rm -rf "$d"
  done
}
trap cleanup EXIT

R='https://registry.npmjs.org'

# lockfile <path> <name@version>...
lockfile() {
  local out="$1"; shift
  local entries=''
  local spec name version
  for spec in "$@"; do
    name="${spec%@*}"
    version="${spec##*@}"
    [[ -n "$entries" ]] && entries+=','
    entries+="\"node_modules/${name}\":{\"version\":\"${version}\",\"resolved\":\"${R}/${name}/-/x.tgz\"}"
  done
  printf '{"lockfileVersion":3,"packages":{"":{"name":"t"}%s%s}}\n' \
    "${entries:+,}" "$entries" > "$out"
}

mktmp() {
  local d
  d="$(mktemp -d)"
  TMP_DIRS+=("$d")
  cat > "$d/times.json" <<'JSON'
{
  "old-pkg":   { "1.0.0": "2026-09-10T00:00:00.000Z", "2.0.0": "2026-09-10T00:00:00.000Z" },
  "young-pkg": { "1.0.0": "2026-09-10T00:00:00.000Z", "2.0.0": "2026-09-17T00:00:00.000Z" }
}
JSON
  echo "$d"
}

pass=0
fail=0
failures=()

# run <label> <expected-exit> <dir> [extra env assignments...]
run() {
  local label="$1" expected="$2" dir="$3"; shift 3
  local out actual
  out="$(cd "$dir" && env \
    RELEASE_AGE_REPO_ROOT="$dir" \
    RELEASE_AGE_BASELINE="$dir/baseline.json" \
    RELEASE_AGE_TIMES="$dir/times.json" \
    RELEASE_AGE_NOW="$NOW" \
    "$@" node "$CHECK_SCRIPT" 2>&1)"
  actual=$?
  if [[ "$actual" == "$expected" ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    failures+=("$label: expected exit $expected, got $actual"$'\n'"$out")
  fi
}

# 1. Nothing new between baseline and head.
d="$(mktmp)"
lockfile "$d/baseline.json" 'old-pkg@1.0.0'
lockfile "$d/package-lock.json" 'old-pkg@1.0.0'
run 'no new versions' 0 "$d"

# 2. New version, comfortably past the cutoff.
d="$(mktmp)"
lockfile "$d/baseline.json" 'old-pkg@1.0.0'
lockfile "$d/package-lock.json" 'old-pkg@2.0.0'
run 'new version old enough' 0 "$d"

# 3. New version inside the cooldown.
d="$(mktmp)"
lockfile "$d/baseline.json" 'young-pkg@1.0.0'
lockfile "$d/package-lock.json" 'young-pkg@2.0.0'
run 'new version too young' 1 "$d"

# 4. The load-bearing property: a version already in the baseline is
#    never re-aged, even when it is younger than the cutoff. This is
#    what the resolver-side cooldown got wrong.
d="$(mktmp)"
lockfile "$d/baseline.json" 'young-pkg@2.0.0'
lockfile "$d/package-lock.json" 'young-pkg@2.0.0'
run 'young version already in baseline is not re-checked' 0 "$d"

# 5. Too young, but validly allowlisted.
d="$(mktmp)"
lockfile "$d/baseline.json" 'young-pkg@1.0.0'
lockfile "$d/package-lock.json" 'young-pkg@2.0.0'
cat > "$d/release-age-allowlist.json" <<JSON
[{"package":"young-pkg","version":"2.0.0","reason":"@vlzware: CVE fix, reviewed by hand","expires":"$EXPIRES_OK"}]
JSON
run 'allowlisted' 0 "$d"

# 6. Allowlist entry past its expiry grants nothing.
d="$(mktmp)"
lockfile "$d/baseline.json" 'young-pkg@1.0.0'
lockfile "$d/package-lock.json" 'young-pkg@2.0.0'
cat > "$d/release-age-allowlist.json" <<JSON
[{"package":"young-pkg","version":"2.0.0","reason":"@vlzware: stale","expires":"$EXPIRES_PAST"}]
JSON
run 'allowlist expired' 1 "$d"

# 7. Expiry beyond the 90-day ceiling.
d="$(mktmp)"
lockfile "$d/baseline.json" 'young-pkg@1.0.0'
lockfile "$d/package-lock.json" 'young-pkg@2.0.0'
cat > "$d/release-age-allowlist.json" <<JSON
[{"package":"young-pkg","version":"2.0.0","reason":"@vlzware: too far out","expires":"$EXPIRES_FAR"}]
JSON
run 'allowlist expiry too far out' 1 "$d"

# 8. Reason without an owner handle.
d="$(mktmp)"
lockfile "$d/baseline.json" 'young-pkg@1.0.0'
lockfile "$d/package-lock.json" 'young-pkg@2.0.0'
cat > "$d/release-age-allowlist.json" <<JSON
[{"package":"young-pkg","version":"2.0.0","reason":"no owner prefix","expires":"$EXPIRES_OK"}]
JSON
run 'allowlist reason missing handle' 1 "$d"

# 9. Fail closed: a package the registry does not answer for.
d="$(mktmp)"
lockfile "$d/baseline.json" 'old-pkg@1.0.0'
lockfile "$d/package-lock.json" 'old-pkg@1.0.0' 'unknown-pkg@1.0.0'
run 'unresolvable publish time fails closed' 1 "$d"

# 10. Non-registry sources carry no publish time and are out of scope.
d="$(mktmp)"
lockfile "$d/baseline.json" 'old-pkg@1.0.0'
printf '%s\n' '{"lockfileVersion":3,"packages":{"":{"name":"t"},"node_modules/old-pkg":{"version":"1.0.0","resolved":"https://registry.npmjs.org/old-pkg/-/x.tgz"},"node_modules/linked":{"version":"9.9.9","link":true},"node_modules/from-git":{"version":"9.9.9","resolved":"git+ssh://git@github.com/x/y.git#abc"}}}' \
  > "$d/package-lock.json"
run 'link and git sources are skipped' 0 "$d"

# 11. Advisory bypass waives an age finding — the vulnerability-PR path.
d="$(mktmp)"
lockfile "$d/baseline.json" 'young-pkg@1.0.0'
lockfile "$d/package-lock.json" 'young-pkg@2.0.0'
run 'advisory bypass waives age finding' 0 "$d" RELEASE_AGE_ADVISORY_BYPASS=1

# 12. The bypass does not waive "could not verify" — only "too young".
d="$(mktmp)"
lockfile "$d/baseline.json" 'old-pkg@1.0.0'
lockfile "$d/package-lock.json" 'old-pkg@1.0.0' 'unknown-pkg@1.0.0'
run 'advisory bypass does not waive lookup failure' 1 "$d" RELEASE_AGE_ADVISORY_BYPASS=1

# 13. Missing head lockfile is a setup error, not a policy violation.
d="$(mktmp)"
lockfile "$d/baseline.json" 'old-pkg@1.0.0'
run 'missing lockfile exits 2' 2 "$d"

# 14. Missing baseline is likewise a setup error — never an empty baseline.
d="$(mktmp)"
lockfile "$d/package-lock.json" 'old-pkg@1.0.0'
rm -f "$d/baseline.json"
run 'missing baseline exits 2' 2 "$d"

echo "release-age gate: $pass passed, $fail failed"
if ((fail > 0)); then
  printf '\n%s\n' "${failures[@]}"
  exit 1
fi
