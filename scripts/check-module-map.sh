#!/usr/bin/env bash
#
# Doc-drift check — ARCHITECTURE.md Module Map coverage (AC-350).
#
# The Module Map silently omitted the entire invoices and takeout
# subsystems (#306). A hand-maintained inventory of a few hundred files
# drifts by default.
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
#     architecture — hence EXCLUDED below.
#   - Top-level directory coverage: nearly free, and useless. It was
#     green while the whole invoices subsystem was missing, because those
#     files live in `services/`, `routes/` and `state/`, all already
#     listed.
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
# Exit codes:
#   0 — every gated directory is covered and the baseline is current
#   1 — undocumented files outside the baseline, or a stale baseline
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

# Directories that carry a subsection but are deliberately not gated at
# file level. Each entry is a reviewed decision, not a convenience.
EXCLUDED=(
  # ~90 React components across nine feature groups. The subsection
  # documents the GROUPS and the handful of components with
  # cross-cutting behaviour; a per-file gate here would turn the Module
  # Map into a file listing, which the tree already provides.
  "src/ui/"
)

is_excluded() {
  local dir="$1" entry
  for entry in "${EXCLUDED[@]}"; do
    [ "$dir" = "$entry" ] && return 0
  done
  return 1
}

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

# Directories whose subsection deliberately delegates its per-file
# detail elsewhere in the same document. Searching only the subsection
# would report the delegated files as undocumented — a checker bug, not
# a doc gap.
#
#   src/config/ — its subsection says so outright: "Deployment-tunable
#   values are indexed in § Configuration Files below — that table is
#   the single list; only non-`[C]` members are listed here."
delegated_body_for() {
  case "$1" in
    "src/config/") section_body "### Configuration Files" ;;
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

in_baseline() {
  local file="$1" entry
  for entry in "${BASELINE_ENTRIES[@]:-}"; do
    [ "$file" = "$entry" ] && return 0
  done
  return 1
}

# `foo.ts` counts as documented when the subsection mentions `foo.ts` or
# the bare stem `foo` — see the header note on `src/state/`.
is_named() {
  local body="$1" base="$2"
  case "$body" in
    *"$base"*) return 0 ;;
  esac
  case "$body" in
    *"\`${base%.*}\`"*) return 0 ;;
  esac
  return 1
}

undocumented=()
gated_count=0

for dir in "${GATED[@]}"; do
  is_excluded "$dir" && continue
  gated_count=$((gated_count + 1))
  body="$(subsection_for "$dir")
$(delegated_body_for "$dir")"
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    case "$file" in
      */__tests__/* | *.test.ts | *.test.tsx | *.d.ts) continue ;;
    esac
    is_named "$body" "$(basename "$file")" && continue
    undocumented+=("$file")
  done < <(files_in "$dir")
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
    printf '%s\n' "${undocumented[@]:-}" | sort
  } >"$BASELINE"
  echo "Wrote ${#undocumented[@]} entries to $BASELINE."
  exit 0
fi

findings=""

for file in "${undocumented[@]:-}"; do
  in_baseline "$file" || findings="${findings}  undocumented: ${file}"$'\n'
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

if [ -n "$findings" ] || [ -n "$stale" ]; then
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
  exit 1
fi

echo "OK: every gated directory in $DOC's Module Map is covered."
echo "    gated directories: ${gated_count} (excluded: ${#EXCLUDED[@]})"
echo "    baseline entries remaining: ${#BASELINE_ENTRIES[@]} (burn-down: #306)"
