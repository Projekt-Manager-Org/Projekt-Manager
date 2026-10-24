#!/usr/bin/env bash
#
# Scenario tests for scripts/ops/docker-fresh-state.sh.
#
# The script is the revert of last resort before a restore from backup
# (server-setup.md § Upgrading pinned versions, step 5c). It moves Docker's
# state aside, so a wrong order or a wrong path loses the Postgres volume
# or starts older binaries on state newer ones wrote.
#
# `id`, `systemctl`, `docker`, `df`, `sleep` and the converge script are
# PATH/env stubs that log every call; DOCKER_ROOT and CONTAINERD_ROOT point
# into a temp dir, so the cases run unprivileged and never touch the host.
#
# Exits 0 when every case matches; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/docker-fresh-state.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/ops/docker-fresh-state.sh"

# One root for every sandbox: `stage` runs in a $(...) subshell, so it
# cannot register its dir with the parent. u+w first: a case makes a
# sandbox dir read-only.
TMP_ROOT="$(mktemp -d)"
trap 'chmod -R u+w "$TMP_ROOT"; rm -rf "$TMP_ROOT"' EXIT

# A fresh sandbox per case: a Docker root with a volume holding data and the
# entries an Engine keeps next to it, a containerd root, a call log, stubs.
# The daemon counts as up once `systemctl start` ran ($d/up exists).
# FAIL_STOP / FAIL_START make systemctl fail; SHIMS=1 makes pgrep find
# container processes that survived the stop.
stage() {
  local d
  d="$(mktemp -d -p "$TMP_ROOT")"
  mkdir -p "$d/bin" "$d/docker/volumes/projekt-manager_pgdata/_data" \
    "$d/docker/image" "$d/docker/network" "$d/containerd/io.containerd.metadata.v1.bolt"
  echo "PG_VERSION 17" >"$d/docker/volumes/projekt-manager_pgdata/_data/PG_VERSION"
  : >"$d/docker/volumes/metadata.db"
  : >"$d/docker/engine-id"
  : >"$d/calls"

  cat >"$d/bin/id" <<EOF
#!/usr/bin/env bash
echo "\${FAKE_UID:-0}"
EOF
  cat >"$d/bin/systemctl" <<EOF
#!/usr/bin/env bash
echo "systemctl \$*" >>"$d/calls"
[[ "\$1" == stop && "\${FAIL_STOP:-0}" == 1 ]] && exit 5
[[ "\$1" == start && "\${FAIL_START:-0}" == 1 ]] && exit 5
[[ "\$1" == start && "\${NEVER_UP:-0}" != 1 ]] && : >"$d/up"
exit 0
EOF
  cat >"$d/bin/docker" <<EOF
#!/usr/bin/env bash
echo "docker \$*" >>"$d/calls"
[[ -f "$d/up" ]]
EOF
  printf '#!/usr/bin/env bash\necho "df $*" >>"%s/calls"\n' "$d" >"$d/bin/df"
  printf '#!/usr/bin/env bash\necho "pgrep $*" >>"%s/calls"\n[[ "${SHIMS:-0}" == 1 ]] || exit 1\necho "4242 containerd-shim"\n' "$d" >"$d/bin/pgrep"
  printf '#!/usr/bin/env bash\nexit 0\n' >"$d/bin/sleep"

  # The converge stub logs its mode, what the Docker root held and whether
  # a daemon was up at that moment; FAIL_PACKAGES / FAIL_CHECK make it fail.
  cat >"$d/converge" <<EOF
#!/usr/bin/env bash
up=down; [[ -f "$d/up" ]] && up=up
echo "converge \$* root=[\$(ls -A "$d/docker" | tr '\n' ' ')] daemon=\$up" >>"$d/calls"
[[ "\$1" == --packages-only && "\${FAIL_PACKAGES:-0}" == 1 ]] && exit 100
[[ "\$1" == --check && "\${FAIL_CHECK:-0}" == 1 ]] && { echo "  image store: have overlay2"; exit 1; }
exit 0
EOF
  chmod +x "$d/bin/"* "$d/converge"
  echo "$d"
}

