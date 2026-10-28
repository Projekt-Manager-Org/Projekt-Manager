#!/usr/bin/env bash
#
# Scenario tests for the [3/10] schema parity gate of
# scripts/sync-dev-to-vps.sh and scripts/sync-vps-to-dev.sh (#644).
#
# Matching baseline files on both checkouts do not prove the source DB was
# built from that baseline: a DB built on an older one would land on the
# target as is, ledger row included, and no guard fires until the next
# deploy. Each script must refuse, before [4/10], when the source DB's
# ledger hash is empty or differs from the sha256 of 0000_baseline.sql.
#
# `ssh` and `docker` are replaced by PATH stubs that answer only the
# preflight reads; anything else fails. A matching ledger is therefore
# shown by reaching [4/10], not by a full sync. The local and
# VPS ledgers come from LOCAL_LEDGER / VPS_LEDGER.
#
# Exits 0 when every case matches; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/sync-schema-parity.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BASELINE_HASH="$(sha256sum "$REPO_ROOT/src/server/db/migrations/0000_baseline.sql" | awk '{print $1}')"
STALE_HASH="$(printf 'an older baseline' | sha256sum | awk '{print $1}')"

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

# A fresh sandbox per case. Both checkouts carry the
# same baseline file; both DBs have users.
stage() {
  local d
  d="$(mktemp -d -p "$TMP_ROOT")"
  mkdir -p "$d/bin"

  cat >"$d/bin/ssh" <<EOF
#!/usr/bin/env bash
cmd="\${!#}"
case "\$cmd" in
  true) exit 0 ;;
  "sha256sum /opt/projekt-manager/src/server/db/migrations/0000_baseline.sql")
    echo "$BASELINE_HASH  /opt/projekt-manager/src/server/db/migrations/0000_baseline.sql" ;;
  *__drizzle_migrations*) printf '%s\n' "\${VPS_LEDGER:-}" ;;
  *"FROM users"*) echo 1 ;;
  *) exit 1 ;;
esac
EOF

  cat >"$d/bin/docker" <<EOF
#!/usr/bin/env bash
case "\$*" in
  "compose ps --services --status running") printf 'db\nstorage\n' ;;
  *__drizzle_migrations*) printf '%s\n' "\${LOCAL_LEDGER:-}" ;;
  *information_schema.tables*) echo 1 ;;
  *"FROM users"*) echo 1 ;;
  *) exit 1 ;;
esac
EOF

  chmod +x "$d/bin/"*
  echo "$d"
}

# run <dir> <script> — sets $rc, $out. Ledgers come from the caller's env.
run() {
  out="$(PATH="$1/bin:$PATH" bash "$REPO_ROOT/scripts/$2" 2>&1)"
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

# refuses <label> <recorded hash or empty> — the gate stopped the run at
# [3/10], naming the hashes and the recovery runbook.
refuses() {
  local label="$1" recorded="$2"
  if [[ "$rc" != 0 ]] && ! grep -qF '[4/10]' <<<"$out"; then
    ok "$label: refused before [4/10] (exit $rc)"
  else
    ko "$label: expected a refusal before [4/10] (exit $rc)"
    return
  fi
  if grep -qF "$BASELINE_HASH" <<<"$out" && { [[ -z "$recorded" ]] || grep -qF "$recorded" <<<"$out"; }; then
    ok "$label: names the hashes"
  else ko "$label: refusal lacks the expected and recorded hash"; fi
  if grep -qF 'recover-from-schema-change.md' <<<"$out"; then
    ok "$label: points at the recovery runbook"
  else ko "$label: refusal lacks the recovery runbook"; fi
}

# passes <label> — the gate let the run through to [4/10].
passes() {
  if grep -qF '[4/10]' <<<"$out"; then ok "$1: reaches [4/10]"; else ko "$1: did not reach [4/10]"; fi
}

for script in sync-dev-to-vps.sh sync-vps-to-dev.sh; do
  # The source DB: local for dev → VPS, VPS for VPS → dev. The target's
  # ledger is set stale throughout: only the source's may decide.
  if [[ "$script" == sync-dev-to-vps.sh ]]; then src=LOCAL_LEDGER tgt=VPS_LEDGER; else src=VPS_LEDGER tgt=LOCAL_LEDGER; fi

  echo "Case: $script, source ledger matches the baseline file"
  d="$(stage)"
  export "$src=$BASELINE_HASH" "$tgt=$STALE_HASH"
  run "$d" "$script"
  passes "$script, matching ledger"

  echo "Case: $script, source DB built on an older baseline"
  d="$(stage)"
  export "$src=$STALE_HASH" "$tgt=$BASELINE_HASH"
  run "$d" "$script"
  refuses "$script, stale ledger" "$STALE_HASH"

  echo "Case: $script, source ledger empty"
  d="$(stage)"
  export "$src=" "$tgt=$BASELINE_HASH"
  run "$d" "$script"
  refuses "$script, empty ledger" ""
done

echo
echo "Passed: $pass, failed: $fail"
if [[ "$fail" -gt 0 ]]; then
  printf '  - %s\n' "${failures[@]}"
  exit 1
fi
