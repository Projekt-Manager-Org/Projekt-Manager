#!/usr/bin/env bash
#
# Scenario tests for scripts/check-doc-paths.sh.
#
# A drift check that cannot fail is worse than no check: it reports green
# forever and everyone stops reading it. Each case below builds a throwaway
# git repository, points the check at it via $DOC_PATHS_ROOT, and asserts
# the exit code.
#
# The must-NOT-fail cases carry the weight here. This check reads prose,
# and prose legitimately contains globs, line-number citations, symbol
# pointers and extensionless module names. A checker that flags those gets
# muted within a week — so every one of those forms has a case below.
#
# Exits 0 when every case matches its expected code; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/check-doc-paths.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHECK="$REPO_ROOT/scripts/check-doc-paths.sh"

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

# A fresh fixture repository per case, so a mutation cannot leak sideways.
# Carries a small source tree the docs can cite: a plain file, an
# extensionless-resolvable module, and a gitignored directory.
#
# `review/` exists to exercise prefix DERIVATION. It is not one of the
# five directories the check used to hardcode, so a case citing a dead
# path under it fails only if the prefix set really is read from
# `git ls-files`.
stage() {
  local d
  d="$(mktemp -d)"
  TMP_DIRS+=("$d")
  mkdir -p "$d/src/server/db" "$d/src/ui/kanban" "$d/scripts/backup" "$d/docs" "$d/review"
  : >"$d/src/server/db/connection.ts"
  : >"$d/src/ui/kanban/KanbanBoard.tsx"
  : >"$d/scripts/backup/load-drill-key.sh"
  : >"$d/review/conventions-shell.md"
  printf 'docs/generated/\n' >"$d/.gitignore"
  mkdir -p "$d/docs/generated"
  git -C "$d" init --quiet
  git -C "$d" add -A >/dev/null 2>&1
  echo "$d"
}

# Writes a doc into the fixture and stages it, so `git ls-files` sees it.
write_doc() {
  local dir="$1" body="$2"
  printf '%s\n' "$body" >"$dir/docs/notes.md"
  git -C "$dir" add docs/notes.md >/dev/null 2>&1
}

pass=0
fail=0
failures=()

