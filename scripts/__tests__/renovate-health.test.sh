#!/usr/bin/env bash
#
# Scenario tests for scripts/ci/renovate-health.mjs (ADR-0027 § 2026-10-29,
# control 2: updater health).
#
# The check reads the Dependency Dashboard and the open PRs through `gh api`
# and writes one thing back: it ticks the dashboard's Mend "manual job" box,
# which is the liveness probe. `gh` is replaced by a stub on PATH that serves
# per-case fixtures and records every write, so no network and no token.
#
# Fixture shapes are the real endpoints' (one page of
# GET /repos/{r}/issues and GET /repos/{r}/pulls). The stub emulates
# `--slurp` by wrapping the page in an outer array, as gh does. Dashboard
# bodies are built from headings and item lines copied verbatim from the
# live dashboard or Renovate's source (section descriptions are
# placeholders; nothing reads them), and one case runs the full live body
# of 2026-10-29 (fixtures/renovate-health/; .txt, so neither Prettier nor
# the link checker rewrites or crawls it).
#
# Exits 0 when every case matches its expectation; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/renovate-health.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/ci/renovate-health.mjs"
LIVE_DASHBOARD="$REPO_ROOT/scripts/__tests__/fixtures/renovate-health/dashboard-2026-10-29.txt"

for tool in node jq; do
  if ! command -v "$tool" > /dev/null 2>&1; then
    echo "ERROR: $tool is required." >&2
    exit 2
  fi
done

TMP_ROOT="$(mktemp -d)"
# shellcheck disable=SC2317  # invoked via `trap cleanup EXIT`
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

NOW='2026-10-29T03:00:00Z'

# ---------------------------------------------------------------------
# `gh` stub. Reads the case directory from $GH_CASE_DIR:
#   issues.json  served for GET .../issues?...  (missing → API error)
#   pulls.json   served for GET .../pulls?...   (missing → API error)
#   fresh.json   served for GET .../issues/{n} if present, else that
#                issue out of issues.json
#   patch.json   written from stdin on -X PATCH (the probe tick)
#   calls        one line per invocation
# Any other call fails, so an unexpected write cannot pass silently.
# ---------------------------------------------------------------------
STUB_BIN="$TMP_ROOT/bin"
mkdir -p "$STUB_BIN"
cat > "$STUB_BIN/gh" <<'STUB'
#!/usr/bin/env bash
dir="$GH_CASE_DIR"
echo "$*" >> "$dir/calls"
serve() {
  [[ -f "$dir/$1" ]] || { echo "gh: HTTP 502" >&2; exit 1; }
  if [[ " $* " == *' --slurp '* ]]; then printf '['; cat "$dir/$1"; printf ']'; else cat "$dir/$1"; fi
}
case " $* " in
  *' -X PATCH '*) cat > "$dir/patch.json"; echo '{}' ;;
  *'/issues?'*)   serve issues.json "$@" ;;
  *'/issues/'[0-9]*)
    # Single-issue GET: fresh.json if the case staged one (Renovate wrote
    # in between), else that issue out of issues.json.
    if [[ -f "$dir/fresh.json" ]]; then cat "$dir/fresh.json"; exit 0; fi
    all="$*"; n="${all##*/issues/}"; n="${n%% *}"
    jq -e --argjson n "$n" '.[] | select(.number == $n)' "$dir/issues.json" || exit 1 ;;
  *'/pulls?'*)    serve pulls.json "$@" ;;
  *)              echo "gh stub: unexpected call: $*" >&2; exit 1 ;;
esac
STUB
chmod +x "$STUB_BIN/gh"

# ---------------------------------------------------------------------
# Dashboard body builders. Headings and item lines are verbatim (leading
# space before `- [ ]` included).
# ---------------------------------------------------------------------
HEADER='This issue lists Renovate updates and detected dependencies. Read the [Dependency Dashboard](https://docs.renovatebot.com/key-concepts/dashboard/) docs to learn more.<br>[View this repository on the Mend.io Web Portal](https://developer.mend.io/github/Projekt-Manager-Org/Projekt-Manager).'

# section <title> <item-line>...
section() {
  local title="$1"
  shift
  printf '## %s\n\nThe following updates are listed here. To act, click on a checkbox below.\n\n' "$title"
  local line
  for line in "$@"; do printf ' %s\n' "$line"; done
  printf '\n'
}

