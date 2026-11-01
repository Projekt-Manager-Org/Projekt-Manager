#!/usr/bin/env bash
#
# Scenario tests for scripts/ci/docker-host-advisories.sh (#699).
#
# Nightly, the script reads the repo security advisories of every
# upstream repo mapped to a Docker host package and opens one issue,
# assigned to the operator, per advisory not MEDIUM/LOW, updated within
# the lookback and not yet reported. `gh` is replaced by a stub on PATH that
# serves per-case fixtures and records every call, so no network and no
# token.
#
# Every case runs against the real docker/host-versions.txt and
# docker/host-advisory-repos.txt unless it stages its own: a pin without
# a mapping row fails here, on the PR, not first in the nightly.
#
# Fixture shapes are the real endpoints': GET
# /repos/{owner}/{repo}/security-advisories and GET /repos/{r}/issues.
#
# Exits 0 when every case matches its expectation; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/docker-host-advisories.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/ci/docker-host-advisories.sh"
REAL_PINS="$REPO_ROOT/docker/host-versions.txt"
REAL_MAP="$REPO_ROOT/docker/host-advisory-repos.txt"

if ! command -v jq > /dev/null 2>&1; then
  echo "ERROR: jq is required." >&2
  exit 2
fi

TMP_ROOT="$(mktemp -d)"
# shellcheck disable=SC2317  # invoked via `trap cleanup EXIT`
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

REPO='Projekt-Manager-Org/Projekt-Manager'

# ---------------------------------------------------------------------
# `gh` stub. Reads the case directory from $GH_CASE_DIR:
#   adv-<owner>__<repo>.json  served for GET /repos/<owner>/<repo>/security-advisories
#                             (missing → HTTP 502; adv-<owner>__<repo>.404 → HTTP 404)
#   issues.json               served for GET .../issues?...  (missing → error)
# A listing read without --paginate fails: real `gh` would return page 1
# only, and a truncated issue list re-reports every advisory beyond it.
#   post-fails                present → every -X POST / -X PATCH fails
#   calls                     every invocation, one argument per line, `--` between
# ---------------------------------------------------------------------
STUB_BIN="$TMP_ROOT/bin"
mkdir -p "$STUB_BIN"
cat > "$STUB_BIN/gh" <<'STUB'
#!/usr/bin/env bash
dir="$GH_CASE_DIR"
printf '%s\n' "$@" -- >> "$dir/calls"
serve() { [[ -f "$dir/$1" ]] || { echo "gh: HTTP 502" >&2; exit 1; }; cat "$dir/$1"; }
case " $* " in
  *' -X POST '* | *' -X PATCH '*)
    [[ -f "$dir/post-fails" ]] && { echo "gh: HTTP 422" >&2; exit 1; }
    echo '{"number":99,"html_url":"https://example.invalid/99"}' ;;
  *' --paginate '*'/security-advisories'*)
    slug="$*"; slug="${slug#*repos/}"; slug="${slug%%/security-advisories*}"
    [[ -f "$dir/adv-${slug/\//__}.404" ]] && { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
    serve "adv-${slug/\//__}.json" ;;
  *' --paginate '*'/issues?'*) serve issues.json ;;
  *) echo "gh stub: unexpected call: $*" >&2; exit 1 ;;
esac
STUB
chmod +x "$STUB_BIN/gh"

ago() { date -u -d "$1 days ago" +%Y-%m-%dT%H:%M:%SZ; }

# advisory <ghsa> <severity|null> <updated days ago> [published days ago] [summary] [withdrawn]
advisory() {
  local sev="$2"
  [[ "$sev" == null ]] || sev="\"$sev\""
  jq -n --arg id "$1" --argjson sev "$sev" --arg upd "$(ago "$3")" \
    --arg pub "$(ago "${4:-$3}")" --arg sum "${5:-Something bad}" --arg wd "${6:-}" \
    '{ghsa_id: $id, cve_id: null, severity: $sev, summary: $sum,
      state: (if $wd == "" then "published" else "withdrawn" end),
      published_at: $pub, updated_at: $upd, withdrawn_at: (if $wd == "" then null else $wd end),
      html_url: "https://github.com/up/stream/security/advisories/\($id)"}'
}

