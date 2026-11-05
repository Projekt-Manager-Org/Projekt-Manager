#!/usr/bin/env bash
#
# Scenario tests for `Open, comment on or close the red-main issue` (id `post`)
# in .github/workflows/notify.yml: what a run on main tells the maintainer.
#
# As in notify-classify.test.sh, the step's shell body is extracted from the
# real notify.yml and run as the runner does, with `bash -e`. `jq` is real.
# `gh` answers only the exact calls the step should make, from the fixture
# directory $FIX; anything else exits 1, like an API error:
#   issues.json          GET repos/<repo>/issues?state=open&labels=<label>
#   jobs.json            GET repos/<repo>/actions/runs/<run>/jobs
#   annotations-<n>.json GET <check_run_url of job n>/annotations
#   POST .../comments    writes the issue number to $FIX/commented-on, the body
#                        to $FIX/comment
#   POST .../issues      writes each -f field to $FIX/issue-<key>
#   PATCH .../issues/<n> writes the number to $FIX/closed
#
# Usage:
#   bash scripts/__tests__/notify-post.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORKFLOW="${NOTIFY_WORKFLOW:-$REPO_ROOT/.github/workflows/notify.yml}"

if ! command -v jq > /dev/null 2>&1; then
  echo "ERROR: jq is required (the step under test pipes through it)." >&2
  exit 2
fi

TMP_ROOT="$(mktemp -d)"
# shellcheck disable=SC2317  # invoked via `trap cleanup EXIT`
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

# shellcheck source=scripts/__tests__/lib/workflow-step.sh
. "$REPO_ROOT/scripts/__tests__/lib/workflow-step.sh"
SCRIPT="$TMP_ROOT/post.sh"

if ! extract_run_step "$WORKFLOW" post > "$SCRIPT"; then
  echo "ERROR: no 'id: post' step with a 'run: |' block found in $WORKFLOW." >&2
  exit 2
fi
# An empty extraction must not make every case pass vacuously.
for marker in 'annotations' 'comments' 'assignees'; do
  if ! grep -q "$marker" "$SCRIPT"; then
    echo "ERROR: step 'post' has no '$marker' — extractor is out of date." >&2
    exit 2
  fi
done

export REPO='o/r'
API="https://api.github.com/repos/$REPO/check-runs"

mkdir -p "$TMP_ROOT/bin"
cat > "$TMP_ROOT/bin/gh" <<'STUB'
#!/usr/bin/env bash
[[ "$1" == api ]] || exit 1
shift
method=GET path='' fields=()
while (($#)); do
  case "$1" in
    -X) method="$2"; shift ;;
    -f) fields+=("$2"); shift ;;
    --jq) shift ;;
    -*) exit 1 ;;
    *) path="$1" ;;
  esac
  shift
done
case "$method $path" in
  "GET repos/$REPO/issues?state=open&labels=$RED_LABEL&per_page=100")
    [[ -f "$FIX/issues.json" ]] && cat "$FIX/issues.json" || exit 1 ;;
  "GET repos/$REPO/actions/runs/$RUN_ID/jobs?per_page=100")
    [[ -f "$FIX/jobs.json" ]] && cat "$FIX/jobs.json" || exit 1 ;;
  "GET https://api.github.com/repos/$REPO/check-runs/"*"/annotations?per_page=100")
    n="${path#https://api.github.com/repos/"$REPO"/check-runs/}"
    n="${n%%/*}"
    [[ -f "$FIX/annotations-$n.json" ]] && cat "$FIX/annotations-$n.json" || exit 1 ;;
  "POST repos/$REPO/issues/"*/comments)
    n="${path#repos/"$REPO"/issues/}"
    echo "${n%%/*}" > "$FIX/commented-on"
    printf '%s' "${fields[0]#body=}" > "$FIX/comment" ;;
  "PATCH repos/$REPO/issues/"*)
    [[ " ${fields[*]} " == *' state=closed '* ]] || exit 1
    echo "${path##*/}" > "$FIX/closed" ;;
  "POST repos/$REPO/issues")
    for f in "${fields[@]}"; do printf '%s\n' "${f#*=}" >> "$FIX/issue-${f%%=*}"; done
    echo 7 ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$TMP_ROOT/bin/gh"

pass=0
fail=0
failures=()

record() { # <ok: yes|no> <label> <detail>
  if [[ "$1" == yes ]]; then
    pass=$((pass + 1))
    echo "  PASS — $2"
  else
    fail=$((fail + 1))
    failures+=("$2")
    printf '  FAIL — %s\n%s\n' "$2" "$(sed 's/^/    /' <<< "$3")"
  fi
}

# A job: <id> <name> <conclusion> <failed step name, or empty for none>
job() {
  jq -nc --arg id "$1" --arg name "$2" --arg how "$3" --arg step "$4" --arg api "$API" '{
    name: $name, conclusion: $how, check_run_url: "\($api)/\($id)",
    steps: (if $step == "" then [] else [
      {name: "Set up job", conclusion: "success"}, {name: $step, conclusion: "failure"}
    ] end)}'
}
jobs() { printf '%s\n' "$@" | jq -s '{jobs: .}' > "$FIX/jobs.json"; }
# Failure-level annotations, one per argument.
errors() {
  local n="$1"
  shift
  jq -n '$ARGS.positional | map({annotation_level: "failure", message: .})' --args "$@" > "$FIX/annotations-$n.json"
}

