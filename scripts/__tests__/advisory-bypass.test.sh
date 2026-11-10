#!/usr/bin/env bash
#
# Scenario tests for scripts/ci/advisory-bypass.sh.
#
# The bypass waives the release-age gate, so a wrong `1` lets a young
# version in unreviewed and a wrong `0` blocks a security fix in the merge
# queue (#828). `gh` is a stub on PATH: it answers the labels of PR 824 and
# fails for any other call.
#
# The case that carries the weight: "merge_group, security PR" — the queue
# run has no `pull_request` payload, so the labels must come from the API.
#
# Exits 0 when every case matches; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/advisory-bypass.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/ci/advisory-bypass.sh"

if [[ ! -f "$SCRIPT" ]]; then
  echo "ERROR: $SCRIPT not found." >&2
  exit 2
fi

TMP="$(mktemp -d)"
# shellcheck disable=SC2317  # invoked via `trap cleanup EXIT`
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

mkdir "$TMP/bin"
cat >"$TMP/bin/gh" <<'STUB'
#!/usr/bin/env bash
# Labels of PR 824 in o/r, one per line, from $STUB_LABELS; anything else fails.
[[ "$*" == *"repos/o/r/issues/824/labels"* ]] || exit 1
[[ -n "${STUB_LABELS:-}" ]] && printf '%s\n' "$STUB_LABELS"
exit 0
STUB
chmod +x "$TMP/bin/gh"

pass=0
fail=0
failures=()

# $1 label, $2 expected exit, $3 expected `bypass=` value (empty: unchecked),
# rest: VAR=value environment for the run.
assert_case() {
  local label="$1" expected="$2" bypass="$3"
  shift 3
  local out rc
  out="$(env PATH="$TMP/bin:$PATH" "$@" bash "$SCRIPT" 2>/dev/null)"
  rc=$?
  if [[ "$rc" != "$expected" ]]; then
    fail=$((fail + 1))
    failures+=("$label: expected exit $expected, got $rc")
  elif [[ -n "$bypass" && "$out" != "bypass=$bypass" ]]; then
    fail=$((fail + 1))
    failures+=("$label: expected bypass=$bypass, got: $out")
  else
    pass=$((pass + 1))
    echo "  PASS — $label (exit $rc${bypass:+, bypass=$bypass})"
  fi
}

REF=MERGE_GROUP_HEAD_REF=refs/heads/gh-readonly-queue/main/pr-824-49e6ca22ee8b8f3eff8fa6265edbf0c944921456

echo "Case: pull_request"
assert_case "security label" 0 1 EVENT=pull_request 'PR_LABELS=["bug","security"]'
assert_case "no security label" 0 0 EVENT=pull_request 'PR_LABELS=["bug","security-review"]'
assert_case "no labels" 0 0 EVENT=pull_request 'PR_LABELS=[]'
assert_case "labels not JSON" 1 "" EVENT=pull_request 'PR_LABELS=security'
assert_case "labels not an array" 1 "" EVENT=pull_request 'PR_LABELS={"a":"security"}'
assert_case "labels null" 1 "" EVENT=pull_request 'PR_LABELS=null'

echo "Case: merge_group"
assert_case "security PR" 0 1 EVENT=merge_group "$REF" REPO=o/r STUB_LABELS=$'bug\nsecurity'
assert_case "PR without security" 0 0 EVENT=merge_group "$REF" REPO=o/r STUB_LABELS=$'bug\nsecurity-review'
assert_case "PR without labels" 0 0 EVENT=merge_group "$REF" REPO=o/r STUB_LABELS=
assert_case "lookup fails" 1 "" EVENT=merge_group "$REF" REPO=x/y
assert_case "ref not a queue branch" 1 "" EVENT=merge_group MERGE_GROUP_HEAD_REF=refs/heads/main REPO=o/r

echo "Case: other events never waive"
assert_case "push" 0 0 EVENT=push
assert_case "workflow_dispatch" 0 0 EVENT=workflow_dispatch

echo "Case: missing inputs"
assert_case "no EVENT" 2 ""
assert_case "no PR_LABELS" 2 "" EVENT=pull_request
assert_case "no MERGE_GROUP_HEAD_REF" 2 "" EVENT=merge_group REPO=o/r
assert_case "no REPO" 2 "" EVENT=merge_group "$REF"

echo ""
echo "passed: $pass   failed: $fail"
if [[ "$fail" -gt 0 ]]; then
  echo ""
  echo "Failures:"
  for f in "${failures[@]}"; do echo "  - $f"; done
  exit 1
fi
exit 0
