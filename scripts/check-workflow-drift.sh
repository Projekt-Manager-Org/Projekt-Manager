#!/usr/bin/env bash
#
# Static drift check for what .github/workflows/ci.yml (`check-shard`) and
# .github/workflows/e2e.yml must keep in agreement:
#
#   1. the `postgres` service container — compared field by field
#   2. the call to .github/actions/install-age — asserted present in both
#
# It is ONE decision expressed twice: the two services must agree on image
# major, role and password, published port and health probe. When they
# diverge, the workflow that was not edited keeps running against the old
# shape — and because e2e.yml is `workflow_dispatch` only, that divergence
# surfaces at the moment an operator clicks "Run workflow" before a manual
# deploy, which is the worst time to discover it.
#
# The `-h 127.0.0.1` health probe is the live example: a socket probe
# reports healthy during the entrypoint's init-phase temporary server, so
# fixing it in one file and not the other leaves the other flaky for a
# reason unrelated to any diff.
#
# WHY A CHECK AND NOT DEDUPLICATION
#   GitHub Actions offers no include mechanism for a service block.
#   Composite actions have no `services` key — action.yml's top-level
#   keys are name/author/description/inputs/outputs/runs/branding, and
#   `runs.steps` takes only `run` and `uses` steps. Reusable workflows
#   CAN declare services, but the unit of reuse is a whole job: folding
#   `check` (2-way shard matrix, vitest) and `e2e` (Playwright,
#   webServer, MinIO) into one parameterised job to share five lines of
#   service config trades a small duplication for a large conditional.
#   Workflow-level YAML anchors are not supported either.
#
#   The `Install age` step WAS compared here, and no longer is: it was
#   deduplicated into .github/actions/install-age. The sole objection to
#   that — Renovate's customManager scanned `.github/workflows/**` only,
#   so a composite would have hidden the pin — was removed by widening
#   the manager's `managerFilePatterns` and the scan in
#   check-renovate-annotations.mjs to `.github/actions/*/*.{yml,yaml,sh}`.
#   See #355 review, .github/renovate.json manager 6, ADR-0027 §Decision.1.
#
#   One definition cannot drift, so the field-by-field comparison is gone.
#   Presence is a separate invariant and is NOT covered by deduplication:
#   drop the `uses:` line from e2e.yml and nothing else in the pipeline
#   notices, because e2e.yml is `workflow_dispatch` only. Hence (2).
#
# WHAT IT CHECKS
#   (1) The postgres block with whole-line comments and its base
#   indentation removed. Comments are stripped deliberately: each file
#   explains its block in its own terms (vitest's per-fork databases vs
#   Playwright's `ensure-db.mjs`), and forcing prose to match would be
#   enforcing prose, not configuration. Everything else — image, env,
#   ports, options — must be identical.
#
#   (2) That each file calls the install-age composite at least once.
#   Both jobs mint a binary `age` identity (ADR-0024) and neither can run
#   without it.
#
# EXIT CODES
#   0  in sync
#   1  drift (the diff is printed)
#   2  structural problem — a file, the postgres block or the install-age
#      call is missing, or a file holds more than one postgres block,
#      which would make "the block" ambiguous and let this check pass
#      while comparing the wrong pair.
#
# Usage:
#   bash scripts/check-workflow-drift.sh
#
# The two paths are overridable so the self-test
# (scripts/__tests__/check-workflow-drift.test.sh) can stage mutated
# copies without touching the real workflows.

set -euo pipefail

cd "$(dirname "$0")/.."

CI_WORKFLOW="${CI_WORKFLOW:-.github/workflows/ci.yml}"
E2E_WORKFLOW="${E2E_WORKFLOW:-.github/workflows/e2e.yml}"

for f in "$CI_WORKFLOW" "$E2E_WORKFLOW"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: $f not found — run from the project root or set CI_WORKFLOW / E2E_WORKFLOW." >&2
    exit 2
  fi
done

# Exactly one of each block per file. Two would mean the extractor
# silently compares the first of each and reports "in sync" about a pair
# nobody asked about.
assert_single() {
  local file="$1" pattern="$2" label="$3" count
  count=$(grep -c "$pattern" "$file" || true)
  if [ "$count" -ne 1 ]; then
    echo "ERROR: $file declares $count '$label' blocks, expected exactly 1." >&2
    echo "       This check compares one block per file; teach it which pair to" >&2
    echo "       compare before adding a second." >&2
    exit 2
  fi
}