AWAITING_EXEMPT=(
  '- [ ] <!-- unschedule-branch=renovate/docker-host -->chore(deps): update docker-host (`containerd.io`, `docker-ce`)'
  '- [ ] <!-- unschedule-branch=renovate/lock-file-maintenance -->chore(deps): lock file maintenance'
  '- [ ] <!-- unschedule-branch=renovate/renovate-config-validator -->chore(deps): update renovate-config-validator to v44.199.0'
)
AWAITING_BULK='- [ ] <!-- create-all-awaiting-schedule-prs -->🔐 **Create all awaiting schedule PRs at once** 🔐'
# Extra Awaiting Schedule items for one case; reset by new_case.
AWAITING_EXTRA=()
# Lookup-warning block for one case, rendered where Renovate puts it
# (after Pending Branch Automerge); reset by new_case.
LOOKUP_WARNING=''

# Every section Renovate renders that is not a problem, with real items.
benign_sections() {
  printf '## Abandoned Dependencies\n\nThe following dependencies have not received updates for an extended period and may be unmaintained.\n\n<details>\n<summary>View abandoned dependencies (1)</summary>\n\n| Datasource | Package | Last Updated |\n|------------|------|-------------|\n| npm | `xslt3` | `2024-10-17` |\n\n</details>\n\n\n'
  section 'Pending Approval' '- [ ] <!-- approve-branch=renovate/node-26.x -->chore(deps): update node.js to v26'
  section 'Awaiting Schedule' "${AWAITING_EXEMPT[@]}" "${AWAITING_EXTRA[@]}" "$AWAITING_BULK"
  section 'Pending Status Checks' '- [ ] <!-- unpend-branch=renovate/aws-sdk -->chore(deps): update aws-sdk to v3.1159.0'
  section 'Pending Branch Automerge' '- [ ] <!-- approvePr-branch=renovate/vite-7.x -->chore(deps): update dependency vite to v7.4.1'
  printf '%s' "$LOOKUP_WARNING"
  section 'Open' '- [ ] <!-- rebase-branch=renovate/go-golang.org-x-net-vulnerability -->[chore(deps): update module golang.org/x/net to v0.62.0 [security]](../pull/648)'
  section 'PR Closed (Blocked)' '- [ ] <!-- recreate-branch=renovate/postgres-18.x -->[chore(deps): update postgres docker tag to v18](../pull/211)'
  printf '## Deprecations / Replacements\n> ⚠️ **Warning**\n> \n> These dependencies are either deprecated or have replacements available:\n\n| Datasource | Name | Replacement PR? |\n|------------|------|--------------|\n| npm | `foo` | ![Unavailable](https://img.shields.io/badge/unavailable-orange?style=flat-square) |\n\n'
}

# footer <box>: the Mend-appended footer; box is ' ' or 'x'.
footer() {
  printf '## Detected Dependencies\n\n<details><summary>npm (1)</summary>\n<blockquote>\n\n</blockquote>\n</details>\n\n---\n\n- [%s] <!-- manual job -->Check this box to trigger a request for Renovate to run again on this repository\n\n' "$1"
}

HEALTHY_BODY="$(printf '%s\n\n' "$HEADER"; benign_sections; footer ' ')"

# ---------------------------------------------------------------------
# JSON builders.
# ---------------------------------------------------------------------
# dashboard_issue <body> [number]
dashboard_issue() {
  jq -n --arg body "$1" --argjson n "${2:-201}" \
    '{number: $n, title: "Dependency Dashboard", state: "open", user: {login: "renovate[bot]", type: "Bot"}, body: $body}'
}

# pr <number> <login> <head ref> <created_at>
pr() {
  jq -n --argjson n "$1" --arg login "$2" --arg ref "$3" --arg at "$4" \
    '{number: $n, title: "chore(deps): something", state: "open", created_at: $at, user: {login: $login}, head: {ref: $ref}}'
}

# Renovate PR 3 days old; docker-host and a human PR far older — both exempt.
HEALTHY_PULLS="$(jq -s . \
  <(pr 648 'renovate[bot]' renovate/go-golang.org-x-net-vulnerability 2026-10-26T03:00:00Z) \
  <(pr 640 'renovate[bot]' renovate/docker-host 2026-09-29T03:00:00Z) \
  <(pr 600 vlzware fix/some-topic 2026-09-01T03:00:00Z))"

