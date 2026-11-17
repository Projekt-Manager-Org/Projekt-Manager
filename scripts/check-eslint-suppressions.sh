#!/usr/bin/env bash
#
# Keeps eslint-suppressions.json shrink-only (#937, #939).
#
# WHY THIS EXISTS
#   The file is the baseline of direct database queries outside
#   src/server/repositories/ (rule `local/no-direct-db-access`). ESLint fails
#   on a suppression that no longer matches, but not on a baseline that
#   grew: `eslint --suppress-rule` / `--suppress-all` rewrite it bigger and
#   lint stays green. And ESLint only checks entries for the files it lints,
#   so an entry for a deleted file lingers and hands its allowance to the
#   next file at that path.
#
# FAILS ON
#   Always:
#     - an entry for a rule other than the ones in RATCHET_RULES
#       (`--suppress-all` would freeze every rule's violations);
#     - an entry for a file that does not exist;
#     - an unreadable file.
#   With --base-dir <dir> (the PR gate in `lint`; the base's copy comes from
#   scripts/ci/gate-base.sh):
#     - an entry for a path the base does not have, or a higher count;
#     - the file removed while the base has it. The burn-down ends with the
#       file holding {}, so the one allowance below cannot recur.
#   No file at the base and at the head is fine. A file at the head with
#   none at the base is the change that creates the baseline: allowed once,
#   because removing the file again fails.
#
#   Also always: any line in src/server/ (tests aside) naming a rule in
#   GUARDED_RULES or the eslint-comments guard. Code has no reason to name
#   either; a comment that does disables or reconfigures them (`eslint-disable`, a
#   multi-line block, `/* eslint <rule>: off */`). Lint refuses the plain
#   forms, but a comment can switch the lint guard off too; only a check
#   outside ESLint sees every form.
#
# A rename or split of a file with entries fails: its queries move into a
# repository first (#937, "Rules for every burn-down PR").
#
# EXIT CODES
#   0  ok
#   1  a violation, or the file is unreadable
#   2  usage error
#
# Usage:
#   bash scripts/check-eslint-suppressions.sh [--base-dir <dir>]
#
# SUPPRESSIONS_PROJECT_ROOT overrides the project root (tests).

set -euo pipefail

ROOT="${SUPPRESSIONS_PROJECT_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
FILE=eslint-suppressions.json
RATCHET_RULES='local/no-direct-db-access'
# Rules no inline comment may switch off: ADR-0021's gate (#938), with the bans
# that keep a type error from forging its handle (#964). None has a baseline:
# an entry fails like any other non-ratchet rule.
GUARDED_RULES="$RATCHET_RULES local/audit-write-gate @typescript-eslint/ban-ts-comment @typescript-eslint/no-explicit-any @typescript-eslint/no-unsafe-function-type"

BASE_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-dir)
      BASE_DIR="${2:-}"
      if [[ -z "$BASE_DIR" ]]; then
        echo "ERROR: --base-dir needs a directory" >&2
        exit 2
      fi
      if [[ ! -d "$BASE_DIR" ]]; then
        echo "ERROR: --base-dir '$BASE_DIR' is not a directory" >&2
        exit 2
      fi
      shift 2
      ;;
    *)
      echo "ERROR: unknown argument '$1'" >&2
      exit 2
      ;;
  esac
done

HEAD_FILE="$ROOT/$FILE"
BASE_FILE="${BASE_DIR:+$BASE_DIR/$FILE}"
status=0

# shellcheck disable=SC2086 # GUARDED_RULES is a space-separated list
guarded="$(printf '%s|' $GUARDED_RULES)eslint-comments/"
if [[ -d "$ROOT/src/server" ]]; then
  disables="$(grep -rEn --include='*.ts' --exclude-dir=__tests__ \
    "(${guarded})" "$ROOT/src/server" || true)"
  if [[ -n "$disables" ]]; then
    while IFS= read -r line; do
      echo "::error::${line#"$ROOT"/}: names a guarded lint rule or its guard, which only disables or reconfigures it. Fix the code instead: move a query into src/server/repositories/, route an audited write through mutate(), type a value instead of \`any\`, \`Function\` or a @ts- comment." >&2
    done <<<"$disables"
    status=1
  fi
fi

node - "$ROOT" "$HEAD_FILE" "${BASE_FILE:-}" "$RATCHET_RULES" <<'EOF' || status=1
const fs = require('fs');
const path = require('path');
const [root, headFile, baseFile, ratchetRules] = process.argv.slice(2);
const allowedRules = new Set(ratchetRules.split(/\s+/).filter(Boolean));
const problems = [];

function load(file, label) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    return data;
  } catch (err) {
    console.error(`::error::${label} eslint-suppressions.json is unreadable: ${err.message}`);
    process.exit(1);
  }
}

const head = load(headFile, 'the');
const base = load(baseFile, "the base's");

if (head === null) {
  if (base !== null) {
    problems.push('eslint-suppressions.json is removed, but the base has it. Pay entries down to {} instead.');
  }
} else {
  for (const [file, rules] of Object.entries(head)) {
    if (!fs.existsSync(path.join(root, file))) {
      problems.push(`${file}: no such file. Prune its entry (eslint --prune-suppressions).`);
    }
    for (const [rule, entry] of Object.entries(rules ?? {})) {
      const count = entry?.count;
      if (!allowedRules.has(rule)) {
        problems.push(`${file}: suppresses ${rule}, which is not a ratchet rule. Fix the violations instead.`);
        continue;
      }
      if (base === null) continue;
      const before = base[file]?.[rule]?.count;
      if (before === undefined) {
        problems.push(`${file}: new ${rule} entry (${count}). Move the queries into src/server/repositories/ instead.`);
      } else if (!(count <= before)) {
        problems.push(`${file}: ${rule} count ${before} -> ${count}. The baseline only shrinks.`);
      }
    }
  }
}

if (problems.length) {
  for (const p of problems) console.error(`::error::${p}`);
  console.error('See #937 for the burn-down and its rules.');
  process.exit(1);
}
console.log('eslint-suppressions.json: ok');
EOF
exit "$status"
