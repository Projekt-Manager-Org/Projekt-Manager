#!/usr/bin/env bash
#
# Architecture check — audit-log single-write-path (AC-179, ADR-0021).
#
# Fails CI when a file under src/server/ authors a raw
# INSERT/UPDATE/DELETE against an audited table from outside the
# service-layer `mutate()` helper. The `mutate()` helper is the single
# legitimate writer; every other path must go through it so the audit
# row is produced atomically with the state change (ADR-0021 §Decision).
#
# Audited-table derivation (AC-179 Part 2):
#   The audited-table set is sourced from `AUDIT_ENTITY_TO_TABLE` in
#   `src/server/db/schema.ts`, read via `scripts/print-audited-tables.ts`.
#   That TS mapping carries a `satisfies Record<AuditEntityType, …>`
#   clause, so a new `AuditEntityType` value without a table mapping
#   fails tsc — and a new entity type with a mapping automatically
#   extends this check's scan. Neither direction lets a new audited
#   entity ship with its mutation surface unobserved.
#
# `audit_log` itself is NOT in the audited-table set — `mutate()` is
# its legitimate writer, and the retention-cleanup job is its only
# legitimate deleter. Both are allowlisted below.
#
# Allowlist (ALLOW): files that legitimately author raw mutations
# against audited tables — kept intentionally small and reviewed per
# line at PR time (ADR-0021 §Consequences §Negative).
#
# Exit code:
#   0 — no findings outside the allowlist
#   1 — at least one finding; each is printed file:line, followed by
#       the matched snippet so the reviewer can inspect it.
#   2 — toolchain error (missing ripgrep/grep/tsx, no source tree).

set -euo pipefail

# Project root. Defaults to the parent of this script's directory; the
# test harness (scripts/check-audit-mutations.test.sh) overrides via
# $AUDIT_PROJECT_ROOT so it can point the scan at a fixture tree
# without copying the check + helper + schema into a tmp dir.
PROJECT_ROOT="${AUDIT_PROJECT_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

# The TS helper (print-audited-tables.ts) imports the real
# src/server/db/schema.ts — it must run from the actual repository
# root regardless of where the scan target lives. Captured before
# `cd` to $PROJECT_ROOT so the test harness can point PROJECT_ROOT
# at a fixture tmp dir while still resolving the helper.
HELPER_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$PROJECT_ROOT"

if [ ! -d "src/server" ]; then
  echo "ERROR: src/server not found under \$PROJECT_ROOT ($PROJECT_ROOT)." >&2
  exit 2
fi

# Derive audited-table identifiers from `AUDIT_ENTITY_TO_TABLE`
# (src/server/db/schema.ts) via the TS helper. Using `npx tsx` keeps
# the shell as the orchestrator and avoids porting the schema to a
# parallel format. Both SQL name + Drizzle export name are checked.
if ! command -v npx >/dev/null 2>&1; then
  echo "ERROR: npx not found — cannot derive audited-table set from schema.ts." >&2
  exit 2
fi

read -ra AUDITED_TABLE_SQL_NAMES <<<"$(cd "$HELPER_ROOT" && npx --no-install tsx scripts/print-audited-tables.ts sql)"
read -ra AUDITED_DRIZZLE_EXPORTS <<<"$(cd "$HELPER_ROOT" && npx --no-install tsx scripts/print-audited-tables.ts drizzle)"

if [ "${#AUDITED_TABLE_SQL_NAMES[@]}" -eq 0 ] || [ "${#AUDITED_DRIZZLE_EXPORTS[@]}" -eq 0 ]; then
  echo "ERROR: scripts/print-audited-tables.ts returned no audited tables." >&2
  echo "       The scan would silently pass with empty sets — refusing to run." >&2
  exit 2
fi

# Scan covers three surfaces:
#   1. Drizzle builder calls:  `.insert(projects)` / `.update(projects)` / `.delete(projects)`
#      — receiver-agnostic (`db.`, `tx.`, `this.db.`, `client.` all match).
#   2. Raw SQL templates:       `` sql`INSERT INTO projects …` ``, `` sql`UPDATE customers …` ``,
#      `` sql`DELETE FROM project_workers …` `` — keyword can appear anywhere inside the
#      template, so compound `` sql`BEGIN; UPDATE projects …` `` still matches.
#   3. Raw `.query()` calls:    `pool.query('INSERT INTO projects …')`, `client.query(…)`,
#      `tx.query(…)` — receiver-agnostic.
#
# Dynamic SQL paths — `sql.raw(...)`, `db.$with(...).delete(...)`,
# runtime-assembled query strings — are NOT detected. ADR-0021 accepts
# this gap for the static check; runtime guards would require the
# trigger belt ruled out in that ADR. When a dynamic-SQL surface is
# added, extend the scanner.
#
# Keyword matching is case-insensitive (`-i`) so `sql`update projects…`` does not
# bypass the keyword family. Table names are lowercase identifiers and stay
# case-sensitive — PostgreSQL folds unquoted identifiers to lowercase, and the
# Drizzle exports + SQL table declarations in schema.ts are all lowercase.

