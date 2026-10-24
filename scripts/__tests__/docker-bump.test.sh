#!/usr/bin/env bash
#
# Scenario tests for scripts/ops/docker-bump.sh.
#
# The script runs a Docker pin bump and its revert on the VPS
# (server-setup.md § Upgrading pinned versions, steps 2-3 and 5b/5c). A
# wrong order deploys on pins nobody converged to, or accepts a bump that
# lost the Postgres volume.
#
# `id`, `sudo`, `git` and `docker` are PATH stubs; deploy.sh, the converge
# and the fresh-state script are stubs in a fake repo. All log every call,
# so the cases run unprivileged and never touch the host.
#
# Exits 0 when every case matches; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/docker-bump.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/ops/docker-bump.sh"
SYSID=7699904455714574369

# One root for every sandbox: `stage` runs in a $(...) subshell.
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

# A fresh sandbox per case. Host state: $d/drift exists while the host is
# off the checked-out pins (INSYNC=1 removes it), $d/sysid is the running
# cluster, $d/head the checkout. Knobs, read by the stubs at run time:
# FAIL_CHECKOUT, FAIL_DEPLOY (fails past the drift guard), FAIL_CONVERGE,
# FAIL_FRESH, LOSE_VOLUME (the switch replaces the cluster), DB_DOWN,
# FAIL_BACKUP=<n> (the n-th backup cycle fails), DRILL_MISSING,
# FAIL_DRILL_LOAD.
stage() {
  local d
  d="$(mktemp -d -p "$TMP_ROOT")"
  mkdir -p "$d/bin" "$d/repo/scripts/ops" "$d/state"
  echo "$SYSID" >"$d/sysid"
  echo sha-old >"$d/head"
  : >"$d/drift"
  : >"$d/calls"

  cat >"$d/bin/id" <<'EOF'
#!/usr/bin/env bash
echo "${FAKE_UID:-0}"
EOF
  cat >"$d/bin/sudo" <<'EOF'
#!/usr/bin/env bash
[[ "$1" == -u && "$2" == deploy ]] || { echo "sudo stub: unexpected $*" >&2; exit 99; }
shift 2
exec "$@"
EOF
  cat >"$d/bin/git" <<'EOF'
#!/usr/bin/env bash
[[ "$1" == -C && "$3" == rev-parse ]] || { echo "git stub: unexpected $*" >&2; exit 99; }
if [[ "$4" == HEAD ]]; then cat "$STUB_DIR/head"; else echo "sha-$4"; fi
EOF
  cat >"$d/bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >>"$STUB_DIR/calls"
case "$*" in
  "exec projekt-manager-db-1 psql"*)
    [[ "${DB_DOWN:-0}" == 1 ]] && exit 1
    cat "$STUB_DIR/sysid"
    ;;
  "exec projekt-manager-backup-1 node /app/dist/server/backup-runner.js run")
    n=$(($(cat "$STUB_DIR/backups" 2>/dev/null || echo 0) + 1))
    echo "$n" >"$STUB_DIR/backups"
    [[ "${FAIL_BACKUP:-0}" != "$n" ]]
    ;;
  "exec projekt-manager-backup-1 test -s /run/drill-key/identity") [[ "${DRILL_MISSING:-0}" != 1 ]] ;;
  "exec -it projekt-manager-backup-1 load-drill-key") [[ "${FAIL_DRILL_LOAD:-0}" != 1 ]] ;;
  "inspect "*) echo "DOMAIN=pm.example.test" ;;
  *) echo "docker stub: unexpected $*" >&2; exit 99 ;;
esac
EOF
  cat >"$d/repo/scripts/deploy.sh" <<'EOF'
#!/usr/bin/env bash
echo "deploy $1" >>"$STUB_DIR/calls"
[[ "${FAIL_CHECKOUT:-0}" == 1 ]] && exit 1
case "$1" in sha-*) echo "$1" ;; *) echo "sha-$1" ;; esac >"$STUB_DIR/head"
[[ -f "$STUB_DIR/drift" ]] && { echo "ERROR: Docker host does not match the pins"; exit 1; }
[[ "${FAIL_DEPLOY:-0}" != 1 ]]
EOF
  cat >"$d/repo/scripts/ops/docker-converge.sh" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == --check ]]; then
  echo "converge check" >>"$STUB_DIR/calls"
  [[ ! -f "$STUB_DIR/drift" ]]
  exit
fi
echo "converge install $(cat "$STUB_DIR/head")" >>"$STUB_DIR/calls"
[[ "${FAIL_CONVERGE:-0}" == 1 ]] && exit 100
rm -f "$STUB_DIR/drift"
[[ "${LOSE_VOLUME:-0}" == 1 ]] && echo 1111 >"$STUB_DIR/sysid"
exit 0
EOF
  cat >"$d/repo/scripts/ops/docker-fresh-state.sh" <<'EOF'
