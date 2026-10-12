#!/usr/bin/env bash
#
# Doc-drift check — files and functions cited in prose must exist (AC-347).
#
# Every tracked `*.md` names files: `src/server/services/mutate.ts`,
# `scripts/backup/load-drill-key.sh`, `e2e/kanban-flows.spec.ts`. When a
# file is renamed or deleted, the prose keeps its old name and nothing
# notices — the third round of doc-vs-code drift fixed by hand (#289,
# #292, #306) all included dead path references.
#
# Scope: inline code spans only (`` `like this` ``). Three forms are
# claims:
#
#   1. Repository path — contains a `/`, and its first segment is a
#      tracked top-level directory. That set is DERIVED from
#      `git ls-files`, not hardcoded: a hardcoded {src, scripts, e2e,
#      docs, .github} silently skipped `assets/`, `docker/`, `.husky/`,
#      `review/`, `fixtures/`, `patches/` and `public/`.
#   2. File name — bare (`mutate.ts`) or partial (`routes/auth.ts`),
#      carrying an extension some tracked file carries. Resolves when a
#      tracked path ends with it at a segment boundary, so `oauth.ts`
#      does not keep a dead `auth.ts` alive. Basenames collide by the
#      dozen here (`auth.ts`, `events.ts`); a partial path pins which
#      one is meant. The extension set is read off the tree, which is
#      what keeps `crypto.subtle`, `payload.after` and `10.213.17.1` out:
#      no tracked file ends in `.subtle`. `invoices.test.ts` survived in
#      the traceability ledger after the file was split (#490).
#   3. Call form — `name()`. Resolves when its final segment
#      (`app.swagger()` → `swagger`) occurs as a whole word in a tracked
#      non-markdown file. ARCHITECTURE.md cited
#      `assertBinaryAgeIdentityLoaded()` long after the rename (#490).
#      A comment can keep a dead name alive; a full rename — the real
#      failure — is caught. A bare identifier is not a claim: a type
#      name and a deleted module are indistinguishable there.
#
# Host paths — `/etc/…`, `~/…`, `./deploy.sh` — name files on a machine,
# not in this tree, and are not claims.
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
# Resolution reads the git INDEX, not the working tree, so the result
# does not depend on which untracked or gitignored files happen to be
# lying around. A local run and CI see the same repository.
#
# Exit codes:
#   0 — every claim resolves
#   1 — at least one dead citation; each printed as `doc -> citation`
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
#
# TRACKED_TAILS holds every segment-boundary tail of a tracked path
# (`src/server/routes/auth.ts` → `routes/auth.ts`, `auth.ts`, …), which
# is what a bare or partial file name resolves against. TRACKED_EXTS is
# the set of extensions those files carry — what makes a dotted name a
# file claim at all.
declare -A TRACKED=()
declare -A TRACKED_DIRS=()
declare -A TRACKED_TAILS=()
declare -A TRACKED_EXTS=()

# The extension of a basename, `os.path.splitext`-style: leading dots
# belong to the name, so `.gitignore` and `.ts` carry none and
# `.env.example` carries `example`. Sets EXT, empty when there is none —
# a variable, not `$(…)`: a subshell per span made the scan 30x slower.
extension_of() {
  local name="${1#"${1%%[!.]*}"}"
  EXT=""
  case "$name" in *.*) EXT="${name##*.}" ;; esac
}

while IFS= read -r tracked_file; do
  TRACKED["$tracked_file"]=1
  extension_of "${tracked_file##*/}"
  [ -n "$EXT" ] && TRACKED_EXTS["$EXT"]=1
  tracked_tail="$tracked_file"
  while :; do
    TRACKED_TAILS["$tracked_tail"]=1
    [ "${tracked_tail#*/}" = "$tracked_tail" ] && break
    tracked_tail="${tracked_tail#*/}"
  done
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

