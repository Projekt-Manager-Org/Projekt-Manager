#!/usr/bin/env bash
#
# Scenario tests for scripts/check-module-map.sh (AC-350).
#
# A coverage check that cannot fail is worse than no check. Each case
# stages a fixture repository — a small source tree plus a synthetic
# ARCHITECTURE.md — and points the check at it via $MODULE_MAP_ROOT.
#
# The ratchet cases matter most. A baseline that never shrinks is a
# permanent exemption list wearing a burn-down costume, so "an entry that
# is documented now must fail" gets the same weight as "an undocumented
# file must fail".
#
# Exits 0 when every case matches its expected code; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/check-module-map.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHECK="$REPO_ROOT/scripts/check-module-map.sh"

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

# Fixture: two source files under a gated directory, one under a
# directory with no subsection (must stay unchecked), and a doc that
# names only the first.
stage() {
  local d
  d="$(mktemp -d)"
  TMP_DIRS+=("$d")
  mkdir -p "$d/src/server/services" "$d/src/ungated" "$d/scripts"
  : >"$d/src/server/services/AlphaService.ts"
  : >"$d/src/server/services/BetaService.ts"
  : >"$d/src/ungated/Whatever.ts"
  cat >"$d/ARCHITECTURE.md" <<'DOC'
## Module Map

| Directory              | Owns   | Must NOT |
| ---------------------- | ------ | -------- |
| `src/server/services/` | Things | Nothing  |
| `src/ungated/`         | Things | Nothing  |

### Directory Detail

#### `src/server/services/`

- `AlphaService.ts` — the documented one

### Configuration Files

Nothing here.
DOC
  : >"$d/scripts/module-map-baseline.txt"
  git -C "$d" init --quiet
  git -C "$d" add -A >/dev/null 2>&1
  echo "$d"
}

pass=0
fail=0
failures=()

