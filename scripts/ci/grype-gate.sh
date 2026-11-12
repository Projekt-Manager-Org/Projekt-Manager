#!/usr/bin/env bash
#
# Severity gate over a Grype JSON report (#724; ADR-0027 § Decision.2).
#
# WHY THIS EXISTS
#   `grype --fail-on high` cannot fail on an unrated advisory: Grype ranks
#   Unknown below Negligible, so no threshold reaches it. Unrated is not
#   yet assessed, not low — Go vuln DB advisories carry no severity by
#   design, and Go binaries are seen only by the image scans.
#
# CONTRACT
#   Argument: the report path (`grype ... -o json=<path>`).
#   Fails on every entry of `matches` whose severity is not Negligible,
#   Low or Medium (Grype's spelling): High, Critical, Unknown and a
#   missing severity (the field is `omitempty`) alike. Allowlisted
#   findings sit in `ignoredMatches` and are not read.
#
# EXIT CODES
#   0  no failing match
#   1  failing matches, one ::error:: line each
#   2  the report is missing, not JSON or has no `matches` array
#   other  jq failed on a malformed match

set -euo pipefail

report="${1:?usage: grype-gate.sh <report.json>}"

if ! jq -e '.matches | type == "array"' "$report" > /dev/null 2>&1; then
  echo "::error::Grype report $report is missing, not JSON or has no matches array"
  exit 2
fi

failing=$(jq -r '
  .matches[]
  | (.vulnerability.severity // "") as $sev
  | select(["Negligible", "Low", "Medium"] | index($sev) | not)
  | "::error::\(.vulnerability.id) \(if $sev == "" then "unrated" else $sev end): \(.artifact.name)@\(.artifact.version) (\([.artifact.locations[]?.path] | join(", ")))"
' "$report")

if [[ -n "$failing" ]]; then
  echo "$failing"
  echo "$(wc -l <<< "$failing") Grype finding(s) at High, Critical or unrated."
  exit 1
fi
echo "✓ Grype: nothing at High, Critical or unrated."
