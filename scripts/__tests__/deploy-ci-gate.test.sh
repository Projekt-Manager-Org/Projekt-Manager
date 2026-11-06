#!/usr/bin/env bash
#
# Scenario tests for scripts/ops/deploy-ci-gate.sh, the check deploy.sh runs
# on the target commit, and for deploy.sh's handling of the override flag.
#
# `curl` and `logger` are PATH stubs. curl answers from the case's fixture
# directory and fails on any other URL, like an unreachable API; logger writes
# to a file. `jq` is real.
#   runs.json    GET .../actions/workflows/ci.yml/runs for this commit, main, push
#   issues.json  GET .../issues, open and labelled ci-red
#
# Usage:
#   bash scripts/__tests__/deploy-ci-gate.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GATE="$REPO_ROOT/scripts/ops/deploy-ci-gate.sh"
DEPLOY="$REPO_ROOT/scripts/deploy.sh"

if ! command -v jq > /dev/null 2>&1; then
  echo "ERROR: jq is required." >&2
  exit 2
fi

TMP_ROOT="$(mktemp -d)"
# shellcheck disable=SC2317  # invoked via `trap cleanup EXIT`
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

API='https://api.github.com/repos/Projekt-Manager-Org/Projekt-Manager'
SHA='abc123abc123abc123abc123abc123abc123abc1'

mkdir -p "$TMP_ROOT/bin"
cat > "$TMP_ROOT/bin/curl" <<STUB
#!/usr/bin/env bash
url="\${*: -1}"
case "\$url" in
  "$API/actions/workflows/ci.yml/runs?event=push&branch=main&head_sha=$SHA&per_page=1") f=runs.json ;;
  "$API/issues?state=open&labels=ci-red&per_page=100") f=issues.json ;;
  *) exit 22 ;;
esac
[[ -f "\$FIX/\$f" ]] && cat "\$FIX/\$f" || exit 22
STUB
cat > "$TMP_ROOT/bin/logger" <<'STUB'
#!/usr/bin/env bash
[[ -z "${LOGGER_FAILS:-}" ]] || exit 1
echo "$*" >> "$FIX/logged"
STUB
chmod +x "$TMP_ROOT/bin/curl" "$TMP_ROOT/bin/logger"

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
    printf '  FAIL — %s\n%s\n' "$2" "$3" | sed '3,$s/^/    /'
  fi
}

# A fresh fixture holding a run of this commit, or `none` for no run at all.
# <status> <conclusion>
fresh() {
  FIX="$(mktemp -d "$TMP_ROOT/case.XXXXXX")"
  export FIX
  echo '[]' > "$FIX/issues.json"
  if [[ "$1" == none ]]; then
    echo '{"total_count": 0, "workflow_runs": []}' > "$FIX/runs.json"
  else
    jq -n --arg status "$1" --arg conclusion "${2:-}" --arg sha "$SHA" '{total_count: 1, workflow_runs: [{
      status: $status, conclusion: (if $conclusion == "" then null else $conclusion end),
      head_sha: $sha, head_branch: "main", event: "push", html_url: "https://runs/7"}]}' > "$FIX/runs.json"
  fi
}

# gate <expected-exit> <label> <args...>: also leaves the output in $FIX/out.
gate() {
  local expected="$1" label="$2" actual=0
  shift 2
  PATH="$TMP_ROOT/bin:$PATH" bash "$GATE" "$SHA" "$@" > "$FIX/out" 2>&1 || actual=$?
  if [[ "$actual" == "$expected" ]]; then
    record yes "$label" ""
  else
    record no "$label" "expected exit $expected, got $actual: $(cat "$FIX/out")"
  fi
}

says() { # <label> <text>
  if grep -qF -- "$2" "$FIX/out"; then
    record yes "$1" ""
  else
    record no "$1" "no '$2' in: $(cat "$FIX/out")"
  fi
}

