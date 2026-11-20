#!/usr/bin/env bash
#
# Lint step: enforce the theming rule (ARCHITECTURE.md § Design Decisions,
# "Theming"). Components read semantic color tokens only, so a theme or a
# branding change never touches a component: a hardcoded #ffffff in a
# stylesheet ignores the dark theme, a hardcoded accent ignores the
# configured brand accent (spec AC-114, AC-742).
#
# Three checks run in sequence:
#
#   Check 1 — palette hex scan
#     Scans src/**/*.{css,module.css,ts,tsx} for 6- and 8-digit hex color
#     literals (#RRGGBB, #RRGGBBAA) and fails if any are found outside the
#     allowlist. The 3- and 4-digit shorthands are intentionally NOT
#     scanned: they collide with `(issue #NNN)` references and the
#     codebase's tokens use 6-char hex consistently — so the loss of
#     coverage is theoretical, while the false-positive cost is real.
#
#   Check 2 — no --color-blue-* primitives in tokens.css
#     Greps src/styles/tokens.css for definitions of the retired blue
#     primitives. Fails if any remain. The accent value
#     lives only in src/config/brandingConfig.ts; tokens.css must reference
#     --brand-accent-light / --brand-accent-dark, not a local blue palette.
#     The check is scoped to tokens.css by design — comments elsewhere in
#     the repo that *mention* the old token names are not leaks, only
#     *definitions* of them in the token source are.
#
#   Check 3 — no undefined --color-* references
#     Every `var(--color-…)` under src/ must name a token tokens.css
#     defines. An undefined one makes the declaration silently invalid, or
#     silently falls back when the var() has a fallback — either way the
#     intended color never renders.
#
# Allowlist (Check 1):
#   src/styles/tokens.css        — single source of palette + semantic tokens
#   src/config/stateConfig.ts    — data-driven state colors (documented exception)
#   src/config/brandingConfig.ts — brand accent + brand-mark color values
#
# The script is intentionally strict: any new file that needs raw hex values
# must be justified and added here, not silently added to src/.
#
# Run from repo root: ./scripts/check-theme-tokens.sh
# Exit 0 = clean, exit 1 = leaks found, exit 2 = scan environment broken.

set -euo pipefail

cd "$(dirname "$0")/.."

# Preflight: ripgrep is required. Without it, `rg || true` below would
# silently swallow a 127 exit and report a clean scan on every run —
# turning the audit gate into a no-op.
if ! command -v rg >/dev/null 2>&1; then
  echo "error: ripgrep (rg) is required for this check." >&2
  echo "  Debian/Ubuntu: apt install ripgrep" >&2
  echo "  macOS:         brew install ripgrep" >&2
  exit 1
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

# Files allowed to contain palette hex literals. Each entry is a repo-relative
# path. The script still detects hex in these files; it just does not fail on
# matches from them.
ALLOWLIST=(
  "src/styles/tokens.css"
  "src/config/stateConfig.ts"
  "src/config/brandingConfig.ts"
)

# --- Hex literal pattern --------------------------------------------------
# Match #RRGGBB or #RRGGBBAA bounded by a word boundary. The 3- and 4-digit
# shorthands are intentionally excluded: `(issue #108)` and `Reported in
# #128. */` and friends would match the loose `[0-9a-fA-F]{3,8}` pattern
# and the awk filter below cannot reliably distinguish a digit-only short
# hex from an issue reference (they are syntactically identical). See the
# header docstring for the tradeoff rationale.
HEX_PATTERN='#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b'

# Build the ripgrep argument set. Notes on the non-obvious flags:
#
#   * Positional path `src` (passed at the call site below) is REQUIRED.
#     Without it, ripgrep's stdin-detection heuristic ("is_readable_stdin
#     = true → search stdin, ignore --glob filters") kicks in whenever the
#     calling shell hands rg a non-TTY stdin. GitHub Actions `run:` steps
#     do exactly that — `bash -e {0}` runs with stdin connected to an
#     empty file. Result: rg searches that empty stdin, finds nothing,
#     exits 1, and `|| true` swallows it. Silent no-op. This is the root
#     cause of issue #134 (CI green / local red on the same content).
#
#   * `--no-config --no-ignore` neutralizes any environment ignore chain
#     (RIPGREP_CONFIG_PATH, ~/.config/git/ignore, parent .gitignore,
#     .ignore, .rgignore). Defense in depth — a local override of any of
#     these would otherwise silently shrink the scan footprint.
#
#   * `--glob '!...'` excludes the allowlist files from the scan.
rg_args=(
  --no-config
  --no-ignore
  --hidden
  --line-number
  --no-heading
  --color=never
  --sort=path
  --type-add 'cssmod:*.module.css'
  --glob '*.css'
  --glob '*.ts'
  --glob '*.tsx'
)
for entry in "${ALLOWLIST[@]}"; do
  rg_args+=(--glob "!${entry}")