assert_case() {
  local expected="$1" label="$2" dir="$3"
  local actual
  MODULE_MAP_ROOT="$dir" bash "$CHECK" >/dev/null 2>&1
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
assert_case 0 "real repository covered" "$REPO_ROOT"

echo "Case: an undocumented file in a gated directory"
# The regression this check exists for — #306's invoices subsystem was
# exactly this, at scale.
assert_case 1 "undocumented file" "$(stage)"

echo "Case: the same file, recorded in the baseline"
# Must pass. The ratchet freezes the existing backlog so new files are
# gated from day one.
d="$(stage)"
echo "src/server/services/BetaService.ts" >"$d/scripts/module-map-baseline.txt"
assert_case 0 "baselined file" "$d"

echo "Case: a NEW undocumented file alongside a baselined one"
# Must fail. This is the whole point of a ratchet: the frozen set does
# not shelter files added after it.
d="$(stage)"
echo "src/server/services/BetaService.ts" >"$d/scripts/module-map-baseline.txt"
: >"$d/src/server/services/GammaService.ts"
git -C "$d" add -A >/dev/null 2>&1
assert_case 1 "new file beside a baselined one" "$d"

echo "Case: a baseline entry that is documented now"
# Must fail. Without this the baseline never shrinks and the burn-down
# is invisible.
d="$(stage)"
echo "src/server/services/AlphaService.ts" >"$d/scripts/module-map-baseline.txt"
assert_case 1 "stale baseline — file documented" "$d"

echo "Case: a baseline entry whose file was deleted"
# Same ratchet, other direction.
d="$(stage)"
printf 'src/server/services/BetaService.ts\nsrc/server/services/Gone.ts\n' >"$d/scripts/module-map-baseline.txt"
assert_case 1 "stale baseline — file deleted" "$d"

echo "Case: a directory with no Directory Detail subsection"
# Must pass. Coverage is opt-in by subsection: `src/ungated/` is
# documented at table level only and carries no per-file obligation.
d="$(stage)"
echo "src/server/services/BetaService.ts" >"$d/scripts/module-map-baseline.txt"
: >"$d/src/ungated/Another.ts"
git -C "$d" add -A >/dev/null 2>&1
assert_case 0 "ungated directory ignored" "$d"

echo "Case: adding a subsection opts the directory in"
# Must fail. The doc's own structure is the configuration — writing a
# `#### <dir>` heading is the act of accepting per-file coverage.
# Inserted INSIDE the Directory Detail block: the block ends at the next
# `### ` heading, so a subsection appended past it is out of scope.
d="$(stage)"
echo "src/server/services/BetaService.ts" >"$d/scripts/module-map-baseline.txt"
sed -i 's|^### Configuration Files$|#### `src/ungated/`\n\nNo files named here.\n\n### Configuration Files|' "$d/ARCHITECTURE.md"
assert_case 1 "new subsection gates its directory" "$d"

echo "Case: a subsection past the end of the Directory Detail block"
# Must pass — and this is a boundary, not a loophole: a `#### <dir>`
# heading under some later `### ` section is not part of the Directory
# Detail structure and gates nothing.
d="$(stage)"
echo "src/server/services/BetaService.ts" >"$d/scripts/module-map-baseline.txt"
printf '\n#### `src/ungated/`\n\nNo files named here.\n' >>"$d/ARCHITECTURE.md"
assert_case 0 "subsection outside the Detail block" "$d"

echo "Case: tests and nested directories are out of scope"
# Must pass. `__tests__/` is not architecture, and a nested directory
# opts in through its own subsection rather than its parent's.
d="$(stage)"
echo "src/server/services/BetaService.ts" >"$d/scripts/module-map-baseline.txt"
mkdir -p "$d/src/server/services/__tests__" "$d/src/server/services/nested"
: >"$d/src/server/services/__tests__/AlphaService.test.ts"
: >"$d/src/server/services/nested/Deep.ts"
git -C "$d" add -A >/dev/null 2>&1
assert_case 0 "tests and nested dirs out of scope" "$d"

echo "Case: a basename mentioned as part of a DIFFERENT path"
# Must fail. `is_named` used to be an unanchored substring test, so prose
# about `src/server/repositories/BetaService.ts` inside the
# `src/server/services/` subsection counted the services file as
# documented. Scoping to one subsection stops that across directories,
# not within one — which is exactly where cross-references appear.
d="$(stage)"
sed -i 's|^- `AlphaService.ts` — the documented one$|- `AlphaService.ts` — the documented one\n- see also `src/server/repositories/BetaService.ts`|' "$d/ARCHITECTURE.md"
assert_case 1 "basename inside another path" "$d"

echo "Case: a file named by its full repository path"
# Must pass. The delegated `### Configuration Files` table cites files as
# `src/config/permissions.ts`, so the anchoring must not reject a leading
# path — only a leading path belonging to a DIFFERENT directory.
d="$(stage)"
sed -i 's|^- `AlphaService.ts` — the documented one$|- `src/server/services/AlphaService.ts` — the documented one\n- `src/server/services/BetaService.ts` — also documented|' "$d/ARCHITECTURE.md"
assert_case 0 "full-path citation counts as documented" "$d"

echo "Case: a longer name must not cover a shorter one"
# Must fail. `BetaService.ts` is not documented by prose about
# `SubBetaService.ts`. The longer file is staged for real so the only
# reason to fail is the coverage gap — otherwise the doc -> file
# direction would fail this case too and it would stop isolating the
# anchoring regression it exists for.
d="$(stage)"
: >"$d/src/server/services/SubBetaService.ts"
git -C "$d" add -A >/dev/null 2>&1
sed -i 's|^- `AlphaService.ts` — the documented one$|- `AlphaService.ts` — the documented one\n- `SubBetaService.ts` — a different file|' "$d/ARCHITECTURE.md"
assert_case 1 "longer name does not cover shorter" "$d"

# --- doc -> file: every name the section claims must still exist -------
#
# The direction #306 opened with and nothing caught: the Module Map named
# three deleted files for months. `check-doc-paths.sh` cannot see them —
# they are bare basenames — so the must-NOT-fire cases below are what
# keeps this direction from being reverted as noisy.

echo "Case: an extensioned name in prose that no longer exists"
# Must fail. This is the exact shape of the dead `bulk-download-reaper.ts`
# citation: prose, not a list item, so a list-only rule would miss it.
d="$(stage)"
echo "src/server/services/BetaService.ts" >"$d/scripts/module-map-baseline.txt"
sed -i 's|^- `AlphaService.ts` — the documented one$|- `AlphaService.ts` — the documented one\n\nThe `GoneService.ts` retires under e2e.|' "$d/ARCHITECTURE.md"
assert_case 1 "prose names a deleted file" "$d"

echo "Case: a bare stem leading a list item that no longer exists"
# Must fail. The shape of the dead `dataExchangeStore` citation —
# `src/state/` documents its stores without the extension.
d="$(stage)"
echo "src/server/services/BetaService.ts" >"$d/scripts/module-map-baseline.txt"
sed -i 's|^- `AlphaService.ts` — the documented one$|- `AlphaService.ts` — the documented one\n- `GhostService` — gone|' "$d/ARCHITECTURE.md"
assert_case 1 "list item names a deleted stem" "$d"

echo "Case: a type name in prose is not a file claim"
# Must pass, and this is the case that decides whether the direction is
# survivable. `BulkDownloadOrchestrator` named a deleted class, but
# `MutatingDatabase` and `AppError` sit in the same position and are
# live types. No lexical rule separates them, so bare prose identifiers
# are not checked at all.
d="$(stage)"
echo "src/server/services/BetaService.ts" >"$d/scripts/module-map-baseline.txt"
sed -i 's|^- `AlphaService.ts` — the documented one$|- `AlphaService.ts` — the documented one\n\nEvery service takes a `MutatingDatabase` and throws `AppError`.|' "$d/ARCHITECTURE.md"
assert_case 0 "type name in prose ignored" "$d"

echo "Case: a bare stem after the gloss separator is not a file claim"
# Must pass. The inventory entry is the prefix before ` — `; everything
# after it is prose about the entry.
d="$(stage)"
echo "src/server/services/BetaService.ts" >"$d/scripts/module-map-baseline.txt"
sed -i 's|^- `AlphaService.ts` — the documented one$|- `AlphaService.ts` — superseded `legacyAlpha` in the rewrite|' "$d/ARCHITECTURE.md"
assert_case 0 "stem after the gloss ignored" "$d"

echo "Case: a named file living in a nested directory resolves"
# Must pass. Coverage stops at direct children — a nested directory opts
# in through its own subsection — but a subsection may still NAME a file
# below it, so resolution walks the whole tree.
d="$(stage)"
echo "src/server/services/BetaService.ts" >"$d/scripts/module-map-baseline.txt"
mkdir -p "$d/src/server/services/invoice"
: >"$d/src/server/services/invoice/InvoiceRenderer.ts"
git -C "$d" add -A >/dev/null 2>&1
sed -i 's|^- `AlphaService.ts` — the documented one$|- `AlphaService.ts` — the documented one\n- `InvoiceRenderer.ts` — under invoice/|' "$d/ARCHITECTURE.md"
assert_case 0 "nested file resolves" "$d"

echo "Case: a type name in a bulleted sentence is not a file claim"
# Must pass, and it is the same rule as the prose case above — a bullet
# is not automatically an inventory entry. The citation form is a
# backticked name LEADING the item; a sentence that merely contains one
# is prose that happens to be bulleted, and `SseConnection` sits in
# exactly that position in the real `src/server/sse/` subsection.
d="$(stage)"
echo "src/server/services/BetaService.ts" >"$d/scripts/module-map-baseline.txt"
sed -i 's|^- `AlphaService.ts` — the documented one$|- `AlphaService.ts` — the documented one\n- Failure isolation keeps one broken `SseConnection` from stalling the fan-out.|' "$d/ARCHITECTURE.md"
assert_case 0 "type name in a bulleted sentence ignored" "$d"

echo "Case: a leading run of names is claimed in full"
# Must fail. Anchoring the citation to the START of the item must not
# shrink it to the first name: `src/state/` lists a dozen stores in one
# comma-separated run, and every one of them is an inventory entry.
d="$(stage)"
echo "src/server/services/BetaService.ts" >"$d/scripts/module-map-baseline.txt"
sed -i 's|^- `AlphaService.ts` — the documented one$|- `AlphaService.ts`, `GhostService` — the documented one and a dead one|' "$d/ARCHITECTURE.md"
assert_case 1 "dead name inside the leading run" "$d"

echo "Case: a full repository path is left to check-doc-paths.sh"
# Must pass. The documented escape hatch for citing a file this
# subsection does not own: a `/` puts it outside both citation forms, and
# the sibling checker resolves it repository-wide instead.
d="$(stage)"
echo "src/server/services/BetaService.ts" >"$d/scripts/module-map-baseline.txt"
sed -i 's|^- `AlphaService.ts` — the documented one$|- `AlphaService.ts` — the documented one\n- `src/server/repositories/GoneRepo.ts` — historical, resolved elsewhere|' "$d/ARCHITECTURE.md"
assert_case 0 "full path left to the sibling checker" "$d"

echo "Case: a directory whose subsection delegates its file list"
# Must pass. `src/config/` and `src/server/config/` both hand their
# per-file detail to the `### Configuration Files` table rather than
# repeat it. Without the delegation the check reports files as
# undocumented against a document that documents them — a checker bug
# that costs three entries of #306's burn-down to spurious duplication.
#
# The LINK is the trigger, not the directory name: delegation is
# doc-driven for the same reason gating is, so that a third delegating
# subsection needs no script edit. $1 is the subsection's opening
# sentence — the paired case below drops the link from it.
stage_delegated() {
  local d
  d="$(mktemp -d)"
  TMP_DIRS+=("$d")
  mkdir -p "$d/src/server/config" "$d/scripts"
  : >"$d/src/server/config/env.ts"
  cat >"$d/ARCHITECTURE.md" <<DOC
## Module Map

### Directory Detail

#### \`src/server/config/\`

$1

### Configuration Files

| What            | File                        |
| --------------- | --------------------------- |
| Env validation  | \`src/server/config/env.ts\` |
DOC
  : >"$d/scripts/module-map-baseline.txt"
  git -C "$d" init --quiet
  git -C "$d" add -A >/dev/null 2>&1
  echo "$d"
}
assert_case 0 "delegated file list counts as documented" \
  "$(stage_delegated 'Deployment-tunable values are indexed in [§ Configuration Files](#configuration-files) below.')"

echo "Case: the same table, not linked from the subsection"
# Must fail, and this is what makes the case above a test of the
# mechanism rather than of the fixture. A hard-coded list of delegating
# directories would pass both: the script would keep delegating after the
# sentence was deleted from ARCHITECTURE.md, silently.
assert_case 1 "no link, no delegation" \
  "$(stage_delegated 'Deployment-tunable values live in the Configuration Files table below.')"

echo "Case: a subsection with no direct children is still checked for dead names"
# Must fail. `src/ui/` holds no files of its own — every component lives
# in a feature subdirectory — so the file -> doc direction has nothing to
# say about it either way. The doc -> file direction very much does: the
# subsection backticks eight component files, and a rename leaves the
# citation behind. Excluding the directory bought no coverage and cost
# this check.
stage_nested_only() {
  local d
  d="$(mktemp -d)"
  TMP_DIRS+=("$d")
  mkdir -p "$d/src/ui/detail" "$d/scripts"
  : >"$d/src/ui/detail/PhotoGallery.tsx"
  cat >"$d/ARCHITECTURE.md" <<'DOC'
## Module Map

### Directory Detail

#### `src/ui/`

- `PhotoGallery.tsx` — the surviving one
- `RenamedAway.tsx` — the dead citation

### Configuration Files

Nothing here.
DOC
  : >"$d/scripts/module-map-baseline.txt"
  git -C "$d" init --quiet
  git -C "$d" add -A >/dev/null 2>&1
  echo "$d"
}
assert_case 1 "dead name in a nested-only directory" "$(stage_nested_only)"

echo "Case: deleting a subsection silently un-gates its directory"
# Must fail. Opting out is allowed — the error message says so — but
# doing it invisibly is how a gate dies. The stale-entry ratchet only
# catches this when the directory still has baseline entries, so a fully
# documented directory could be dropped with no signal at all.
# Two gated subsections, so removing one leaves the Directory Detail
# block intact — an empty block is a structural error (exit 2) and would
# mask the un-gating this case is about.
stage_two_gated() {
  local d
  d="$(stage)"
  sed -i 's|^### Configuration Files$|#### `src/ungated/`\n\n- `Whatever.ts` — documented\n\n### Configuration Files|' "$d/ARCHITECTURE.md"
  MODULE_MAP_ROOT="$d" bash "$CHECK" --update-baseline >/dev/null 2>&1
  echo "$d"
}

drop_services_subsection() {
  sed -i '/^#### `src\/server\/services\/`$/,/^#### `src\/ungated\/`$/{/^#### `src\/ungated\/`$/!d}' "$1/ARCHITECTURE.md"
}

d="$(stage_two_gated)"
drop_services_subsection "$d"
assert_case 1 "silently un-gated directory" "$d"

echo "Case: un-gating recorded in the baseline passes"
# Must pass. The gate is opt-out, not immovable — regenerating the
# baseline makes the removal a visible diff instead of a silent one.
d="$(stage_two_gated)"
drop_services_subsection "$d"
MODULE_MAP_ROOT="$d" bash "$CHECK" --update-baseline >/dev/null 2>&1
assert_case 0 "un-gating recorded in baseline" "$d"

echo "Case: --update-baseline makes a failing tree pass"
d="$(stage)"
MODULE_MAP_ROOT="$d" bash "$CHECK" --update-baseline >/dev/null 2>&1
assert_case 0 "regenerated baseline" "$d"

echo "Case: the Directory Detail block is missing"
# Structural, not drift. Without a dedicated code the run would gate
# nothing and report green over an empty scan.
d="$(stage)"
sed -i '/^### Directory Detail$/d; /^#### /d' "$d/ARCHITECTURE.md"
assert_case 2 "missing Directory Detail block" "$d"

echo "Case: ARCHITECTURE.md is missing entirely"
d="$(stage)"
rm "$d/ARCHITECTURE.md"
assert_case 2 "missing document" "$d"

echo
echo "Results: $pass passed, $fail failed"
if [[ "$fail" -gt 0 ]]; then
  printf '%s\n' "${failures[@]}" >&2
  exit 1
fi
exit 0