PASS=0
FAIL=0
LAST_DIR=''
LAST_OUT=''

# new_case: fresh case dir with healthy fixtures, path in $CASE.
new_case() {
  AWAITING_EXTRA=()
  LOOKUP_WARNING=''
  CASE="$(mktemp -d "$TMP_ROOT/case.XXXXXX")"
  : > "$CASE/calls"
  set_body "$HEALTHY_BODY"
  printf '%s' "$HEALTHY_PULLS" > "$CASE/pulls.json"
}

# Renovate's other issue, opened by the same bot on a config error: listed
# beside the dashboard in every case, so the title filter is exercised.
other_issue() {
  jq -n '{number: 300, title: "Action Required: Fix Renovate Configuration", state: "open", user: {login: "renovate[bot]", type: "Bot"}, body: "There is an error with this repository'"'"'s Renovate configuration."}'
}

# set_body <body>: replace the dashboard body in the current case.
set_body() { jq -s . <(other_issue) <(dashboard_issue "$1") > "$CASE/issues.json"; }

# run_check <desc> <want_rc>: runs the script against $CASE.
# Leaves stdout+stderr in $LAST_OUT for the follow-up assertions.
run_check() {
  local desc="$1" want_rc="$2" rc
  LAST_DIR="$CASE"
  LAST_OUT="$CASE/out"
  (
    PATH="$STUB_BIN:$PATH"
    export PATH GH_CASE_DIR="$CASE"
    export GITHUB_REPOSITORY='Projekt-Manager-Org/Projekt-Manager'
    export RENOVATE_HEALTH_NOW="$NOW"
    node "$SCRIPT"
  ) > "$LAST_OUT" 2>&1
  rc=$?
  # An uncaught exception also exits 1, which would satisfy every "is red"
  # case; a stack trace is never a verdict.
  if grep -qE '^\s+at .+:[0-9]+:[0-9]+' "$LAST_OUT"; then
    printf 'FAIL  %s\n      script crashed\n' "$desc"
    sed 's/^/      /' "$LAST_OUT"
    FAIL=$((FAIL + 1))
  elif [[ $rc -eq $want_rc ]]; then
    PASS=$((PASS + 1))
  else
    printf 'FAIL  %s\n      want exit %d, got %d\n' "$desc" "$want_rc" "$rc"
    sed 's/^/      /' "$LAST_OUT"
    FAIL=$((FAIL + 1))
  fi
}

# expect_output <desc> <fixed string>: the last run reported it.
expect_output() {
  if grep -qF -- "$2" "$LAST_OUT"; then
    PASS=$((PASS + 1))
  else
    printf 'FAIL  %s\n      output lacks: %s\n' "$1" "$2"
    sed 's/^/      /' "$LAST_OUT"
    FAIL=$((FAIL + 1))
  fi
}

# expect_no_output <desc> <fixed string>
expect_no_output() {
  if grep -qF -- "$2" "$LAST_OUT"; then
    printf 'FAIL  %s\n      output unexpectedly has: %s\n' "$1" "$2"
    sed 's/^/      /' "$LAST_OUT"
    FAIL=$((FAIL + 1))
  else
    PASS=$((PASS + 1))
  fi
}

# expect_tick <desc>: the last run PATCHed the dashboard with exactly the
# manual-job box ticked and nothing else changed.
expect_tick() {
  local desc="$1" want got
  if [[ ! -f "$LAST_DIR/patch.json" ]]; then
    printf 'FAIL  %s\n      no PATCH of the dashboard\n' "$desc"
    FAIL=$((FAIL + 1))
    return
  fi
  want="$(jq -r 'map(select(.title == "Dependency Dashboard"))[0].body' "$LAST_DIR/issues.json" | sed 's/^- \[ \] <!-- manual job -->/- [x] <!-- manual job -->/')"
  got="$(jq -r '.body' "$LAST_DIR/patch.json")"
  if grep -q 'issues/201' "$LAST_DIR/calls" && [[ "$got" == "$want" ]]; then
    PASS=$((PASS + 1))
  else
    printf 'FAIL  %s\n      PATCH did not tick exactly the manual-job box of #201\n' "$desc"
    diff <(printf '%s\n' "$want") <(printf '%s\n' "$got") | sed 's/^/      /' | head -20
    FAIL=$((FAIL + 1))
  fi
}