#!/usr/bin/env bash
echo "fresh-state $(cat "$STUB_DIR/head")" >>"$STUB_DIR/calls"
[[ "${FAIL_FRESH:-0}" == 1 ]] && exit 1
rm -f "$STUB_DIR/drift"
exit 0
EOF
  chmod +x "$d/bin/"* "$d/repo/scripts/deploy.sh" "$d/repo/scripts/ops/"*
  [[ "${INSYNC:-0}" == 1 ]] && rm -f "$d/drift"
  [[ -z "${RECORDED:-}" ]] || echo "$RECORDED" >"$d/state/sysid"
  echo "$d"
}

# run <dir> [args...] — sets $rc and $out.
run() {
  local d="$1"
  shift
  out="$(PATH="$d/bin:$PATH" STUB_DIR="$d" DOCKER_BUMP_REPO_DIR="$d/repo" \
    DOCKER_BUMP_STATE_FILE="$d/state/sysid" bash "$SCRIPT" "$@" 2>&1 </dev/null)"
  rc=$?
}

pass=0
fail=0
failures=()

ok() {
  pass=$((pass + 1))
  echo "  PASS — $1"
}
ko() {
  fail=$((fail + 1))
  failures+=("$1")
  echo "  FAIL — $1"
  [[ -n "${out:-}" ]] && sed 's/^/      | /' <<<"$out"
  sed 's/^/      calls: /' "$d/calls"
}
check() {
  local label="$1"
  shift
  if "$@"; then ok "$label"; else ko "$label"; fi
}
expect_rc() {
  local want="$1" label="$2"
  if [[ "$rc" == "$want" ]]; then ok "$label (exit $rc)"; else ko "$label (expected exit $want, got $rc)"; fi
}
called() { grep -qxF -- "$1" "$d/calls"; }
not_called() { ! grep -qF -- "$1" "$d/calls"; }
says() { grep -qF -- "$1" <<<"$out"; }
line_of() { grep -nxF -m1 -- "$1" "$d/calls" | cut -d: -f1; }
before() {
  local a b
  a="$(line_of "$1")"
  b="$(line_of "$2")"
  [[ -n "$a" && -n "$b" && "$a" -lt "$b" ]]
}
backups() { cat "$d/backups" 2>/dev/null || echo 0; }

REF=origin/renovate/docker-host
PSQL="docker exec projekt-manager-db-1 psql -U pm -d projekt_manager -tAc SELECT system_identifier FROM pg_control_system()"
BACKUP_RUN="docker exec projekt-manager-backup-1 node /app/dist/server/backup-runner.js run"

echo "Case: not root"
d="$(stage)"
FAKE_UID=1000 run "$d" test "$REF"
expect_rc 2 "refuses"
check "nothing called" bash -c "[[ ! -s '$d/calls' ]]"

for args in "" "test" "test a b" "revert --bogus" "revert --fresh-state x" "bogus"; do
  echo "Case: usage '$args'"
  d="$(stage)"
  # shellcheck disable=SC2086  # split the argument list on purpose
  run "$d" $args
  expect_rc 2 "usage error"
  check "nothing called" bash -c "[[ ! -s '$d/calls' ]]"
done

echo "Case: test, happy path"
d="$(stage)"
run "$d" test "$REF"
expect_rc 0 "accepted"
check "identifier read before the restore point" before "$PSQL" "$BACKUP_RUN"
check "restore point before the first deploy" before "$BACKUP_RUN" "deploy $REF"
check "first deploy, then converge to the ref's pins" before "deploy $REF" "converge install sha-$REF"
check "second deploy pins the checked-out SHA" before "converge install sha-$REF" "deploy sha-$REF"
check "two backup cycles" [ "$(backups)" == 2 ]
check "identifier recorded" [ "$(cat "$d/state/sysid")" == "$SYSID" ]
check "says PASS" says "PASS: acceptance 1-3 at sha-$REF"
check "prints the merge check" says "git diff --quiet sha-$REF $REF -- docker/host-versions.txt"
check "prints the WireGuard check with the domain" says "curl -fsS https://pm.example.test/api/health"

echo "Case: test, recorded identifier matches"
d="$(RECORDED=$SYSID stage)"
run "$d" test "$REF"
expect_rc 0 "accepted"
check "record unchanged" [ "$(cat "$d/state/sysid")" == "$SYSID" ]

echo "Case: test, running cluster is not the recorded one"
d="$(RECORDED=4242 stage)"
run "$d" test "$REF"
expect_rc 1 "refuses"
check "no backup, no deploy" bash -c "! grep -qE 'backup-runner|^deploy' '$d/calls'"
check "says how to reset the record" says "sudo rm $d/state/sysid"
check "record kept" [ "$(cat "$d/state/sysid")" == 4242 ]

echo "Case: test, database down"
d="$(stage)"
DB_DOWN=1 run "$d" test "$REF"
expect_rc 1 "refuses"
check "no deploy" not_called "deploy "
check "nothing recorded" [ ! -e "$d/state/sysid" ]

