#!/usr/bin/env bash
#
# Scenario tests for scripts/ops/docker-converge.sh.
#
# The script is the single path by which a host (dev workstation, VPS)
# reaches the Docker package set pinned in docker/host-versions.txt
# (ADR-0009), on the containerd image store. Its `--check` mode is also the
# deploy.sh drift guard, so a check that wrongly reports "in sync" lets a
# drifted host deploy silently.
#
# `dpkg-query`, `apt-get`, `apt-mark` and `docker` are replaced by PATH
# stubs that read/write a fake package database and daemon state in a temp
# dir and log every call, so the cases run unprivileged and never touch the
# real host.
#
# Exits 0 when every case matches; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/docker-converge.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/ops/docker-converge.sh"
REAL_PINS="$REPO_ROOT/docker/host-versions.txt"

PKGS=(docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin)

# Real apt version shape (epoch, tilde), so a too-strict pin parser fails here.
PIN="5:1.0-1~ubuntu.24.04~noble"
OLDER="5:0.9-1~ubuntu.24.04~noble"
NEWER="5:2.0-1~ubuntu.24.04~noble"

TMP_DIRS=()
# shellcheck disable=SC2317  # invoked via `trap cleanup EXIT`
cleanup() {
  local d
  for d in "${TMP_DIRS[@]:-}"; do
    [[ -n "${d:-}" && -d "$d" ]] && rm -rf "$d"
  done
}
trap cleanup EXIT

# A fresh sandbox per case: pins file, fake dpkg database, daemon state,
# call log, stubs. Every package starts installed at $PIN and pinned at
# $PIN; the daemon runs the containerd image store. The pins file
# carries a comment and a blank line, so every passing case also proves
# those are accepted.
stage() {
  local d p
  d="$(mktemp -d)"
  TMP_DIRS+=("$d")
  mkdir -p "$d/bin" "$d/db"
  : >"$d/calls"
  printf '# header comment\n\n' >"$d/pins"
  for p in "${PKGS[@]}"; do
    echo "$p=$PIN" >>"$d/pins"
    printf 'installed %s' "$PIN" >"$d/db/$p"
  done

  # dpkg-query -W -f='${db:Status-Status} ${Version}' <pkg>
  cat >"$d/bin/dpkg-query" <<EOF
#!/usr/bin/env bash
echo "dpkg-query \$*" >>"$d/calls"
pkg="\${!#}"
[[ -f "$d/db/\$pkg" ]] || { echo "dpkg-query: no packages found matching \$pkg" >&2; exit 1; }
cat "$d/db/\$pkg"
EOF

  # apt-get install writes the requested versions into the fake db,
  # unless the case set APPLY=0 (an install that silently changes nothing)
  # or FAIL_INSTALL=1 (apt exits non-zero).
  cat >"$d/bin/apt-get" <<EOF
#!/usr/bin/env bash
echo "apt-get \$*" >>"$d/calls"
if [[ " \$* " == *" install "* ]]; then
  [[ "\${FAIL_INSTALL:-0}" == 1 ]] && exit 100
  [[ "\${APPLY:-1}" == 1 ]] || exit 0
  for arg in "\$@"; do
    [[ "\$arg" == *=* && "\$arg" != -* ]] || continue
    printf 'installed %s' "\${arg#*=}" >"$d/db/\${arg%%=*}"
  done
fi
exit 0
EOF

  cat >"$d/bin/apt-mark" <<EOF
#!/usr/bin/env bash
echo "apt-mark \$*" >>"$d/calls"
EOF

  # docker info --format '{{json .DriverStatus}}' prints the store; a
  # missing state file stands for an unreachable daemon.
  printf '[["driver-type","io.containerd.snapshotter.v1"]]' >"$d/driver-status"
  cat >"$d/bin/docker" <<EOF
#!/usr/bin/env bash
echo "docker \$*" >>"$d/calls"
[[ -f "$d/driver-status" ]] || { echo "Cannot connect to the Docker daemon" >&2; exit 1; }
cat "$d/driver-status"
EOF

  chmod +x "$d/bin/"*
  echo "$d"
}

