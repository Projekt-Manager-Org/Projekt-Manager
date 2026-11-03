#!/usr/bin/env bash
#
# Verdict over Trivy image-scan JSON reports (#725; ADR-0027 § 2026-10-31).
#
# WHY THIS EXISTS
#   The PR image gate fails on findings a change introduces, not on what
#   `main` already ships: an advisory published against `main`'s images
#   used to turn every PR red, the ones carrying the fix included, and so
#   did a lapsed .trivyignore.yaml entry. The nightly inventory scan owns
#   `main` and stays absolute.
#
# CONTRACT
#   Arguments: the head report and, in the PR gate, the base report (the
#   `:main` image, scanned in the same job with the same DB and allowlist,
#   so a lapsed entry shows on both sides). Trivy has already applied the
#   severity floor and the allowlist; this reads what is left: the image
#   scan's default scanners, vulnerabilities and secrets.
#
#   A finding is keyed on (id, package, location in the image). A
#   vulnerability's location is PkgPath when set, else the Target of a non-OS
#   result (a Go binary's path); OS results put the image reference in Target,
#   so they use the OS type. A secret is (rule id, "secret", file). Version is
#   not in the key: a bump that stays vulnerable introduces nothing. Location
#   is, unlike the OSV gate's key, because the allowlist is path-scoped:
#   gosu's stdlib CVE must not pass it in Caddy.
#
#   Fails on every head finding whose key the base lacks; without a base,
#   on every finding.
#
# RESIDUAL
#   `:main` lags the true base (until `promote` runs; behind earlier entries
#   of a queue batch), never leads it. A finding it still carries that a
#   newer base fixed passes when a change brings it back. The nightly reads
#   `:main` and is red on that key until it moves. An exact `sha-<base>`
#   image is not always published yet when a queue entry runs.
#
# FAIL-CLOSED
#   Each report must be SchemaVersion 2, with every vulnerability carrying a
#   non-empty VulnerabilityID and PkgName, and every secret a RuleID. A
#   renamed field after a Trivy bump must not read as clean, nor collapse
#   keys so head findings match the base. Misconfiguration or license
#   findings fail too: this reads neither, so a scanner added to the scan
#   must come with a key here. `Results`, `Vulnerabilities` and `Secrets`
#   are `omitempty`: absent means clean.
#
# EXIT CODES
#   0  no finding introduced
#   1  a finding introduced (or any finding, without a base), ::error:: each
#   2  a report is missing, not JSON or not in the expected shape; bad usage

set -euo pipefail

if (($# < 1 || $# > 2)); then
  echo "usage: trivy-gate.sh <head.json> [<base.json>]" >&2
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

for report in "$@"; do
  if ! jq -e "$shape" "$report" > /dev/null 2>&1; then
    echo "::error::Trivy report $report is missing, not JSON or not in the expected shape"
    exit 2
  fi
done

# shellcheck disable=SC2016  # jq program, not a shell expansion
findings='
  def findings:
    (.Results // [])[] | . as $r
    | ((.Vulnerabilities // [])[]
        | {id: .VulnerabilityID, sev: .Severity, what: "\(.PkgName)@\(.InstalledVersion // "?")",
           key: [.VulnerabilityID, .PkgName,
             (if (.PkgPath // "") != "" then .PkgPath
              elif $r.Class == "os-pkgs" then "os:\($r.Type // "")"
              else $r.Target end)]}),
      ((.Secrets // [])[]
        | {id: .RuleID, sev: .Severity, what: "secret", key: [.RuleID, "secret", $r.Target]});'

# One line per head finding: "new<TAB>…" or "base<TAB>…". No base: /dev/null
# slurps to nothing, so every finding is new.
lines=$(jq -r --slurpfile base "${2:-/dev/null}" "$findings"'
  [$base[0] // {} | findings | .key] as $keys
  | findings
  | (if (.key as $k | $keys | index([$k])) then "base" else "new" end)
    + "\t\(.id) \(.sev // "UNKNOWN"): \(.what) (\(.key[2]))"
' "$1")

introduced=$(awk -F'\t' '$1 == "new" { print "::error::" $2 }' <<< "$lines")
preexisting=$(awk -F'\t' '$1 == "base" { print "  " $2 }' <<< "$lines")

if [[ -n "$preexisting" ]]; then
  echo "Already in the base image (the nightly owns these):"
  echo "$preexisting"
fi
if [[ -n "$introduced" ]]; then
  echo "$introduced"
  if (($# == 2)); then
    echo "$(wc -l <<< "$introduced") Trivy finding(s) introduced by this change."
  else
    echo "$(wc -l <<< "$introduced") Trivy finding(s)."
  fi
  exit 1
fi
echo "✓ Trivy: no finding${2:+ introduced}."
