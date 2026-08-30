#!/usr/bin/env bash
#
# Scenario tests for scripts/check-module-map.sh (AC-350).
#
# A coverage check that cannot fail is worse than no check. Each case
# stages a fixture repository — a small source tree plus a synthetic
# ARCHITECTURE.md — and points the check at it via $MODULE_MAP_ROOT.
#
# The must-NOT-fire cases matter most. A guard that fires on prose gets
# muted within a week, so "a type name is not a file claim" gets the same
# weight as "a dead citation must fail".
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
#
# `### Directory Notes` is in the base fixture, not appended by the few
# cases about it. Its absence is exit 2, so every case runs through the
# block — and the cases that are not about it still exercise the entry
# scan, rather than leaving it an unlit branch in a guard.
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

### Directory Notes

**`src/ungated/`** — the others.

### Configuration Files

Nothing here.
DOC
  git -C "$d" init --quiet
  git -C "$d" add -A >/dev/null 2>&1
  # The gating record is a required input — a fixture without one is
  # exit 2, so every case would fail on a missing file rather than on
  # what it is about. Generated rather than hand-written so it tracks
  # the fixture's own subsections.
  MODULE_MAP_ROOT="$d" bash "$CHECK" --update-gated >/dev/null 2>&1
  echo "$d"
}

# Append a list item to the fixture's one `### Directory Notes` entry.
# The entry runs to the next bold key or the end of the block, so
# inserting before the following `### ` heading lands inside it.
add_note_item() {
  sed -i "s|^### Configuration Files\$|${2}\n\n### Configuration Files|" "$1/ARCHITECTURE.md"
}