assert_case() {
  local expected="$1" label="$2" dir="$3"
  local actual
  DOC_PATHS_ROOT="$dir" bash "$CHECK" >/dev/null 2>&1
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

echo "Case: a cited path that exists"
d="$(stage)"
write_doc "$d" 'See `src/server/db/connection.ts` for the handle.'
assert_case 0 "live path reference" "$d"

echo "Case: a cited path that was deleted"
# The regression this check exists for — #306 found three of these in
# ARCHITECTURE.md alone.
d="$(stage)"
write_doc "$d" 'See `src/server/db/gone.ts` for the handle.'
assert_case 1 "dead path reference" "$d"

echo "Case: a line-number citation on a live path"
# Must pass. `schema.ts:149-162` is the repo's house style for pointing at
# a region; flagging it would break every precise citation in the spec.
d="$(stage)"
write_doc "$d" 'The pool lives at `src/server/db/connection.ts:12-30`.'
assert_case 0 "path:LINE citation" "$d"

echo "Case: a symbol pointer on a live path"
# Must pass. Both `file.ts:SYMBOL` and `file.ts::method` appear in the ADRs.
d="$(stage)"
write_doc "$d" 'See `src/server/db/connection.ts::openPool` and `src/server/db/connection.ts:POOL`.'
assert_case 0 "path:SYMBOL citation" "$d"

echo "Case: a line-number citation on a DEAD path"
# The suffix strip must not become an escape hatch — cutting at the colon
# still has to leave a path that resolves.
d="$(stage)"
write_doc "$d" 'The pool lives at `src/server/db/gone.ts:12-30`.'
assert_case 1 "path:LINE on dead path" "$d"

echo "Case: an extensionless module reference"
# Must pass. ARCHITECTURE.md cites `src/server/db/connection` (the module,
# not the file) when describing an import.
d="$(stage)"
write_doc "$d" 'Type-only imports from `src/server/db/connection` are allowed.'
assert_case 0 "extensionless module reference" "$d"

echo "Case: a glob"
# Must pass. `src/ui/**` is a lint-zone expression, not a file.
d="$(stage)"
write_doc "$d" 'A PR reaching from `src/ui/**` into `src/server/**` fails lint.'
assert_case 0 "glob expression" "$d"

echo "Case: a gitignored path that does not exist"
# Must FAIL. Being gitignored used to be an unconditional pass, which
# exempted every ignored path in the tree. The four demo-asset citations
# that need it are ALLOWLIST class (5), one line each.
#
# The previous version of this case created the file on disk, so `-e`
# matched and the gitignore branch was never actually exercised — the
# test passed for a reason unrelated to what it claimed to cover.
d="$(stage)"
write_doc "$d" 'The run writes `docs/generated/report.md`.'
assert_case 1 "gitignored path does not exist" "$d"

echo "Case: a dead path under a DERIVED top-level directory"
# Must FAIL. `review/` is tracked but was not in the hardcoded five, so
# every citation under it went unchecked. Pins that the prefix set comes
# from the tree.
d="$(stage)"
write_doc "$d" 'House style lives in `review/conventions-gone.md`.'
assert_case 1 "dead path under derived prefix" "$d"

echo "Case: a live path under a DERIVED top-level directory"
d="$(stage)"
write_doc "$d" 'House style lives in `review/conventions-shell.md`.'
assert_case 0 "live path under derived prefix" "$d"

echo "Case: a path under a directory this repository does not track"
# Must pass. `dist/` holds build output and is not a tracked top-level
# directory, so it is not this check's business — same for any
# third-party or runtime path that happens to contain a slash.
d="$(stage)"
write_doc "$d" 'The bundle lands at `dist/assets/index.js`.'
assert_case 0 "untracked top-level directory ignored" "$d"

echo "Case: a dead path inside a markdown LINK, not a code span"
# Must pass. Link targets are lychee's lane (separate lint step); this
# check owns code spans only. Overlapping them would double-report.
d="$(stage)"
write_doc "$d" 'See [the handle](src/server/db/gone.ts) for details.'
assert_case 0 "dead link target ignored" "$d"

echo "Case: an allowlisted illustrative path, in the document that owns it"
# Must pass. ARCHITECTURE.md's Supplier walkthrough names files the
# project does not have, on purpose.
d="$(stage)"
printf 'Create `src/server/services/SupplierService.ts` and `src/ui/suppliers/`.\n' >"$d/ARCHITECTURE.md"
git -C "$d" add ARCHITECTURE.md >/dev/null 2>&1
assert_case 0 "allowlisted path in its own document" "$d"

echo "Case: the same allowlisted path cited from a different document"
# Must FAIL. Entries are `document|path`: an exemption earned by the
# ARCHITECTURE.md walkthrough must not let the same filename pass
# unremarked in a spec or ADR that means it literally.
d="$(stage)"
write_doc "$d" 'Create `src/server/services/SupplierService.ts`.'
assert_case 1 "allowlisted path leaking to another document" "$d"

echo "Case: a path outside the scanned first segments"
# Must pass. `node_modules/...`, `dist/...` and bare filenames are not
# repository-source citations and carry no drift guarantee.
d="$(stage)"
write_doc "$d" 'Resolved from `node_modules/@types/gone` at build time.'
assert_case 0 "unscanned first segment" "$d"

echo "Case: the scan root is not a git work tree"
# Structural, not drift. Without a dedicated code the run would report
# "no tracked markdown" — the right code for the wrong reason.
d="$(mktemp -d)"
TMP_DIRS+=("$d")
assert_case 2 "not a git work tree" "$d"

echo "Case: a git work tree with no tracked markdown"
# Structural. An empty document set makes the scan pass vacuously; it
# must stop instead of reporting green over nothing.
d="$(mktemp -d)"
TMP_DIRS+=("$d")
git -C "$d" init --quiet
assert_case 2 "no tracked markdown" "$d"

echo
echo "Results: $pass passed, $fail failed"
if [[ "$fail" -gt 0 ]]; then
  printf '%s\n' "${failures[@]}" >&2
  exit 1
fi
exit 0
