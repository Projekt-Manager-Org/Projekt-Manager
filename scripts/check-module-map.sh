#!/usr/bin/env bash
#
# Doc-drift check — ARCHITECTURE.md Module Map coverage (AC-350).
#
# The Module Map silently omitted the entire invoices and takeout
# subsystems, and named three files that had already been deleted (#306).
# A hand-maintained inventory of a few hundred files drifts by default,
# in BOTH directions — this check covers both:
#
#   file -> doc   every source file in a gated directory is named there
#   doc -> file   every file this section names still exists
#
# The second direction needs its own pass because nothing else can do
# it. `check-doc-paths.sh` resolves cited paths, but the Module Map
# cites bare basenames (`bulk-download-reaper.ts`, `authStore`) and a
# citation with no `/` is not checkable repository-wide — it is
# indistinguishable from the several hundred dotted identifiers in these
# docs. Inside a `#### <dir>` subsection that ambiguity is gone: the
# heading names the directory, so the basename is enough.
#
# NOT a generator. The value of that section is the hand-written prose
# about intent — the `Owns` summary and especially the `Must NOT` column
# ("Know about HTTP, Fastify, or request objects"). None of it is
# derivable from the tree, and generating the section would delete the
# only part worth reading. What IS derivable is coverage, and that is
# all this checks. Mirrors `check-audit-mutations.sh`: derive the
# expected set from the tree, scan, fail on anything uncovered.
#
# Granularity: opt-in by subsection, at SUBSYSTEM level. A directory is
# gated iff ARCHITECTURE.md gives it a `#### <dir>` subsection under
# `### Directory Detail`. The doc's own structure is the configuration;
# there is no parallel list to keep in sync, and adding a subsection is
# the act of opting that directory in.
#
# Three directories carry that contract: `src/server/routes/` (the HTTP
# surface, one module per API resource), `src/server/` root (process
# entry points, schedulers, reapers) and `src/server/services/invoice/`
# (the EN 16931 core). In each, the SET of files is itself architecture
# — a missing one is a missing subsystem, which is the defect #306
# opened with.
#
# Everything else documents itself in `### Directory Notes`, which
# carries no coverage obligation. That block is prose about what a
# filename cannot tell you; a complete file list there would be
# inventory.
#
# THREE REJECTED ALTERNATIVES, because all look reasonable:
#
#   - Per-file over all of src/**: 345 non-test files, most of them React
#     components. Naming every component here is inventory, not
#     architecture.
#   - Per-file over every documented directory — what this check did
#     until #306. Its endgame was ARCHITECTURE.md naming 187 files and
#     growing, and the metric measured typing: appending
#     "- `bus.ts`, `emitters.ts`" with no prose, no `Owns`, no
#     `Must NOT`, burned down two baseline entries and turned CI green.
#     It also gated `toastStore.ts` while leaving the Factur-X builder
#     invisible, because coverage reaches direct children only —
#     obligation ran inversely to architectural significance.
#   - Top-level directory coverage: nearly free, and useless. It was
#     green while the whole invoices subsystem was missing, because those
#     files live in `services/`, `routes/` and `state/`, all already
#     listed.
#
# SCOPE LIMIT — coverage reaches direct children only. A nested
# directory is gated when it takes its own `#### <dir>` subsection, as
# `src/server/services/invoice/` now does. An empty baseline therefore
# means the directories that opted in are covered, not that the Module
# Map is complete.
#
# The doc -> file direction has no such limit and is not opt-in at all:
# it runs over the WHOLE document (see DOCUMENT-WIDE below).
#
# BASELINE — the ratchet. The known-undocumented set at the time this
# check landed is recorded in scripts/module-map-baseline.txt, generated
# by `--update-baseline`, so new files are gated from day one while the
# existing backlog is burned down separately (#306). The file only ever
# shrinks: an entry that is now documented, or whose file is gone, fails
# the check as a stale baseline. This is the ratchet pattern — a
# quality gate on new code with a frozen legacy set, the shape
# `--max-warnings` baselines and "new code" quality gates use.
#
# Matching is extension-tolerant and scoped to the directory's own
# subsection: `src/state/` documents its stores as `authStore`, not
# `authStore.ts`. Scoping means a generic name like `audit.ts` mentioned
# under `src/server/repositories/` does not also cover a different
# `audit.ts` elsewhere.
#
# DOCUMENT-WIDE — where the doc -> file direction looks.
#
# Scoping resolution to gated subsections was right while every
# documented directory had one. Narrowing the gate to three subsystems
# makes it wrong: `### Directory Notes`, `## Attachments Module`,
# `## Invoices Module` and `## How to Extend` all name files, and under
# a subsection-scoped rule every one of them would sit unchecked —
# precisely where the three dead names of #306 would land today.
#
# So form (a) below runs over the whole document. Form (b) stays
# structural: a bare stem opening a list item is an inventory entry, and
# inventory only appears in the two Module Map blocks, so it is scanned
# there and nowhere else. Widening (b) to the whole document would fire
# on prose — see the note on "opens the item" below.
#
# WHERE EACH NAME IS RESOLVED. Reach and strictness are separate knobs.
# Both Module Map blocks carry a directory in their own structure, so a
# name in either resolves under that directory and nowhere else:
#
#   `#### `src/server/routes/``      heading  -> scoped to the heading
#   `**`src/server/storage/`** — …`  note key -> scoped to the key
#   everything else in the document           -> repository-wide
#
# Scoping the notes is what makes "a note cannot outlive the file it
# describes" true. Repository-wide resolution there would let ANY
# same-named file keep a note alive: `src/server/services/events.ts`
# could be deleted and its note would still resolve, against
# `src/server/routes/events.ts` — the very file that note exists to say
# it is NOT. Basenames collide by the dozen in this tree (`client.ts`,
# `auth.ts`, `events.ts`), so this is the common case, not a corner one.
#
# Repository-wide resolution is right for the rest of the document
# precisely because those sections name no directory: prose in
# `## How to Extend` about `mutate.ts` is a claim that the file exists,
# not a claim about where. A name that resolves ANYWHERE is alive there;
# only a name that resolves nowhere is dead.
#
# INVENTORY CITATIONS — what the doc -> file direction treats as a claim
# that a file exists. Two forms, both narrow on purpose, because a
# subsection legitimately backticks plenty of things that are not files
# (`AppError`, `EventSource`, `storage_usage_changed`, a route path):
#
#   (a) a backticked name carrying a `.ts` / `.tsx` extension, anywhere
#       in the subsection — an extension is an unambiguous file claim.
#   (b) the run of backticked names that OPENS a list item, extended
#       across `,` and `/` separators only. That run is the inventory
#       entry; everything after it — including the ` — ` gloss — is prose
#       and is not checked. `src/state/` lists a dozen stores in one
#       comma-separated run, so the run is taken whole, not just its
#       first name.
#
#       The separator set is closed on purpose. A name joined by a word
#       ("- `authStore` and `uiStore` — …", or the Oxford comma in
#       "- `a`, `b`, and `c`") ends the run and goes unchecked, which is
#       the safe direction but still a hole: separate inventory names
#       with commas. Extending the set to English conjunctions would
#       reopen (b) on prose, which is the bug below. Names carrying an
#       extension are unaffected — (a) is document-wide.
#
#       "Opens the item" is load-bearing. Matching a backticked name
#       anywhere before the gloss makes a bulleted SENTENCE an inventory
#       entry: "- Failure isolation keeps one broken `SseConnection` from
#       stalling the fan-out." is then reported as a dead file. That
#       sentence is prose in `src/server/sse/` today and becomes a bullet
#       the moment #306 rewrites the subsection as an inventory — the
#       shape was found by probing that burn-down, not by a CI failure.
#       A bullet is not a citation; leading with the name is.
#
# Not checkable, and deliberately so: a bare identifier in prose.
# `BulkDownloadOrchestrator` named a deleted class, but `MutatingDatabase`,
# `AttachmentStorageClient` and `SseConnection` are live type names in the
# same position. No lexical rule separates them, and a check that fires
# on type names gets muted within a week.
#
# To cite a name this check should NOT resolve — a historical file, or
# a hypothetical one in a walkthrough — write the full repository path.
# It carries a `/`, so both forms above skip it, and `check-doc-paths.sh`
# resolves it instead against an allowlist that already carries the five
# legitimate classes of non-existent citation. That handoff is why this
# script needs no allowlist of its own.
#
# Moving a bare stem out of the item's opening run is enough; moving an
# extensioned name is not, because (a) is document-wide on purpose —
# that is the form the dead `bulk-download-reaper.ts` citation took, and
# the form `§ How to Extend`'s Supplier walkthrough took until it was
# rewritten as `src/server/repositories/supplier-read.ts` to join its
# three siblings in that allowlist.
#
# Exit codes:
#   0 — every gated directory is covered and the baseline is current
#   1 — undocumented files outside the baseline, a stale baseline, or a
#       named file that does not exist
#   2 — toolchain error (ARCHITECTURE.md unreadable, a Module Map block
#       missing so its scan would pass over nothing)