# run <dir> [args...] — runs the script inside the sandbox; sets $rc, $out.
run() {
  local d="$1"
  shift
  out="$(PATH="$d/bin:$PATH" DOCKER_PINS_FILE="$d/pins" \
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
expect_rc() {
  local want="$1" label="$2"
  if [[ "$rc" == "$want" ]]; then ok "$label (exit $rc)"; else ko "$label (expected exit $want, got $rc)"; fi
}

echo "Case: --check, host matches the pins"
d="$(stage)"
run "$d" --check
expect_rc 0 "in sync passes"
if grep -qE '^apt-(get|mark) ' "$d/calls"; then ko "check mode must not call apt"; else ok "no apt calls in check mode"; fi

echo "Case: --check, one package at a different version"
d="$(stage)"
printf 'installed %s' "$OLDER" >"$d/db/docker-compose-plugin"
run "$d" --check
expect_rc 1 "version drift fails"
if grep -F 'docker-compose-plugin' <<<"$out" | grep -F "$OLDER" | grep -qF "$PIN"; then
  ok "names the package, installed and pinned version"
else ko "drift report lacks package or versions"; fi
if grep -q 'sudo .*docker-converge\.sh' <<<"$out"; then ok "prints the fix command"; else ko "drift report lacks the fix command"; fi
if grep -qE '^apt-(get|mark) ' "$d/calls"; then ko "check mode must not call apt"; else ok "no apt calls in check mode"; fi

echo "Case: --check, a pinned package is not installed"
d="$(stage)"
rm "$d/db/containerd.io"
run "$d" --check
expect_rc 1 "missing package fails"
if grep -q 'containerd\.io' <<<"$out"; then ok "names the missing package"; else ko "drift report lacks the missing package"; fi

echo "Case: --check, package removed but its config files remain (dpkg 'config-files')"
# dpkg-query still reports the old Version for an rc-state package.
d="$(stage)"
printf 'config-files %s' "$PIN" >"$d/db/docker-ce"
run "$d" --check
expect_rc 1 "removed package with matching version fails"

echo "Case: --check, packages match but the daemon runs the overlay2 graph driver"
# What an in-place upgrade from Engine <29 keeps.
d="$(stage)"
printf '[["Backing Filesystem","extfs"],["Supports d_type","true"]]' >"$d/driver-status"
run "$d" --check
expect_rc 1 "legacy image store fails"
if grep -q 'containerd' <<<"$out"; then ok "names the wanted image store"; else ko "store report lacks the wanted store"; fi

echo "Case: --check, daemon unreachable"
d="$(stage)"
rm "$d/driver-status"
run "$d" --check
expect_rc 1 "unknown image store fails"

echo "Case: pins file has a line that is not <package>=<version>"
d="$(stage)"
echo "docker-ce $PIN" >>"$d/pins"
run "$d" --check
expect_rc 2 "malformed pin is a config error"

echo "Case: pins file has no pins at all"
# Zero pins would make every host trivially "in sync".
d="$(stage)"
printf '# comments only\n\n' >"$d/pins"
run "$d" --check
expect_rc 2 "empty pin set is a config error"

echo "Case: converge, host already matches"
d="$(stage)"
run "$d"
expect_rc 0 "no-op converge succeeds"
if grep -qE '^apt-get .*install|^apt-mark ' "$d/calls"; then ko "no-op converge must not install or re-hold"; else ok "nothing installed"; fi

echo "Case: converge, two packages drifted (one newer than the pin)"
d="$(stage)"
printf 'installed %s' "$OLDER" >"$d/db/docker-ce"
printf 'installed %s' "$NEWER" >"$d/db/containerd.io"
run "$d"
expect_rc 0 "converge succeeds"
install_line="$(grep -E '^apt-get .*install' "$d/calls" || true)"
if [[ "$(grep -cE '^apt-get .*install' "$d/calls")" == 1 ]]; then ok "exactly one install call"; else ko "expected one lockstep install call"; fi
missing=()
for p in "${PKGS[@]}"; do
  grep -qF " $p=$PIN" <<<"$install_line" || missing+=("$p")
done
if [[ ${#missing[@]} -eq 0 ]]; then ok "install call carries all five pins"; else ko "install call lacks: ${missing[*]}"; fi
# Non-interactive, and able to move packages the previous converge held,
# in either direction (a revert moves back to older pins).
for flag in -y --allow-change-held-packages --allow-downgrades; do
  if grep -qE -- " $flag( |$)" <<<"$install_line"; then ok "install passes $flag"; else ko "install call lacks $flag"; fi
done
hold_line="$(grep -E '^apt-mark hold' "$d/calls" || true)"
missing=()
for p in "${PKGS[@]}"; do
  grep -qE " ${p//./\\.}( |$)" <<<"$hold_line" || missing+=("$p")
done
if [[ -n "$hold_line" && ${#missing[@]} -eq 0 ]]; then ok "holds all five afterwards"; else ko "hold call lacks: ${missing[*]:-the call itself}"; fi
run "$d" --check
expect_rc 0 "host is in sync afterwards"

echo "Case: converge, packages match but the daemon runs overlay2"
# apt cannot switch the image store; converge must say so rather than run
# a pointless install.
d="$(stage)"
printf '[["Backing Filesystem","extfs"]]' >"$d/driver-status"
run "$d"
expect_rc 1 "store-only drift fails"
if grep -qE '^apt-(get|mark) ' "$d/calls"; then ko "store-only drift must not call apt"; else ok "no apt calls"; fi
if grep -q 'containerd-snapshotter' <<<"$out"; then ok "points to the store switch"; else ko "no store remediation printed"; fi

echo "Case: converge, apt-get exits 0 but nothing changed"
d="$(stage)"
printf 'installed %s' "$OLDER" >"$d/db/docker-ce"
APPLY=0 run "$d"
expect_rc 1 "unverified converge fails"
if grep -qE '^apt-get .*install' "$d/calls"; then ok "it did attempt the install"; else ko "failed without attempting the install"; fi

echo "Case: converge, apt-get install fails"
d="$(stage)"
printf 'installed %s' "$OLDER" >"$d/db/docker-ce"
FAIL_INSTALL=1 run "$d"
if [[ "$rc" != 0 && "$rc" != 2 && "$rc" != 127 ]]; then ok "failed install fails (exit $rc)"; else ko "failed install: expected an apt failure exit, got $rc"; fi
if grep -qE '^apt-get .*install' "$d/calls"; then ok "it did attempt the install"; else ko "failed without attempting the install"; fi

echo "Case: the real pins file pins exactly the five ADR-0009 packages"
if [[ -f "$REAL_PINS" ]]; then
  actual="$(grep -vE '^\s*(#|$)' "$REAL_PINS" | cut -d= -f1 | sort | tr '\n' ' ')"
  expected="$(printf '%s\n' "${PKGS[@]}" | sort | tr '\n' ' ')"
  if [[ "$actual" == "$expected" ]]; then ok "real pins file covers the five packages"; else ko "real pins file has [$actual], want [$expected]"; fi
else
  ko "$REAL_PINS not found"
fi

echo
echo "Result: $pass passed, $fail failed"
if [[ $fail -gt 0 ]]; then
  printf '  - %s\n' "${failures[@]}"
  exit 1
fi
