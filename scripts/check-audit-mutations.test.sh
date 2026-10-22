#!/usr/bin/env bash
#
# Scenario tests for scripts/check-audit-mutations.sh (AC-179).
#
# Each scenario stages a fixture source tree in a fresh temp directory
# and runs the real check script against it via `AUDIT_PROJECT_ROOT`.
# The check's TS helper (scripts/print-audited-tables.ts) still imports
# the real `src/server/db/schema.ts`, so audited-table derivation is
# exercised end-to-end — the fixture only supplies the code under scan.
#
# Scenarios:
#   1. Allowlisted path — `src/server/services/mutate.ts` contains a
#      raw mutation. Expected: exit 0 (the path is in ALLOWLIST).
#   2. Non-allowlisted path — a synthetic service file outside the
#      allowlist contains a raw mutation. Expected: exit 1.
#   3. Run against the current repo — every audited mutation is now
#      routed through mutate() and the repositories path is allowlisted
#      behind the MutatingDatabase type gate. Expected: exit 0.
#   4. M1 regression — lowercase `sql\`insert into projects …\``
#      previously bypassed the case-sensitive keyword match.
#      Expected: exit 1.
#   5. M2 regression — `client.query("DELETE FROM users …")`
#      previously bypassed the hardcoded `pool.query(…)` receiver.
#      Expected: exit 1.
#   6. M3 regression — compound `sql\`BEGIN; UPDATE projects …; COMMIT\``
#      previously bypassed the tight "keyword immediately after backtick"
#      anchor. Expected: exit 1.
#   7. M4 regression — a file at
#      `src/server/routes/src/server/repositories/weird.ts` previously
#      got a false allowlist hit because `src/server/repositories/` was
#      matched as a substring anywhere in the path. Expected: exit 1.
#   8. Attachments negative — raw `INSERT INTO attachments …` in a
#      non-allowlisted file must be flagged (the scanner derives the
#      audited-table set from schema.ts; `attachments` is in it).
#      Expected: exit 1.
#   9. Attachments positive — the same raw INSERT placed inside the
#      allowlisted reaper (`src/server/services/attachment-orphan-reaper.ts`,
#      the only legitimate `attachments` deleter per ADR-0023/AC-408)
#      must NOT be flagged. Expected: exit 0.
#   (Previous scenarios 8–9 covered notification_rule as an audited
#    entity; removed when ADR-0023 carved it out of the audit coupling.
#    The numbers are reused here for attachments now that attachments is
#    a first-class audited entity — data-model.md §5.10.)
#
# Usage:
#   bash scripts/check-audit-mutations.test.sh
#
# Exits 0 when every scenario passes; exits 1 on the first mismatch.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHECK_SCRIPT="$SCRIPT_DIR/check-audit-mutations.sh"

if [ ! -x "$CHECK_SCRIPT" ]; then
  echo "ERROR: $CHECK_SCRIPT not executable. chmod +x and try again." >&2
  exit 2
fi

# Single top-level trap manages every tmp dir — adding a scenario
# means appending one path to $TMP_DIRS, not nesting another trap.
# (Review finding A-F7: nested trap chain leaked tmps on earlier runs.)
TMP_DIRS=()
# shellcheck disable=SC2317 # invoked via `trap cleanup EXIT` below
cleanup() {
  local d
  for d in "${TMP_DIRS[@]:-}"; do
    [ -n "${d:-}" ] && [ -d "$d" ] && rm -rf "$d"
  done
}
trap cleanup EXIT

mktmp() {
  local d
  d="$(mktemp -d)"
  TMP_DIRS+=("$d")
  echo "$d"
}

pass=0
fail=0
failures=()

# -------------------------------------------------------------
# assert_exit <expected> <label> <cmd> [args...]
# -------------------------------------------------------------
assert_exit() {
  local expected="$1"
  local label="$2"
  shift 2
  local actual
  "$@" >/dev/null 2>&1
  actual=$?
  if [ "$actual" = "$expected" ]; then
    pass=$((pass + 1))
    echo "  PASS — $label (exit $actual)"
  else
    fail=$((fail + 1))
    failures+=("$label: expected exit $expected, got $actual")
    echo "  FAIL — $label (expected $expected, got $actual)"
  fi
}

