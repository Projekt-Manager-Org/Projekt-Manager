#!/usr/bin/env bash
#
# Truth-table tests for the `Classify run` step of
# .github/workflows/notify.yml.
#
# WHY THIS EXISTS
#   `workflow_run` only fires from the copy of the file on the default
#   branch, so notify.yml cannot be exercised on a PR branch the way
#   its predecessor (#346) was — baseline green, forced red, revert,
#   all pre-merge. It has to be merged first and broken on purpose
#   after. That inverts how every other CI change in this repo was
#   validated, and leaves the branchiest part of the workflow — three
#   states x three routes — resting on nothing but review.
#
#   This closes that gap for the part that is pure logic. The step's
#   shell body is EXTRACTED FROM THE REAL notify.yml and executed, so
#   the test cannot drift away from what ships: editing the step
#   without editing the table fails here, and deleting the step fails
#   the extractor. Only the one API call is stubbed (see below).
#
# WHAT IS AND IS NOT COVERED
#   Covered: the conclusion -> state mapping, the event/branch -> route
#   mapping, the `jq` filter that picks an open PR out of the
#   commits/{sha}/pulls response, and the demotion to `route=none` when
#   no open PR resolves.
#
#   Not covered: that GitHub delivers the event at all, that
#   `workflow_run` fires on `startup_failure`, and the four acting
#   steps that call the issues API. Those are post-merge verification —
#   see the checklist in the issue and the header of notify.yml.
#
# HOW THE STUB WORKS
#   `gh` is replaced by a script on PATH that prints a per-case JSON
#   fixture. `jq` is NOT stubbed: the filter under test is the real
#   one, run by the real jq, against a response shaped like the real
#   endpoint's.
#
# Exits 0 when every case matches; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/notify-classify.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORKFLOW="${NOTIFY_WORKFLOW:-$REPO_ROOT/.github/workflows/notify.yml}"

if [[ ! -f "$WORKFLOW" ]]; then
  echo "ERROR: $WORKFLOW not found." >&2
  exit 2
fi

if ! command -v jq > /dev/null 2>&1; then
  echo "ERROR: jq is required (the step under test pipes through it)." >&2
  exit 2
fi

TMP_ROOT="$(mktemp -d)"
# shellcheck disable=SC2317  # invoked via `trap cleanup EXIT`
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

# ---------------------------------------------------------------------
# Extract the `run:` body of the step whose `id:` is `classify`.
#
# Structural, not line-numbered: reordering the steps or reindenting
# the file does not fool it. awk rather than a YAML parser for the same
# reason as check-workflow-drift.sh — this must run with nothing beyond
# a standard POSIX toolchain.
# ---------------------------------------------------------------------
SCRIPT="$TMP_ROOT/classify.sh"

awk '
  # `id: classify` arms the extractor; the next `run: |` is ours.
  /^[[:space:]]*id:[[:space:]]*classify[[:space:]]*$/ { armed = 1; next }

  armed && /^[[:space:]]*run:[[:space:]]*\|[[:space:]]*$/ {
    match($0, /^[[:space:]]*/)
    run_indent = RLENGTH
    armed = 0
    in_run = 1
    next
  }

  in_run {
    if ($0 ~ /^[[:space:]]*$/) { print ""; next }   # blank lines belong to the block
    match($0, /^[[:space:]]*/)
    indent = RLENGTH
    if (indent <= run_indent) { in_run = 0; next }  # dedent ends the block
    lines[++n] = $0
    if (!have_min || indent < min) { min = indent; have_min = 1 }
    order[n] = 1
  }

  END {
    if (n == 0) { exit 3 }
    for (i = 1; i <= n; i++) print substr(lines[i], min + 1)
  }
' "$WORKFLOW" > "$SCRIPT"

# awk drops blank lines from `lines[]` (they are printed inline above),
# so a zero-length result means the step or its `run:` block is gone.
if [[ ! -s "$SCRIPT" ]]; then
  echo "ERROR: no 'id: classify' step with a 'run: |' block found in $WORKFLOW." >&2
  echo "       If the step was renamed or restructured, update this test with it." >&2
  exit 2
fi

# Sanity-check that we extracted the thing we think we did, rather than
# an empty-ish block that would make every case below pass vacuously.
for marker in 'state=' 'route=' 'GITHUB_OUTPUT'; do
  if ! grep -q "$marker" "$SCRIPT"; then
    echo "ERROR: extracted block has no '$marker' — extractor is out of date." >&2
    exit 2
  fi
done

# ---------------------------------------------------------------------
# `gh` stub. Prints $GH_FIXTURE, which each case sets to a response
# shaped like GET /repos/{owner}/{repo}/commits/{sha}/pulls.
# ---------------------------------------------------------------------
STUB_BIN="$TMP_ROOT/bin"
mkdir -p "$STUB_BIN"
cat > "$STUB_BIN/gh" <<'STUB'
#!/usr/bin/env bash
# Records the call so a case can assert the API was (not) reached.
echo "$*" >> "${GH_CALL_LOG:-/dev/null}"
printf '%s' "${GH_FIXTURE:-[]}"
STUB
chmod +x "$STUB_BIN/gh"

PASS=0
FAIL=0

