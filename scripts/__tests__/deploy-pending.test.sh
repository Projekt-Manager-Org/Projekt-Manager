#!/usr/bin/env bash
#
# Scenario tests for scripts/ci/deploy-pending.sh (ADR-0027 § 2026-10-29,
# control 4: deploy urgency).
#
# On every push to `main`, the script resolves the merged PR behind each
# pushed commit (the merge queue lands a batch in one push) and, for those
# carrying `deploy-asap`, opens or comments on the one "Deploy pending"
# issue assigned to the operator. `gh` is replaced by a stub on PATH that
# serves per-case fixtures and records every call, so no network and no
# token.
#
# Fixture shapes are the real endpoints': GET
# /repos/{r}/compare/{before}...{head} (the pushed commits, oldest first),
# GET /repos/{r}/commits/{sha}/pulls (for a commit on the default branch,
# the merged PR that introduced it) and GET /repos/{r}/issues.
#
# Exits 0 when every case matches its expectation; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/deploy-pending.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/ci/deploy-pending.sh"

if ! command -v jq > /dev/null 2>&1; then
  echo "ERROR: jq is required." >&2
  exit 2
fi

TMP_ROOT="$(mktemp -d)"
# shellcheck disable=SC2317  # invoked via `trap cleanup EXIT`
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

BEFORE='ffffffffffffffffffffffffffffffffffffffff'
SHA='0123456789abcdef0123456789abcdef01234567'
SHA2='1111111111111111111111111111111111111111'
REPO='Projekt-Manager-Org/Projekt-Manager'

# ---------------------------------------------------------------------
# `gh` stub. Reads the case directory from $GH_CASE_DIR:
#   compare.json      served for GET .../compare/...           (missing → error)
#   pulls-<sha>.json  served for GET .../commits/<sha>/pulls   (missing → error)
#   issues.json       served for GET .../issues?...            (missing → error)
#   calls        every invocation, one argument per line, `--` between
# Writes (-X POST) answer with a created issue/comment.
# ---------------------------------------------------------------------
STUB_BIN="$TMP_ROOT/bin"
mkdir -p "$STUB_BIN"
cat > "$STUB_BIN/gh" <<'STUB'
#!/usr/bin/env bash
dir="$GH_CASE_DIR"
printf '%s\n' "$@" -- >> "$dir/calls"
serve() { [[ -f "$dir/$1" ]] || { echo "gh: HTTP 502" >&2; exit 1; }; cat "$dir/$1"; }
case " $* " in
  *' -X POST '*)  echo '{"number":99,"html_url":"https://example.invalid/99"}' ;;
  *"/compare/${GH_BEFORE}..."*) serve compare.json ;;
  *'/commits/'*'/pulls'*)
    sha="$*"; sha="${sha#*/commits/}"
    serve "pulls-${sha%%/pulls*}.json" ;;
  *'/issues?'*)   serve issues.json ;;
  *)              echo "gh stub: unexpected call: $*" >&2; exit 1 ;;
esac
STUB
chmod +x "$STUB_BIN/gh"

# merged_pr <number> <merge_commit_sha> <label>...
merged_pr() {
  local n="$1" merge_sha="$2"
  shift 2
  jq -n --argjson n "$n" --arg m "$merge_sha" --args \
    '{number: $n, state: "closed", title: "chore(deps): update node.js to v24.22.2", html_url: "https://github.com/x/y/pull/\($n)",
      merged_at: "2026-10-29T08:00:00Z", merge_commit_sha: $m, base: {ref: "main"},
      labels: [$ARGS.positional[] | {name: .}]}' "$@"
}

# pushed <sha>...: the commits the push brought, oldest first.
pushed() {
  jq -n --args '{commits: [$ARGS.positional[] | {sha: .}]}' "$@" > "$CASE/compare.json"
}

# pending_issue <number> [title] [login]
pending_issue() {
  jq -n --argjson n "$1" --arg t "${2:-Deploy pending}" --arg l "${3:-github-actions[bot]}" \
    '{number: $n, title: $t, state: "open", user: {login: $l}}'
}

PASS=0
FAIL=0

new_case() {
  CASE="$(mktemp -d "$TMP_ROOT/case.XXXXXX")"
  : > "$CASE/calls"
  echo '[]' > "$CASE/issues.json"
  pushed "$SHA"
}

