#!/usr/bin/env bash
#
# Doc-drift check — repository paths cited in prose must exist.
#
# Every tracked `*.md` names files: `src/server/services/mutate.ts`,
# `scripts/backup/load-drill-key.sh`, `e2e/kanban-flows.spec.ts`. When a
# file is renamed or deleted, the prose keeps its old name and nothing
# notices — the third round of doc-vs-code drift fixed by hand (#289,
# #292, #306) all included dead path references.
#
# Scope: inline code spans only (`` `like this` ``) whose content looks
# like a repository path — first segment in {src, scripts, e2e, docs,
# .github}. Markdown LINK targets are out of scope; `lychee` resolves
# those in a separate lint step. The two surfaces do not overlap: a
# path in a code span is never a link, and a link target is never
# backticked.
#
# Deliberately NOT flagged:
#   - Globs (`src/ui/**`) — the path charset excludes `*`.
#   - Extensionless module references (`src/server/db/connection`) —
#     resolved through FALLBACK_EXTENSIONS below, the way a bundler
#     would.
#   - `path:LINE` / `path:LINE-LINE` citations — the suffix is stripped
#     before resolution.
#   - Gitignored artifacts (demo fixtures under `e2e/fixtures/demo/`) —
#     absent from a clean checkout by design, present after a demo run.
#   - ALLOWLIST entries — illustrative, historical or proposed paths,
#     scoped to the one document entitled to cite them. See the list.
#
# Exit codes:
#   0 — every cited path resolves
#   1 — at least one dead reference; each printed as `doc -> path`
#   2 — toolchain error (not a git work tree, no tracked markdown)

set -euo pipefail

# Project root. Defaults to the parent of this script's directory; the
# test harness (scripts/__tests__/check-doc-paths.test.sh) overrides via
# $DOC_PATHS_ROOT to point the scan at a fixture repository.
PROJECT_ROOT="${DOC_PATHS_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

cd "$PROJECT_ROOT"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: \$DOC_PATHS_ROOT ($PROJECT_ROOT) is not a git work tree." >&2
  exit 2
fi

mapfile -t DOCS < <(git ls-files '*.md')

if [ "${#DOCS[@]}" -eq 0 ]; then
  echo "ERROR: no tracked *.md found under $PROJECT_ROOT." >&2
  echo "       The scan would silently pass with nothing to check — refusing to run." >&2
  exit 2
fi

# Extensions tried when a cited path has none. Mirrors how the prose
# means it: `src/server/db/connection` is the module, not a file that
# must literally exist under that name.
FALLBACK_EXTENSIONS=(".ts" ".tsx" ".js" ".mjs" ".sh" "/index.ts")

# Citations that name a path which does not exist, on purpose. Entries
# are `document|path`, both matched exactly — an exemption earned by one
# ADR does not silently cover the same filename elsewhere.
#
# Three legitimate classes, and nothing else belongs here:
#
#   1. Illustrative — a walkthrough over something the project does not
#      have. The surrounding prose must make the hypothetical obvious.
#   2. Historical — an ADR naming what it superseded or deleted. A
#      decision record that cannot name the thing it removed is useless.
#   3. Proposed — a named artifact that should exist and does not yet,
#      inside an explicit gap marker. These are IOUs: the entry is
#      removed in the same PR that lands the file.
#
# Keep this list small. An entry is a promise that a reader who greps
# for the path and finds nothing has been told why.
ALLOWLIST=(
  # (1) ARCHITECTURE.md § "Adding a new entity (e.g., Supplier)" — a
  # walkthrough over an entity the project does not have. The section
  # header names the example, so the paths read as hypothetical.
  "ARCHITECTURE.md|src/server/services/SupplierService.ts"
  "ARCHITECTURE.md|src/server/routes/suppliers.ts"
  "ARCHITECTURE.md|src/state/supplierStore.ts"
  "ARCHITECTURE.md|src/ui/suppliers/"

  # (2) ADR-0012 is the decision that deleted the workflow — it names it
  # in the problem statement, in the `workflow_run` incident, and in the
  # consequences list ("deleted").
  "docs/adr/0012-manual-pull-based-deploy-over-wireguard.md|.github/workflows/deploy.yml"

  # (2) ADR-0020 § the dcron → croner rewrite: both paths are named in
  # the past tense as part of the superseded container design
  # ("The container's PID 1 was dcron…", "formerly … probe-r2.mjs").
  "docs/adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md|scripts/backup/crontab"
  "docs/adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md|scripts/backup/probe-r2.mjs"

  # (3) Named coverage gaps in the traceability ledger — each sits
  # inside a "**GAP** — … follow-up to add `X`" note. Drop the entry
  # when the spec lands.
  "docs/testing/traceability.md|e2e/project-detail-page.spec.ts"
  "docs/testing/traceability.md|e2e/project-detail-attachments.spec.ts"
  "docs/testing/traceability.md|src/server/__tests__/project-detail-workers.test.ts"
)

is_allowlisted() {
  local doc="$1" candidate="$2" entry
  for entry in "${ALLOWLIST[@]}"; do
    [ "${doc}|${candidate}" = "$entry" ] && return 0
  done
  return 1
}

# Resolves iff the path exists as-is, resolves through a fallback
# extension, or is gitignored (built or generated artifact — absent
# from a clean checkout, not a dead reference).
resolves() {
  local candidate="$1" ext
  [ -e "$candidate" ] && return 0
  for ext in "${FALLBACK_EXTENSIONS[@]}"; do
    [ -e "${candidate}${ext}" ] && return 0
  done
  git check-ignore -q "$candidate" 2>/dev/null && return 0
  return 1
}

findings=""
checked=0

for doc in "${DOCS[@]}"; do
  # Inline code spans, one per line, backticks stripped. `[^\`]+`
  # cannot span a closing backtick, so adjacent spans stay separate.
  while IFS= read -r span; do
    # Strip any `:suffix` citation — line numbers (`schema.ts:149-162`)
    # and symbol pointers (`features.ts:FEATURE_CATALOG`,
    # `backup.ts::computeManifest`). No repository path contains a colon,
    # so cutting at the first one is lossless.
    candidate="${span%%:*}"

    # Repository-path shape: known first segment, no glob metacharacters
    # (the charset in the extractor already excludes them).
    case "$candidate" in
      src/* | scripts/* | e2e/* | docs/* | .github/*) ;;
      *) continue ;;
    esac

    checked=$((checked + 1))
    is_allowlisted "$doc" "$candidate" && continue
    resolves "$candidate" && continue
    findings="${findings}${doc} -> ${candidate}"$'\n'
  done < <(grep -oE '`[A-Za-z0-9_./:-]+`' "$doc" | tr -d '`' || true)
done

if [ -n "$findings" ]; then
  echo "ERROR: documentation cites repository paths that do not exist." >&2
  echo "       Update the prose to the current path, or add an" >&2
  echo "       inline-documented \`document|path\` entry to ALLOWLIST in" >&2
  echo "       $(basename "$0") if the citation is illustrative," >&2
  echo "       historical, or a named coverage gap." >&2
  echo "" >&2
  printf "%s" "$findings" | sort -u >&2
  exit 1
fi

echo "OK: every repository path cited in documentation resolves."
echo "    documents scanned: ${#DOCS[@]}"
echo "    path references checked: ${checked}"
echo "    allowlist size: ${#ALLOWLIST[@]}"