# run_case <desc> <conclusion> <event> <branch> <fixture> <want_state> <want_route> <want_pr>
run_case() {
  local desc="$1" conclusion="$2" event="$3" branch="$4" fixture="$5"
  local want_state="$6" want_route="$7" want_pr="$8"
  local dir out log rc
  dir="$(mktemp -d "$TMP_ROOT/case.XXXXXX")"
  out="$dir/github_output"
  log="$dir/gh_calls"
  : > "$out"
  : > "$log"

  (
    PATH="$STUB_BIN:$PATH"
    export PATH
    export GITHUB_OUTPUT="$out"
    export GH_CALL_LOG="$log"
    export GH_FIXTURE="$fixture"
    export GITHUB_REPOSITORY='Projekt-Manager-Org/Projekt-Manager'
    export CONCLUSION="$conclusion"
    export RUN_EVENT="$event"
    export HEAD_BRANCH="$branch"
    export HEAD_SHA='0123456789abcdef0123456789abcdef01234567'
    bash "$SCRIPT"
  ) > "$dir/stdout" 2>&1
  rc=$?

  if [[ $rc -ne 0 ]]; then
    printf 'FAIL  %s\n      step exited %d\n' "$desc" "$rc"
    sed 's/^/      /' "$dir/stdout"
    FAIL=$((FAIL + 1))
    return
  fi

  local got_state got_route got_pr
  got_state="$(sed -n 's/^state=//p' "$out")"
  got_route="$(sed -n 's/^route=//p' "$out")"
  got_pr="$(sed -n 's/^pr=//p' "$out")"

  if [[ "$got_state" == "$want_state" && "$got_route" == "$want_route" && "$got_pr" == "$want_pr" ]]; then
    PASS=$((PASS + 1))
  else
    printf 'FAIL  %s\n      want state=%s route=%s pr=%s\n      got  state=%s route=%s pr=%s\n' \
      "$desc" "$want_state" "$want_route" "$want_pr" "$got_state" "$got_route" "$got_pr"
    FAIL=$((FAIL + 1))
  fi
}

OPEN_PR='[{"number":284,"state":"open"}]'
CLOSED_PR='[{"number":346,"state":"closed"}]'
NO_PR='[]'
# The endpoint returns every PR containing the commit. A squashed
# commit on `main` resolves back to its merged PR — the response that
# would misroute a red `main` to a closed PR if routing read the API
# instead of the originating event.
SQUASHED='[{"number":346,"state":"closed"},{"number":284,"state":"open"}]'

# --- conclusion -> state -------------------------------------------
run_case 'success on a PR is green'            success        pull_request feature "$OPEN_PR" green  pr   284
run_case 'failure on a PR is red'              failure        pull_request feature "$OPEN_PR" red    pr   284
run_case 'timed_out is red'                    timed_out      pull_request feature "$OPEN_PR" red    pr   284
run_case 'startup_failure is red'              startup_failure pull_request feature "$OPEN_PR" red   pr   284
# The one that matters most: ci.yml cancels superseded runs on every
# force-push. Red would assign on every rebase; green would CLEAR a
# live assignment and lose a real failure. It must be neither.
run_case 'cancelled is inert, not green'       cancelled      pull_request feature "$OPEN_PR" ignore pr   284
run_case 'skipped is inert'                    skipped        pull_request feature "$OPEN_PR" ignore pr   284
run_case 'neutral is inert'                    neutral        pull_request feature "$OPEN_PR" ignore pr   284
run_case 'action_required is inert'            action_required pull_request feature "$OPEN_PR" ignore pr  284
run_case 'stale is inert'                      stale          pull_request feature "$OPEN_PR" ignore pr   284

# --- event/branch -> route -----------------------------------------
run_case 'push to main routes to the issue'    failure push            main "$NO_PR" red   main ''
run_case 'green push to main still routes'     success push            main "$NO_PR" green main ''
run_case 'nightly schedule routes to issue'    failure schedule        main "$NO_PR" red   main ''
run_case 'dispatch on a feature branch: none'  failure workflow_dispatch feature "$NO_PR" red none ''
run_case 'dispatch on main routes to issue'    failure workflow_dispatch main "$NO_PR" red main ''
run_case 'merge_group train is not main'       failure push 'gh-readonly-queue/main/pr-1-abc' "$NO_PR" red none ''

# --- PR resolution --------------------------------------------------
run_case 'PR already merged: demoted to none'  failure pull_request feature "$NO_PR"     red none ''
run_case 'only a closed PR: demoted to none'   failure pull_request feature "$CLOSED_PR" red none ''
run_case 'closed+open: picks the open one'     failure pull_request feature "$SQUASHED"  red pr  284

# --- routing must not read the API ----------------------------------
# A push to `main` whose SHA resolves to a merged PR must still raise
# the main-is-red issue, never assign the PR it came from.
run_case 'squashed main commit stays on main'  failure push main "$SQUASHED" red main ''

# The `main` route must never call the endpoint at all.
API_CASE="$TMP_ROOT/api-case"
mkdir -p "$API_CASE"
(
  PATH="$STUB_BIN:$PATH"; export PATH
  export GITHUB_OUTPUT="$API_CASE/out" GH_CALL_LOG="$API_CASE/log" GH_FIXTURE="$SQUASHED"
  export GITHUB_REPOSITORY='Projekt-Manager-Org/Projekt-Manager'
  export CONCLUSION=failure RUN_EVENT=push HEAD_BRANCH=main HEAD_SHA=deadbeef
  bash "$SCRIPT"
) > /dev/null 2>&1
if [[ -s "$API_CASE/log" ]]; then
  printf 'FAIL  %s\n      gh was called: %s\n' 'main route makes no API call' "$(cat "$API_CASE/log")"
  FAIL=$((FAIL + 1))
else
  PASS=$((PASS + 1))
fi

echo ""
if [[ $FAIL -eq 0 ]]; then
  echo "OK: notify.yml 'Classify run' — $PASS/$((PASS + FAIL)) cases passed"
  exit 0
fi

echo "FAILED: $FAIL of $((PASS + FAIL)) cases" >&2
exit 1