done

# --- Sanity floor ---------------------------------------------------------
# Anchor the scan footprint to a known-stable file: src/main.tsx is the
# Vite entry point. If the configured --glob set cannot see it, the scan
# would silently no-op and the gate is broken. Fail loud instead.
#
# `rg --files` lists candidate files (no regex search) and is immune to
# the stdin-search heuristic above, but we still pass the positional `src`
# for symmetry with the actual scan and to ensure the floor mirrors it.
if ! rg --no-config --no-ignore --hidden --files \
        --glob '*.tsx' \
        src \
      | grep -qx 'src/main.tsx'; then
  echo "error: scan footprint is missing src/main.tsx — the environment is" >&2
  echo "       filtering source files (ignore chain, RIPGREP_CONFIG_PATH," >&2
  echo "       sparse checkout, or similar). The check would no-op silently." >&2
  exit 2
fi

# Run ripgrep. Disable pipefail for this one call because rg exits 1 on "no
# matches" which is actually the success case for us. The positional `src`
# argument is load-bearing — see the rg_args note above.
set +o pipefail
raw_matches=$(rg "${HEX_PATTERN}" "${rg_args[@]}" src || true)
set -o pipefail

# --- Filter out obvious false positives -----------------------------------
# Drop lines that are pure comments: `//` line comments and ` * ` continuation
# lines inside JSDoc or CSS block comments. Comments have no runtime theming
# effect, so a hex-shaped token inside one (commonly a markdown link URL
# fragment like `docs.md#1522-anchor`) is not a palette leak. No broader
# URL-fragment filter: a cleverer heuristic can drop whole lines (and hide
# real leaks alongside a URL). CSS `url(...#fragment)` on a palette-bearing
# line is rare enough that false positives are acceptable — refactor the URL
# to a constant or split the line if one ever appears.
filtered=$(printf '%s\n' "$raw_matches" \
  | awk -F: '
    NF < 3 { next }
    {
      file = $1
      line = $2
      content = $0
      sub(/^[^:]*:[^:]*:/, "", content)
      if (match(content, /^[[:space:]]*\/\//)) next
      if (match(content, /^[[:space:]]*\*([[:space:]]|$)/)) next
      print file ":" line ":" content
    }
  ')

# --- Report (Check 1) -----------------------------------------------------
echo -e "${GREEN}=== Theme token hygiene check ===${NC}"
echo ""
echo -e "${GREEN}--- Check 1/3: palette hex scan ---${NC}"
echo "Scope: src/**/*.{css,module.css,ts,tsx}"
echo "Allowlist:"
for entry in "${ALLOWLIST[@]}"; do
  echo "  - ${entry}"
done
echo ""

check1_failed=0
if [ -z "$filtered" ]; then
  echo -e "${GREEN}✓ no palette leaks outside the tokens source${NC}"
else
  check1_failed=1
  # Count matches and files.
  leak_count=$(printf '%s\n' "$filtered" | grep -c . || true)
  leak_files=$(printf '%s\n' "$filtered" | cut -d: -f1 | sort -u | wc -l)

  echo -e "${RED}✗ Palette hex leaks detected outside the token source:${NC}"
  echo ""
  printf '%s\n' "$filtered" | awk -F: '
    {
      file = $1
      line = $2
      content = $0
      sub(/^[^:]*:[^:]*:/, "", content)
      # Trim leading whitespace from content for display.
      sub(/^[[:space:]]+/, "", content)
      printf "  %s:%s  %s\n", file, line, content
    }
  '

  echo ""
  echo -e "${YELLOW}Summary: ${leak_count} leak(s) across ${leak_files} file(s).${NC}"
  echo ""
  echo "The theming rule requires palette colors to live only in:"
  for entry in "${ALLOWLIST[@]}"; do
    echo "  - ${entry}"
  done
  echo ""
  echo "Fix: replace the hex literal with a semantic token reference"
  echo "     (e.g. var(--color-surface-base)) defined in src/styles/tokens.css."
fi

# --- Check 2: blue primitives must not exist in tokens.css -------
# The accent value lives in src/config/brandingConfig.ts. The
# tokens file must reference --brand-accent-light / --brand-accent-dark
# instead of defining its own blue palette. We grep for *definitions*
# (lines like `  --color-blue-500: #...;`) in tokens.css only. Comments or
# references elsewhere in the repo are not in scope for this check — the
# contract is that these primitive names no longer exist as CSS custom
# properties in the token source.
echo ""
echo -e "${GREEN}--- Check 2/3: no blue primitives in tokens.css ---${NC}"
echo "Scope: src/styles/tokens.css"
echo ""

TOKENS_FILE="src/styles/tokens.css"
# Match lines that DEFINE a --color-blue-* custom property (i.e. `name:` form,
# not `var(--color-blue-*)` references). The pattern is anchored to the
# characteristic `--color-blue-<digits>:` shape at (optional) leading indent.
set +o pipefail
blue_defs=$(grep -nE '^\s*--color-blue-[0-9]+\s*:' "$TOKENS_FILE" || true)
# References (lines using the retired token via var(--color-blue-*)) are
# also a violation — the accent chain must flow through
# --brand-accent-*, not legacy blue primitives.
blue_refs=$(grep -nE 'var\(\s*--color-blue-[0-9]+\s*\)' "$TOKENS_FILE" || true)
set -o pipefail

check2_failed=0
if [ -z "$blue_defs" ] && [ -z "$blue_refs" ]; then
  echo -e "${GREEN}✓ no --color-blue-* primitives in tokens.css${NC}"
else
  check2_failed=1
  echo -e "${RED}✗ --color-blue-* primitives still present in tokens.css:${NC}"
  echo ""
  if [ -n "$blue_defs" ]; then
    echo "  Definitions:"
    printf '%s\n' "$blue_defs" | awk -F: '
      {
        line = $1
        content = $0
        sub(/^[^:]*:/, "", content)
        sub(/^[[:space:]]+/, "", content)
        printf "    %s:%s  %s\n", "src/styles/tokens.css", line, content
      }
    '
  fi
  if [ -n "$blue_refs" ]; then
    echo "  References:"
    printf '%s\n' "$blue_refs" | awk -F: '
      {
        line = $1
        content = $0
        sub(/^[^:]*:/, "", content)
        sub(/^[[:space:]]+/, "", content)
        printf "    %s:%s  %s\n", "src/styles/tokens.css", line, content
      }
    '
  fi
  echo ""
  echo "The theming rule requires the brand accent to live in src/config/brandingConfig.ts"
  echo "as explicit light and dark values, consumed via --brand-accent-light /"
  echo "--brand-accent-dark. Remove the --color-blue-* primitives from"
  echo "tokens.css and point --color-accent / --color-accent-hover /"
  echo "--color-accent-active-surface / --color-focus-ring at the brand"
  echo "accent custom properties instead."
fi

# --- Check 3: every var(--color-*) names a defined token ------------------
echo ""
echo -e "${GREEN}--- Check 3/3: no undefined --color-* references ---${NC}"
echo "Scope: var(--color-…) in src/**/*.{css,module.css,ts,tsx} against ${TOKENS_FILE}"
echo ""

set +o pipefail
defined=$(grep -oE '^\s*--color-[A-Za-z0-9-]+\s*:' "$TOKENS_FILE" 2>/dev/null \
  | grep -oE -- '--color-[A-Za-z0-9-]+' | sort -u || true)
set -o pipefail
if [ -z "$defined" ]; then
  echo "error: no --color-* definitions found in ${TOKENS_FILE} — the check would flag everything." >&2
  exit 2
fi

set +o pipefail
color_refs=$(rg --no-config --no-ignore --hidden --line-number --no-heading --color=never \
  --sort=path --only-matching --glob '*.css' --glob '*.ts' --glob '*.tsx' \
  'var\(\s*--color-[A-Za-z0-9-]+' src || true)
set -o pipefail

# file:line:var(--color-name → keep the ones whose name is not defined.
undefined_refs=$(printf '%s\n' "$color_refs" | DEFINED="$defined" awk '
  BEGIN { n = split(ENVIRON["DEFINED"], d, "\n"); for (i = 1; i <= n; i++) ok[d[i]] = 1 }
  NF == 0 { next }
  {
    name = $0
    sub(/^.*var\([[:space:]]*/, "", name)
    if (!(name in ok)) {
      loc = $0
      sub(/:var\(.*$/, "", loc)
      printf "  %s  %s\n", loc, name
    }
  }
')

check3_failed=0
if [ -z "$undefined_refs" ]; then
  echo -e "${GREEN}✓ every --color-* reference names a defined token${NC}"
else
  check3_failed=1
  echo -e "${RED}✗ References to --color-* tokens that ${TOKENS_FILE} does not define:${NC}"
  echo ""
  printf '%s\n' "$undefined_refs"
  echo ""
  echo "Fix: use a token ${TOKENS_FILE} defines, or define the missing one there."
fi

# --- Final verdict --------------------------------------------------------
echo ""
if [ "$check1_failed" -eq 0 ] && [ "$check2_failed" -eq 0 ] && [ "$check3_failed" -eq 0 ]; then
  echo -e "${GREEN}Theme token hygiene check PASSED${NC}"
  exit 0
fi
echo -e "${RED}Theme token hygiene check FAILED${NC}"
exit 1
