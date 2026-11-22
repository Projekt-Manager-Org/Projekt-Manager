#!/usr/bin/env bash
#
# Scenario tests for scripts/check-section-citations.mjs.
#
# Each case builds a throwaway git repository, points the check at it via
# $SECTION_CITATIONS_ROOT, and asserts the exit code. The must-NOT-fail
# cases matter as much as the dead ones: a check that flags a live
# citation gets muted.
#
# Exits 0 when every case matches its expected code; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/check-section-citations.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHECK="$REPO_ROOT/scripts/check-section-citations.mjs"

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

# A fresh fixture repository per case. `index.md` exists in `docs/spec/`
# and `docs/spec/ui/`; `setup.md` in two ops directories, each with a
# section the other lacks.
# shellcheck disable=SC2016  # the backticks are markdown, not expansions
stage() {
  local d
  d="$(mktemp -d)"
  TMP_DIRS+=("$d")
  mkdir -p "$d/docs/spec/ui" "$d/docs/ops/backup" "$d/docs/ops/binary-key" "$d/src" \
    "$d/src/server/db/migrations" "$d/src/server/db/baseline/head"
  printf '# Data Model\n\n### 5.1 Project Entity\n\n### 5.2 User\n\n```md\n### 5.9 Not a heading\n```\n' \
    >"$d/docs/spec/data-model.md"
  printf '# Spec\n\n## 3. Workflow States\n' >"$d/docs/spec/index.md"
  printf '# UI\n\n## 8. Views\n' >"$d/docs/spec/ui/index.md"
  printf '# Backup setup\n\n## 1. Bucket\n' >"$d/docs/ops/backup/setup.md"
  printf '# Key setup\n\n## 2. Keypair\n' >"$d/docs/ops/binary-key/setup.md"
  git -C "$d" init --quiet
  git -C "$d" add -A >/dev/null 2>&1
  echo "$d"
}

# Writes a file into the fixture and stages it, so `git ls-files` sees it.
write_file() {
  local dir="$1" file="$2" body="$3"
  mkdir -p "$(dirname "$dir/$file")"
  printf '%s\n' "$body" >"$dir/$file"
  git -C "$dir" add "$file" >/dev/null 2>&1
}

pass=0
fail=0
failures=()

