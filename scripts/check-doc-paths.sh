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
# like a repository path — contains a `/`, and its first segment is a
# tracked top-level directory. That set is DERIVED from `git ls-files`,
# not hardcoded: a hardcoded {src, scripts, e2e, docs, .github} silently
# skipped `assets/`, `docker/`, `.husky/`, `review/`, `fixtures/`,
# `patches/` and `public/`, and a checker that ignores a directory
# nobody remembered to list is the drift it exists to catch.
#
# Markdown LINK targets are out of scope; `lychee` resolves those in a
# separate lint step. The two surfaces do not overlap: a path in a code
# span is never a link, and a link target is never backticked.
#
# Deliberately NOT flagged:
#   - Globs (`src/ui/**`) — the path charset excludes `*`.
#   - Extensionless module references (`src/server/db/connection`) —
#     resolved through FALLBACK_EXTENSIONS below, the way a bundler
#     would.
#   - Directory citations (`docs/ops/backup/`) — git has no entry for a
#     directory, so the prefixes implied by tracked files stand in.
#   - `path:LINE` / `path:LINE-LINE` citations — the suffix is stripped
#     before resolution.
#   - ALLOWLIST entries — see the list.
#
# NOT CHECKABLE, by construction: a citation with no `/`. The docs are
# full of dotted identifiers that are indistinguishable from bare
# filenames — `ProjectCrudService.purgeProject`, `payload.after`,
# `projects.updatedBy`, `crypto.subtle`, `10.213.17.1`, `v1.0.0-rc.2`.
# Any rule broad enough to check `docker-compose.yml` also fires on
# several hundred of those. So `docker-compose.yml`, `package.json` and
# `ARCHITECTURE.md` go unverified when cited without a directory. Cite
# a path if you want it checked.
#
# Resolution reads the git INDEX, not the working tree, so the result
# does not depend on which untracked or gitignored files happen to be
# lying around. A local run and CI see the same repository.
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

# The git INDEX, not the filesystem — see `resolves()` for why.
#
# TRACKED holds every tracked file; TRACKED_DIRS holds every directory
# prefix implied by one, since git has no entry for a directory and the
# docs cite plenty (`docs/ops/backup/`, `src/ui/kanban/`).
declare -A TRACKED=()
declare -A TRACKED_DIRS=()

while IFS= read -r tracked_file; do
  TRACKED["$tracked_file"]=1
  tracked_dir="${tracked_file%/*}"
  while [ "$tracked_dir" != "$tracked_file" ] && [ -n "$tracked_dir" ]; do
    TRACKED_DIRS["$tracked_dir"]=1
    [ "${tracked_dir%/*}" = "$tracked_dir" ] && break
    tracked_dir="${tracked_dir%/*}"
  done
done < <(git ls-files)

# Top-level directories that actually hold tracked files. This is the
# repository-path shape test, derived rather than declared so a new
# top-level directory is checked the day it lands.
mapfile -t TOP_DIRS < <(printf '%s\n' "${!TRACKED_DIRS[@]}" | grep -v '/' | sort -u)

if [ "${#TOP_DIRS[@]}" -eq 0 ]; then
  echo "ERROR: no tracked files under a directory in $PROJECT_ROOT." >&2
  echo "       Nothing would match the path shape — refusing to run." >&2
  exit 2
fi

