#!/usr/bin/env bash
#
# Scenario tests for the steps of .github/workflows/notify.yml that comment
# on a standing ci-red issue (#732): `Compare with the last alert` (id
# `compare`) and `Open or update the red-main issue` (id `post`).
#
# WHY THIS EXISTS
#   While a nightly stays red, each later red run comments on its ci-red
#   issue. A plain "Still red" there hid a new advisory in #420. `compare`
#   diffs the run against the last run the issue reported and writes the
#   comment; plain "Still red" only when nothing was added and every gate
#   gave a verdict on both runs.
#
#   As in notify-classify.test.sh, each step's shell body is EXTRACTED FROM
#   THE REAL notify.yml and executed under the runner's own bash flags, so
#   the test cannot drift from what ships. `jq` is not stubbed.
#
# HOW THE STUB WORKS
#   `gh` answers only the exact calls the steps should make, from a
#   per-case fixture directory ($FIX); anything else exits 1, like an API
#   error:
#     issue.json, comments.json   GET repos/<repo>/issues/<n>[/comments],
#                                 paged like the API: `per_page` (default
#                                 30) per page, one JSON array per page
#                                 under --paginate, the first page without
#     run-<run>.json              GET repos/<repo>/actions/runs/<run>
#     jobs-<run>.json             GET repos/<repo>/actions/runs/<run>/jobs
#     artifacts-<run>/            what `gh run download <run> --repo <repo>
#                                 --pattern 'findings-*' --dir <d>` extracts:
#                                 findings-<label>/<gate>.keys | <gate>.none;
#                                 GET …/runs/<run>/artifacts lists the same.
#                                 download-fails-<run> makes the download
#                                 fail, listing-fails-<run> the listing
#     POST .../comments           the body is written to $FIX/posted
#
# Exits 0 when every case matches; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/notify-compare.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORKFLOW="${NOTIFY_WORKFLOW:-$REPO_ROOT/.github/workflows/notify.yml}"

if ! command -v jq > /dev/null 2>&1; then
  echo "ERROR: jq is required (the steps under test pipe through it)." >&2
  exit 2
fi

TMP_ROOT="$(mktemp -d)"
# shellcheck disable=SC2317  # invoked via `trap cleanup EXIT`
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

# shellcheck source=scripts/__tests__/lib/workflow-step.sh
. "$REPO_ROOT/scripts/__tests__/lib/workflow-step.sh"

# extract <step-id> <marker>... — the step body, checked for its markers so a
# wrong or empty extraction cannot make every case pass vacuously.
extract() {
  local id="$1" marker
  shift
  if ! extract_run_step "$WORKFLOW" "$id" > "$TMP_ROOT/$id.sh"; then
    echo "ERROR: no 'id: $id' step with a 'run: |' block found in $WORKFLOW." >&2
    echo "       If the step was renamed or restructured, update this test with it." >&2
    exit 2
  fi
  for marker in "$@"; do
    if ! grep -q -- "$marker" "$TMP_ROOT/$id.sh"; then
      echo "ERROR: step '$id' has no '$marker' — extractor is out of date." >&2
      exit 2
    fi
  done
}
extract compare 'run download' 'body_file=' 'GITHUB_OUTPUT'
extract post 'comments' 'BODY_FILE'

STUB_BIN="$TMP_ROOT/bin"
mkdir -p "$STUB_BIN"
cat > "$STUB_BIN/gh" <<'STUB'
#!/usr/bin/env bash
pages() { # <file> <per_page> <all> — the API's paging, one array per page
  [[ -f "$1" ]] || exit 1
  jq -c --argjson n "$2" --argjson all "$3" '
    . as $a | if length == 0 then [] else
      [range(0; $a | length; $n) | $a[.:. + $n]] | if $all then .[] else .[0] end
    end' "$1"
}
if [[ "$1 $2" == 'run download' ]]; then
  shift 2
  id='' repo="${GH_REPO:-}" pattern='' dest=''
  while (($#)); do
    case "$1" in
      -R | --repo) repo="$2"; shift ;;
      -p | --pattern) pattern="$2"; shift ;;
      -D | --dir) dest="$2"; shift ;;
      -*) exit 1 ;;
      *) id="$1" ;;
    esac
    shift
  done
  # Without a checkout gh cannot infer the repo; real gh fails here too.
  [[ "$repo" == "$STUB_REPO" && "$pattern" == 'findings-*' && -n "$dest" ]] || exit 1
  if [[ ! -d "$FIX/artifacts-$id" ]]; then
    echo 'no valid artifacts found to download' >&2
    exit 1
  fi
  mkdir -p "$dest" && cp -R "$FIX/artifacts-$id"/. "$dest"/
  [[ -e "$FIX/download-fails-$id" ]] && exit 1
  exit 0
