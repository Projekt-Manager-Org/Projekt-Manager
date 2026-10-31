#!/usr/bin/env bash
#
# Enforce exception-register.yaml (docs/ops/dep-management.md § Exception
# register): every exception with no expiry of its own has a row with
# owner, reason, drop condition and a review date at most 90 days out, the
# allowlist window (ADR-0027 §Negative). The exceptions are discovered from
# their sources, so one without a row fails, and so does a row whose
# exception is gone: the PR that changes an exception changes its row. A
# pinned issue held this list before (#669); nothing could check it, and an
# unlisted type shim outlived its drop condition by five months.
#
# Exit code:
#   0 — every discovered exception is covered by exactly one row, every
#       row covers live exceptions only and meets the row contract
#       (review_by within [today, today+90d]); no exceptions and no
#       register is valid.
#   1 — at least one violation; one line per finding on stdout.
#   2 — bad arguments.
#
# --base-dir <dir> (the PR gate in `lint`): a row past its review_by that
# is unchanged from the base's copy in <dir> is a warning, not a violation:
# main's lapse, which the nightly turns red on (the allowlists' rule,
# check-allowlist-schema.sh). An unregistered exception or a stale row is
# always the change's own.

set -euo pipefail

BASE_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-dir)
      BASE_DIR="${2:-}"
      if [[ -z "$BASE_DIR" ]]; then
        echo "ERROR: --base-dir needs a directory" >&2
        exit 2
      fi
      shift 2
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

# Repo root: parent of this script's directory. REGISTER_REPO_ROOT lets the
# test harness point at a fixture tree.
REPO_ROOT="${REGISTER_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

# A source that does not parse crashes the check, which exits 1: fail closed.
REPO_ROOT="$REPO_ROOT" BASE_DIR="$BASE_DIR" exec python3 - <<'PY'
import json, os, re, sys
from datetime import date, datetime, timedelta
from pathlib import Path

import yaml

root = Path(os.environ["REPO_ROOT"])
base_dir = os.environ.get("BASE_DIR", "")
today = date.today()
max_d = today + timedelta(days=90)
handle_re = re.compile(r"^@[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$")

REGISTER = "exception-register.yaml"
ROW_KEYS = {"covers", "owner", "reason", "drop_when", "review_by"}
# The `covers` keys, `<kind>:<name>`:
#   npm-override       a leaf of package.json `overrides`
#   type-shim          an ambient `declare module '<pkg>'`
#   renovate-disabled  a package or setting Renovate is told to skip
KINDS = ("npm-override", "type-shim", "renovate-disabled")
# A .d.ts with a top-level import/export is a module, where `declare
# module` augments the package instead of replacing its types; `'*.css'`
# declares asset imports, not a package.
SHIM_RE = re.compile(r"""^declare\s+module\s+['"]([^'"*]+)['"]""", re.M)
MODULE_RE = re.compile(r"^(?:import|export)\b", re.M)
# Not the repo's own code: `.claude` holds whole worktrees.
SKIP_DIRS = {".git", ".claude", "node_modules", "dist", "coverage", "playwright-report"}
RULE_RE = re.compile(r"/packageRules/\d+$")

out = []
found = {}  # covers key -> where it lives


def nonempty_str(v):
    return isinstance(v, str) and v.strip() != ""


def as_date(v):
    # A bare YYYY-MM-DD only, which PyYAML reads as datetime.date; a quoted
    # string or a timestamp is rejected, as in the allowlists.
    return v if isinstance(v, date) and not isinstance(v, datetime) else None


def npm_overrides(tree, path):
    # npm scopes an override by nesting: {"a": {"b": "1"}} pins b under a
    # only, and "." is the parent itself. Each leaf is its own exception.
    for k, v in tree.items():
        if k == ".":
            yield ">".join(path)
        elif isinstance(v, dict):
            yield from npm_overrides(v, path + [k])
        else:
            yield ">".join(path + [k])


def renovate_disabled(node, path):
    # A package rule is keyed on the packages it names. A setting is keyed
    # on its path, which starts with `/` where a package name cannot:
    # `/lockFileMaintenance`, `/` for the whole config.
    if isinstance(node, list):
        for i, v in enumerate(node):
            yield from renovate_disabled(v, f"{path}/{i}")
        return
    if not isinstance(node, dict):
        return
    for name in node.get("ignoreDeps") or []:
        yield name, f"{path}/ignoreDeps"
    for glob in node.get("ignorePaths") or []:
        yield f"{path}/ignorePaths/{glob}", f"{path}/ignorePaths"
    if "enabledManagers" in node:
        yield f"{path}/enabledManagers", f"{path}/enabledManagers"
    if node.get("enabled") is False:
        if RULE_RE.search(path):
            names = node.get("matchPackageNames") or []
            if not names:
                out.append(f".github/renovate.json:0: {path}: enabled: false must list matchPackageNames; register rows are keyed on them")
            for name in names:
                yield name, path
        else:
            yield path or "/", path or "/"
    for k, v in node.items():
        yield from renovate_disabled(v, f"{path}/{k}")