# serves <owner/repo> <advisory json>...: that repo's listing.
serves() {
  local slug="$1"
  shift
  if [[ $# -eq 0 ]]; then echo '[]'; else printf '%s\n' "$@" | jq -s .; fi \
    > "$CASE/adv-${slug/\//__}.json"
}

# reported_issue <number> <title> [login] [state] [updated days ago]
reported_issue() {
  jq -n --argjson n "$1" --arg t "$2" --arg l "${3:-github-actions[bot]}" --arg s "${4:-closed}" \
    --arg u "$(ago "${5:-0}")" \
    '{number: $n, title: $t, state: $s, updated_at: $u, user: {login: $l}}'
}

PASS=0
FAIL=0

# Every repo the real mapping names serves an empty listing; a case
# overrides the ones it needs.
new_case() {
  CASE="$(mktemp -d "$TMP_ROOT/case.XXXXXX")"
  : > "$CASE/calls"
  echo '[]' > "$CASE/issues.json"
  PINS="$REAL_PINS"
  MAP="$REAL_MAP"
  LOOKBACK=''
  local slug
  if [[ -f "$REAL_MAP" ]]; then
    while read -r slug; do
      serves "$slug"
    done < <(sed 's/#.*//' "$REAL_MAP" | awk '{ for (i = 2; i <= NF; i++) print $i }' | sort -u)
  fi
}

# run_case <desc> <want_rc>
run_case() {
  local desc="$1" want_rc="$2" rc
  (
    PATH="$STUB_BIN:$PATH"
    export PATH GH_CASE_DIR="$CASE"
    export GITHUB_REPOSITORY="$REPO" MAINTAINER='vlzware'
    export DOCKER_PINS_FILE="$PINS" ADVISORY_REPOS_FILE="$MAP"
    # Set even when empty: a scheduled run has no dispatch input.
    export LOOKBACK_DAYS="$LOOKBACK"
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

expect_output() {
  if grep -qF -- "$2" "$CASE/out"; then PASS=$((PASS + 1)); else
    printf 'FAIL  %s\n      output lacks: %s\n' "$1" "$2"; FAIL=$((FAIL + 1)); fi
}

# expect_error <desc> <regex>: an ::error:: line matches, not just any log line.
expect_error() {
  if grep -qE -- "^::error::.*$2" "$CASE/out"; then PASS=$((PASS + 1)); else
    printf 'FAIL  %s\n      no ::error:: line matches: %s\n' "$1" "$2"; FAIL=$((FAIL + 1)); fi
}

# expect_call <desc> <regex>: some recorded gh argument matches.
expect_call() {
  if grep -qE -- "$2" "$CASE/calls"; then PASS=$((PASS + 1)); else
    printf 'FAIL  %s\n      no call matches: %s\n' "$1" "$2"; FAIL=$((FAIL + 1)); fi
}

# writes: the -X POST / -X PATCH calls, each joined onto one line.
writes() { awk 'BEGIN{RS="--\n"} /-X\n(POST|PATCH)/ {gsub("\n"," "); print}' "$CASE/calls"; }

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

expect_no_write() {
  if writes | grep -qE -- "$2"; then
    printf 'FAIL  %s\n      a write unexpectedly matches: %s\n' "$1" "$2"
    FAIL=$((FAIL + 1))
  else PASS=$((PASS + 1)); fi
}

# --- the real files agree -------------------------------------------
new_case
run_case 'real pins, real mapping, nothing new: green' 0
expect_writes 'real pins, real mapping, nothing new: no write' 0

# --- a new HIGH advisory --------------------------------------------
# The assigned issue is the notification.
new_case
serves moby/moby "$(advisory GHSA-aaaa-aaaa-aaaa high 1)"
run_case 'new HIGH: opens an issue' 0
expect_writes 'new HIGH: one write' 1
expect_write 'new HIGH: new issue' "repos/$REPO/issues "
expect_write 'new HIGH: titled by its id' 'title=Docker host advisory: GHSA-aaaa-aaaa-aaaa'
expect_write 'new HIGH: assigned to the operator' 'assignees\[\]=vlzware'
expect_write 'new HIGH: links the advisory' 'body=.*https://github.com/up/stream/security/advisories/GHSA-aaaa-aaaa-aaaa'
expect_write 'new HIGH: names the package' 'body=.*docker-ce([^-]|$)'
expect_no_write 'new HIGH: names no other package' 'body=.*docker-ce-cli'
expect_write 'new HIGH: states the severity' 'body=.*HIGH'
expect_write 'new HIGH: links the triage rule' 'body=.*docs/ops/server-setup\.md#'

# --- severity floor -------------------------------------------------
# HIGH and CRITICAL are reported; MEDIUM/LOW ride the quarterly window.
# An advisory without a severity, or with one GitHub may add later,
# cannot be judged below the floor.
new_case
serves containerd/containerd \
  "$(advisory GHSA-cccc-cccc-cccc critical 1)" \
  "$(advisory GHSA-mmmm-mmmm-mmmm medium 1)" \
  "$(advisory GHSA-llll-llll-llll low 1)" \
  "$(advisory GHSA-nnnn-nnnn-nnnn null 1)" \
  "$(advisory GHSA-uuuu-uuuu-uuuu unknown 1)"
run_case 'severity floor: green' 0
expect_writes 'severity floor: all but MEDIUM and LOW' 3
expect_write 'severity floor: CRITICAL reported' 'GHSA-cccc-cccc-cccc'
expect_write 'severity floor: no severity reported' 'GHSA-nnnn-nnnn-nnnn'
expect_write 'severity floor: unknown severity reported' 'GHSA-uuuu-uuuu-uuuu'

# --- lookback -------------------------------------------------------
# 7 days by default, on updated_at: a MEDIUM raised to HIGH long after
# publishing is still reported.
new_case
serves opencontainers/runc \
  "$(advisory GHSA-oooo-oooo-oooo high 8)" \
  "$(advisory GHSA-rrrr-rrrr-rrrr high 2 90)"
run_case 'lookback: green' 0
expect_writes 'lookback: one write' 1
expect_write 'lookback: raised long after publishing is reported' 'GHSA-rrrr-rrrr-rrrr'

# A dispatch re-covers a longer outage.
new_case
serves opencontainers/runc "$(advisory GHSA-oooo-oooo-oooo high 20)"
LOOKBACK=31
run_case 'LOOKBACK_DAYS=31: green' 0
expect_write 'LOOKBACK_DAYS=31: 20 days back is reported' 'GHSA-oooo-oooo-oooo'

# An unreadable lookback must not shrink to "nothing is new".
new_case
serves moby/moby "$(advisory GHSA-aaaa-aaaa-aaaa high 1)"
LOOKBACK=abc
run_case 'invalid LOOKBACK_DAYS is red' 1
expect_writes 'invalid LOOKBACK_DAYS: no write' 0

# Without a date it cannot be judged outside the lookback.
new_case
serves opencontainers/runc "$(advisory GHSA-dddd-dddd-dddd high 1 | jq '.updated_at = null | .published_at = null')"
run_case 'no date: green' 0
expect_write 'no date: reported' 'GHSA-dddd-dddd-dddd'

# --- withdrawn ------------------------------------------------------
new_case
serves docker/cli "$(advisory GHSA-wwww-wwww-wwww high 1 1 'x' "$(ago 1)")"
run_case 'withdrawn: green' 0
expect_writes 'withdrawn: not reported' 0

# --- dedupe ---------------------------------------------------------
# Reported once, open or closed. Only this workflow's own issues count:
# anyone can open a look-alike on a public repo.
new_case
serves moby/moby "$(advisory GHSA-aaaa-aaaa-aaaa high 1)" "$(advisory GHSA-bbbb-bbbb-bbbb high 1)"
jq -s . \
  <(reported_issue 70 'Docker host advisory: GHSA-aaaa-aaaa-aaaa' 'github-actions[bot]' closed) \
  <(reported_issue 71 'Docker host advisory: GHSA-bbbb-bbbb-bbbb' 'github-actions[bot]' open) \
  > "$CASE/issues.json"
run_case 'already reported: green' 0
expect_writes 'already reported, closed or open: no write' 0
expect_call 'already reported: searched closed issues too' '/issues\?.*state=all'

new_case
serves moby/moby "$(advisory GHSA-aaaa-aaaa-aaaa high 1)"
jq -s . \
  <(reported_issue 72 'Docker host advisory: GHSA-aaaa-aaaa-aaaa' vlzware closed) \
  <(reported_issue 73 'Docker host advisory: GHSA-aaaa-aaaa-aaaa (dup)' 'github-actions[bot]' closed) \
  > "$CASE/issues.json"
run_case 'look-alikes: green' 0
expect_write 'look-alikes: still reported' 'title=Docker host advisory: GHSA-aaaa-aaaa-aaaa'

# Edited upstream after the issue was closed: a corrected range or
# severity can overturn "not applicable", so it reopens, with a comment.
new_case
serves moby/moby "$(advisory GHSA-aaaa-aaaa-aaaa high 1 30)"
jq -s . <(reported_issue 74 'Docker host advisory: GHSA-aaaa-aaaa-aaaa' 'github-actions[bot]' closed 3) \
  > "$CASE/issues.json"
run_case 'edited after close: green' 0
expect_writes 'edited after close: reopen and comment' 2
expect_write 'edited after close: reopens it' "repos/$REPO/issues/74 .*state=open"
expect_write 'edited after close: comments on it' "repos/$REPO/issues/74/comments .*body=.*GHSA-aaaa-aaaa-aaaa"

# Closed after the last edit: acknowledged, stays closed.
new_case
serves moby/moby "$(advisory GHSA-aaaa-aaaa-aaaa high 3 30)"
jq -s . <(reported_issue 75 'Docker host advisory: GHSA-aaaa-aaaa-aaaa' 'github-actions[bot]' closed 1) \
  > "$CASE/issues.json"
run_case 'closed after the last edit: green' 0
expect_writes 'closed after the last edit: no write' 0

# A race left two; the open one is live, nothing reopens.
new_case
serves moby/moby "$(advisory GHSA-aaaa-aaaa-aaaa high 1 30)"
jq -s . \
  <(reported_issue 76 'Docker host advisory: GHSA-aaaa-aaaa-aaaa' 'github-actions[bot]' closed 3) \
  <(reported_issue 77 'Docker host advisory: GHSA-aaaa-aaaa-aaaa' 'github-actions[bot]' open 3) \
  > "$CASE/issues.json"
run_case 'one of two open: green' 0
expect_writes 'one of two open: no write' 0

# A failed reopen is a lost alert.
new_case
touch "$CASE/post-fails"
serves moby/moby "$(advisory GHSA-aaaa-aaaa-aaaa high 1 30)"
jq -s . <(reported_issue 78 'Docker host advisory: GHSA-aaaa-aaaa-aaaa' 'github-actions[bot]' closed 3) \
  > "$CASE/issues.json"
run_case 'reopen failure is red' 1
expect_error 'reopen failure: names it' '#78'

# --- one repo, two packages -----------------------------------------
# BuildKit is embedded in docker-ce and backs docker-buildx-plugin.
new_case
serves moby/buildkit "$(advisory GHSA-kkkk-kkkk-kkkk high 1)"
run_case 'shared repo: green' 0
expect_writes 'shared repo: one issue' 1
expect_write 'shared repo: names both packages' 'body=.*docker-ce([^-]|$).*docker-buildx-plugin|body=.*docker-buildx-plugin.*docker-ce([^-]|$)'

# Every row of the mapping is read: one advisory per repo, one issue each.
new_case
serves moby/moby "$(advisory GHSA-0001-0001-0001 high 1)"
serves moby/buildkit "$(advisory GHSA-0002-0002-0002 high 1)"
serves docker/cli "$(advisory GHSA-0003-0003-0003 high 1)"
serves containerd/containerd "$(advisory GHSA-0004-0004-0004 high 1)"
serves opencontainers/runc "$(advisory GHSA-0005-0005-0005 high 1)"
serves docker/buildx "$(advisory GHSA-0006-0006-0006 high 1)"
serves docker/compose "$(advisory GHSA-0007-0007-0007 high 1)"
run_case 'every mapped repo: green' 0
expect_writes 'every mapped repo: one issue each' 7
expect_write 'every mapped repo: buildx names its package' 'GHSA-0006-0006-0006 .*body=.*docker-buildx-plugin'
expect_write 'every mapped repo: runc names containerd.io' 'GHSA-0005-0005-0005 .*body=.*containerd\.io'

# --- upstream text is not live markup -------------------------------
# Inside a code span, @mentions and #refs ping and link nothing. The
# summary's own backticks are dropped, the simplest way to keep one from
# closing the span early (a wider fence would also do; this pins one).
new_case
# shellcheck disable=SC2016  # literal backticks are the input under test
serves docker/compose "$(advisory GHSA-ssss-ssss-ssss high 1 1 'Fix by @someone, see #12 and `x` here')"
run_case 'summary: green' 0
expect_write 'summary: inside a code span' 'body=.*`Fix by @someone, see #12 and '
# shellcheck disable=SC2016
expect_no_write 'summary: its backticks do not survive' 'and `x` here'

# The CVE id is upstream text too.
new_case
serves docker/compose "$(advisory GHSA-ssss-ssss-ssss high 1 | jq '.cve_id = "CVE-1 @octocat #1"')"
run_case 'CVE id: green' 0
# shellcheck disable=SC2016  # literal backticks
expect_write 'CVE id: inside a code span' 'body=.*`CVE-1 @octocat #1`'

# --- mapping --------------------------------------------------------
# A pin without a row would be silently unwatched.
new_case
PINS="$CASE/pins.txt"
MAP="$CASE/map.txt"
printf '# comment\ndocker-ce=5:29.8.2-1~ubuntu.24.04~noble\ndocker-rootless-extras=5:29.8.2-1\n' > "$PINS"
printf '# comment\ndocker-ce moby/moby\n' > "$MAP"
serves moby/moby "$(advisory GHSA-aaaa-aaaa-aaaa high 1)"
run_case 'pin without a mapping row is red' 1
expect_error 'pin without a mapping row: names it' 'docker-rootless-extras'
expect_writes 'pin without a mapping row: no write' 0

# A pins file that names nothing, or is gone, would watch nothing.
new_case
PINS="$CASE/pins.txt"
printf '# only a comment\n' > "$PINS"
run_case 'pins naming nothing is red' 1
expect_error 'pins naming nothing: says so' 'No pinned packages'

new_case
PINS="$CASE/missing.txt"
run_case 'missing pins file is red' 1
expect_error 'missing pins file: names it' 'missing\.txt'

# --- API failures ---------------------------------------------------
# One unreachable repo is red and named; the others are still reported.
new_case
rm "$CASE/adv-docker__cli.json"
serves moby/moby "$(advisory GHSA-aaaa-aaaa-aaaa high 1)"
run_case 'one upstream unreachable is red' 1
expect_error 'one upstream unreachable: names it' 'docker/cli'
expect_write 'one upstream unreachable: the others still reported' 'GHSA-aaaa-aaaa-aaaa'

# 404 is not "advisories disabled": a mapped repo is known to file them,
# so a 404 means renamed, moved or misspelled, and the row watches nothing.
new_case
touch "$CASE/adv-moby__moby.404"
run_case 'upstream 404 is red' 1
expect_error 'upstream 404: names it' 'moby/moby'

# A listing jq cannot read is red, never an empty listing.
new_case
echo '{"message":"not a list"}' > "$CASE/adv-moby__moby.json"
run_case 'unreadable upstream listing is red' 1
expect_error 'unreadable upstream listing: names it' 'moby/moby'

# Without the reported list, every write could be a duplicate.
new_case
rm "$CASE/issues.json"
serves moby/moby "$(advisory GHSA-aaaa-aaaa-aaaa high 1)"
run_case 'issue lookup failure is red' 1
expect_writes 'issue lookup failure: no write' 0
expect_error 'issue lookup failure: names the unreported advisory' 'GHSA-aaaa-aaaa-aaaa'

# A lost alert must not pass as green.
new_case
touch "$CASE/post-fails"
serves moby/moby "$(advisory GHSA-aaaa-aaaa-aaaa high 1)"
run_case 'issue creation failure is red' 1
expect_error 'issue creation failure: names the advisory' 'GHSA-aaaa-aaaa-aaaa'

echo
echo "docker-host-advisories: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