# Close the fixture's one coverage gap, so a case about something else
# is not also failing on `BetaService.ts`. The `AlphaService.ts` line
# survives, so cases that sed on it still match afterwards.
cover_beta() {
  sed -i 's|^- `AlphaService.ts` — the documented one$|- `AlphaService.ts` — the documented one\n- `BetaService.ts` — the other one|' "$1/ARCHITECTURE.md"
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

# Asserts on the REPORT, not the exit code. A name reported twice still
# exits 1, so dedup between the scoped and the document-wide pass — and
# the label a report line carries — are invisible to assert_case.
assert_report_case() {
  local expected="$1" pattern="$2" label="$3" dir="$4"
  local actual
  actual="$(MODULE_MAP_ROOT="$dir" bash "$CHECK" 2>&1 | grep -c -- "$pattern")"
  if [[ "$actual" == "$expected" ]]; then
    pass=$((pass + 1))
    echo "  PASS — $label ($actual matching line(s))"
  else
    fail=$((fail + 1))
    failures+=("$label: expected $expected matching line(s), got $actual")
    echo "  FAIL — $label (expected $expected matching line(s), got $actual)"
  fi
}

echo "Case: the real repository passes its own check"
assert_case 0 "real repository covered" "$REPO_ROOT"

echo "Case: an undocumented file in a gated directory"
# The regression this check exists for — #306's invoices subsystem was
# exactly this, at scale.
assert_case 1 "undocumented file" "$(stage)"

echo "Case: the same file, once the subsection names it"
# Must pass — and it is the only way out. #306's burn-down retired the
# coverage baseline, so there is no longer a list to defer a file to.
d="$(stage)"
cover_beta "$d"
assert_case 0 "documented file" "$d"

echo "Case: a NEW undocumented file in a covered directory"
# Must fail. Completing a subsection does not exempt what lands after it.
d="$(stage)"
cover_beta "$d"
: >"$d/src/server/services/GammaService.ts"
git -C "$d" add -A >/dev/null 2>&1
assert_case 1 "new file in a covered directory" "$d"

echo "Case: a directory with no Directory Detail subsection"
# Must pass. Coverage is opt-in by subsection: `src/ungated/` is
# documented at table level only and carries no per-file obligation.
d="$(stage)"
cover_beta "$d"
: >"$d/src/ungated/Another.ts"
git -C "$d" add -A >/dev/null 2>&1
assert_case 0 "ungated directory ignored" "$d"

echo "Case: adding a subsection opts the directory in"
# Must fail. The doc's own structure is the configuration — writing a
# `#### <dir>` heading is the act of accepting per-file coverage.
# Inserted INSIDE the Directory Detail block: the block ends at the next
# `### ` heading, so a subsection appended past it is out of scope.
d="$(stage)"
cover_beta "$d"
sed -i 's|^### Directory Notes$|#### `src/ungated/`\n\nNo files named here.\n\n### Directory Notes|' "$d/ARCHITECTURE.md"
assert_case 1 "new subsection gates its directory" "$d"

echo "Case: a subsection past the end of the Directory Detail block"
# Must pass — and this is a boundary, not a loophole: a `#### <dir>`
# heading under some later `### ` section is not part of the Directory
# Detail structure and gates nothing.
d="$(stage)"
cover_beta "$d"
printf '\n#### `src/ungated/`\n\nNo files named here.\n' >>"$d/ARCHITECTURE.md"
assert_case 0 "subsection outside the Detail block" "$d"

echo "Case: tests and nested directories are out of scope"
# Must pass. `__tests__/` is not architecture, and a nested directory
# opts in through its own subsection rather than its parent's.
d="$(stage)"
cover_beta "$d"
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
cover_beta "$d"
sed -i 's|^- `AlphaService.ts` — the documented one$|- `AlphaService.ts` — the documented one\n\nThe `GoneService.ts` retires under e2e.|' "$d/ARCHITECTURE.md"
assert_case 1 "prose names a deleted file" "$d"

echo "Case: a bare stem leading a list item that no longer exists"
# Must fail. The shape of the dead `dataExchangeStore` citation —
# `src/state/` documents its stores without the extension.
d="$(stage)"
cover_beta "$d"
sed -i 's|^- `AlphaService.ts` — the documented one$|- `AlphaService.ts` — the documented one\n- `GhostService` — gone|' "$d/ARCHITECTURE.md"
assert_case 1 "list item names a deleted stem" "$d"

echo "Case: a type name in prose is not a file claim"
# Must pass, and this is the case that decides whether the direction is
# survivable. `BulkDownloadOrchestrator` named a deleted class, but
# `MutatingDatabase` and `AppError` sit in the same position and are
# live types. No lexical rule separates them, so bare prose identifiers
# are not checked at all.
d="$(stage)"
cover_beta "$d"
sed -i 's|^- `AlphaService.ts` — the documented one$|- `AlphaService.ts` — the documented one\n\nEvery service takes a `MutatingDatabase` and throws `AppError`.|' "$d/ARCHITECTURE.md"
assert_case 0 "type name in prose ignored" "$d"

echo "Case: a bare stem after the gloss separator is not a file claim"
# Must pass. The inventory entry is the prefix before ` — `; everything
# after it is prose about the entry.
d="$(stage)"
cover_beta "$d"
sed -i 's|^- `AlphaService.ts` — the documented one$|- `AlphaService.ts` — superseded `legacyAlpha` in the rewrite|' "$d/ARCHITECTURE.md"
assert_case 0 "stem after the gloss ignored" "$d"

echo "Case: a named file living in a nested directory resolves"
# Must pass. Coverage stops at direct children — a nested directory opts
# in through its own subsection — but a subsection may still NAME a file
# below it, so resolution walks the whole tree.
d="$(stage)"
cover_beta "$d"
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
cover_beta "$d"
sed -i 's|^- `AlphaService.ts` — the documented one$|- `AlphaService.ts` — the documented one\n- Failure isolation keeps one broken `SseConnection` from stalling the fan-out.|' "$d/ARCHITECTURE.md"
assert_case 0 "type name in a bulleted sentence ignored" "$d"

echo "Case: a leading run of names is claimed in full"
# Must fail. Anchoring the citation to the START of the item must not
# shrink it to the first name: `src/state/` lists a dozen stores in one
# comma-separated run, and every one of them is an inventory entry.
d="$(stage)"
cover_beta "$d"
sed -i 's|^- `AlphaService.ts` — the documented one$|- `AlphaService.ts`, `GhostService` — the documented one and a dead one|' "$d/ARCHITECTURE.md"
assert_case 1 "dead name inside the leading run" "$d"

echo "Case: a full repository path is left to check-doc-paths.sh"
# Must pass. The documented escape hatch for citing a file this
# subsection does not own: a `/` puts it outside both citation forms, and
# the sibling checker resolves it repository-wide instead.
d="$(stage)"
cover_beta "$d"
sed -i 's|^- `AlphaService.ts` — the documented one$|- `AlphaService.ts` — the documented one\n- `src/server/repositories/GoneRepo.ts` — historical, resolved elsewhere|' "$d/ARCHITECTURE.md"
assert_case 0 "full path left to the sibling checker" "$d"

# Subsection delegation to `### Configuration Files` had two cases here.
# The gate now covers three subsystem directories, none of which
# delegate, so the branch was deleted rather than kept warm for a
# hypothetical caller — and its tests went with it.

# --- doc -> file: the document-wide pass -------------------------------
#
# Narrowing the gate to three subsystems moved most of the document's
# file citations out of any gated subsection. A subsection-scoped
# resolution rule would leave every one of them unchecked — the blind
# spot #306 opened with, relocated rather than closed.

echo "Case: a dead name in a section with no subsection at all"
# Must fail. `### Configuration Files` gates nothing, so under the old
# scoped rule a dead citation there was invisible.
d="$(stage)"
cover_beta "$d"
sed -i 's|^Nothing here.$|Nothing here, but `VanishedConfig.ts` is cited.|' "$d/ARCHITECTURE.md"
assert_case 1 "dead name outside every subsection" "$d"

echo "Case: a live name outside every subsection resolves repository-wide"
# Must pass, and this is what keeps the document-wide pass survivable.
# Scoped resolution would reject `Whatever.ts` here — it is not in
# `src/server/services/` — but this pass asks only whether the file
# exists at all. A name that resolves anywhere is alive; only one that
# resolves nowhere is a dead citation.
d="$(stage)"
cover_beta "$d"
sed -i 's|^Nothing here.$|Nothing here, but `Whatever.ts` is cited.|' "$d/ARCHITECTURE.md"
assert_case 0 "live name outside every subsection" "$d"

echo "Case: a dead name is reported once, by the scoped pass"
# Both passes see a name that resolves nowhere, and reporting it twice
# still exits 1 — so only the report shows the dedup. The scoped line is
# the one worth keeping: it names the directory whose claim broke.
d="$(stage)"
cover_beta "$d"
sed -i 's|^- `AlphaService.ts` — the documented one$|- `AlphaService.ts` — the documented one\n- `GoneService.ts` — gone|' "$d/ARCHITECTURE.md"
assert_report_case 1 'GoneService\.ts' "dead name reported exactly once" "$d"
assert_report_case 1 'src/server/services/ -> GoneService\.ts' "scoped report wins over the document-wide one" "$d"

echo "Case: the scoped pass stays stricter than the document-wide one"
# Must fail. A gated subsection claiming a file that exists ELSEWHERE is
# still breaking its own contract — the document-wide pass must not
# soften that into a pass.
d="$(stage)"
cover_beta "$d"
sed -i 's|^- `AlphaService.ts` — the documented one$|- `AlphaService.ts` — the documented one\n- `Whatever.ts` — lives in src/ungated/|' "$d/ARCHITECTURE.md"
assert_case 1 "live file cited by the wrong subsection" "$d"

# --- `### Directory Notes`: prose, not a coverage contract --------------
#
# No coverage obligation in the file -> doc direction, full obligation in
# the other one — and scoped, because each entry is keyed by a bold path
# and that key is a directory.

echo "Case: Directory Notes does not gate its directories"
# Must pass, and it is the whole point of the block. `src/ungated/` is
# keyed by a bold path, not a `#### ` heading, so it carries no coverage
# obligation and adding a file to it stays green. This is what keeps the
# Module Map from being a 187-file inventory.
d="$(stage)"
cover_beta "$d"
: >"$d/src/ungated/Another.ts"
git -C "$d" add -A >/dev/null 2>&1
assert_case 0 "notes block gates nothing" "$d"

echo "Case: a dead bare stem leading a Directory Notes item"
# Must fail. Extension-less inventory (`dataExchangeStore`) is the shape
# that outlived its file longest in #306, and the notes block is where
# such runs now live. Form (a) cannot see it — there is no extension —
# so form (b) has to run over this block too.
d="$(stage)"
cover_beta "$d"
add_note_item "$d" '- `GhostStore` — gone'
assert_case 1 "dead stem in Directory Notes" "$d"

echo "Case: a live bare stem under its own note key"
# Must pass. `Whatever.ts` is in `src/ungated/`, which is the key this
# entry is filed under, so the citation resolves.
d="$(stage)"
cover_beta "$d"
add_note_item "$d" '- `Whatever` — alive'
assert_case 0 "live stem under its own note key" "$d"

echo "Case: a note naming a live file owned by a DIFFERENT directory"
# Must fail, and this is the case the block's own promise rests on: a
# note cannot outlive the file it describes. Repository-wide resolution
# here would pass — `AlphaService.ts` exists, in `src/server/services/` —
# and the note would survive the deletion of the file it is about,
# propped up by a same-named sibling. The real document has the sharp
# version: the `src/server/services/` note describes `events.ts` and
# exists precisely to say it is NOT `src/server/routes/events.ts`.
d="$(stage)"
cover_beta "$d"
add_note_item "$d" '- `AlphaService.ts` — lives in src/server/services/'
assert_case 1 "note names a file from another directory" "$d"

echo "Case: a bold opener that is not a directory does not scope its entry"
# Must pass. The notes block is prose first, and a bold backticked
# opener naming a concept rather than a directory (`**`Bulk download`**`
# is the real shape) is not a key. Treating it as one would scope its
# names to an empty file set and report every one of them dead —
# `Whatever.ts` here, which exists.
d="$(stage)"
cover_beta "$d"
add_note_item "$d" '**`Bulk download`** — no orchestrator, by decision; see `Whatever.ts`.'
assert_case 0 "non-directory bold opener is not a key" "$d"

echo "Case: a Directory Notes key that is not a real directory"
# Must fail, and loudly. A typo in the bold key still ends in `/`, so it
# is taken as a key — and every name in the entry then resolves against
# an empty file set and is reported dead. That is the safe direction, but
# only because the report carries the key: the label is what separates a
# misspelled key from a genuine batch of dead citations.
d="$(stage)"
cover_beta "$d"
sed -i 's|^\*\*`src/ungated/`\*\* — the others\.$|**`src/ungatedd/`** — the others.|' "$d/ARCHITECTURE.md"
add_note_item "$d" '- `Whatever.ts` — alive; the key above is misspelled'
assert_case 1 "misspelled notes key reports live names dead" "$d"
assert_report_case 1 '### Directory Notes src/ungatedd/ -> Whatever\.ts' "the report names the misspelled key" "$d"

echo "Case: a note naming a file in a nested directory of its own key"
# Must pass. Scoping is by directory, not by direct children: `src/ui/`
# holds no files of its own and every component it names sits a level
# down.
d="$(stage)"
cover_beta "$d"
mkdir -p "$d/src/ungated/nested"
: >"$d/src/ungated/nested/Deep.ts"
git -C "$d" add -A >/dev/null 2>&1
add_note_item "$d" '- `Deep.ts` — one level down'
assert_case 0 "note names a nested file under its key" "$d"

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

### Directory Notes

**`src/ui/`** — the components.

### Configuration Files

Nothing here.
DOC
  git -C "$d" init --quiet
  git -C "$d" add -A >/dev/null 2>&1
  MODULE_MAP_ROOT="$d" bash "$CHECK" --update-gated >/dev/null 2>&1
  echo "$d"
}
assert_case 1 "dead name in a nested-only directory" "$(stage_nested_only)"