set -euo pipefail

PROJECT_ROOT="${MODULE_MAP_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$PROJECT_ROOT"

DOC="${MODULE_MAP_DOC:-ARCHITECTURE.md}"
BASELINE="${MODULE_MAP_BASELINE:-scripts/module-map-baseline.txt}"

if [ ! -f "$DOC" ]; then
  echo "ERROR: $DOC not found under \$MODULE_MAP_ROOT ($PROJECT_ROOT)." >&2
  exit 2
fi

# The `### Directory Detail` block, bounded by the next `### ` heading.
DETAIL="$(awk '/^### Directory Detail/{f=1;next} f&&/^### /{exit} f' "$DOC")"

if [ -z "$DETAIL" ]; then
  echo "ERROR: no '### Directory Detail' block found in $DOC." >&2
  echo "       The scan would silently pass with nothing gated — refusing to run." >&2
  exit 2
fi

# Directory paths from the `#### \`src/...\`` headings. The heading may
# carry a suffix ("(root files)"), so only the backticked path is taken.
mapfile -t GATED < <(printf '%s\n' "$DETAIL" | grep -oE '^#### `[^`]+`' | sed 's/^#### `//; s/`$//')

if [ "${#GATED[@]}" -eq 0 ]; then
  echo "ERROR: '### Directory Detail' contains no '#### \`<dir>\`' subsections in $DOC." >&2
  exit 2