# expect_no_tick <desc>
expect_no_tick() {
  if [[ -f "$LAST_DIR/patch.json" ]]; then
    printf 'FAIL  %s\n      dashboard was PATCHed\n' "$1"
    FAIL=$((FAIL + 1))
  else
    PASS=$((PASS + 1))
  fi
}

# --- healthy --------------------------------------------------------
# Every benign section present at once, the exempt Awaiting Schedule
# branches, an exempt old docker-host PR and an old human PR. Green, and
# the probe is armed for the next night.
new_case
run_check 'healthy dashboard is green' 0
expect_tick 'healthy dashboard: probe ticked'

# --- liveness probe -------------------------------------------------
# The tick re-reads the body right before writing: a Renovate edit made
# while this run read the PRs survives, instead of being overwritten.
new_case
FRESH_BODY="$(printf '%s\n\n' "$HEADER"; section 'Open' '- [ ] <!-- rebase-branch=renovate/react -->[chore(deps): update react](../pull/700)'; footer ' ')"
dashboard_issue "$FRESH_BODY" > "$CASE/fresh.json"
run_check 'tick on a fresh read: green' 0
if [[ "$(jq -r .body "$CASE/patch.json" 2>/dev/null)" == "${FRESH_BODY/- \[ \] <!-- manual job/- [x] <!-- manual job}" ]]; then
  PASS=$((PASS + 1))
else
  printf 'FAIL  tick on a fresh read: PATCH is not the fresh body with the box ticked\n'
  FAIL=$((FAIL + 1))
fi

# Ticked by the previous night's run and never unticked: Renovate did
# not run in between. Already ticked, so nothing to write.
new_case
set_body "$(printf '%s\n\n' "$HEADER"; benign_sections; footer x)"
run_check 'box still ticked is red' 1
expect_output 'box still ticked: names the probe' 'manual job'
expect_no_tick 'box still ticked: no write'

# The probe depends on the Mend footer. Without it there is no liveness
# signal, which must read as red, not as "nothing to check".
new_case
set_body "$(printf '%s\n\n' "$HEADER"; benign_sections)"
run_check 'no manual-job box is red' 1
expect_output 'no manual-job box: names the probe' 'manual job'
expect_no_tick 'no manual-job box: no write'

# --- Awaiting Schedule ----------------------------------------------
# A starved non-major: what #637 found. Red, naming the branch; the
# exempt branches are not reported. The probe is still armed — a red
# section says nothing about whether Renovate runs.
new_case
AWAITING_EXTRA=('- [ ] <!-- unschedule-branch=renovate/node-24.x -->chore(deps): update node.js to v24.22.2')
set_body "$(printf '%s\n\n' "$HEADER"; benign_sections; footer ' ')"
run_check 'starved branch in Awaiting Schedule is red' 1
expect_output 'starved branch: named' 'renovate/node-24.x'
expect_no_output 'starved branch: exempt branch not reported' 'renovate/docker-host'
expect_no_output 'starved branch: exempt branch not reported' 'renovate/lock-file-maintenance'
expect_no_output 'starved branch: exempt branch not reported' 'renovate/renovate-config-validator'
expect_tick 'starved branch: probe still ticked'

# --- problem and unknown sections -----------------------------------
for title in 'Errored' 'Rate-Limited' 'PR Edited (Blocked)' 'Config Migration Needed' 'Other Branches'; do
  new_case
  set_body "$(printf '%s\n\n' "$HEADER"; benign_sections; section "$title" '- [ ] <!-- retry-branch=renovate/foo -->chore(deps): update foo'; footer ' ')"
  run_check "'$title' section is red" 1
  expect_output "'$title' section: named" "$title"
done

# Renovate's own Repository Problems section carries no checkbox items,
# only warnings; it is red on presence.
new_case
set_body "$(printf '%s\n\n' "$HEADER"; printf '## Repository Problems\n\nRenovate tried to run on this repository, but found these problems.\n\n - WARN: Error updating branch: update failure\n\n'; benign_sections; footer ' ')"
run_check 'Repository Problems without items is red' 1
expect_output 'Repository Problems without items: named' 'Repository Problems'