echo "Case: deleting a subsection silently un-gates its directory"
# Must fail. Opting out is allowed — the error message says so — but
# doing it invisibly is how a gate dies, and nothing else notices: a
# directory that is fully documented leaves no other trace behind when
# its heading goes.
# Two gated subsections, so removing one leaves the Directory Detail
# block intact — an empty block is a structural error (exit 2) and would
# mask the un-gating this case is about.
stage_two_gated() {
  local d
  d="$(stage)"
  cover_beta "$d"
  sed -i 's|^### Directory Notes$|#### `src/ungated/`\n\n- `Whatever.ts` — documented\n\n### Directory Notes|' "$d/ARCHITECTURE.md"
  MODULE_MAP_ROOT="$d" bash "$CHECK" --update-gated >/dev/null 2>&1
  echo "$d"
}

drop_services_subsection() {
  sed -i '/^#### `src\/server\/services\/`$/,/^#### `src\/ungated\/`$/{/^#### `src\/ungated\/`$/!d}' "$1/ARCHITECTURE.md"
}

d="$(stage_two_gated)"
drop_services_subsection "$d"
assert_case 1 "silently un-gated directory" "$d"

echo "Case: un-gating recorded in the gating record passes"
# Must pass. The gate is opt-out, not immovable — regenerating the
# record makes the removal a visible diff instead of a silent one.
d="$(stage_two_gated)"
drop_services_subsection "$d"
MODULE_MAP_ROOT="$d" bash "$CHECK" --update-gated >/dev/null 2>&1
assert_case 0 "un-gating recorded" "$d"