# -------------------------------------------------------------
# Scenario 1 — allowlisted path, raw mutation, expect pass.
# -------------------------------------------------------------
echo "Scenario 1: allowlisted path with raw mutation → expect exit 0"
tmp="$(mktmp)"
mkdir -p "$tmp/src/server/services"
cat > "$tmp/src/server/services/mutate.ts" <<'EOF'
import { db, projects } from '../db.js';
export async function doWrite() {
  await db.insert(projects).values({ title: 'x' });
}
EOF
assert_exit 0 "allowlisted file authors raw mutation" \
  env AUDIT_PROJECT_ROOT="$tmp" bash "$CHECK_SCRIPT"

# -------------------------------------------------------------
# Scenario 2 — non-allowlisted path, raw mutation, expect fail.
# -------------------------------------------------------------
echo ""
echo "Scenario 2: non-allowlisted path with raw mutation → expect exit 1"
tmp="$(mktmp)"
mkdir -p "$tmp/src/server/rogue"
# A non-allowlisted path — `src/server/rogue/` is not in the ALLOWLIST
# and is not covered by the MutatingDatabase type gate (it's a
# synthetic file, not importing repositories). The scan must flag it.
cat > "$tmp/src/server/rogue/leak.ts" <<'EOF'
import { db, customers } from '../db.js';
export async function updateCustomer(id: string) {
  return db.update(customers).set({ name: 'new' }).where(eq(customers.id, id));
}
EOF
assert_exit 1 "non-allowlisted file authors raw mutation" \
  env AUDIT_PROJECT_ROOT="$tmp" bash "$CHECK_SCRIPT"

# -------------------------------------------------------------
# Scenario 3 — current repo, post-implementation, expect pass.
# -------------------------------------------------------------
# Every audited mutation in the production tree routes through
# `mutate()` (ADR-0021) and the repository writes are type-gated
# behind `MutatingDatabase` (see `src/server/db/connection.ts`).
# The scan should therefore find no findings outside the allowlist.
echo ""
echo "Scenario 3: current repo (post-implementation) → expect exit 0"
assert_exit 0 "current repo passes — every audited mutation routes through mutate()" \
  bash "$CHECK_SCRIPT"

# -------------------------------------------------------------
# Scenario 4 — M1 regression: lowercase SQL keyword in sql template.
# -------------------------------------------------------------
echo ""
echo "Scenario 4: M1 regression — lowercase sql\`insert into projects\` → expect exit 1"
tmp="$(mktmp)"
mkdir -p "$tmp/src/server/rogue"
cat > "$tmp/src/server/rogue/lowercase.ts" <<'EOF'
import { db } from '../db.js';
export async function doLowercase() {
  await db.execute(sql`insert into projects (title) values ('x')`);
}
EOF
assert_exit 1 "lowercase SQL keyword is flagged (M1)" \
  env AUDIT_PROJECT_ROOT="$tmp" bash "$CHECK_SCRIPT"

# -------------------------------------------------------------
# Scenario 5 — M2 regression: client.query receiver.
# -------------------------------------------------------------
echo ""
echo "Scenario 5: M2 regression — client.query(\"DELETE FROM users …\") → expect exit 1"
tmp="$(mktmp)"
mkdir -p "$tmp/src/server/rogue"
cat > "$tmp/src/server/rogue/clientquery.ts" <<'EOF'
import { client } from '../db.js';
export async function deleteUser(id: string) {
  await client.query("DELETE FROM users WHERE id = $1", [id]);
}
EOF
assert_exit 1 "client.query mutation is flagged (M2)" \
  env AUDIT_PROJECT_ROOT="$tmp" bash "$CHECK_SCRIPT"