# True iff the candidate is shaped like a repository path: it names a
# directory, and that directory is one this repository tracks.
has_repo_prefix() {
  local first="${1%%/*}" entry
  case "$1" in */*) ;; *) return 1 ;; esac
  for entry in "${TOP_DIRS[@]}"; do
    [ "$first" = "$entry" ] && return 0
  done
  return 1
}

# Extensions tried when a cited path has none. Mirrors how the prose
# means it: `src/server/db/connection` is the module, not a file that
# must literally exist under that name.
FALLBACK_EXTENSIONS=(".ts" ".tsx" ".js" ".mjs" ".sh" "/index.ts")

# Citations that name a path which does not exist, on purpose. Entries
# are `document|path`, both matched exactly — an exemption earned by one
# ADR does not silently cover the same filename elsewhere.
#
# Five legitimate classes, and nothing else belongs here:
#
#   1. Illustrative — a walkthrough over something the project does not
#      have. The surrounding prose must make the hypothetical obvious.
#   2. Historical — an ADR naming what it superseded or deleted. A
#      decision record that cannot name the thing it removed is useless.
#   3. Proposed — a named artifact that should exist and does not yet,
#      inside an explicit gap marker. These are IOUs: the entry is
#      removed in the same PR that lands the file.
#   4. External identifier — an `owner/repo` name that collides with a
#      tracked top-level directory. `docker/login-action` is a GitHub
#      Action, not this repository's `docker/` directory.
#   5. Generated artifact — gitignored, so absent from a clean checkout
#      and present only after the generating run. Listed one path at a
#      time on purpose: a blanket "gitignored paths pass" rule used to
#      live in `resolves()` and exempted every ignored path in the tree,
#      including all of `docs/wip/` and `dist/`, for the sake of these
#      four citations.
#
# Keep this list small. An entry is a promise that a reader who greps
# for the path and finds nothing has been told why.
ALLOWLIST=(
  # (1) ARCHITECTURE.md § "Adding a new entity (e.g., Supplier)" — a
  # walkthrough over an entity the project does not have. The section
  # header names the example, so the paths read as hypothetical.
  "ARCHITECTURE.md|src/server/services/SupplierService.ts"
  "ARCHITECTURE.md|src/server/repositories/supplier-read.ts"
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

  # (4) GitHub Actions published by the `docker` org, named in ADR-0011's
  # comparison of build approaches. Collides with this repo's `docker/`
  # directory only because the org shares its name.
  "docs/adr/0011-build-images-in-ci-distribute-via-ghcr.md|docker/login-action"
  "docs/adr/0011-build-images-in-ci-distribute-via-ghcr.md|docker/build-push-action"
  "docs/adr/0011-build-images-in-ci-distribute-via-ghcr.md|docker/setup-buildx-action"

  # (5) The scratch directory, gitignored and created on demand, so it is
  # absent from a clean checkout. CLAUDE.md is the document that DEFINES
  # the convention — it has to be able to name it. This is the only
  # citation of an ignored path that is not a generated artifact.
  "CLAUDE.md|docs/wip/"

  # (5) Pixabay stock photos and the phone backdrop, gitignored per
  # .gitignore and written by the opt-in demo recording flow.
  "docs/demo/storyboard.md|e2e/fixtures/demo/site-1.jpg"
  "docs/testing/demo-recordings.md|e2e/fixtures/demo/site-1.jpg"
  "docs/testing/demo-recordings.md|e2e/fixtures/demo/site-2.jpg"
  "docs/testing/demo-recordings.md|scripts/demo/assets/phone-backdrop.jpg"
)

is_allowlisted() {
  local doc="$1" candidate="$2" entry
  for entry in "${ALLOWLIST[@]}"; do
    [ "${doc}|${candidate}" = "$entry" ] && return 0
  done
  return 1
}

# Resolves iff the path is TRACKED — in the git index — as a file, as a
# directory, or through a fallback extension.
#
# Deliberately not `[ -e ]`. The filesystem answers a different question
# than CI asks: a gitignored or merely-untracked path that happens to sit
# in your working tree resolves locally and fails on a clean checkout.
# That is not hypothetical — `docs/wip/` passed every local run and
# failed in CI, because the scratch directory exists here and nowhere
# else. Reading the index makes a local pass mean what it says.
#
# Being gitignored is therefore not a pass either. It used to be an
# explicit one, which exempted every ignored path in the tree —
# `docs/wip/`, `dist/`, `data/` — to cover four demo-asset citations.
# Documentation should not be pointing at ignored paths; the five that
# legitimately do are ALLOWLIST class (5), each visible and reviewed.
resolves() {
  local candidate="${1%/}" ext
  [ -n "${TRACKED[$candidate]:-}" ] && return 0
  [ -n "${TRACKED_DIRS[$candidate]:-}" ] && return 0
  for ext in "${FALLBACK_EXTENSIONS[@]}"; do
    [ -n "${TRACKED[${candidate}${ext}]:-}" ] && return 0
  done
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

    # Repository-path shape: names a tracked top-level directory, and no
    # glob metacharacters (the extractor's charset already excludes
    # them).
    has_repo_prefix "$candidate" || continue

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
  echo "       historical, a named coverage gap, an external identifier," >&2
  echo "       or a gitignored artifact." >&2
  echo "" >&2
  printf "%s" "$findings" | sort -u >&2
  exit 1
fi

echo "OK: every repository path cited in documentation resolves."
echo "    documents scanned: ${#DOCS[@]}"
echo "    path references checked: ${checked}"
echo "    allowlist size: ${#ALLOWLIST[@]}"