echo "Case: --update-gated does not excuse an undocumented file"
# Must fail. The record covers which directories are gated, nothing
# more — regenerating it is not a way to defer coverage, and there is
# no longer a baseline that is.
d="$(stage)"
MODULE_MAP_ROOT="$d" bash "$CHECK" --update-gated >/dev/null 2>&1
assert_case 1 "regenerated record does not defer coverage" "$d"

echo "Case: deleting the gating record does not un-gate anything"
# Must fail, and structurally (exit 2), not merely differ. Dropping a
# subsection AND deleting the record is the bypass shape: the ratchet
# read a missing file as "no history", so the pair went green while
# either alone failed. With the baseline retired this file is the only
# artifact between a dropped heading and a passing build, so it is a
# required input — same posture as a missing ARCHITECTURE.md.
d="$(stage_two_gated)"
drop_services_subsection "$d"
rm "$d/scripts/module-map-gated.txt"
assert_case 2 "record deleted alongside the subsection" "$d"

echo "Case: emptying the gating record does not un-gate anything either"
# Must fail, exit 2, for the same reason as the deletion above — and it
# is the shape a guard that tests EXISTENCE leaves open. The entries are
# what the ratchet compares against, so truncating the file disarms it
# exactly as `rm` does, while the file itself is still there.
d="$(stage_two_gated)"
drop_services_subsection "$d"
: >"$d/scripts/module-map-gated.txt"
assert_case 2 "record truncated alongside the subsection" "$d"