logged() { # <label> <text>
  if [[ -f "$FIX/logged" ]] && grep -qF -- "$2" "$FIX/logged"; then
    record yes "$1" ""
  else
    record no "$1" "not logged: '$2'"
  fi
}

not_logged() { # <label>
  [[ ! -e "$FIX/logged" ]] && record yes "$1" "" || record no "$1" "$(cat "$FIX/logged")"
}

echo "Case: a green push run"
fresh completed success
gate 0 "proceeds"
not_logged "nothing to log"

echo "Case: a push run that is not green is refused"
for how in failure cancelled timed_out skipped; do
  fresh completed "$how"
  gate 1 "$how"
  says "$how: names the run" 'https://runs/7'
  says "$how: names the override" '--accept-red-ci'
done
fresh in_progress
gate 1 "still running"
says "says it has not finished" 'has not finished'
fresh none
gate 1 "no push run, as for a feature branch or an evicted run"
says "says there is none" 'no push run'

echo "Case: the API does not answer"
fresh completed success
rm "$FIX/runs.json"
gate 1 "unreachable is refused"
says "says it could not check" 'could not read'
fresh completed success
echo 'not json' > "$FIX/runs.json"
gate 1 "not JSON is refused"
fresh completed success
echo '{"message": "API rate limit exceeded"}' > "$FIX/runs.json"
gate 1 "an unexpected shape is refused"

echo "Case: a run that is not this commit's push run on main does not count"
for field in 'head_sha:"other"' 'head_branch:"feature"' 'event:"workflow_dispatch"'; do
  fresh completed success
  jq --arg f "${field%%:*}" --argjson v "${field#*:}" '.workflow_runs[0][$f] = $v' "$FIX/runs.json" > "$FIX/runs.tmp"
  mv "$FIX/runs.tmp" "$FIX/runs.json"
  gate 1 "another ${field%%:*}"
done

echo "Case: the override"
fresh completed failure
gate 0 "a red run proceeds" 'hotfix, see #1'
logged "the reason is logged" 'hotfix, see #1'
logged "the commit is logged" "$SHA"
logged "what it overrode is logged" 'failure'
says "says so loudly" 'OVERRIDE'
fresh none
gate 0 "no run proceeds" 'feature branch'
logged "logged" 'feature branch'
fresh completed success
rm "$FIX/runs.json"
gate 0 "an unreachable API proceeds" 'github is down'
logged "logged" 'github is down'
fresh completed success
gate 0 "a green run needs no override" 'unused reason'
not_logged "nothing overridden, nothing logged"
fresh completed failure
LOGGER_FAILS=1 gate 1 "an override that cannot be logged is refused" 'reason'
says "says why" 'could not log'

echo "Case: open ci-red issues warn and never block"
fresh completed success
jq -n '[{title: "Inventory scan is red on main", html_url: "https://issues/3"}]' > "$FIX/issues.json"
gate 0 "a red nightly proceeds"
says "names it" 'Inventory scan is red on main'
says "links it" 'https://issues/3'
fresh completed success
rm "$FIX/issues.json"
gate 0 "an unreadable list proceeds"
says "says it could not read it" 'could not read the open ci-red issues'
fresh completed failure
jq -n '[{title: "Inventory scan is red on main", html_url: "https://issues/3"}]' > "$FIX/issues.json"
gate 1 "a refused deploy still warns"
says "names it" 'Inventory scan is red on main'

echo "Case: usage"
fresh completed success
actual=0
PATH="$TMP_ROOT/bin:$PATH" bash "$GATE" > "$FIX/out" 2>&1 || actual=$?
[[ "$actual" == 2 ]] && record yes "no commit" "" || record no "no commit" "got $actual"

echo "Case: deploy.sh refuses bad flags before touching anything"
for args in '--accept-red-ci' '--accept-red-ci=' '--unknown' 'origin/a origin/b'; do
  # shellcheck disable=SC2086  # word splitting wanted: the case's arguments
  out="$(DEPLOY_REEXEC=0 bash "$DEPLOY" $args 2>&1)"
  rc=$?
  if [[ "$rc" == 2 ]] && grep -q 'usage' <<< "$out"; then
    record yes "'$args'" ""
  else
    record no "'$args'" "exit $rc: $out"
  fi