# Lookup failures carry no heading: Renovate appends a warning block to
# whatever section precedes it (errors-warnings.ts,
# getDepWarningsDashboard). A dependency that cannot be looked up is
# never updated, so it is red wherever it lands.
new_case
LOOKUP_WARNING="$(printf '\n---\n\n> ⚠️ **Warning**\n> \n> Renovate failed to look up the following dependencies: `ghcr.io/example/lost-image`.\n> \n> Files affected: `package.json`\n\n---\n\n')"
set_body "$(printf '%s\n\n' "$HEADER"; benign_sections; footer ' ')"
run_check 'dependency lookup warning is red' 1
expect_output 'lookup warning: names the dependency' 'ghcr.io/example/lost-image'

# A heading this check does not know: a Renovate format change. Fail
# closed (#637 § Accepted), never skip it as harmless.
new_case
set_body "$(printf '%s\n\n' "$HEADER"; benign_sections; section 'Brand New Section' '- [ ] <!-- other-branch=renovate/foo -->chore(deps): update foo'; footer ' ')"
run_check 'unknown section is red' 1
expect_output 'unknown section: named' 'Brand New Section'

# --- stale Renovate PRs ---------------------------------------------
new_case
jq -s 'add' <(printf '%s' "$HEALTHY_PULLS") <(jq -s . <(pr 650 'renovate[bot]' renovate/react 2026-10-22T02:59:00Z)) > "$CASE/pulls.json"
run_check 'Renovate PR open over 7 days is red' 1
expect_output 'stale PR: named' '#650'
expect_no_output 'stale PR: docker-host exempt' '#640'
expect_no_output 'stale PR: human PR not counted' '#600'

new_case
jq -s 'add' <(printf '%s' "$HEALTHY_PULLS") <(jq -s . <(pr 651 'renovate[bot]' renovate/react 2026-10-22T03:01:00Z)) > "$CASE/pulls.json"
run_check 'Renovate PR just under 7 days is green' 0

# --- the dashboard issue itself -------------------------------------
new_case
jq -s . <(other_issue) > "$CASE/issues.json"
run_check 'no dashboard issue is red' 1
expect_output 'no dashboard: says so' 'Dependency Dashboard'
expect_no_tick 'no dashboard: no write'

# The issues endpoint also returns PRs; a PR titled like the dashboard
# is not the dashboard.
new_case
jq -s . <(other_issue) <(dashboard_issue "$HEALTHY_BODY" | jq '. + {pull_request: {url: "x"}}') > "$CASE/issues.json"
run_check 'PR titled Dependency Dashboard is not the dashboard' 1
expect_output 'PR titled Dependency Dashboard: no dashboard' 'found 0'

new_case
jq -s . <(other_issue) <(dashboard_issue "$HEALTHY_BODY" 201) <(dashboard_issue "$HEALTHY_BODY" 202) > "$CASE/issues.json"
run_check 'two open dashboards are red' 1
expect_output 'two open dashboards: says so' 'found 2'
expect_no_tick 'two dashboards: no write'

# --- API failure ----------------------------------------------------
# Cannot check is not healthy: exit 2, distinct from a finding.
new_case
rm "$CASE/pulls.json"
run_check 'API failure exits 2' 2

new_case
rm "$CASE/issues.json"
run_check 'API failure on the dashboard exits 2' 2
expect_no_tick 'API failure: no write'

# --- the live dashboard of 2026-10-29 -------------------------------
# Full body, verbatim: control 1 not yet landed, so Awaiting Schedule
# holds the starved non-majors (#637 target step 2). Red for exactly
# that; its benign sections (Abandoned, Pending Status Checks, Open, PR
# Closed (Blocked), Detected Dependencies) raise nothing.
new_case
set_body "$(cat "$LIVE_DASHBOARD")"
run_check 'live dashboard is red' 1
expect_output 'live dashboard: starved node bump' 'renovate/node-24.x'
expect_output 'live dashboard: failing pin branch' 'renovate/pin-dependencies'
expect_no_output 'live dashboard: exempt branch' 'renovate/lock-file-maintenance'
for benign in 'Abandoned Dependencies' 'Pending Status Checks' 'PR Closed (Blocked)' 'Detected Dependencies'; do
  expect_no_output "live dashboard: '$benign' not reported" "$benign"
done
expect_tick 'live dashboard: probe ticked'

echo
echo "renovate-health: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