echo "Case: a comments-only gating record is empty"
# Must fail, exit 2. The parser drops comments and blank lines, so a
# record stripped to its own header records nothing — the file being
# non-empty on disk is not the property that matters.
d="$(stage_two_gated)"
drop_services_subsection "$d"
printf '# Module Map gating record\n#\n\n' >"$d/scripts/module-map-gated.txt"
assert_case 2 "comments-only record alongside the subsection" "$d"

echo "Case: the gating record is missing on an otherwise-green tree"
# Must fail too. The absence is refused on its own, without waiting for
# a second edit to make it exploitable.
d="$(stage)"
cover_beta "$d"
rm "$d/scripts/module-map-gated.txt"
assert_case 2 "missing gating record" "$d"

echo "Case: --update-gated bootstraps a missing record"
# Must pass. The required-input rule cannot lock out the one invocation
# that creates the file.
d="$(stage)"
cover_beta "$d"
rm "$d/scripts/module-map-gated.txt"
MODULE_MAP_ROOT="$d" bash "$CHECK" --update-gated >/dev/null 2>&1
assert_case 0 "record regenerated from scratch" "$d"

echo "Case: the Directory Detail block is missing"
# Structural, not drift. Without a dedicated code the run would gate
# nothing and report green over an empty scan.
d="$(stage)"
sed -i '/^### Directory Detail$/d; /^#### /d' "$d/ARCHITECTURE.md"
assert_case 2 "missing Directory Detail block" "$d"

echo "Case: the Directory Notes block is missing"
# Structural for the same reason, in the other direction. The notes block
# is where extension-less inventory lives outside the gated subsections,
# and the only place a name is resolved against the directory that owns
# it. Renaming the heading would take both scans down and report green.
d="$(stage)"
sed -i '/^### Directory Notes$/d' "$d/ARCHITECTURE.md"
assert_case 2 "missing Directory Notes block" "$d"

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