done
out="$(bash "$DEPLOY" --accept-red-ci '' 2>&1)"
rc=$?
[[ "$rc" == 2 ]] && record yes "an empty reason" "" || record no "an empty reason" "exit $rc: $out"

echo "Case: deploy.sh runs the gate before the checkout"
# A real clone; the gate is a stub, and a failing converge stops Phase 2 right
# after the re-exec, before anything needs a host.
g() { git -c user.name=t -c user.email=t@example.test "$@"; }
origin="$TMP_ROOT/origin"
g init -q -b main "$origin"
mkdir -p "$origin/scripts/ops"
cat > "$origin/scripts/ops/deploy-ci-gate.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$#" "$@" > "$GATE_LOG"
exit "${GATE_RC:-0}"
STUB
cat > "$origin/scripts/ops/docker-converge.sh" <<'STUB'
#!/usr/bin/env bash
echo ran > "$CONVERGE_LOG"
exit 1
STUB
chmod +x "$origin/scripts/ops/"*.sh
g -C "$origin" add -A
g -C "$origin" commit -qm old
old="$(git -C "$origin" rev-parse HEAD)"
g -C "$origin" commit -qm target --allow-empty
target="$(git -C "$origin" rev-parse HEAD)"

# run_deploy <gate rc> <args...>: leaves the clone in $clone.
run_deploy() {
  local rc="$1"
  shift
  clone="$(mktemp -d "$TMP_ROOT/clone.XXXXXX")"
  git clone -q "$origin" "$clone"
  git -C "$clone" checkout -q "$old"
  GATE_LOG="$clone/gate.log" CONVERGE_LOG="$clone/converge.log" GATE_RC="$rc" \
    DEPLOY_REPO_DIR="$clone" DEPLOY_REEXEC=0 bash "$DEPLOY" "$@" > "$clone/out" 2>&1
  deploy_rc=$?
}
run_deploy 1 "$target"
[[ "$(git -C "$clone" rev-parse HEAD)" == "$old" ]] && record yes "a refusal leaves the tree alone" "" \
  || record no "a refusal leaves the tree alone" "HEAD moved"
[[ "$deploy_rc" == 1 && ! -e "$clone/converge.log" ]] && record yes "a refusal stops the deploy" "" \
  || record no "a refusal stops the deploy" "exit $deploy_rc: $(cat "$clone/out")"
run_deploy 0 "$target"
[[ "$(sed -n 2p "$clone/gate.log")" == "$target" ]] && record yes "the gate gets the resolved commit" "" \
  || record no "the gate gets the resolved commit" "$(cat "$clone/gate.log")"
[[ "$(git -C "$clone" rev-parse HEAD)" == "$target" && -e "$clone/converge.log" ]] \
  && record yes "a pass checks out and carries on in the target's script" "" \
  || record no "a pass checks out and carries on in the target's script" "$(cat "$clone/out")"
run_deploy 0 --accept-red-ci 'a reason with spaces' "$target"
[[ "$(sed -n 1p "$clone/gate.log")" == 2 && "$(sed -n 3p "$clone/gate.log")" == 'a reason with spaces' ]] \
  && record yes "the reason reaches the gate as one argument" "" \
  || record no "the reason reaches the gate as one argument" "$(cat "$clone/gate.log")"
[[ "$(git -C "$clone" rev-parse HEAD)" == "$target" ]] && record yes "the flag survives the re-exec" "" \
  || record no "the flag survives the re-exec" "$(cat "$clone/out")"

echo
echo "Result: $pass passed, $fail failed"
if ((fail > 0)); then
  printf '  - %s\n' "${failures[@]}"
  exit 1
fi