# run_post <red|green> [workflow name]: runs the step against the case's fixture.
# A non-zero exit is itself a failure; run_post_rc leaves it in $step_rc instead.
run_post_rc() {
  step_rc=0
  STATE="$1" WORKFLOW_NAME="${2:-$WF}" \
    GH_TOKEN=x GITHUB_REPOSITORY="$REPO" RUN_ID=42 FIX="$FIX" \
    RUN_URL='https://runs/42' RUN_EVENT=schedule CONCLUSION=failure HEAD_SHA=abc123 \
    MAINTAINER=mx RED_LABEL=ci-red EVENT_SCOPED='Deploy pending' \
    PATH="$TMP_ROOT/bin:$PATH" \
    bash --noprofile --norc -e "$SCRIPT" > "$FIX/out" 2>&1 || step_rc=$?
}
run_post() {
  run_post_rc "$@"
  ((step_rc == 0)) || record no "step exits 0" "$(cat "$FIX/out")"
}

WF='Security (scheduled)'
# Open ci-red issues: another workflow's, and a PR that shares the title (the
# issues API lists PRs too), around <number> <title> when given.
open_issues() {
  jq -n --arg wf "$WF is red on main" --arg n "${1:-}" --arg t "${2:-}" '
    [{number: 90, title: "CI is red on main"},
     {number: 91, title: $wf, pull_request: {}}]
    + (if $n == "" then [] else [{number: ($n | tonumber), title: $t}] end)' > "$FIX/issues.json"
}

# A fresh fixture with a standing issue for $WF, or with none: fresh_none.
fresh_none() {
  FIX="$(mktemp -d "$TMP_ROOT/case.XXXXXX")"
  open_issues
}
fresh() {
  FIX="$(mktemp -d "$TMP_ROOT/case.XXXXXX")"
  open_issues 12 "$WF is red on main"
}

# check <label> <file> [+present | -absent]...: grep -F per pattern.
check() {
  local label="$1" file="$2" text pat
  shift 2
  if [[ ! -f "$file" ]]; then
    record no "$label" "$(basename "$file") was not written; step output: $(cat "$FIX/out")"
    return
  fi
  text="$(cat "$file")"
  for pat in "$@"; do
    if [[ "$pat" == +* ]] && ! grep -qF -- "${pat#+}" <<< "$text"; then
      record no "$label" "missing '${pat#+}' in: $text"
      return
    fi
    if [[ "$pat" == -* ]] && grep -qF -- "${pat#-}" <<< "$text"; then
      record no "$label" "unexpected '${pat#-}' in: $text"
      return
    fi
  done
  record yes "$label" ""
}

echo "Case: the first red opens the issue and lists the failures"
fresh_none
jobs "$(job 1 scan failure 'OSV scan')" "$(job 2 other success '')"
errors 1 'GHSA-1 glob@1' 'Process completed with exit code 1.'
run_post red
check "body names the job, step and annotation; no exit-code noise" "$FIX/issue-body" \
  '+`Security (scheduled)` concluded **failure**' '+https://runs/42' '+abc123' \
  '+- `scan / OSV scan`' '+- `scan: GHSA-1 glob@1`' '-Process completed' '-other' \
  '+closes itself on the next green run'
check "titled for this workflow, so a green CI cannot close it" "$FIX/issue-title" "+$WF is red on main"
check "assigned" "$FIX/issue-assignees[]" '+mx'
check "labelled" "$FIX/issue-labels[]" '+ci-red'

echo "Case: a repeat red comments and names the step"
fresh
jobs "$(job 1 check failure 'Probe (deliberate red)')"
errors 1 'probe: red run'
run_post red
check "comment says still red, with step and annotation" "$FIX/comment" \
  '+Still red — https://runs/42' '+- `check / Probe (deliberate red)`' '+- `check: probe: red run`'
check "on this workflow's issue" "$FIX/commented-on" '+12'
[[ -e "$FIX/issue-title" ]] && record no "no second issue" "an issue was opened" || record yes "no second issue" ""

echo "Case: only failure-level annotations count"
fresh
jobs "$(job 1 check failure 'Scan')"
jq -n '[{annotation_level: "notice", message: "runner label migrates"},
        {annotation_level: "warning", message: "a deprecation"},
        {annotation_level: "failure", message: "real"}]' > "$FIX/annotations-1.json"
run_post red
check "notice and warning left out" "$FIX/comment" '+- `check: real`' '-migrates' '-deprecation'

echo "Case: a job with no failed step, as on a timeout"
fresh
jobs "$(job 1 hung cancelled '')"
errors 1 'The job has exceeded the maximum execution time of 5m0s' 'The operation was canceled.'
run_post red
check "job and conclusion, the reason kept, the generic line not" "$FIX/comment" \
  '+- `hung (cancelled)`' '+exceeded the maximum execution time' '-operation was canceled'

