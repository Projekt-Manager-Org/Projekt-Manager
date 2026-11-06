#!/usr/bin/env bash
#
# Verdict over a Trivy image-scan JSON report (#740). Trivy has already
# applied the severity floor and the allowlist; every finding left fails.
#
# FAIL-CLOSED
#   The report must be SchemaVersion 2, with every vulnerability carrying a
#   non-empty VulnerabilityID and PkgName, and every secret a RuleID. A
#   renamed field after a Trivy bump must not read as clean. Misconfiguration
#   or license findings fail too: this reads neither, so a scanner added to
#   the scan must come with a line here. `Results`, `Vulnerabilities` and
#   `Secrets` are `omitempty`: absent means clean.
#
# EXIT CODES
#   0  no finding
#   1  a finding, one ::error:: line each
#   2  the report is missing, not JSON or not in the expected shape; bad usage

set -euo pipefail

if (($# != 1)); then
  echo "usage: trivy-gate.sh <report.json>" >&2
  exit 2
fi

shape='
  def ids(f): all(.[]; f | type == "string" and length > 0);
  .SchemaVersion == 2
  and ((.Results // []) | type == "array")
  and all((.Results // [])[];
    (.Target | type == "string")
    and (.Class | type == "string")
    and ((.Vulnerabilities // []) | type == "array" and ids(.VulnerabilityID) and ids(.PkgName))
    and ((.Secrets // []) | type == "array" and ids(.RuleID))
    and ((.Misconfigurations // []) | length == 0)
    and ((.Licenses // []) | length == 0))'

if ! jq -e "$shape" "$1" > /dev/null 2>&1; then
  echo "::error::Trivy report $1 is missing, not JSON or not in the expected shape"
  exit 2
fi

# A vulnerability's location is PkgPath when set, else the Target of a non-OS
# result (a Go binary's path); OS results put the image reference in Target.
# shellcheck disable=SC2016  # jq program, not a shell expansion
findings=$(jq -r '
  (.Results // [])[] | . as $r
  | ((.Vulnerabilities // [])[]
      | "::error::\(.VulnerabilityID) \(.Severity // "UNKNOWN"): \(.PkgName)@\(.InstalledVersion // "?") (\(
          if (.PkgPath // "") != "" then .PkgPath
          elif $r.Class == "os-pkgs" then "os:\($r.Type // "")"
          else $r.Target end))"),
    ((.Secrets // [])[] | "::error::\(.RuleID) \(.Severity // "UNKNOWN"): secret (\($r.Target))")
' "$1")

if [[ -n "$findings" ]]; then
  echo "$findings"
  echo "$(wc -l <<< "$findings") Trivy finding(s)."
  exit 1
fi
echo "✓ Trivy: no finding."
