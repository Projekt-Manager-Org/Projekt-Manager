#!/usr/bin/env bash
#
# Static drift check between the `postgres` service container in
# .github/workflows/ci.yml and the one in .github/workflows/e2e.yml.
#
# Both jobs run the app's integration code against a throwaway Postgres,
# so the two service blocks are ONE decision expressed twice: same image
# major, same role and password, same published port, same health probe.
# When they diverge, the workflow that was not edited keeps running
# against the old shape — and because e2e.yml is `workflow_dispatch`
# only, that divergence surfaces at the moment an operator clicks "Run
# workflow" before a manual deploy, which is the worst time to discover
# it. The `-h 127.0.0.1` health probe is the live example: a socket
# probe reports healthy during the entrypoint's init-phase temporary
# server, so fixing it in one file and not the other leaves the other
# flaky for a reason unrelated to any diff.
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
#   Workflow-level YAML anchors are not supported either. So the
#   duplication stays and the invariant gets machine-enforced instead —
#   same pattern as check-env-drift.sh.
#
# WHAT IT COMPARES
#   The `services.postgres` block of each file, with whole-line comments
#   and the block's base indentation removed. Comments are stripped
#   deliberately: each file explains the block in its own terms (vitest's
#   per-fork databases vs Playwright's `ensure-db.mjs`), and forcing those
#   to match would be enforcing prose, not configuration. Everything else
#   — image, env, ports, options — must be identical.
#
# EXIT CODES
#   0  in sync
#   1  drift (the diff is printed)
#   2  structural problem — a file or block is missing, or a file holds
#      more than one postgres service, which would make "the block"
#      ambiguous and let this check pass while comparing the wrong pair.
#
# Usage:
#   bash scripts/check-workflow-service-drift.sh
#
# The two paths are overridable so the self-test
# (scripts/__tests__/check-workflow-service-drift.test.sh) can stage
# mutated copies without touching the real workflows.

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

# Exactly one postgres service per file. Two would mean the extractor
# silently compares the first of each and reports "in sync" about a pair
# nobody asked about.
for f in "$CI_WORKFLOW" "$E2E_WORKFLOW"; do
  count=$(grep -c '^[[:space:]]*postgres:[[:space:]]*$' "$f" || true)
  if [ "$count" -ne 1 ]; then
    echo "ERROR: $f declares $count 'postgres:' service blocks, expected exactly 1." >&2
    echo "       This check compares one block per file; teach it which pair to" >&2
    echo "       compare before adding a second." >&2
    exit 2
  fi
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

ci_block="$(extract_pg_service "$CI_WORKFLOW")"
e2e_block="$(extract_pg_service "$E2E_WORKFLOW")"

if [ -z "$ci_block" ]; then
  echo "ERROR: no services.postgres block extracted from $CI_WORKFLOW — did the format change?" >&2
  exit 2
fi
if [ -z "$e2e_block" ]; then
  echo "ERROR: no services.postgres block extracted from $E2E_WORKFLOW — did the format change?" >&2
  exit 2
fi

if [ "$ci_block" != "$e2e_block" ]; then
  echo "ERROR: the postgres service containers in $CI_WORKFLOW and $E2E_WORKFLOW have drifted." >&2
  echo "" >&2
  echo "--- $CI_WORKFLOW" >&2
  echo "+++ $E2E_WORKFLOW" >&2
  diff <(printf '%s\n' "$ci_block") <(printf '%s\n' "$e2e_block") >&2 || true
  echo "" >&2
  echo "Both jobs run integration code against a throwaway Postgres and are meant" >&2
  echo "to be the same environment. Apply the change to both blocks." >&2
  echo "" >&2
  echo "If the two genuinely must differ now, that is a design change, not a fixup:" >&2
  echo "say why in a comment in both files and narrow this check to the fields that" >&2
  echo "are still shared — do not delete it." >&2
  exit 1
fi

echo "OK: $CI_WORKFLOW ↔ $E2E_WORKFLOW services.postgres in sync"
echo "  compared lines (comments stripped): $(printf '%s\n' "$ci_block" | wc -l)"