fresh
jobs "$(job 1 hung timed_out '')"
errors 1 'too slow'
run_post red
check "a timed-out job is listed too" "$FIX/comment" '+- `hung (timed_out)`' '+- `hung: too slow`'

echo "Case: GitHub's annotation cap"
fresh
jobs "$(job 1 check failure 'Scan')"
errors 1 CVE-1 CVE-2 CVE-3 CVE-4 CVE-5 CVE-6 CVE-7 CVE-8 CVE-9 CVE-10
run_post red
check "10 on a job is flagged" "$FIX/comment" '+GitHub keeps 10 per step'
fresh
jobs "$(job 1 check failure 'Scan')"
errors 1 CVE-1 CVE-2 CVE-3 CVE-4 CVE-5 CVE-6 CVE-7 CVE-8 CVE-9
run_post red
check "9 are not" "$FIX/comment" '+CVE-9' '-GitHub keeps 10 per step'

echo "Case: annotation text is third-party"
fresh
jobs "$(job 1 check failure 'Scan')"
errors 1 'pkg`](https://evil) @someone' "$(printf 'line one\nline two')" "$(printf 'x%.0s' {1..400})"
run_post red
check "no backtick escapes its code span; one line per annotation" "$FIX/comment" \
  '+- `check: pkg](https://evil) @someone`' '+- `check: line one line two`'
check "a long one is cut" "$FIX/comment" "+$(printf 'x%.0s' {1..250})" "-$(printf 'x%.0s' {1..301})"

echo "Case: the list is capped, a comment over 65536 characters posts nothing"
fresh
jobs "$(job 1 a failure 'S1')" "$(job 2 b failure 'S2')" "$(job 3 c failure 'S3')" \
  "$(job 4 d failure 'S4')" "$(job 5 e failure 'S5')" "$(job 6 f failure 'S6')"
for n in 1 2 3 4 5 6; do errors "$n" M1 M2 M3 M4 M5 M6 M7 M8 M9 M10; done
run_post red
check "at most 50 and a count of the rest" "$FIX/comment" '+- … and 16 more in the run'
if [[ "$(grep -c '^- `' "$FIX/comment" 2> /dev/null)" == 50 ]]; then
  record yes "exactly 50 items" ""
else
  record no "exactly 50 items" "$(cat "$FIX/comment" 2> /dev/null)"
fi

echo "Case: a failed lookup still posts"
fresh
run_post red
check "jobs unreadable, the comment says so" "$FIX/comment" \
  '+Still red — https://runs/42' '+Could not read every failure'
fresh_none
run_post red
check "jobs unreadable, the issue still opens" "$FIX/issue-body" \
  '+https://runs/42' '+Could not read every failure'
fresh
jobs "$(job 1 a failure 'S1')" "$(job 2 b failure 'S2')"
errors 2 'from b'
run_post red
check "one job's annotations unreadable, the rest still listed" "$FIX/comment" \
  '+- `a / S1`' '+- `b / S2`' '+- `b: from b`' '+Could not read every failure'

echo "Case: a run that lists no failed job says so"
fresh
jobs "$(job 1 a success '')"
run_post red
check "not an empty list" "$FIX/comment" '+Could not read every failure'

echo "Case: an event-scoped workflow"
fresh
open_issues 13 'Deploy pending is red on main'
jobs "$(job 1 report failure 'Open the issue')"
errors 1 'nope'
run_post red 'Deploy pending'
check "a repeat is another merge" "$FIX/comment" \
  '+Also red (another merge, `abc123`) — https://runs/42' '+- `report / Open the issue`' '-Still red'
fresh_none
jobs "$(job 1 report failure 'Open the issue')"
errors 1 'nope'
run_post red 'Deploy pending'
check "a first red is closed by hand" "$FIX/issue-body" '+close this issue by hand' '-closes itself'

echo "Case: an issue lookup that fails posts nothing, as it could open a second issue"
fresh
rm "$FIX/issues.json"
run_post_rc red
[[ -e "$FIX/issue-title" || -e "$FIX/comment" ]] && record no "nothing posted" "$(ls "$FIX")" || record yes "nothing posted" ""
((step_rc != 0)) && record yes "the step fails" "" || record no "the step fails" "exited 0"

echo "Case: green closes this workflow's issue"
fresh
run_post green
check "says where it went green" "$FIX/comment" '+Green again on abc123 — https://runs/42'
check "closed" "$FIX/closed" '+12'
fresh_none
run_post green
[[ -e "$FIX/closed" || -e "$FIX/comment" ]] && record no "no issue, nothing to do" "$(ls "$FIX")" || record yes "no issue, nothing to do" ""
fresh
open_issues 13 'Deploy pending is red on main'
run_post green 'Deploy pending'
[[ -e "$FIX/closed" ]] && record no "an event-scoped issue stays open" "closed" || record yes "an event-scoped issue stays open" ""

echo
echo "Result: $pass passed, $fail failed"
if ((fail > 0)); then
  printf '  - %s\n' "${failures[@]}"
  exit 1
fi