fi

# The subsection body for one directory: from its heading to the next
# `#### `, exclusive.
subsection_for() {
  printf '%s\n' "$DETAIL" | awk -v h="#### \`$1\`" '
    index($0, h) == 1 { f = 1; next }
    f && /^#### / { exit }
    f { print }
  '
}

# A `### ` section body, bounded by the next `### ` or `## ` heading.
section_body() {
  awk -v h="$1" '
    index($0, h) == 1 { f = 1; next }
    f && (/^### / || /^## /) { exit }
    f { print }
  ' "$DOC"
}

# One `### Directory Notes` entry: from its bold key to the next one,
# exclusive. The key line carries the entry's opening prose, so it is
# part of the body — unlike a `#### ` heading, which carries none.
note_entry_for() {
  printf '%s\n' "$NOTES" | awk -v h="**\`$1\`**" '
    index($0, h) == 1 { f = 1; print; next }
    f && /^\*\*`[^`]+\/`\*\*/ { exit }
    f { print }
  '
}

# Subsection delegation to `### Configuration Files` used to live here:
# `src/config/` and `src/server/config/` handed their file lists to that
# table rather than repeat it, and the script keyed on the link so the
# delegation could not outlive the sentence that declared it.
#
# Both directories moved to `### Directory Notes` when the gate narrowed
# to subsystems, so no gated subsection delegates anything and the branch
# had no live caller. It is deleted rather than kept warm for a
# hypothetical third delegator — an unexercised branch in a guard is the
# guard's own drift.
#
# Files a subsection is responsible for: directly inside the directory
# (nested directories opt in through their own subsection), source only.
files_in() {
  git ls-files "$1*.ts" "$1*.tsx" 2>/dev/null |
    awk -v d="$1" 'substr($0, 1, length(d)) == d && index(substr($0, length(d) + 1), "/") == 0'
}

mapfile -t BASELINE_ENTRIES < <([ -f "$BASELINE" ] && grep -vE '^\s*(#|$)' "$BASELINE" || true)

# The gated directory set at the time the baseline was written.
#
# Gating is opt-in by subsection, so the cheapest way to silence this
# check is to delete a `#### <dir>` heading — which the error message
# below openly offers as the way to opt out. That escape hatch is fine;
# doing it silently is not. Recording the set makes un-gating a visible
# diff in this file rather than an invisible consequence of an
# ARCHITECTURE.md edit.
#
# The stale-entry ratchet only catches this for directories that still
# have baseline entries; a fully documented directory could be dropped
# with no signal at all.
mapfile -t RECORDED_GATED < <([ -f "$BASELINE" ] && sed -n 's/^# gated: //p' "$BASELINE" || true)

in_baseline() {
  local file="$1" entry
  for entry in "${BASELINE_ENTRIES[@]:-}"; do
    [ "$file" = "$entry" ] && return 0
  done
  return 1
}

# `foo.ts` counts as documented when the subsection mentions `foo.ts` or
# the bare stem `foo` — see the header note on `src/state/`.
#
# The basename match is ANCHORED. An unanchored substring test counted a
# file as documented whenever the subsection happened to mention some
# OTHER path ending in the same basename: prose about
# `src/server/repositories/audit.ts` inside the `src/server/services/`
# subsection silently covered `src/server/services/audit.ts`. Scoping
# the search to one subsection prevents that across directories but not
# within one, which is where cross-references actually appear.
#
# Three accepted forms, in order:
#
#   (a) the full repository path — `src/server/routes/invoices.ts`. A
#       subsection may cite its own files either way.
#   (b) the bare basename, NOT preceded by `/` (that would make it a file
#       in another directory) and not glued to a longer name, so
#       `ledger.ts` does not cover `subledger.ts` and `bus.ts` does not
#       cover `bus.tsx`.
#   (c) the bare stem in backticks — `src/state/` documents its stores as
#       `authStore`, not `authStore.ts`.
is_named() {
  local body="$1" file="$2" base escaped_file escaped_base stem
  base="${file##*/}"
  escaped_file="${file//./\\.}"
  escaped_base="${base//./\\.}"

  if printf '%s' "$body" |
    grep -qE "(^|[^[:alnum:]_./-])${escaped_file}([^[:alnum:]_-]|$)"; then
    return 0
  fi
  if printf '%s' "$body" |
    grep -qE "(^|[^/[:alnum:]_.-])${escaped_base}([^[:alnum:]_-]|$)"; then
    return 0
  fi
  stem="${base%.*}"
  case "$body" in
    *"\`${stem}\`"*) return 0 ;;
  esac
  return 1
}

