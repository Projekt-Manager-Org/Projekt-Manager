#!/usr/bin/env bash
#
# Static drift check: every GitHub Actions runner runs the hosts' Ubuntu
# release (#856).
#
#   docker/host-versions.txt     the hosts' release, encoded in every pin
#                                (`~ubuntu.24.04~noble`, ADR-0009)
#   .github/workflows/*.yml      every `runs-on:` must be `ubuntu-<release>`
#
# CI installs tools from the runner image (apt's `python3-boto3` for the
# restore script, `shellcheck`) and tests code the hosts run with theirs.
# `ubuntu-latest` moved to 26.04 under hosts on 24.04 with every check
# green. Renovate does not bump runners (.github/renovate.json): the
# release moves with the host pins, in one PR.
#
# EXIT CODES
#   0  in sync
#   1  drift (each offending runner or pin is printed)
#   2  structural problem — no pin names an Ubuntu release, or no workflow
#      has a `runs-on:`, which would otherwise pass as "no drift".
#
# Usage:
#   bash scripts/check-runner-release.sh
#
# The root is overridable so the self-test
# (scripts/__tests__/check-runner-release.test.sh) can stage mutated copies.

set -euo pipefail

ROOT="${RELEASE_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
PINS="$ROOT/docker/host-versions.txt"

if [[ ! -f "$PINS" ]]; then
  echo "ERROR: $PINS not found." >&2
  exit 2
fi

mapfile -t releases < <(grep -v '^[[:space:]]*#' "$PINS" | sed -nE 's/.*~ubuntu\.([0-9]+\.[0-9]+)~.*/\1/p' | sort -u)
if ((${#releases[@]} == 0)); then
  echo "ERROR: no pin in docker/host-versions.txt names an Ubuntu release (~ubuntu.XX.YY~)." >&2
  exit 2
fi
if ((${#releases[@]} > 1)); then
  echo "::error::docker/host-versions.txt mixes Ubuntu releases: ${releases[*]}" >&2
  exit 1
fi
release="${releases[0]}"
want="ubuntu-$release"

shopt -s nullglob
workflows=("$ROOT"/.github/workflows/*.yml "$ROOT"/.github/workflows/*.yaml)

# "<file>:<line>: <value>" per `runs-on:` (also quoted or spaced before the
# colon), quotes and trailing comments stripped.
KEY='[[:space:]]*["'"'"']?runs-on["'"'"']?[[:space:]]*:'
found=0
drift=()
for f in "${workflows[@]}"; do
  while IFS= read -r hit; do
    found=1
    value="$(sed -E "s/^[0-9]+:${KEY}[[:space:]]*//; s/[[:space:]]+#.*\$//; s/^[\"']//; s/[\"']\$//" <<<"${hit}")"
    if [[ "$value" != "$want" ]]; then
      drift+=("${f#"$ROOT"/}:${hit%%:*}: $value")
    fi
  done < <(grep -nE "^$KEY" "$f" || true)
done

if ((!found)); then
  echo "ERROR: no \`runs-on:\` in .github/workflows/." >&2
  exit 2
fi

if ((${#drift[@]})); then
  echo "::error::Runner release drift — every runs-on must be $want, the hosts' release (docker/host-versions.txt):" >&2
  printf '  %s\n' "${drift[@]}" >&2
  echo "Fix: pin the runner to $want, or move the host pins and every runner together." >&2
  exit 1
fi
echo "Runners in sync with the hosts: $want"