# Citations that name a file or function which does not exist, on
# purpose. Entries are `document|citation`, both matched exactly — an
# exemption earned by one ADR does not silently cover the same filename
# elsewhere. A call-form entry keeps its `()`.
#
# Six legitimate classes, and nothing else belongs here:
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
#   6. Outside the tracked tree — a file on a host, inside a dependency,
#      or created at run time (an archive member, a bucket object).
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

  # (1) ARCHITECTURE.md § "Adding a new SSE event" — `X` stands for the
  # entity; the recipe names the helper's shape, not one that exists.
  "ARCHITECTURE.md|emitXChanged()"

  # (1) CONTRIBUTING.md names the CSS-module file suffix as a convention.
  "CONTRIBUTING.md|.module.css"

  # (2) ADR-0012 is the decision that deleted the workflow — it names it
  # in the problem statement, in the `workflow_run` incident, and in the
  # consequences list ("deleted").
  "docs/adr/0012-manual-pull-based-deploy-over-wireguard.md|.github/workflows/deploy.yml"
  "docs/adr/0012-manual-pull-based-deploy-over-wireguard.md|deploy.yml"

  # (2) ADR-0020 § the dcron → croner rewrite: both paths are named in
  # the past tense as part of the superseded container design
  # ("The container's PID 1 was dcron…", "formerly … probe-r2.mjs").
  "docs/adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md|scripts/backup/crontab"
  "docs/adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md|scripts/backup/probe-r2.mjs"
  "docs/adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md|entrypoint.sh"
  "docs/adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md|run-backup.sh"
  "docs/adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md|run-drill.sh"

  # (6) The brand-logo drop-in directory (#189). A deployment creates
  # `public/brand/` and commits its own asset there; this generalized
  # repo ships none of its own per ADR-0001, so the directory is empty
  # and git tracks nothing under it. The spec cites the path to say
  # where the file goes. Drop this entry if the repo ever tracks one.
  "docs/spec/architecture.md|public/brand/"

  # (3) Named coverage gaps in the traceability ledger — each sits
  # inside a "**GAP** — … follow-up to add `X`" note. Drop the entry
  # when the spec lands.
  "docs/testing/traceability.md|e2e/project-detail-page.spec.ts"
  "docs/testing/traceability.md|e2e/project-detail-attachments.spec.ts"
  "docs/testing/traceability.md|src/server/__tests__/project-detail-workers.test.ts"
  "docs/testing/traceability.md|project-site-address.spec.ts"

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

  # (5) The Service Worker bundle, built from `src/sw/`.
  "docs/adr/0024-binary-attachment-e2e-encryption.md|dist/sw.js"

  # (6) Members of the takeout archive, created at export time.
  "DATA.md|data.json"
  "DATA.md|manifest.json"
  "docs/spec/api.md|data.json"
  "docs/spec/api.md|manifest.json"
  "docs/spec/ui/daten.md|data.json"
  "docs/spec/ui/daten.md|manifest.json"
  "docs/spec/verification.md|data.json"
  "docs/spec/verification.md|manifest.json"
  "docs/testing/traceability.md|data.json"
  "docs/testing/traceability.md|manifest.json"

  # (6) The backup status object in the R2 bucket.
  "docs/adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md|status/latest.json"
  "docs/ops/backup/overview.md|status/latest.json"
  "docs/ops/backup/recovery.md|status/latest.json"
  "docs/ops/backup/setup.md|status/latest.json"
  "docs/testing/traceability.md|status/latest.json"

  # (6) A file inside a dependency, and one in the deploy user's home on
  # the VPS.
  "docs/ops/dep-management.md|@noble/hashes/legacy.js"
  "docs/ops/manual-deploy.md|~deploy/.docker/config.json"
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
# Documentation should not be pointing at ignored paths; the ones that
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

# True iff the candidate is a file name — bare or partial — whose
# extension some tracked file carries. Host paths are not claims.
is_file_name() {
  case "$1" in /* | \~/* | ./*) return 1 ;; esac
  extension_of "${1##*/}"
  [ -n "$EXT" ] && [ -n "${TRACKED_EXTS[$EXT]:-}" ]
}

# Call-form identifiers: dotted name segments, then `()`. Every final
# segment cited anywhere is resolved in ONE `git grep` over the index
# (`--cached`, same reason as `resolves()`), not a process per name.
CALL_FORM='`[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*\(\)`'
declare -A CALL_FOUND=()
mapfile -t CALL_NAMES < <(grep -ohE "$CALL_FORM" "${DOCS[@]}" |
  sed -E 's/^`(.*)\(\)`$/\1/; s/.*\.//' | sort -u || true)
if [ "${#CALL_NAMES[@]}" -gt 0 ]; then
  while IFS= read -r found; do
    CALL_FOUND["$found"]=1
  done < <(git grep --cached -ohwF -f <(printf '%s\n' "${CALL_NAMES[@]}") \
    -- ':(exclude)*.md' | sort -u || true)
fi

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
    # them). Otherwise a bare or partial file name, or not a claim.
    if has_repo_prefix "$candidate"; then
      checked=$((checked + 1))
      is_allowlisted "$doc" "$candidate" && continue
      resolves "$candidate" && continue
    elif is_file_name "$candidate"; then
      checked=$((checked + 1))
      is_allowlisted "$doc" "$candidate" && continue
      [ -n "${TRACKED_TAILS[$candidate]:-}" ] && continue
    else
      continue
    fi
    findings="${findings}${doc} -> ${candidate}"$'\n'
  done < <(grep -oE '`[A-Za-z0-9_./:~@-]+`' "$doc" | tr -d '`' || true)

  # Call-form identifiers. The charset above excludes `(`, so the two
  # scans never see the same span.
  while IFS= read -r span; do
    checked=$((checked + 1))
    is_allowlisted "$doc" "$span" && continue
    name="${span%\(\)}"
    [ -n "${CALL_FOUND[${name##*.}]:-}" ] && continue
    findings="${findings}${doc} -> ${span}"$'\n'
  done < <(grep -oE "$CALL_FORM" "$doc" | tr -d '`' || true)
done

if [ -n "$findings" ]; then
  echo "ERROR: documentation cites files or functions that do not exist." >&2
  echo "       Update the prose to the current name — a partial path" >&2
  echo "       (\`routes/auth.ts\`) pins a basename several files share —" >&2
  echo "       or add an inline-documented \`document|citation\` entry to" >&2
  echo "       ALLOWLIST in $(basename "$0") if the citation is" >&2
  echo "       illustrative, historical, a named coverage gap, an external" >&2
  echo "       identifier, or names something outside the tracked tree" >&2
  echo "       (built, on a host, in a dependency, created at run time)." >&2
  echo "" >&2
  printf "%s" "$findings" | sort -u >&2
  exit 1
fi

echo "OK: every file and function cited in documentation resolves."
echo "    documents scanned: ${#DOCS[@]}"
echo "    citations checked: ${checked}"
echo "    allowlist size: ${#ALLOWLIST[@]}"