echo "Case: test, restore-point backup fails"
d="$(stage)"
FAIL_BACKUP=1 run "$d" test "$REF"
expect_rc 1 "refuses"
check "no deploy" not_called "deploy "
check "says nothing changed" says "nothing changed"

echo "Case: test, checkout fails"
d="$(stage)"
FAIL_CHECKOUT=1 run "$d" test "$REF"
expect_rc 1 "fails"
check "no converge" not_called "converge install"
check "names the checkout" says "did not check out $REF"

echo "Case: test, first deploy fails past the drift guard"
d="$(INSYNC=1 stage)"
FAIL_DEPLOY=1 run "$d" test "$REF"
expect_rc 1 "fails"
check "no converge" not_called "converge install"
check "names it" says "not at the drift guard"

echo "Case: test, host already on the ref's pins"
d="$(INSYNC=1 stage)"
run "$d" test "$REF"
expect_rc 0 "accepted"
check "one deploy" [ "$(grep -c '^deploy' "$d/calls")" == 1 ]
check "no converge" not_called "converge install"
check "says so" says "already on the pins"
check "backup after the deploy" [ "$(backups)" == 2 ]

echo "Case: test, converge fails"
d="$(stage)"
FAIL_CONVERGE=1 run "$d" test "$REF"
expect_rc 1 "fails"
check "no second deploy" not_called "deploy sha-"
check "points to the revert" says "Next: revert, step 5"

echo "Case: test, second deploy fails"
d="$(stage)"
FAIL_DEPLOY=1 run "$d" test "$REF"
expect_rc 1 "fails"
check "no backup after it" [ "$(backups)" == 1 ]
check "names the deploy" says "FAIL: deploy.sh sha-$REF"

echo "Case: test, drill key missing, pasted now"
d="$(stage)"
DRILL_MISSING=1 run "$d" test "$REF"
expect_rc 0 "accepted"
check "asked for the paste" called "docker exec -it projekt-manager-backup-1 load-drill-key"

echo "Case: test, drill key paste fails"
d="$(stage)"
DRILL_MISSING=1 FAIL_DRILL_LOAD=1 run "$d" test "$REF"
expect_rc 1 "fails"
check "no backup after it" [ "$(backups)" == 1 ]

echo "Case: test, backup after the switch fails"
d="$(stage)"
FAIL_BACKUP=2 run "$d" test "$REF"
expect_rc 1 "fails"
check "names it" says "FAIL: backup cycle after the switch"

echo "Case: test, the switch replaced the cluster"
d="$(stage)"
LOSE_VOLUME=1 run "$d" test "$REF"
expect_rc 1 "fails"
check "names both identifiers" says "system_identifier is 1111, recorded $SYSID"
check "points to the restore" says "step 5d"

echo "Case: revert, happy path"
d="$(RECORDED=$SYSID stage)"
run "$d" revert
expect_rc 0 "accepted"
check "deploys before anything else" bash -c "head -n1 '$d/calls' | grep -qx 'deploy origin/main'"
check "converges to main's pins" before "deploy origin/main" "converge install sha-origin/main"
check "second deploy pins main's SHA" before "converge install sha-origin/main" "deploy sha-origin/main"
check "one backup cycle" [ "$(backups)" == 1 ]
check "says close the PR" says "Close the PR after the schedule window"

echo "Case: revert, no recorded identifier"
d="$(stage)"
run "$d" revert
expect_rc 0 "accepted"
check "warns check 3 skipped" says "check 3 skipped"
check "records nothing" [ ! -e "$d/state/sysid" ]

echo "Case: revert --fresh-state"
d="$(RECORDED=$SYSID stage)"
run "$d" revert --fresh-state
expect_rc 0 "accepted"
check "fresh state on main's pins" before "deploy origin/main" "fresh-state sha-origin/main"
check "no converge" not_called "converge install"
check "then deploy" before "fresh-state sha-origin/main" "deploy sha-origin/main"
check "points to the old state" says "rm -rf line"

echo "Case: revert, converge fails"
d="$(RECORDED=$SYSID stage)"
FAIL_CONVERGE=1 run "$d" revert
expect_rc 1 "fails"
check "points to 5c" says "Next: step 5c, or 5d"

echo "Case: revert --fresh-state fails"
d="$(RECORDED=$SYSID stage)"
FAIL_FRESH=1 run "$d" revert --fresh-state
expect_rc 1 "fails"
check "no deploy after it" not_called "deploy sha-"
check "points to 5d" says "step 5d"

echo "Case: revert, the cluster changed"
d="$(RECORDED=4242 stage)"
run "$d" revert
expect_rc 1 "fails"
check "points to the restore" says "step 5d"

echo
echo "Result: $pass passed, $fail failed"
if ((fail > 0)); then
  printf '  - %s\n' "${failures[@]}"
  exit 1
fi