# run_case <desc> <want_rc>
run_case() {
  local desc="$1" want_rc="$2" rc
  (
    PATH="$STUB_BIN:$PATH"
    export PATH GH_CASE_DIR="$CASE" GH_BEFORE="$BEFORE"
    export GITHUB_REPOSITORY="$REPO" BEFORE_SHA="$BEFORE" HEAD_SHA="$SHA" MAINTAINER='vlzware'
    bash "$SCRIPT"
  ) > "$CASE/out" 2>&1
  rc=$?
  if [[ $rc -eq $want_rc ]]; then
    PASS=$((PASS + 1))
  else
    printf 'FAIL  %s\n      want exit %d, got %d\n' "$desc" "$want_rc" "$rc"
    sed 's/^/      /' "$CASE/out"
    FAIL=$((FAIL + 1))
  fi
}

# expect_output <desc> <fixed string> / expect_no_output: on the last run.
expect_output() {
  if grep -qF -- "$2" "$CASE/out"; then PASS=$((PASS + 1)); else
    printf 'FAIL  %s\n      output lacks: %s\n' "$1" "$2"; FAIL=$((FAIL + 1)); fi
}
expect_no_output() {
  if grep -qF -- "$2" "$CASE/out"; then
    printf 'FAIL  %s\n      output unexpectedly has: %s\n' "$1" "$2"; FAIL=$((FAIL + 1))
  else PASS=$((PASS + 1)); fi
}

# writes: the -X POST calls, each joined onto one line.
writes() { awk 'BEGIN{RS="--\n"} /-X\nPOST/ {gsub("\n"," "); print}' "$CASE/calls"; }

# expect_writes <desc> <count>
expect_writes() {
  local got
  got="$(writes | grep -c . || true)"
  if [[ "$got" -eq "$2" ]]; then
    PASS=$((PASS + 1))
  else
    printf 'FAIL  %s\n      want %d write(s), got %d\n' "$1" "$2" "$got"
    writes | sed 's/^/      /'
    FAIL=$((FAIL + 1))
  fi
}

# expect_write <desc> <regex>: some write matches.
expect_write() {
  if writes | grep -qE -- "$2"; then
    PASS=$((PASS + 1))
  else
    printf 'FAIL  %s\n      no write matches: %s\n' "$1" "$2"
    writes | sed 's/^/      /'
    FAIL=$((FAIL + 1))
  fi
}

# --- labelled merge, nothing pending yet ----------------------------
# Opens the issue: assigned to the operator (that is the notification),
# naming the PR.
new_case
jq -s . <(merged_pr 512 "$SHA" dependencies deploy-asap) > "$CASE/pulls-$SHA.json"
run_case 'labelled merge, none pending: opens the issue' 0
expect_writes 'labelled merge, none pending: one write' 1
expect_write 'labelled merge, none pending: new issue' "repos/$REPO/issues "
expect_write 'labelled merge, none pending: titled' 'title=Deploy pending'
expect_write 'labelled merge, none pending: assigned to the operator' 'assignees\[\]=vlzware'
expect_write 'labelled merge, none pending: names the PR' 'body=.*#512'

# --- labelled merge, one already pending ----------------------------
# One issue per backlog: a comment, which re-notifies the assignee.
new_case
jq -s . <(merged_pr 513 "$SHA" deploy-asap) > "$CASE/pulls-$SHA.json"
jq -s . <(pending_issue 90) > "$CASE/issues.json"
run_case 'labelled merge, one pending: comments' 0
expect_writes 'labelled merge, one pending: one write' 1
expect_write 'labelled merge, one pending: on the open issue' "repos/$REPO/issues/90/comments"
expect_write 'labelled merge, one pending: names the PR' 'body=.*#513'

# An issue someone else opened with the same title is not ours.
new_case
jq -s . <(merged_pr 514 "$SHA" deploy-asap) > "$CASE/pulls-$SHA.json"
jq -s . <(pending_issue 91 'Deploy pending' vlzware) <(pending_issue 92 'Deploy pending soon') > "$CASE/issues.json"
run_case 'look-alike issues are not the pending issue' 0
expect_write 'look-alike issues: opens a new one' "repos/$REPO/issues "