# The names a subsection claims exist — see the header on INVENTORY
# CITATIONS for the two forms and why nothing wider is safe.
cited_names_in() {
  {
    printf '%s\n' "$1" | grep -oE '`[A-Za-z0-9_.-]+\.tsx?`' || true
    printf '%s\n' "$1" |
      sed -n 's|^- \(`[^`]*`\( *[,/] *`[^`]*`\)*\).*|\1|p' |
      grep -oE '`[A-Za-z0-9_.-]+`' || true
  } | tr -d '`' | sort -u
}

undocumented=()
ghosts=()
gated_now=()
gated_count=0

# Every tracked source basename and stem, for the document-wide scan.
# A name that resolves ANYWHERE is alive; only one that resolves nowhere
# is a dead citation, so this index is deliberately unscoped.
declare -A REPO_FILES=()
while IFS= read -r file; do
  [ -z "$file" ] && continue
  base="${file##*/}"
  REPO_FILES["$base"]=1
  REPO_FILES["${base%.*}"]=1
done < <(git ls-files '*.ts' '*.tsx')

# Names already reported dead, so the scoped and document-wide passes do
# not each report the same one.
declare -A REPORTED_GHOSTS=()

# doc -> file, scoped to one directory. Resolution is by basename
# anywhere under it, with or without extension: a block may name a file
# that sits in a nested directory of its own.
#
# Stricter than the document-wide pass — a block claiming `toastStore.ts`
# fails here even though the file exists, because it does not exist *in
# that directory*. That is the whole point of a scoped block: it says
# where the file is, not merely that it is.
#
# Already-reported names are marked, not skipped: two blocks may both be
# wrong about the same name, and each has its own broken claim to report.
check_scoped_names() {
  local dir="$1" body="$2" label="$3" file base name
  local -A existing=()

  while IFS= read -r file; do
    [ -z "$file" ] && continue
    base="${file##*/}"
    existing["$base"]=1
    existing["${base%.*}"]=1
  done < <(git ls-files "$dir")

  while IFS= read -r name; do
    [ -z "$name" ] && continue
    [ -n "${existing[$name]:-}" ] && continue
    ghosts+=("${label} -> ${name}")
    REPORTED_GHOSTS["$name"]=1
  done < <(cited_names_in "$body")
}