# Deduplicating the age step removed the drift risk, not the presence
# risk. The old check exited 2 when the step vanished from either file;
# nothing else does. ci.yml's call is self-protecting (the integration
# suite fails without `age-keygen`), but e2e.yml is `workflow_dispatch`
# only — a dropped call there surfaces when an operator runs it before a
# manual deploy and Playwright dies minting the identity.
#
# Matched loosely enough to survive a `name:` being added above the
# `uses:`; "at least one" rather than "exactly one" because a second call
# is redundant, not ambiguous.
assert_calls_install_age() {
  local file="$1" count
  count=$(grep -cE \
    '^[[:space:]]*(-[[:space:]]*)?uses:[[:space:]]*\./\.github/actions/install-age[[:space:]]*$' \
    "$file" || true)
  if [ "$count" -lt 1 ]; then
    echo "ERROR: $file never calls ./.github/actions/install-age." >&2
    echo "       Both jobs mint a binary \`age\` identity (ADR-0024) and cannot run" >&2
    echo "       without the SHA-pinned install. Re-add the step — or, if the job" >&2
    echo "       genuinely no longer needs age, say so here and drop this guard." >&2
    exit 2
  fi
}

for f in "$CI_WORKFLOW" "$E2E_WORKFLOW"; do
  assert_single "$f" '^[[:space:]]*postgres:[[:space:]]*$' 'postgres:'
  assert_calls_install_age "$f"
done

# Extract `services.postgres` and normalise it for comparison.
#
# awk rather than a YAML parser for the same reason as check-env-drift.sh:
# ubuntu-latest runners ship mawk, and this must run with nothing beyond a
# standard POSIX toolchain. The block is found structurally (a `postgres:`
# key inside a `services:` key), not by line number, so reordering the
# jobs or reindenting a file does not fool it.
extract_pg_service() {
  awk '
    # `services:` at any indent opens the section.
    /^[[:space:]]*services:[[:space:]]*$/ { in_services = 1; next }

    # The `postgres:` key inside it. Its indent is the block boundary:
    # every line belonging to the block is nested deeper.
    in_services && !in_pg && /^[[:space:]]*postgres:[[:space:]]*$/ {
      match($0, /^[[:space:]]*/)
      pg_indent = RLENGTH
      in_pg = 1
      next
    }

    in_pg {
      if ($0 ~ /^[[:space:]]*$/) next            # blank line, no content
      match($0, /^[[:space:]]*/)
      indent = RLENGTH
      if (indent <= pg_indent) { in_pg = 0; next }   # sibling key ends the block
      if ($0 ~ /^[[:space:]]*#/) next            # whole-line comment
      sub(/[[:space:]]+$/, "")                   # trailing whitespace
      lines[++n] = $0
      if (!have_min || indent < min) { min = indent; have_min = 1 }
    }

    # Dedent by the shallowest line so the two blocks compare on relative
    # structure, not on how deep their job happens to sit.
    END { for (i = 1; i <= n; i++) print substr(lines[i], min + 1) }
  ' "$1"
}

# Compare one extracted pair. Prints the diff and returns 1 on drift, 2
# when either side came back empty (the format changed under us).
compare_blocks() {
  local label="$1" ci_block="$2" e2e_block="$3" guidance="$4"

  if [ -z "$ci_block" ]; then
    echo "ERROR: no $label block extracted from $CI_WORKFLOW — did the format change?" >&2
    return 2
  fi
  if [ -z "$e2e_block" ]; then
    echo "ERROR: no $label block extracted from $E2E_WORKFLOW — did the format change?" >&2
    return 2
  fi

  if [ "$ci_block" != "$e2e_block" ]; then
    echo "ERROR: the $label blocks in $CI_WORKFLOW and $E2E_WORKFLOW have drifted." >&2
    echo "" >&2
    echo "--- $CI_WORKFLOW" >&2
    echo "+++ $E2E_WORKFLOW" >&2
    diff <(printf '%s\n' "$ci_block") <(printf '%s\n' "$e2e_block") >&2 || true
    echo "" >&2
    echo "$guidance" >&2
    echo "" >&2
    echo "If the two genuinely must differ now, that is a design change, not a fixup:" >&2
    echo "say why in a comment in both files and narrow this check to the fields that" >&2
    echo "are still shared — do not delete it." >&2
    return 1
  fi

  echo "OK: $CI_WORKFLOW ↔ $E2E_WORKFLOW $label in sync"
  echo "  compared lines (comments stripped): $(printf '%s\n' "$ci_block" | wc -l)"
  return 0
}

status=0

# `|| rc=$?` rather than a bare call: `set -e` would abort before the
# diff and the guidance below it could be printed.
rc=0
compare_blocks \
  "services.postgres" \
  "$(extract_pg_service "$CI_WORKFLOW")" \
  "$(extract_pg_service "$E2E_WORKFLOW")" \
  "Both jobs run integration code against a throwaway Postgres and are meant
to be the same environment. Apply the change to both blocks." || rc=$?
if [ "$rc" -eq 2 ]; then exit 2; fi
if [ "$rc" -ne 0 ]; then status=1; fi

exit "$status"