assert_case() {
  local expected="$1" label="$2" dir="$3"
  local actual
  # A timeout, so a regex that backtracks out of control fails the case
  # (124) instead of hanging the CI job.
  SECTION_CITATIONS_ROOT="$dir" timeout 20 node "$CHECK" >/dev/null 2>&1
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

echo "Case: the real repository passes its own check"
assert_case 0 "real repository in sync" "$REPO_ROOT"

echo "Case: a live citation in a code comment"
d="$(stage)"
write_file "$d" src/a.ts '// Fields: data-model.md §5.1.'
assert_case 0 "live citation" "$d"

echo "Case: a citation to a deleted section"
# The regression this check exists for: data-model.md's §5.21 outlived
# its section in two services.
d="$(stage)"
write_file "$d" src/a.ts '// Fields: data-model.md §5.21.'
assert_case 1 "dead citation" "$d"

echo "Case: a citation to a file that does not exist"
d="$(stage)"
write_file "$d" src/a.ts '// See gone.md §1.'
assert_case 1 "missing file" "$d"

echo "Case: a dead citation wrapped across // comment lines"
# `git grep` misses these; the check must not.
d="$(stage)"
write_file "$d" src/a.ts $'// Fields: data-model.md\n// §5.21 holds them.'
assert_case 1 "dead, wrapped //" "$d"

echo "Case: a dead citation wrapped inside a JSDoc block"
d="$(stage)"
write_file "$d" src/a.ts $'/**\n * Fields: data-model.md §\n * 5.21 holds them.\n */'
assert_case 1 "dead, wrapped *" "$d"

echo "Case: a dead citation wrapped across # comment lines"
d="$(stage)"
write_file "$d" src/a.sh $'# Fields: data-model.md\n# §5.21 holds them.'
assert_case 1 "dead, wrapped #" "$d"

echo "Case: a dead citation wrapped across -- comment lines"
d="$(stage)"
write_file "$d" src/a.sql $'-- Fields: data-model.md\n-- §5.21 holds them.'
assert_case 1 "dead, wrapped --" "$d"

echo "Case: a blank line ends a claim"
# Must pass: the name and the number are in different paragraphs.
d="$(stage)"
write_file "$d" docs/notes.md $'See data-model.md\n\n§5.21 is something else.'
assert_case 0 "no claim across a blank line" "$d"

echo "Case: whitespace-only lines after a file name"
# Must pass, and fast. A looser line-break pattern backtracked
# exponentially here: 9 such lines took over 30 s.
d="$(stage)"
write_file "$d" src/a.sh "# see docs/ops/backup/setup.md$(printf '\n        %.0s' {1..40})"
assert_case 0 "whitespace-only lines" "$d"

echo "Case: a list claims each number"
d="$(stage)"
write_file "$d" src/a.ts '// Fields: data-model.md §5.1, §5.2 and §5.21.'
assert_case 1 "dead number in a list" "$d"

echo "Case: a live list"
d="$(stage)"
write_file "$d" src/a.ts '// Fields: data-model.md §5.1 / §5.2.'
assert_case 0 "live list" "$d"

echo "Case: a date-named section is not a claim"
# ADR history headings are dates: `§ 2026-04-23` is not section 2026.
d="$(stage)"
write_file "$d" docs/notes.md 'See [the ADR](spec/index.md) § 2026-04-23.'
assert_case 0 "date section" "$d"

echo "Case: a range is not shortened into a claim"
# Must pass: `§5.1-5.2` is no claim — not a claim of the parent §5.
d="$(stage)"
write_file "$d" src/a.ts '// Fields: data-model.md §5.1-5.2.'
assert_case 0 "range not shortened" "$d"

echo "Case: a heading with a trailing dot, cited with a space after §"
d="$(stage)"
write_file "$d" src/a.ts '// Adjacency: index.md § 3.'
assert_case 0 "## 3. heading, § 3" "$d"

echo "Case: a number inside fenced code is not a heading"
d="$(stage)"
write_file "$d" src/a.ts '// See data-model.md §5.9.'
assert_case 1 "fenced pseudo-heading" "$d"

echo "Case: a bare name prefers docs/spec/"
# Must pass: `index.md` is also `docs/spec/ui/index.md`, which has no §3.
d="$(stage)"
write_file "$d" src/a.ts '// Workflow: spec index.md §3.'
assert_case 0 "docs/spec/ preferred" "$d"

echo "Case: a bare name beside the citing file wins"
# Must pass: `setup.md §1` in docs/ops/backup/ means the backup setup.md.
d="$(stage)"
write_file "$d" docs/ops/backup/notes.md 'Lock the bucket first (setup.md §1).'
assert_case 0 "sibling preferred" "$d"

echo "Case: a bare name beside the citing file wins over docs/spec/"
# Must pass: docs/spec/index.md has no §7; the one beside the citer has.
d="$(stage)"
write_file "$d" docs/ops/backup/index.md $'# Backup\n\n## 7. Drills'
write_file "$d" docs/ops/backup/notes.md 'Drill monthly (index.md §7).'
assert_case 0 "sibling before docs/spec/" "$d"

echo "Case: a bare name matching several files"
d="$(stage)"
write_file "$d" docs/notes.md 'See setup.md §1.'
assert_case 1 "ambiguous name" "$d"

echo "Case: a partial path pins the file"
d="$(stage)"
write_file "$d" docs/notes.md 'See binary-key/setup.md §2.'
assert_case 0 "partial path" "$d"

echo "Case: a full path to a deleted section"
d="$(stage)"
write_file "$d" README.md 'See docs/spec/data-model.md §5.21.'
assert_case 1 "dead, full path" "$d"

echo "Case: a claim in link text resolves through the link target"
# Must pass: the text's bare `index.md` would pick docs/spec/index.md,
# which has no §8; the target says the UI one is meant.
d="$(stage)"
write_file "$d" docs/spec/notes.md 'See [index.md §8](ui/index.md#8-views).'
assert_case 0 "link text, target wins" "$d"

echo "Case: a link followed by a live section number"
d="$(stage)"
write_file "$d" docs/notes.md 'See [the model](spec/data-model.md) §5.1.'
assert_case 0 "link then live §" "$d"

echo "Case: a dead link target is lychee's to report"
d="$(stage)"
write_file "$d" docs/notes.md 'See [data-model.md §5.1](spec/gone.md#51-x).'
assert_case 0 "dead link target skipped" "$d"

echo "Case: a link followed by a dead section number"
d="$(stage)"
write_file "$d" docs/notes.md 'See [the model](spec/data-model.md) §5.21.'
assert_case 1 "link then dead §" "$d"

echo "Case: a named citation is not a claim"
d="$(stage)"
write_file "$d" src/a.ts '// See ARCHITECTURE.md § Design Decisions.'
assert_case 0 "named citation" "$d"

echo "Case: the baseline SQL is not scanned"
# Editing it changes the migration hash; its citations cannot be fixed
# without a schema-change recovery.
d="$(stage)"
write_file "$d" src/server/db/migrations/0000_baseline.sql '-- data-model.md §5.21'
write_file "$d" src/server/db/baseline/head/10-x.sql '-- data-model.md §5.21'
assert_case 0 "migrations/ and baseline/ excluded" "$d"

echo "Case: an untracked file is not scanned"
d="$(stage)"
printf '// data-model.md §5.21\n' >"$d/src/untracked.ts"
assert_case 0 "untracked file" "$d"

echo "Case: not a git work tree"
d="$(mktemp -d)"
TMP_DIRS+=("$d")
assert_case 2 "no repository" "$d"

echo
echo "Summary: $pass passed, $fail failed"
if ((fail > 0)); then
  printf '  %s\n' "${failures[@]}"
  exit 1
fi
exit 0