for dir in "${GATED[@]}"; do
  gated_count=$((gated_count + 1))
  gated_now+=("$dir")
  subsection="$(subsection_for "$dir")"
  body="$subsection"

  # file -> doc.
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    case "$file" in
      */__tests__/* | *.test.ts | *.test.tsx | *.d.ts) continue ;;
    esac
    is_named "$body" "$file" && continue
    undocumented+=("$file")
  done < <(files_in "$dir")

  # doc -> file, scoped to the heading's directory.
  check_scoped_names "$dir" "$subsection" "$dir"
done

# `### Directory Notes` — prose, and no coverage obligation in the
# file -> doc direction. The doc -> file direction applies in full, and
# it is scoped: every entry is keyed by a bold path, that key is a
# directory, so the entry's names resolve under it. See WHERE EACH NAME
# IS RESOLVED above for why repository-wide would be wrong here.
#
# The block is also the one place outside the gated subsections where
# form (b)'s extension-less inventory (`dataExchangeStore`) can
# legitimately appear — the shape that survived longest in #306. Losing
# the block loses that scan silently, so its absence is structural, the
# same as `### Directory Detail` above.
NOTES="$(section_body "### Directory Notes")"

if [ -z "$NOTES" ]; then
  echo "ERROR: no '### Directory Notes' block found in $DOC." >&2
  echo "       It is where extension-less inventory lives outside the" >&2
  echo "       gated subsections, and the only place those names are" >&2
  echo "       resolved against the directory that owns them. Without it" >&2
  echo "       that scan passes over nothing — refusing to run." >&2
  exit 2
fi

# The bold path opening each entry. A key is a DIRECTORY — it ends in
# `/`. This block is prose first, so a bold backticked opener naming
# something else (`**`Bulk download`** — …`) is not a key: scoping to it
# would resolve every name in the entry against an empty file set and
# report the lot dead. Such an entry is unscoped, like the rest of the
# document.
mapfile -t NOTE_KEYS < <(printf '%s\n' "$NOTES" | grep -oE '^\*\*`[^`]+/`\*\*' | sed 's/^\*\*`//; s/`\*\*$//')

for key in "${NOTE_KEYS[@]:-}"; do
  [ -z "$key" ] && continue
  check_scoped_names "$key" "$(note_entry_for "$key")" "### Directory Notes ${key}"
done

# The block's own preamble belongs to no entry, so it has no directory
# to be scoped to and resolves repository-wide. Running this over the
# whole block rather than the preamble alone costs nothing: every keyed
# name that resolves nowhere was already reported by the scoped pass
# above, with its directory attached.
while IFS= read -r name; do
  [ -z "$name" ] && continue
  [ -n "${REPO_FILES[$name]:-}" ] && continue
  [ -n "${REPORTED_GHOSTS[$name]:-}" ] && continue
  ghosts+=("### Directory Notes -> ${name}")
  REPORTED_GHOSTS["$name"]=1
done < <(cited_names_in "$NOTES")

# doc -> file, document-wide — see the DOCUMENT-WIDE header note.
#
# A name a scoped pass already reported is skipped: it resolves nowhere,
# so both passes see it, and the scoped report is the more useful of the
# two because it names the directory whose claim was broken.
#
# Form (a) over the entire document: a backticked name carrying a source
# extension is an unambiguous file claim wherever it appears, and the
# sections that carry the most prose about files are the ones no
# subsection covers. Reported with the line number — the first of them,
# since a name is reported once — because `ARCHITECTURE.md -> Foo.ts`
# alone leaves the author grepping a 680-line document.
while IFS= read -r match; do
  [ -z "$match" ] && continue
  line="${match%%:*}"
  name="${match#*:}"
  [ -n "${REPO_FILES[$name]:-}" ] && continue
  [ -n "${REPORTED_GHOSTS[$name]:-}" ] && continue
  ghosts+=("${DOC}:${line} -> ${name}")
  REPORTED_GHOSTS["$name"]=1
done < <(grep -noE '`[A-Za-z0-9_.-]+\.tsx?`' "$DOC" | tr -d '`')

# --update-baseline: freeze the current undocumented set and stop.
if [ "${1:-}" = "--update-baseline" ]; then
  {
    echo "# Module Map coverage baseline (AC-350) — generated by"
    echo "# \`bash scripts/check-module-map.sh --update-baseline\`."
    echo "#"
    echo "# Files in a gated directory that ARCHITECTURE.md's Directory Detail"
    echo "# does not name yet. This list only shrinks: documenting a file and"
    echo "# dropping its line here are one change. An entry that is already"
    echo "# documented, or whose file is gone, fails the check."
    echo "#"
    echo "# Burn-down tracked in #306."
    echo "#"
    echo "# The '# gated:' lines record which directories carried a"
    echo "# '#### <dir>' subsection when this was written. Dropping a"
    echo "# subsection un-gates that directory; the check fails until the"
    echo "# line here goes too, so it lands as a visible diff."
    printf '# gated: %s\n' "${gated_now[@]:-}" | sort
    printf '%s\n' "${undocumented[@]:-}" | sort
  } >"$BASELINE"
  echo "Wrote ${#undocumented[@]} entries to $BASELINE."
  exit 0
fi

findings=""

for file in "${undocumented[@]:-}"; do
  in_baseline "$file" || findings="${findings}  undocumented: ${file}"$'\n'
done

# The gating ratchet — a directory that was gated must still be gated.
# An empty record means no history to ratchet against (a fresh baseline),
# not a passing check.
ungated=""
for entry in "${RECORDED_GATED[@]:-}"; do
  [ -z "$entry" ] && continue
  found=0
  for dir in "${gated_now[@]:-}"; do
    [ "$dir" = "$entry" ] && found=1 && break
  done
  [ "$found" -eq 0 ] && ungated="${ungated}  no longer gated: ${entry}"$'\n'
done

# The ratchet. Without this the baseline would keep entries alive after
# the doc caught up, and the burn-down would never be visible.
stale=""
for entry in "${BASELINE_ENTRIES[@]:-}"; do
  found=0
  for file in "${undocumented[@]:-}"; do
    [ "$file" = "$entry" ] && found=1 && break
  done
  [ "$found" -eq 0 ] && stale="${stale}  stale baseline entry: ${entry}"$'\n'
done

dead=""
for entry in "${ghosts[@]:-}"; do
  [ -z "$entry" ] && continue
  dead="${dead}  names a file that does not exist: ${entry}"$'\n'
done

if [ -n "$findings" ] || [ -n "$stale" ] || [ -n "$ungated" ] || [ -n "$dead" ]; then
  if [ -n "$findings" ]; then
    echo "ERROR: files in a gated directory are not named in $DOC's Module Map." >&2
    echo "       Add them to the directory's '#### <dir>' subsection under" >&2
    echo "       '### Directory Detail'. A directory is gated because it HAS" >&2
    echo "       such a subsection — drop the subsection to opt out entirely." >&2
    echo "" >&2
    printf "%s" "$findings" >&2
  fi
  if [ -n "$stale" ]; then
    [ -n "$findings" ] && echo "" >&2
    echo "ERROR: $BASELINE lists files that are documented now, or gone." >&2
    echo "       The baseline only shrinks — run" >&2
    echo "       \`bash $(basename "$0") --update-baseline\` and commit it." >&2
    echo "" >&2
    printf "%s" "$stale" >&2
  fi
  if [ -n "$ungated" ]; then
    { [ -n "$findings" ] || [ -n "$stale" ]; } && echo "" >&2
    echo "ERROR: a directory lost its '#### <dir>' subsection in $DOC and is" >&2
    echo "       no longer gated. Opting out is allowed — doing it silently" >&2
    echo "       is not. Restore the subsection, or run" >&2
    echo "       \`bash $(basename "$0") --update-baseline\` so the change" >&2
    echo "       lands as a visible diff in $BASELINE." >&2
    echo "" >&2
    printf "%s" "$ungated" >&2
  fi
  if [ -n "$dead" ]; then
    { [ -n "$findings" ] || [ -n "$stale" ] || [ -n "$ungated" ]; } && echo "" >&2
    echo "ERROR: $DOC names a source file that does not exist. A prefix" >&2
    echo "       naming a directory means the name is not in THAT" >&2
    echo "       directory — the gated subsection or the notes entry that" >&2
    echo "       cites it says where the file is, not merely that it is." >&2
    echo "       A '$DOC:<line>' prefix means it is nowhere in the" >&2
    echo "       repository. Drop the name, or correct it to the file that" >&2
    echo "       replaced it. To cite a historical or hypothetical name," >&2
    echo "       write the full repository path instead — check-doc-paths.sh" >&2
    echo "       resolves those, against an allowlist." >&2
    echo "" >&2
    printf "%s" "$dead" >&2
  fi
  exit 1
fi

echo "OK: $DOC's Module Map covers every gated directory, and names no file that is gone."
echo "    gated directories: ${gated_count}"
echo "    baseline entries remaining: ${#BASELINE_ENTRIES[@]} (burn-down: #306)"
