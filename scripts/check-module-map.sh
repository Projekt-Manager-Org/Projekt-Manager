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
# Granularity: opt-in by subsection. A directory is gated iff
# ARCHITECTURE.md gives it a `#### <dir>` subsection under
# `### Directory Detail`. Directories documented at table level only —
# the file itself names `src/server/db/`, `src/server/data/`, `src/api/`,
# `src/hooks/`, `src/test/` — are skipped. The doc's own structure is
# the configuration; there is no parallel list to keep in sync, and
# adding a subsection is the act of opting that directory in.
#
# Two rejected alternatives, because both look reasonable:
#   - Per-file over all of src/**: 345 non-test files, most of them React
#     components. Naming every component here is inventory, not
#     architecture.
#   - Top-level directory coverage: nearly free, and useless. It was
#     green while the whole invoices subsystem was missing, because those
#     files live in `services/`, `routes/` and `state/`, all already
#     listed.
#
# SCOPE LIMIT — coverage reaches direct children only. A nested
# directory is gated when it takes its own `#### <dir>` subsection, and
# is otherwise invisible: `src/server/services/invoice/` holds five
# files (the Factur-X builder, the PDF drawer, the payload crypto, the
# XSD validator) that this check will never ask about. That is the same
# opt-in rule applied one level down, not an oversight, but it does mean
# an empty baseline is not proof the Module Map is complete — only that
# the directories which opted in are covered.
#
# The doc -> file direction has no such limit: a subsection may name a
# file anywhere beneath it, and every name is resolved.
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
#       extension are unaffected — (a) is subsection-wide.
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
# To cite a name this check should NOT resolve — a file in another
# directory, or a historical one — write the full repository path. It
# carries a `/`, so both forms above skip it and `check-doc-paths.sh`
# resolves it instead. Moving a bare stem out of the item's opening run
# is enough; moving an extensioned name is not, because (a) is
# subsection-wide on purpose — that is the form the dead
# `bulk-download-reaper.ts` citation took.
#
# Exit codes:
#   0 — every gated directory is covered and the baseline is current
#   1 — undocumented files outside the baseline, a stale baseline, or a
#       named file that does not exist
#   2 — toolchain error (ARCHITECTURE.md unreadable, no subsections found)

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

# A subsection may delegate its per-file detail elsewhere in the same
# document. Searching only the subsection would then report the delegated
# files as undocumented — a checker bug, not a doc gap.
#
# The delegation is DOC-DRIVEN, like the gating above: a subsection that
# links `### Configuration Files` hands its file list to that table.
# `src/config/` and `src/server/config/` both open with "Deployment-tunable
# values are indexed in [§ Configuration Files](#configuration-files)
# below — that table is the single list; only non-`[C]` members are listed
# here." The table cites files by full repository path, so it spans both
# directories and either one reading it is correct.
#
# A hard-coded list of delegating directories would be the parallel list
# this check exists without: the sentence could be deleted from the
# document while the script kept delegating, silently. Keying on the link
# costs a rule for doc authors — do not link that table from a subsection
# unless the subsection really does hand over its file list — and buys
# the third one landing with no script edit.
delegated_body_for() {
  case "$1" in
    *"](#configuration-files)"*) section_body "### Configuration Files" ;;
    *) : ;;
  esac
}

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
#   (a) the full repository path — `src/config/permissions.ts`, which is
#       how the delegated `### Configuration Files` table cites files.
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

for dir in "${GATED[@]}"; do
  gated_count=$((gated_count + 1))
  gated_now+=("$dir")
  subsection="$(subsection_for "$dir")"
  body="$subsection
$(delegated_body_for "$subsection")"

  # file -> doc.
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    case "$file" in
      */__tests__/* | *.test.ts | *.test.tsx | *.d.ts) continue ;;
    esac
    is_named "$body" "$file" && continue
    undocumented+=("$file")
  done < <(files_in "$dir")

  # doc -> file. Resolution is by basename anywhere under the directory,
  # with or without extension: a subsection may name a file that sits in
  # a nested directory of its own (`src/server/services/invoice/`), and
  # `src/state/` writes its stores without the `.ts`.
  #
  # The delegated body is NOT scanned here. `### Configuration Files`
  # indexes files across many directories, so a name there is not a claim
  # about THIS one.
  unset EXISTING
  declare -A EXISTING=()
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    base="${file##*/}"
    EXISTING["$base"]=1
    EXISTING["${base%.*}"]=1
  done < <(git ls-files "$dir")

  while IFS= read -r name; do
    [ -z "$name" ] && continue
    [ -n "${EXISTING[$name]:-}" ] && continue
    ghosts+=("${dir} -> ${name}")
  done < <(cited_names_in "$subsection")
done

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
    echo "ERROR: a '#### <dir>' subsection in $DOC names a file that is not" >&2
    echo "       in the directory. Drop the name, or correct it to the file" >&2
    echo "       that replaced it. To cite a name this check should not" >&2
    echo "       resolve, write the full repository path instead." >&2
    echo "" >&2
    printf "%s" "$dead" >&2
  fi
  exit 1
fi

echo "OK: $DOC's Module Map covers every gated directory, and names no file that is gone."
echo "    gated directories: ${gated_count}"
echo "    baseline entries remaining: ${#BASELINE_ENTRIES[@]} (burn-down: #306)"