fi
[[ "$1" == api ]] || exit 1
shift
all=false method=GET path='' body=''
while (($#)); do
  case "$1" in
    --paginate) all=true ;;
    -X) method="$2"; shift ;;
    -f) [[ "$2" == body=* ]] && body="${2#body=}"; shift ;;
    -*) exit 1 ;;
    *) path="$1" ;;
  esac
  shift
done
per=30
[[ "$path" =~ [?\&]per_page=([0-9]+) ]] && per="${BASH_REMATCH[1]}"
base="${path%%\?*}"
case "$method $base" in
  "GET repos/$STUB_REPO/issues/$STUB_ISSUE") [[ -f "$FIX/issue.json" ]] && cat "$FIX/issue.json" || exit 1 ;;
  "GET repos/$STUB_REPO/issues/$STUB_ISSUE/comments") pages "$FIX/comments.json" "$per" "$all" ;;
  "POST repos/$STUB_REPO/issues/$STUB_ISSUE/comments") printf '%s' "$body" > "$FIX/posted" && echo '{}' ;;
  GET\ repos/"$STUB_REPO"/actions/runs/*/jobs)
    id="${base#repos/"$STUB_REPO"/actions/runs/}"
    [[ -f "$FIX/jobs-${id%/jobs}.json" ]] && cat "$FIX/jobs-${id%/jobs}.json" || exit 1
    ;;
  GET\ repos/"$STUB_REPO"/actions/runs/*/artifacts)
    id="${base#repos/"$STUB_REPO"/actions/runs/}"
    id="${id%/artifacts}"
    [[ -e "$FIX/listing-fails-$id" ]] && exit 1
    for d in "$FIX/artifacts-$id"/*/; do [[ -d "$d" ]] && basename "$d"; done \
      | jq -Rn '[inputs | {name: ., expired: false}] | {total_count: length, artifacts: .}'
    ;;
  GET\ repos/"$STUB_REPO"/actions/runs/*)
    id="${base#repos/"$STUB_REPO"/actions/runs/}"
    [[ -f "$FIX/run-$id.json" ]] && cat "$FIX/run-$id.json" || exit 1
    ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$STUB_BIN/gh"

# The workflow's own value, so the event-scoped case follows a rename.
EVENT_SCOPED="$(sed -n 's/^  EVENT_SCOPED: //p' "$WORKFLOW")"
REPO='Projekt-Manager-Org/Projekt-Manager'
RUNS="https://github.com/$REPO/actions/runs"
BOT='github-actions[bot]'
# #420's two runs: the second failed on another advisory and said "Still red".
BASE=35071412334
CUR=35197890861
TAB=$'\t'

WORKFLOW_ID=86242
# new_case — a fresh fixture dir; the issue body links BASE, a nightly of
# this workflow on main; no comments.
new_case() {
  FIX="$(mktemp -d "$TMP_ROOT/case.XXXXXX")"
  issue_body "- Run: $RUNS/$BASE"
  printf '[]' > "$FIX/comments.json"
  run_meta "$BASE"
}

# run_meta <run> [<jq update>] — GET actions/runs/{run}, trimmed.
run_meta() {
  jq -n --argjson id "$1" --argjson wf "$WORKFLOW_ID" --arg repo "$REPO" \
    "{id: \$id, workflow_id: \$wf, head_branch: \"main\", event: \"schedule\",
      head_repository: {full_name: \$repo}} | ${2:-.}" > "$FIX/run-$1.json"
}

issue_body() {
  jq -n --arg u "$BOT" --arg b "$1" '{user: {login: $u}, body: $b}' > "$FIX/issue.json"
}

# comment <login> <body> — appended, so comments stay oldest first.
comment() {
  jq --arg u "$1" --arg b "$2" '. + [{user: {login: $u}, body: $b}]' "$FIX/comments.json" > "$FIX/c.json"
  mv "$FIX/c.json" "$FIX/comments.json"
}

# jobs <run> <job|conclusion[|failed step]>... — GET actions/runs/{run}/jobs.
# A conclusion suffixed `!` has `steps: []`, as an expired run's jobs read.
jobs() {
  local run="$1"
  shift
  jq -n '$ARGS.positional
    | map(split("|") | {name: .[0], conclusion: (.[1] | rtrimstr("!")),
        steps: (if .[1] | endswith("!") then []
          else [{name: "Set up job", conclusion: "success"}]
            + (if .[2] then [{name: .[2], conclusion: "failure"}] else [] end) end)})
    | {total_count: length, jobs: .}' --args "$@" > "$FIX/jobs-$run.json"
}

# keys <run> <label> <gate> [<key>...] — a gate's verdict in the run's artifacts.
keys() {
  local run="$1" label="$2" gate="$3"
  shift 3
  local d="$FIX/artifacts-$run/findings-$label"
  mkdir -p "$d"
  : > "$d/$gate.keys"
  local k
  for k in "$@"; do printf '%s\n' "$k" >> "$d/$gate.keys"; done
}

# none <run> <label> <gate> — the job ran but the gate gave no verdict.
none() {
  mkdir -p "$FIX/artifacts-$1/findings-$2"
  : > "$FIX/artifacts-$1/findings-$2/$3.none"
}

# run_as <step-id> [VAR=value...] — run the step for CUR as the runner does
# (`bash --noprofile --norc -eo pipefail`); sets STEP_RC.
run_as() {
  local id="$1"
  shift
  mkdir -p "$FIX/tmp"
  (
    PATH="$STUB_BIN:$PATH"
    export PATH FIX STUB_REPO="$REPO" STUB_ISSUE=420
    export GITHUB_OUTPUT="$FIX/out" RUNNER_TEMP="$FIX/tmp" GITHUB_REPOSITORY="$REPO"
    export GH_TOKEN=x ISSUE=420 RUN_ID="$CUR" RUN_URL="$RUNS/$CUR"
    export EVENT_SCOPED="$EVENT_SCOPED" WORKFLOW_ID="$WORKFLOW_ID"
    for kv in "$@"; do export "${kv?}"; done
    bash --noprofile --norc -eo pipefail "$TMP_ROOT/$id.sh"
  ) >> "$FIX/stdout" 2>&1
  STEP_RC=$?
}

# run_step — `compare` for CUR; BODY is the comment it wrote.
run_step() {
  BODY=''
  run_as compare
  local file
  file="$(sed -n 's/^body_file=//p' "$FIX/out" 2> /dev/null)"
  [[ -n "$file" && -f "$file" ]] && BODY="$(cat "$file")"
}

PASS=0
FAIL=0

# check <label> <description> <test-command...>
check() {
  local label="$1" what="$2"
  shift 2
  if [[ "$STEP_RC" -eq 0 ]] && "$@"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL  %s: %s (step exit %d)\n' "$label" "$what" "$STEP_RC"
    sed 's/^/      body| /' <<< "$BODY"
    sed 's/^/      log | /' "$FIX/stdout"
  fi
}
first_is() { [[ "$(head -n 1 <<< "$BODY")" == "$1" ]]; }
has() { grep -qF -- "$1" <<< "$BODY"; }
lacks() { ! grep -qF -- "$1" <<< "$BODY"; }

PLAIN="Still red — $RUNS/$CUR"
NEW="Still red, **with something new** — $RUNS/$CUR"
UNCOMPARED="Still red, **not compared** — $RUNS/$CUR"
BOTH="Still red, **with something new**, **partly not compared** — $RUNS/$CUR"

STANDING="GHSA-gpj5-g38j-94v9${TAB}drizzle-orm"

# Both runs red on the same steps; the per-case difference is in the keys.
same_jobs() {
  jobs "$BASE" 'osv-scan|success' 'repo-advisories|failure|Repo-level advisory check'
  jobs "$CUR" 'osv-scan|success' 'repo-advisories|failure|Repo-level advisory check'
}

# --- what is new --------------------------------------------------------

c='#420: a new advisory in an already-red job is named'
new_case
same_jobs
keys "$BASE" osv-scan osv
keys "$BASE" repo-advisories repo-advisories "$STANDING" "GHSA-4mh8-r7rc-xpvc${TAB}fastify"
keys "$CUR" osv-scan osv
keys "$CUR" repo-advisories repo-advisories "$STANDING" "GHSA-r799-r9gc-m956${TAB}@fastify/static"
run_step
check "$c" 'first line says something is new' first_is "$NEW"
check "$c" 'names the added finding' has 'repo-advisories/repo-advisories · GHSA-r799-r9gc-m956 · @fastify/static'
check "$c" 'a standing finding is not added' lacks 'GHSA-gpj5'
check "$c" 'a finding that went away is not added' lacks 'GHSA-4mh8'
check "$c" 'links the run it compared with' has "$RUNS/$BASE"

c='nothing added: plain Still red'
new_case
same_jobs
keys "$BASE" repo-advisories repo-advisories "$STANDING"
keys "$CUR" repo-advisories repo-advisories "$STANDING"
run_step
check "$c" 'the comment is exactly the old one' [ "$BODY" == "$PLAIN" ]

c='a finding that went away adds nothing'
new_case
same_jobs
keys "$BASE" repo-advisories repo-advisories "$STANDING" "GHSA-4mh8-r7rc-xpvc${TAB}fastify"
keys "$CUR" repo-advisories repo-advisories "$STANDING"
run_step
check "$c" 'plain Still red' [ "$BODY" == "$PLAIN" ]

c='keys are compared per gate'
# The same stdlib CVE at the same path in two images: one standing, one new.
new_case
jobs "$BASE" 'scan (caddy)|failure|Grype' 'scan (db)|success'
jobs "$CUR" 'scan (caddy)|failure|Grype' 'scan (db)|failure|Grype'
keys "$BASE" scan-caddy grype "CVE-1${TAB}stdlib${TAB}/usr/bin/gosu"
keys "$BASE" scan-db grype
keys "$CUR" scan-caddy grype "CVE-1${TAB}stdlib${TAB}/usr/bin/gosu"
keys "$CUR" scan-db grype "CVE-1${TAB}stdlib${TAB}/usr/bin/gosu"
run_step
check "$c" 'names it in the new image' has 'scan-db/grype · CVE-1'
check "$c" 'not in the standing one' lacks 'scan-caddy/grype'

c='a gate only the current run judged is not compared'
# A new image, or its job uploaded nothing last night: the keys may be old.
new_case
same_jobs
keys "$BASE" repo-advisories repo-advisories "$STANDING"
keys "$CUR" repo-advisories repo-advisories "$STANDING"
keys "$CUR" scan-new trivy "CVE-7${TAB}openssl${TAB}os:alpine"
run_step
check "$c" 'first line says not compared' first_is "$UNCOMPARED"
check "$c" 'names the gate' has "not compared: \`scan-new/trivy\` had no verdict on the last alert's run"
check "$c" 'does not call its keys new' lacks 'CVE-7'

c='a gate without a verdict on the compared run is not compared'
# The check crashed last night: a standing advisory must not read as new.
new_case
same_jobs
none "$BASE" repo-advisories repo-advisories
keys "$CUR" repo-advisories repo-advisories "$STANDING"
run_step
check "$c" 'first line says not compared' first_is "$UNCOMPARED"
check "$c" 'does not call the standing finding new' lacks 'GHSA-gpj5'

c='a newly failing step is named'
new_case
jobs "$BASE" 'repo-advisories|failure|Repo-level advisory check'
jobs "$CUR" 'repo-advisories|failure|Repo-level advisory check' 'allowlists|failure|Check allowlist schema'
keys "$BASE" repo-advisories repo-advisories "$STANDING"
keys "$CUR" repo-advisories repo-advisories "$STANDING"
run_step
check "$c" 'first line says something is new' first_is "$NEW"
check "$c" 'names the step' has 'failed: allowlists / Check allowlist schema'
check "$c" 'not the standing one' lacks 'Repo-level advisory check'

c='a newly failing job with no failed step is named'
new_case
jobs "$BASE" 'repo-advisories|failure|Repo-level advisory check'
jobs "$CUR" 'repo-advisories|failure|Repo-level advisory check' 'osv-scan|failure'
keys "$BASE" repo-advisories repo-advisories "$STANDING"
keys "$BASE" osv-scan osv
keys "$CUR" repo-advisories repo-advisories "$STANDING"
keys "$CUR" osv-scan osv
run_step
check "$c" 'first line says something is new' first_is "$NEW"
check "$c" 'names the job and how it ended' has 'failed: osv-scan (failure)'

# --- what cannot be compared ----------------------------------------------

c='a gate with no verdict this run is not compared'
new_case
jobs "$BASE" 'scan (caddy)|failure|Grype'
jobs "$CUR" 'scan (caddy)|failure|Grype'
keys "$BASE" scan-caddy trivy
keys "$BASE" scan-caddy grype "CVE-1${TAB}stdlib${TAB}/usr/bin/caddy"
keys "$CUR" scan-caddy trivy
none "$CUR" scan-caddy grype
run_step
check "$c" 'first line says not compared' first_is "$UNCOMPARED"
check "$c" 'names the gate' has 'not compared: `scan-caddy/grype` gave no verdict'

c='a gate with no verdict on both runs is not compared'
# Grype crashing two nights in a row: same red step, no keys either night.
new_case
jobs "$BASE" 'scan (caddy)|failure|Grype'
jobs "$CUR" 'scan (caddy)|failure|Grype'
keys "$BASE" scan-caddy trivy
none "$BASE" scan-caddy grype
keys "$CUR" scan-caddy trivy
none "$CUR" scan-caddy grype
run_step
check "$c" 'first line says not compared' first_is "$UNCOMPARED"
check "$c" 'names the gate' has 'not compared: `scan-caddy/grype` gave no verdict'

c='a gate the compared run had and this run lacks is not compared'
# Its job left no artifact; a missing verdict is not a clean one.
new_case
jobs "$BASE" 'scan (caddy)|failure|Grype'
jobs "$CUR" 'scan (caddy)|failure|Grype'
keys "$BASE" scan-caddy grype "CVE-1${TAB}stdlib${TAB}/usr/bin/caddy"
keys "$CUR" other gate
run_step
check "$c" 'first line says not compared' first_is "$UNCOMPARED"
check "$c" 'names the gate' has 'not compared: `scan-caddy/grype` gave no verdict'

c='a cancelled or skipped job is not compared'
# A timed-out or skipped job uploads nothing, on every night alike.
new_case
jobs "$BASE" 'inventory|failure|Derive inventory' 'scan|skipped'
jobs "$CUR" 'inventory|failure|Derive inventory' 'scan|skipped' 'allowlists|cancelled'
keys "$BASE" repo-advisories repo-advisories
keys "$CUR" repo-advisories repo-advisories
run_step
check "$c" 'first line says not compared, and nothing new' first_is "$UNCOMPARED"
check "$c" 'names the skipped job' has 'not compared: `scan` (skipped)'
check "$c" 'names the cancelled job' has 'not compared: `allowlists` (cancelled)'

c='the current run left no findings at all: new and partly not compared'
new_case
jobs "$BASE" 'inventory|success' 'scan (caddy)|failure|Grype'
jobs "$CUR" 'inventory|failure|Derive inventory'
keys "$BASE" scan-caddy grype "CVE-1${TAB}stdlib${TAB}/usr/bin/caddy"
run_step
check "$c" 'first line says both' first_is "$BOTH"
check "$c" 'names the failed step' has 'failed: inventory / Derive inventory'
check "$c" 'names the gate without a verdict' has 'not compared: `scan-caddy/grype` gave no verdict'

c='the compared run left no findings'
# Expired, from before #732, or all its jobs died: nothing to diff.
new_case
same_jobs
keys "$CUR" repo-advisories repo-advisories "GHSA-r799-r9gc-m956${TAB}@fastify/static"
run_step
check "$c" 'first line says not compared' first_is "$UNCOMPARED"
check "$c" 'says why' has 'left no findings'
check "$c" 'links the run it could not compare with' has "$RUNS/$BASE"

c='the compared run has expired step data'
new_case
jobs "$BASE" 'repo-advisories|failure!'
jobs "$CUR" 'repo-advisories|failure|Repo-level advisory check'
keys "$BASE" repo-advisories repo-advisories "$STANDING"
keys "$CUR" repo-advisories repo-advisories "$STANDING"
run_step
check "$c" 'first line says not compared' first_is "$UNCOMPARED"
check "$c" 'says why' has 'steps'

for side in current compared; do
  c="a failed jobs lookup ($side run) is not compared"
  new_case
  [[ "$side" == current ]] && jobs "$BASE" 'repo-advisories|failure|Repo-level advisory check'
  [[ "$side" == compared ]] && jobs "$CUR" 'repo-advisories|failure|Repo-level advisory check'
  keys "$BASE" repo-advisories repo-advisories "$STANDING"
  keys "$CUR" repo-advisories repo-advisories "$STANDING"
  run_step
  check "$c" 'first line says not compared' first_is "$UNCOMPARED"
  check "$c" 'says why' has 'jobs'
done

c='an issue that links no earlier run is not compared'
new_case
issue_body 'Raised by hand.'
same_jobs
run_step
check "$c" 'first line says not compared' first_is "$UNCOMPARED"
check "$c" 'says why' has 'links no earlier run'

for f in issue.json comments.json; do
  c="a failed read of $f is not compared"
  new_case
  same_jobs
  keys "$BASE" repo-advisories repo-advisories "$STANDING"
  keys "$CUR" repo-advisories repo-advisories "$STANDING"
  rm "$FIX/$f"
  run_step
  check "$c" 'first line says not compared' first_is "$UNCOMPARED"
  check "$c" 'says why' has 'could not read the issue'
done

c='an upload that failed on both runs is not compared'
# No artifact either night, the same red step: only the step says it.
new_case
jobs "$BASE" 'osv-scan|failure|Upload findings' 'repo-advisories|success'
jobs "$CUR" 'osv-scan|failure|Upload findings' 'repo-advisories|success'
keys "$BASE" repo-advisories repo-advisories
keys "$CUR" repo-advisories repo-advisories
run_step
check "$c" 'first line says not compared' first_is "$UNCOMPARED"
check "$c" 'names the job' has 'not compared: `osv-scan` uploaded no findings'

for run in "$CUR" "$BASE"; do
  for what in download listing; do
    c="a failed $what ($run) is not compared"
    new_case
    same_jobs
    keys "$BASE" repo-advisories repo-advisories "$STANDING"
    keys "$CUR" repo-advisories repo-advisories "$STANDING"
    : > "$FIX/$what-fails-$run"
    run_step
    check "$c" 'first line says not compared' first_is "$UNCOMPARED"
    check "$c" 'says why' has 'could not download the findings'
  done
done

# --- which run is the baseline ----------------------------------------------

# fixtures for BASE only: comparing with any other run reads as not compared.
base_only_fixtures() {
  same_jobs
  keys "$BASE" repo-advisories repo-advisories "$STANDING"
  keys "$CUR" repo-advisories repo-advisories "$STANDING"
}

c='compares with the newest run notify reported'
new_case
issue_body "- Run: $RUNS/111"
comment "$BOT" "Still red — $RUNS/222"
comment "$BOT" "Still red — $RUNS/$BASE"
comment vlzware "Looks like $RUNS/999 again"
base_only_fixtures
run_step
check "$c" 'plain Still red against the newest bot comment' [ "$BODY" == "$PLAIN" ]

c='a comparing comment counts by its own run, not the one it links'
new_case
issue_body "- Run: $RUNS/111"
comment "$BOT" "Still red, **with something new** — $RUNS/$BASE

New since the [last alert]($RUNS/111):"
base_only_fixtures
run_step
check "$c" 'plain Still red' [ "$BODY" == "$PLAIN" ]

c='a re-run compares with the run reported before it'
# Re-running keeps the run id; comparing a run with itself finds nothing.
new_case
comment "$BOT" "Still red, **not compared** — $RUNS/$CUR"
base_only_fixtures
keys "$CUR" repo-advisories repo-advisories "$STANDING" "GHSA-r799-r9gc-m956${TAB}@fastify/static"
run_step
check "$c" 'names the added finding' has 'GHSA-r799'

c='a re-run of the only reported run is not compared'
new_case
issue_body "- Run: $RUNS/$CUR"
base_only_fixtures
run_step
check "$c" 'first line says not compared' first_is "$UNCOMPARED"
check "$c" 'says why' has 'links no earlier run'

for bad in '.workflow_id = 1' '.head_branch = "feature"' '.event = "pull_request"' \
  '.head_repository.full_name = "fork/Projekt-Manager"'; do
  c="a baseline that is not a nightly of this workflow on main ($bad)"
  new_case
  run_meta "$BASE" "$bad"
  base_only_fixtures
  run_step
  check "$c" 'first line says not compared' first_is "$UNCOMPARED"
  check "$c" 'says why' has 'not a run of this workflow on main'
done

c='the newest bot comment past the first page'
new_case
issue_body "- Run: $RUNS/111"
for i in $(seq 1 104); do comment vlzware "noise $i"; done
comment "$BOT" "Still red — $RUNS/$BASE"
base_only_fixtures
run_step
check "$c" 'plain Still red' [ "$BODY" == "$PLAIN" ]

# --- what reaches the issue -------------------------------------------------

c='key text cannot leave its code span'
# Package names and paths come from scanned third-party data.
new_case
same_jobs
keys "$BASE" scan-app trivy
keys "$CUR" scan-app trivy "CVE-1${TAB}x\`[a](https://e.example) @someone${TAB}/p"
run_step
check "$c" 'backticks are stripped, the line is one code span' \
  has '- `scan-app/trivy · CVE-1 · x[a](https://e.example) @someone · /p`'

c='a long list is capped'
new_case
same_jobs
keys "$BASE" scan-app trivy
many=()
for i in $(seq 1 60); do many+=("CVE-$i${TAB}openssl${TAB}os:alpine"); done
keys "$CUR" scan-app trivy "${many[@]}"
run_step
check "$c" 'lists 50' [ "$(grep -c '^- `' <<< "$BODY")" -eq 50 ]
check "$c" 'says how many it left out' has 'and 10 more'

# post_case <label> <want> [VAR=value...] — the `post` step on an open issue.
post_case() {
  local label="$1" want="$2"
  shift 2
  new_case
  BODY=''
  run_as post EXISTING=420 WORKFLOW_NAME='Security (scheduled)' HEAD_SHA=abc "$@"
  [[ -f "$FIX/posted" ]] && BODY="$(cat "$FIX/posted")"
  check "$label" 'posted comment' [ "$BODY" == "$want" ]
}

printf 'Still red, **with something new** — %s\n\nNew since …\n' "$RUNS/$CUR" > "$TMP_ROOT/written.md"
post_case 'the compared comment is posted as written' "$(cat "$TMP_ROOT/written.md")" \
  COMPARED=true BODY_FILE="$TMP_ROOT/written.md"
post_case 'a comparison that wrote nothing is not plain Still red' \
  "$UNCOMPARED"$'\n\n'"The comparison failed; see the Notify run's log." \
  COMPARED=true BODY_FILE=''
post_case 'a workflow out of scope keeps Still red' "$PLAIN" COMPARED=false WORKFLOW_NAME=CI BODY_FILE=''
post_case 'an event-scoped workflow keeps its own comment' \
  "Also red (another merge, \`abc\`) — $RUNS/$CUR" COMPARED=false WORKFLOW_NAME='Deploy pending' BODY_FILE=''

echo ""
if [[ $FAIL -eq 0 ]]; then
  echo "OK: notify.yml ci-red comments — $PASS/$((PASS + FAIL)) checks passed"
  exit 0
fi
echo "FAILED: $FAIL of $((PASS + FAIL)) checks" >&2
exit 1