# run <dir> <stdin> [args...] — sets $rc and $out.
run() {
  local d="$1" input="$2"
  shift 2
  out="$(printf '%s' "$input" | PATH="$d/bin:$PATH" DOCKER_CONVERGE="$d/converge" \
    DOCKER_ROOT="$d/docker" CONTAINERD_ROOT="$d/containerd" \
    DOCKER_DAEMON_JSON="$d/daemon.json" DOCKER_START_ATTEMPTS=3 \
    bash "$SCRIPT" "$@" 2>&1)"
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
untouched() {
  [[ -d "$d/docker/image" && -d "$d/containerd" ]] && ! compgen -G "$d/*.pre-revert-*" >/dev/null
}
volume_kept() { [[ "$(cat "$d/docker/volumes/projekt-manager_pgdata/_data/PG_VERSION")" == "PG_VERSION 17" ]]; }
line_of() { grep -n -m1 -- "$1" "$d/calls" | cut -d: -f1; }
before() {
  local a b
  a="$(line_of "$1")"
  b="$(line_of "$2")"
  [[ -n "$a" && -n "$b" && "$a" -lt "$b" ]]
}

echo "Case: not root"
d="$(stage)"
FAKE_UID=1000 run "$d" "y"
expect_rc 2 "refuses"
check "nothing stopped" bash -c "! grep -q '^systemctl' '$d/calls'"
check "nothing moved" untouched

echo "Case: unexpected argument"
d="$(stage)"
run "$d" "y" --yes
expect_rc 2 "usage error"
check "nothing moved" untouched

echo "Case: operator declines"
d="$(stage)"
run "$d" "n"
expect_rc 1 "aborts"
check "nothing stopped" bash -c "! grep -q '^systemctl' '$d/calls'"
check "nothing moved" untouched
check "shows disk headroom first" grep -q '^df -i' "$d/calls"
check "shows the pins against the host first" grep -q '^converge --check' "$d/calls"

echo "Case: no answer (stdin closed)"
d="$(stage)"
run "$d" ""
expect_rc 1 "aborts"
check "nothing moved" untouched

echo "Case: fresh state"
d="$(stage)"
run "$d" "y"
expect_rc 0 "succeeds"
check "volume data stays in place" volume_kept
check "volumes metadata stays in place" test -f "$d/docker/volumes/metadata.db"
check "Docker root holds only volumes/" test "$(ls -A "$d/docker")" == volumes
old_docker="$(compgen -G "$d/docker.pre-revert-*")"
check "other Docker state moved aside" test -d "$old_docker/image" -a -d "$old_docker/network" -a -f "$old_docker/engine-id"
check "containerd state moved aside" bash -c "[[ ! -e '$d/containerd' ]] && compgen -G '$d/containerd.pre-revert-*/io.containerd.metadata.v1.bolt' >/dev/null"
check "Docker stopped before the pins install" before '^systemctl stop' '^converge --packages-only'
check "stops the socket too (no re-activation)" grep -q '^systemctl stop docker.socket' "$d/calls"
check "looks for surviving containers before moving" before '^pgrep ' '^converge --packages-only'
check "matches shims by process name, not command line" bash -c "! grep -q '^pgrep .*-f' '$d/calls'"
check "starts without blocking (Type=notify, no timeout)" grep -q '^systemctl start --no-block' "$d/calls"
check "pins installed on the moved-aside state, no daemon up" grep -q '^converge --packages-only root=\[volumes \] daemon=down' "$d/calls"
check "started only after the pins install" before '^converge --packages-only' '^systemctl start'
check "checks the store once the daemon runs" grep -q '^converge --check .* daemon=up' "$d/calls"
check "names the old state to delete after acceptance" grep -q "rm -rf $old_docker" <<<"$out"

echo "Case: Docker root is a symlink"
# find does not descend into a symlinked start point: unresolved, nothing
# would move and the old daemon state would stay in use.
d="$(stage)"
mv "$d/docker" "$d/real-docker"
ln -s "$d/real-docker" "$d/docker"
run "$d" "y"
expect_rc 0 "succeeds"
check "target holds only volumes/" test "$(ls -A "$d/real-docker")" == volumes
check "volume data stays in place" test -f "$d/real-docker/volumes/projekt-manager_pgdata/_data/PG_VERSION"
check "old state sits next to the target" bash -c "compgen -G '$d/real-docker.pre-revert-*/image' >/dev/null"

echo "Case: daemon.json relocates the data root"
d="$(stage)"
echo '{ "data-root": "/srv/docker" }' >"$d/daemon.json"
run "$d" "y"
expect_rc 1 "refuses"
check "nothing stopped" bash -c "! grep -q '^systemctl' '$d/calls'"
check "nothing moved" untouched

echo "Case: container processes survive the stop"
# A crashed dockerd leaves containers running under their shims; going on
# would let a second Postgres open the same volume.
d="$(stage)"
SHIMS=1 run "$d" "y"
expect_rc 1 "refuses"
check "nothing moved" untouched
check "names the processes" grep -q '4242 containerd-shim' <<<"$out"
check "says to reboot" grep -q 'Reboot the host' <<<"$out"

echo "Case: stopping Docker fails"
d="$(stage)"
FAIL_STOP=1 run "$d" "y"
if [[ "$rc" != 0 ]]; then ok "fails (exit $rc)"; else ko "reported success"; fi
check "nothing moved" untouched
check "says where things stand" grep -q 'Docker is stopped' <<<"$out"

echo "Case: a move fails midway"
d="$(stage)"
chmod a-w "$d/docker"
run "$d" "y"
chmod u+w "$d/docker"
if [[ "$rc" != 0 ]]; then ok "fails (exit $rc)"; else ko "reported success"; fi
check "volume data stays in place" volume_kept
check "says where things stand" grep -q 'moved so far' <<<"$out"
check "pins not installed" bash -c "! grep -q '^converge --packages-only' '$d/calls'"
check "Docker not started" bash -c "! grep -q '^systemctl start' '$d/calls'"

echo "Case: starting Docker fails"
d="$(stage)"
FAIL_START=1 run "$d" "y"
if [[ "$rc" != 0 ]]; then ok "fails (exit $rc)"; else ko "reported success"; fi
check "not silent" grep -q 'error:' <<<"$out"

echo "Case: no containerd root"
d="$(stage)"
rm -rf "$d/containerd"
run "$d" "y"
expect_rc 0 "succeeds"
check "volume data stays in place" volume_kept

echo "Case: installing the pins fails"
d="$(stage)"
FAIL_PACKAGES=1 run "$d" "y"
expect_rc 1 "fails"
check "Docker not started" bash -c "! grep -q '^systemctl start' '$d/calls'"
check "old state kept" bash -c "compgen -G '$d/docker.pre-revert-*/image' >/dev/null"
check "volume data stays in place" volume_kept

echo "Case: the daemon does not come up"
d="$(stage)"
NEVER_UP=1 run "$d" "y"
expect_rc 1 "fails"
check "no store check without a daemon" bash -c "! grep -q '^converge --check .* daemon=up' '$d/calls'"
check "points to the daemon log" grep -q 'journalctl -u docker.service' <<<"$out"

echo "Case: fresh state not in sync with the pins"
d="$(stage)"
FAIL_CHECK=1 run "$d" "y"
expect_rc 1 "fails"
check "passes the converge report through" grep -q 'image store: have overlay2' <<<"$out"
check "old state kept" bash -c "compgen -G '$d/docker.pre-revert-*/image' >/dev/null"

echo
echo "Result: $pass passed, $fail failed"
if [[ $fail -gt 0 ]]; then
  printf '  - %s\n' "${failures[@]}"
  exit 1
fi