# --- nothing to do --------------------------------------------------
new_case
jq -s . <(merged_pr 515 "$SHA" dependencies) > "$CASE/pulls-$SHA.json"
run_case 'unlabelled merge: nothing' 0
expect_writes 'unlabelled merge: no write' 0

# --- no merged PR behind the commit ---------------------------------
# main only takes PR merges, so this is a bypass push or the API not yet
# linking the PR. Red: notify.yml raises it, and a labelled merge cannot
# vanish as "nothing to do".
new_case
echo '[]' > "$CASE/pulls-$SHA.json"
run_case 'no PR behind the commit is red' 1
expect_output 'no PR behind the commit: says so' 'No merged PR produced'
expect_writes 'no PR behind the commit: no write' 0

# A merged PR whose merge commit is another SHA did not produce this push.
new_case
jq -s . <(merged_pr 517 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' deploy-asap) > "$CASE/pulls-$SHA.json"
run_case 'labelled PR merged as another commit is red' 1
expect_writes 'labelled PR merged as another commit: no write' 0

# --- a batch: the merge queue lands several PRs in one push ---------
# Every commit counts, not only the head (#677 merged under #675 and was
# never reported).
new_case
pushed "$SHA2" "$SHA"
jq -s . <(merged_pr 521 "$SHA2" deploy-asap) > "$CASE/pulls-$SHA2.json"
jq -s . <(merged_pr 522 "$SHA" dependencies) > "$CASE/pulls-$SHA.json"
run_case 'batch, labelled PR below the head: opens the issue' 0
expect_writes 'batch, labelled PR below the head: one write' 1
expect_write 'batch, labelled PR below the head: names it' 'body=.*#521'

# Two labelled in one push, one pending: one comment naming both.
new_case
pushed "$SHA2" "$SHA"
jq -s . <(merged_pr 523 "$SHA2" deploy-asap) > "$CASE/pulls-$SHA2.json"
jq -s . <(merged_pr 524 "$SHA" deploy-asap) > "$CASE/pulls-$SHA.json"
jq -s . <(pending_issue 90) > "$CASE/issues.json"
run_case 'batch, two labelled, one pending: comments' 0
expect_writes 'batch, two labelled, one pending: one write' 1
expect_write 'batch, two labelled, one pending: names both' "issues/90/comments .*#523.*#524"

# A commit with no PR is red, but the labelled ones are still reported.
new_case
pushed "$SHA2" "$SHA"
echo '[]' > "$CASE/pulls-$SHA2.json"
jq -s . <(merged_pr 525 "$SHA" deploy-asap) > "$CASE/pulls-$SHA.json"
run_case 'batch, one commit without a PR: red' 1
expect_output 'batch, one commit without a PR: names it' "No merged PR produced $SHA2"
expect_write 'batch, one commit without a PR: still reports the labelled one' 'body=.*#525'

# A failed lookup of one commit's PR is red, names the commit, and the
# others are still reported.
new_case
pushed "$SHA2" "$SHA"
jq -s . <(merged_pr 527 "$SHA" deploy-asap) > "$CASE/pulls-$SHA.json"
run_case 'batch, one PR lookup fails: red' 1
expect_output 'batch, one PR lookup fails: names the commit' "PR lookup failed for $SHA2"
expect_write 'batch, one PR lookup fails: still reports the other' 'body=.*#527'

# --- API failure ----------------------------------------------------
# The head's PR is labelled: a fallback to the head alone would write.
new_case
rm "$CASE/compare.json"
jq -s . <(merged_pr 526 "$SHA" deploy-asap) > "$CASE/pulls-$SHA.json"
run_case 'API failure on the commit list is red' 1
expect_writes 'API failure on the commit list: no write' 0

# Red, so notify.yml raises it: a lost deploy-asap signal must not pass
# as "nothing to do".
new_case
run_case 'API failure on the PR lookup is red' 1
# Not misread as an empty PR list (pipefail).
expect_no_output 'API failure on the PR lookup: not read as no PR' 'No merged PR produced'

new_case
jq -s . <(merged_pr 518 "$SHA" deploy-asap) > "$CASE/pulls-$SHA.json"
rm "$CASE/issues.json"
run_case 'API failure on the issue lookup is red' 1
expect_writes 'API failure on the issue lookup: no write' 0

echo
echo "deploy-pending: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