# Files permitted to author raw mutations against audited tables.
# Each entry is a prefix matched against the finding's file path (from
# the scan root, forward slashes). An entry containing `*/…/*` is
# treated as a shell glob and matched anywhere in the path — used for
# nested patterns like `*/__tests__/*`.
#
# Anchoring matters: a prefix like `src/server/repositories/` must
# match the START of the path. The earlier "substring anywhere" form
# would allowlist a malicious `src/server/routes/src/server/repositories/x.ts`
# bypass — see regression test for M4.
#
# See AC-179 for the review contract: adding to this list is a
# reviewed line in the check configuration — not a reflexive escape
# hatch.
ALLOWLIST=(
  # The single-write-path helper — the legitimate writer.
  "src/server/services/mutate.ts"
  # Repository write functions accept `MutatingDatabase` (= `TxHandle`,
  # see `src/server/db/connection.ts`) — a plain `Database` fails
  # typecheck. The bypass the static scan cannot reliably detect
  # (receiver-name agnostic `.insert(X)`) is therefore closed at the
  # type level; this path-based allowlist exists so the scan does not
  # flag the legitimate `tx.insert(...)` calls inside repos. The
  # integrity guarantee is the type, not the allowlist.
  #
  # AC-219 single audit-free exception for attachments lives here:
  # `createPending` (the init `pending`-row insert) is the state-machine
  # pre-step that writes NO audit row — an upload abandoned before
  # complete leaves nothing on the activity feed (parity with the orphan
  # reaper's pending-row carve-out below). `AttachmentService.initUpload`
  # therefore calls it inside a plain `db.transaction`, not `mutate()`.
  # Its sibling `markReady` (the `complete` flip) is NOT an exception:
  # `completeUpload` routes it through `mutate()` so the authoritative
  # `attachment:add` row co-commits with the `pending → ready` flip.
  "src/server/repositories/"
  # Migrations: schema-level DDL + seed-data migrations run outside
  # the runtime path and predate the helper.
  "src/server/db/migrations/"
  # Unified restore — bulk import replaces business data in one
  # transaction; per ADR-0021 this is allowlisted.
  "src/server/services/ImportService.ts"
  # Business-data seed loader — fixture hydration bypasses audit by
  # design (data-model.md §7).
  "src/server/seed/business.ts"
  # User seed loader — direct-DB path, parallel to business.ts.
  "src/server/seed/users.ts"
  # Notification rule seed loader — v1 rule hydration is administrative
  # config, not an authored rule edit. ADR-0023 ships the initial set
  # via seed; routing it through mutate() would add six noise rows to
  # the activity feed on every fresh install.
  "src/server/seed/notificationRules.ts"
  # Invoice seed loader — issuance/cancellation/draft writes all run
  # through `createInvoiceService()` (audited). The single raw
  # `.update(projects)` is fixture-shaping: to attach invoices to
  # projects whose target demo state is `erledigt` / `abnahme`, the
  # seed flips the project to `rechnung_faellig` (the only state
  # `InvoiceIssueService` accepts), issues through the service, then
  # flips the project to its target state. That second flip is not a
  # legal state-machine transition (workflows.md §projectStatus); the
  # seed steps outside the machine on purpose to compose a varied dev
  # landscape. TRUNCATE has just run — no users observe the moves.
  "src/server/seed/invoices.ts"
  # Audit retention — the only legitimate deleter of audit_log rows.
  # (audit_log is not in the audited-table set, but this job is the
  # archetypal allowlist case for parity with the helper.)
  "src/server/services/audit-retention.ts"
  # Attachment orphan reaper (AC-213) — housekeeping sweep that
  # deletes pending rows past TTL with no audit row (orphans never
  # entered the domain). Parallel to audit-retention's allowlist slot.
  "src/server/services/attachment-orphan-reaper.ts"
  # Full-account takeout IMPORT job runner — writes raw audit_log rows at
  # its terminal transition (AC-332) and raw INSERT into `attachments` for
  # each restored binary (Pass 2). Both are reviewed bulk-write sites:
  #   - The audit row is the single job-terminal row (mirrors takeout-
  #     export-runner's allowlisted terminal audit insert).
  #   - The attachments insert restores IDs-preserved rows from the takeout
  #     archive; routing through mutate() would write spurious audit rows
  #     for every attachment (AC-332: exactly ONE data_import row, not N).
  "src/server/services/takeout-import-runner.ts"
  # Any `__tests__/` directory anywhere under the scan root — the
  # AC-179 carve-out for tests. The nested-glob form covers both
  # top-level `src/server/__tests__/` and any future subtree's local
  # `__tests__/` without a separate line per location.
  "*/__tests__/*"
)

