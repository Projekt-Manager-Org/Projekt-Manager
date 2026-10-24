#!/usr/bin/env bash
#
# Scenario tests for scripts/smoke-caddy-health.sh.
#
# The script is deploy.sh's outside-in health gate (ADR-0009): a probe that
# passes without reaching Caddy on the published address would let a
# broken port, proxy or certificate through. `docker`, `curl` and `sleep`
# are replaced by PATH stubs that serve a canned container and a queue of
# HTTP statuses and log every call, so the cases run without a stack.
#
# Exits 0 when every case matches; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/smoke-caddy-health.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/smoke-caddy-health.sh"

TMP_DIRS=()
# shellcheck disable=SC2317  # invoked via `trap cleanup EXIT`
cleanup() {
  local d
  for d in "${TMP_DIRS[@]:-}"; do
    [[ -n "${d:-}" && -d "$d" ]] && rm -rf "$d"
  done
}
trap cleanup EXIT

# A fresh sandbox per case. $1: the container's DOMAIN ('' for none),
# $2: `docker port` output ('' for unpublished), $3..: curl statuses,
# one per attempt (the last repeats).
stage() {
  local d
  d="$(mktemp -d)"
  TMP_DIRS+=("$d")
  mkdir -p "$d/bin"
  : >"$d/calls"
  printf '%s' "$1" >"$d/domain"
  printf '%s' "$2" >"$d/port"
  shift 2
  printf '%s\n' "$@" >"$d/statuses"

  cat >"$d/bin/docker" <<EOF
#!/usr/bin/env bash
case "\$1" in
  inspect)
    echo "PATH=/usr/bin"
    [[ -s "$d/domain" ]] && echo "DOMAIN=\$(cat "$d/domain")"
    ;;
  port) [[ -s "$d/port" ]] && cat "$d/port" ;;
esac
exit 0
EOF
  cat >"$d/bin/curl" <<EOF
#!/usr/bin/env bash
echo "curl \$*" >>"$d/calls"
status=\$(head -n 1 "$d/statuses")
[[ \$(wc -l <"$d/statuses") -gt 1 ]] && sed -i 1d "$d/statuses"
printf '%s' "\$status"
EOF
  printf '#!/usr/bin/env bash\nexit 0\n' >"$d/bin/sleep"
  chmod +x "$d/bin/"*
  SANDBOX="$d"
}

run_probe() {
  OUT="$(PATH="$SANDBOX/bin:$PATH" bash "$SCRIPT" "$@" 2>&1)"
  RC=$?
}

PASS=0
FAIL=0
check() {
  local desc="$1"
  shift
  if "$@"; then
    echo "  PASS — $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL — $desc"
    echo "$OUT" | sed 's/^/    | /'
    FAIL=$((FAIL + 1))
  fi
}
calls_have() { grep -qF -- "$1" "$SANDBOX/calls"; }
calls_lack() { ! grep -qF -- "$1" "$SANDBOX/calls"; }
curl_count() { [[ $(grep -c '^curl ' "$SANDBOX/calls") -eq "$1" ]]; }

echo "Case: 200 on the first attempt"
stage smoke.invalid "10.213.17.1:443" 200
run_probe 60
check "exits 0" test "$RC" -eq 0
check "resolves the domain to the published address" calls_have "--resolve smoke.invalid:443:10.213.17.1"
check "probes /api/health over https on the published port" calls_have "https://smoke.invalid:443/api/health"
check "never skips certificate verification" calls_lack "--insecure"
check "never skips certificate verification (short flag)" calls_lack " -k "
check "one attempt" curl_count 1

echo "Case: connection refused, then 502, then 200"
stage smoke.invalid "127.0.0.1:443" "000curl: (7) Failed to connect" 502 200
run_probe 60
check "retries until 200 and exits 0" test "$RC" -eq 0
check "three attempts" curl_count 3
check "reports each failed attempt" grep -q "attempt 2: 502" <<<"$OUT"

echo "Case: never 200"
stage smoke.invalid "127.0.0.1:443" 503
run_probe 0
check "fails" test "$RC" -eq 1
check "names the timeout" grep -q "did not return 200 through Caddy" <<<"$OUT"

echo "Case: 443 not published"
stage smoke.invalid "" 200
run_probe 60
check "fails" test "$RC" -eq 1
check "never probes" curl_count 0

echo "Case: no DOMAIN on the container"
stage "" "127.0.0.1:443" 200
run_probe 60
check "fails" test "$RC" -eq 1
check "never probes" curl_count 0

echo
echo "Result: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