pkg_json = root / "package.json"
if pkg_json.is_file():
    overrides = json.loads(pkg_json.read_text(encoding="utf-8")).get("overrides") or {}
    for k in npm_overrides(overrides, []):
        found[f"npm-override:{k}"] = "package.json overrides"
renovate = root / ".github" / "renovate.json"
if renovate.is_file():
    for k, where in renovate_disabled(json.loads(renovate.read_text(encoding="utf-8")), ""):
        found[f"renovate-disabled:{k}"] = f".github/renovate.json {where}"
for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
    for f in filenames:
        if f.endswith(".d.ts"):
            p = Path(dirpath) / f
            text = p.read_text(encoding="utf-8")
            if not MODULE_RE.search(text):
                for m in SHIM_RE.finditer(text):
                    found[f"type-shim:{m.group(1)}"] = str(p.relative_to(root))


def load_rows(path):
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    if doc is None:
        return [], []
    if not isinstance(doc, dict):
        return [], ["top level must be a mapping"]
    errors = [f"{k}: top-level key not allowed (exceptions only)" for k in sorted(set(doc) - {"exceptions"}, key=str)]
    rows = doc.get("exceptions") or []
    if not isinstance(rows, list):
        return [], errors + ["exceptions: must be a list"]
    return rows, errors


def base_rows():
    # Rows exactly as the base has them (see --base-dir). An unreadable or
    # malformed base copy counts as none: every lapsed row stays a violation.
    p = Path(base_dir) / REGISTER if base_dir else None
    if p is None or not p.is_file():
        return []
    try:
        return load_rows(p)[0]
    except yaml.YAMLError:
        return []


reg = root / REGISTER
rows = []
if reg.is_file():
    try:
        rows, errors = load_rows(reg)
    except yaml.YAMLError as e:
        rows, errors = [], [f"parse: {e}".replace("\n", " ")]
    out.extend(f"{reg}:0: {e}" for e in errors)

covered = {}
for i, e in enumerate(rows, start=1):
    label = f"{reg}:0: exceptions#{i}"
    if not isinstance(e, dict):
        out.append(f"{label}: must be a mapping")
        continue
    for k in sorted(set(e) - ROW_KEYS, key=str):
        out.append(f"{label}: {k}: unknown key (allowed: {', '.join(sorted(ROW_KEYS))})")
    covers = e.get("covers")
    if not (isinstance(covers, list) and covers and all(nonempty_str(c) for c in covers)):
        out.append(f"{label}: covers: must be a non-empty list of '<kind>:<name>' strings")
        covers = []
    for c in covers:
        if ":" not in c or c.split(":", 1)[0] not in KINDS:
            out.append(f"{label}: covers: {c}: unknown kind (one of: {', '.join(KINDS)})")
        elif c not in found:
            out.append(f"{label}: covers: {c}: no such exception; drop it from the row")
        covered[c] = covered.get(c, 0) + 1
    if not (isinstance(e.get("owner"), str) and handle_re.match(e["owner"].strip())):
        out.append(f"{label}: owner: must be '@<github-handle>' (1-39 alnum chars + non-leading/trailing hyphens)")
    for k in ("reason", "drop_when"):
        if not nonempty_str(e.get(k)):
            out.append(f"{label}: {k}: missing or empty")
    if "review_by" not in e:
        out.append(f"{label}: review_by: missing")
    else:
        d = as_date(e["review_by"])
        if d is None:
            out.append(f"{label}: review_by: must be a bare YYYY-MM-DD date")
        elif d < today and e in base_rows():
            print(f"warning: {label}: review_by: lapsed ({d} < {today}), unchanged from the base", file=sys.stderr)
        elif d < today:
            out.append(f"{label}: review_by: lapsed ({d} < {today}); re-check drop_when, then drop the exception or renew")
        elif d > max_d:
            out.append(f"{label}: review_by: too far ({d} > today+90d {max_d})")

for c in sorted(k for k, n in covered.items() if n > 1):
    out.append(f"{reg}:0: {c}: covered more than once")
for c in sorted(set(found) - set(covered)):
    out.append(f"{reg}:0: {c}: unregistered ({found[c]}); add a row (dep-management.md § Exception register)")

for line in out:
    print(line)
sys.exit(1 if out else 0)
PY