is_allowlisted() {
  local file="$1"
  local entry
  for entry in "${ALLOWLIST[@]}"; do
    case "$entry" in
      # Glob entry — match anywhere.
      *\**)
        # shellcheck disable=SC2053 # glob on the right is intentional
        [[ "$file" == $entry ]] && return 0
        ;;
      # Prefix entry — must start with it.
      *)
        case "$file" in
          "$entry"*) return 0 ;;
        esac
        ;;
    esac
  done
  return 1
}

# Prefer ripgrep when available — faster, deterministic ordering,
# bundles on every dev + CI box. Fall back to grep -R for minimal
# environments. `-i` makes the SQL keyword match (INSERT / UPDATE /
# DELETE) case-insensitive so lowercase or mixed-case writes do not
# bypass; table identifiers remain case-sensitive per Postgres fold
# rules.
if command -v rg >/dev/null 2>&1; then
  scanner="rg -i --line-number --no-heading --color=never"
else
  scanner="grep -RniE --binary-files=without-match"
fi

findings=""

# --- Drizzle-builder pattern -----------------------------------------
for table in "${AUDITED_DRIZZLE_EXPORTS[@]}"; do
  # Matches `.insert(projects)`, `.update(projects)`, `.delete(projects)`
  # as a word boundary. Optional whitespace between the paren and the
  # identifier to catch `.insert(\n  projects,\n  ...)` on multi-line
  # calls.
  pattern="\\.(insert|update|delete)\\(\\s*${table}\\b"
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    # ripgrep emits file:line:match; grep -RnE emits file:line:match —
    # both have file as the first colon-separated field.
    file="${line%%:*}"
    if ! is_allowlisted "$file"; then
      findings="${findings}${line}"$'\n'
    fi
  done < <($scanner "$pattern" src/server 2>/dev/null || true)
done

# --- Raw SQL template pattern ----------------------------------------
# Matches `sql\`…INSERT INTO projects…\``, `sql\`…UPDATE customers…\``,
# `sql\`…DELETE FROM project_workers…\``. The keyword can appear
# ANYWHERE inside the template body (the `[^\`]*` prefix) — a
# compound `` sql`BEGIN; UPDATE projects SET …; COMMIT` `` still
# matches, as does any template with leading whitespace or newline
# before the keyword.
for table in "${AUDITED_TABLE_SQL_NAMES[@]}"; do
  # `[^\`]*` keeps the match bounded inside the opening backtick —
  # greedy is fine because the character class excludes the closing
  # backtick, so the engine cannot consume past the template body.
  pattern="sql\`[^\`]*(INSERT INTO|UPDATE|DELETE FROM) ${table}\\b"
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    file="${line%%:*}"
    if ! is_allowlisted "$file"; then
      findings="${findings}${line}"$'\n'
    fi
  done < <($scanner "$pattern" src/server 2>/dev/null || true)
done

# --- Raw .query() pattern --------------------------------------------
# `pool.query('INSERT INTO projects ...')`, `client.query(…)`,
# `tx.query(…)`, `this.db.query(…)` — any identifier followed by
# `.query(` is the receiver. The Drizzle-builder pattern above is
# already receiver-agnostic (starts with `\.`); the query form needs
# the same breadth so `client.query` / `tx.query` do not slip past.
for table in "${AUDITED_TABLE_SQL_NAMES[@]}"; do
  pattern="\\b\\w+\\.query\\([\"'\\\`](INSERT INTO|UPDATE|DELETE FROM) ${table}\\b"
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    file="${line%%:*}"
    if ! is_allowlisted "$file"; then
      findings="${findings}${line}"$'\n'
    fi
  done < <($scanner "$pattern" src/server 2>/dev/null || true)
done

if [ -n "$findings" ]; then
  echo "ERROR: raw mutations on audited tables found outside mutate()." >&2
  echo "       Route the write through src/server/services/mutate.ts, or" >&2
  echo "       add an inline-documented entry to ALLOWLIST in" >&2
  echo "       $(basename "$0") if the path is a reviewed bulk-write site." >&2
  echo "" >&2
  # shellcheck disable=SC2059
  printf "%s" "$findings" >&2
  exit 1
fi

echo "OK: no raw mutations on audited tables outside mutate()."
echo "    audited tables (sql): ${AUDITED_TABLE_SQL_NAMES[*]}"
echo "    audited tables (drizzle exports): ${AUDITED_DRIZZLE_EXPORTS[*]}"
echo "    allowlist size: ${#ALLOWLIST[@]}"