# -------------------------------------------------------------
# Scenario 6 — M3 regression: compound tx in sql template.
# -------------------------------------------------------------
echo ""
echo "Scenario 6: M3 regression — sql\`BEGIN; UPDATE projects …; COMMIT\` → expect exit 1"
tmp="$(mktmp)"
mkdir -p "$tmp/src/server/rogue"
cat > "$tmp/src/server/rogue/compound.ts" <<'EOF'
import { db } from '../db.js';
export async function compoundTx(id: string) {
  await db.execute(sql`BEGIN; UPDATE projects SET deleted=true WHERE id = ${id}; COMMIT`);
}
EOF
assert_exit 1 "compound tx with UPDATE mid-template is flagged (M3)" \
  env AUDIT_PROJECT_ROOT="$tmp" bash "$CHECK_SCRIPT"

# -------------------------------------------------------------
# Scenario 7 — M4 regression: substring-bypass path.
# -------------------------------------------------------------
echo ""
echo "Scenario 7: M4 regression — nested path src/server/routes/src/server/repositories/weird.ts → expect exit 1"
tmp="$(mktmp)"
mkdir -p "$tmp/src/server/routes/src/server/repositories"
cat > "$tmp/src/server/routes/src/server/repositories/weird.ts" <<'EOF'
import { db, projects } from '../db.js';
export async function evilWrite() {
  await db.insert(projects).values({ title: 'bypass' });
}
EOF
assert_exit 1 "substring-bypass path is not allowlisted (M4)" \
  env AUDIT_PROJECT_ROOT="$tmp" bash "$CHECK_SCRIPT"

# -------------------------------------------------------------
# Scenario 8 — attachments table, non-allowlisted path, expect fail.
# -------------------------------------------------------------
# `attachments` is a first-class audited table (data-model.md §5.10,
# AuditEntityType includes 'attachment'). The scanner derives the
# audited-table set from schema.ts, so a raw INSERT against the
# attachments table from a non-allowlisted path must be flagged.
echo ""
echo "Scenario 8: attachments raw INSERT in non-allowlisted path → expect exit 1"
tmp="$(mktmp)"
mkdir -p "$tmp/src/server/rogue"
cat > "$tmp/src/server/rogue/attachments-leak.ts" <<'EOF'
import { db } from '../db.js';
export async function leakAttachment(id: string, projectId: string) {
  await db.execute(sql`INSERT INTO attachments (id, project_id) VALUES (${id}, ${projectId})`);
}
EOF
assert_exit 1 "attachments raw INSERT in non-allowlisted file is flagged" \
  env AUDIT_PROJECT_ROOT="$tmp" bash "$CHECK_SCRIPT"

# -------------------------------------------------------------
# Scenario 9 — attachments table, allowlisted reaper, expect pass.
# -------------------------------------------------------------
# The orphan reaper (src/server/services/attachment-orphan-reaper.ts)
# is allowlisted — it's the only legitimate deleter of orphaned
# `attachments` rows (housekeeping sweep past TTL, pre-domain rows
# that never produced an audit entry; AC-408). The same INSERT that
# Scenario 8 flags must NOT fire here.
echo ""
echo "Scenario 9: attachments raw INSERT inside allowlisted reaper → expect exit 0"
tmp="$(mktmp)"
mkdir -p "$tmp/src/server/services"
cat > "$tmp/src/server/services/attachment-orphan-reaper.ts" <<'EOF'
import { db } from '../db.js';
export async function reapOrphan(id: string, projectId: string) {
  await db.execute(sql`INSERT INTO attachments (id, project_id) VALUES (${id}, ${projectId})`);
}
EOF
assert_exit 0 "attachments raw INSERT inside allowlisted reaper passes" \
  env AUDIT_PROJECT_ROOT="$tmp" bash "$CHECK_SCRIPT"

echo ""
echo "-------------------------------------------------------------"
echo "  Passed: $pass"
echo "  Failed: $fail"
if [ "$fail" -gt 0 ]; then
  for f in "${failures[@]}"; do
    echo "    - $f"
  done
  exit 1
fi
echo "All scenarios passed."
exit 0
