#!/usr/bin/env bash
#
# Traceability check — spec ACs ↔ tests ↔ exceptions (S-ACTR, S-TRAC).
#
# Tests are the test spec: an AC is covered when a test file cites its ID.
# There is no hand-kept matrix; `grep -rn AC-245 src e2e` is the map.
#
# Inputs:
#   docs/spec/verification.md                AC definitions:
#                                            - **AC-<n>** `[crit|vis|infra]`: …
#   docs/testing/verification-exceptions.md  | AC-<n> | infra | gap | retired | … |
#   every tracked file                       AC references
#
# Fails when:
#   - a definition is malformed (suffix ID, missing tier) or duplicated;
#   - any tracked file cites an AC that is unknown or retired — an ID's
#     meaning never changes and IDs are never reused (#486 B), so a stale
#     reference cannot quietly resolve to a different requirement — or
#     cites a range of ACs instead of listing each;
#   - a defined AC is cited by no test and has no `infra`/`gap` row;
#   - an exception row is stale or inconsistent: `gap`/`infra` for an AC a
#     test now cites, `infra` for a non-[infra] AC, `retired` for a defined
#     one, a duplicate row, an unknown status.
#
# Test file: `*.test.*`, `*.spec.*`, or under `scripts/__tests__/`. A code
# comment citing an AC must resolve but is not coverage.
#
# Exit 0 = clean, 1 = findings. $TRACEABILITY_ROOT overrides the repo root
# (used by the self-test).
#
# Usage:
#   bash scripts/check-traceability.sh

set -euo pipefail
export LC_ALL=C

ROOT="${TRACEABILITY_ROOT:-$(git rev-parse --show-toplevel)}"
cd "$ROOT"

SPEC="docs/spec/verification.md"
EXC="docs/testing/verification-exceptions.md"
# Carry AC IDs as fixtures or as the retirement record, not as references.
NOT_REFERENCES=("$EXC" scripts/check-traceability.sh scripts/__tests__/check-traceability.test.sh)

errors=()
declare -A tier_of=() status_of=() covered=()

# --- Definitions ---------------------------------------------------------
def_re='^- \*\*(AC-[0-9]+)\*\* `\[(crit|vis|infra)\]`'
while IFS= read -r line; do
  if [[ "$line" =~ $def_re ]]; then
    id="${BASH_REMATCH[1]}"
    [[ -n "${tier_of[$id]:-}" ]] && errors+=("$SPEC: $id defined twice")
    tier_of[$id]="${BASH_REMATCH[2]}"
  else
    errors+=("$SPEC: malformed definition (suffix ID or missing tier): ${line:0:80}")
  fi
done < <(grep -E '^- \*\*AC-' "$SPEC" || true)

# --- Exceptions ----------------------------------------------------------
if [[ ! -f "$EXC" ]]; then
  errors+=("$EXC: missing")
else
  while IFS='|' read -r _ id status _; do
    id="${id// /}"
    status="${status// /}"
    if [[ ! "$id" =~ ^AC-[0-9]+$ ]]; then
      errors+=("$EXC: malformed ID '$id'")
      continue
    fi
    [[ -n "${status_of[$id]:-}" ]] && errors+=("$EXC: $id listed twice")
    status_of[$id]="$status"
    case "$status" in
      infra)
        [[ "${tier_of[$id]:-}" == infra ]] ||
          errors+=("$EXC: $id is 'infra' but not a defined [infra] AC")
        ;;
      gap)
        [[ -n "${tier_of[$id]:-}" ]] || errors+=("$EXC: $id is 'gap' but not defined")
        ;;
      retired)
        [[ -z "${tier_of[$id]:-}" ]] || errors+=("$EXC: $id is 'retired' but still defined")
        ;;
      *)
        errors+=("$EXC: $id has unknown status '$status'")
        ;;
    esac
  done < <(grep -E '^\| *AC-' "$EXC" || true)
fi

# --- References ----------------------------------------------------------
exclude=()
for f in "${NOT_REFERENCES[@]}"; do exclude+=(-e "$f"); done

while IFS=: read -r file id; do
  if [[ -n "${tier_of[$id]:-}" ]]; then
    if [[ "$file" == *.test.* || "$file" == *.spec.* || "$file" == scripts/__tests__/* ]]; then
      covered[$id]=1
    fi
  elif [[ "${status_of[$id]:-}" == retired ]]; then
    errors+=("$file: cites retired $id")
  else
    errors+=("$file: cites unknown $id")
  fi
done < <(git ls-files -z | grep -zvxF "${exclude[@]}" |
  xargs -0 grep -oHIP '\bAC-\d+[a-z]?\b' 2>/dev/null | sort -u || true)

# A range (`AC-189..AC-193`, `AC-155–158`) hides every ID but the first
# from the checks above — including a retired one inside it.
while IFS= read -r hit; do
  errors+=("${hit%%:*}: AC range '${hit#*:}' — list each ID")
done < <(git ls-files -z | grep -zvxF "${exclude[@]}" |
  xargs -0 grep -oHIP '\bAC-\d+\s*(\.\.|–|—|-)\s*(AC-)?\d+\b' 2>/dev/null | sort -u || true)

# --- Coverage ------------------------------------------------------------
for id in "${!tier_of[@]}"; do
  status="${status_of[$id]:-}"
  if [[ -n "${covered[$id]:-}" ]]; then
    [[ "$status" == infra || "$status" == gap ]] &&
      errors+=("$EXC: $id is '$status' but a test cites it — drop the row")
  elif [[ "$status" != infra && "$status" != gap ]]; then
    errors+=("$id: cited by no test and has no exception row")
  fi
done

# --- Numbering -----------------------------------------------------------
# Every number up to the highest ID is defined or retired, so a free
# number can never be handed out again: new IDs are max + 1.
max=0
for id in "${!tier_of[@]}" "${!status_of[@]}"; do
  n="${id#AC-}"
  ((n > max)) && max="$n"
done
for ((n = 1; n <= max; n++)); do
  [[ -z "${tier_of[AC-$n]:-}" && "${status_of[AC-$n]:-}" != retired ]] &&
    errors+=("AC-$n: neither defined nor retired — IDs are never reused")
done

# --- Report --------------------------------------------------------------
if ((${#errors[@]} > 0)); then
  echo "Traceability check FAILED — ${#errors[@]} finding(s):" >&2
  printf '%s\n' "${errors[@]}" | sort | sed 's/^/  - /' >&2
  exit 1
fi
echo "✓ Traceability clean — ${#tier_of[@]} ACs, ${#covered[@]} cited by tests."
