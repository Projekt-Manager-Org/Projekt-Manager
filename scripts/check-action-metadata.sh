#!/usr/bin/env bash
#
# No composite action carries `${{` in its metadata strings.
#
# The runner evaluates expressions in an action.yml's prose too. One quoted
# in a description (`if: ${{ !cancelled() }}`) fails the manifest load, and
# with it every step that uses the action — upload-findings broke every
# nightly that way (#736). actionlint reads an action.yml only for its
# inputs, and an action that only nightlies use first loads on main.
#
# Checked: name, description, author, and each input's and output's
# description. Expressions belong in `runs` and in an output's `value`.
#
# Exit codes:
#   0  no metadata string carries `${{`
#   1  at least one does; one `<file>: <field>` line per hit on stdout
#   2  no .github/actions/*/action.yml found, or one does not parse

set -euo pipefail

# ACTION_METADATA_REPO_ROOT lets the test harness point at a fixture tree.
REPO_ROOT="${ACTION_METADATA_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

ACTIONS_DIR="$REPO_ROOT/.github/actions" python3 - <<'PY'
import os, sys
from pathlib import Path

import yaml

actions_dir = Path(os.environ["ACTIONS_DIR"])
paths = sorted(actions_dir.glob("*/action.yml"))
if not paths:
    print(f"ERROR: no action.yml under {actions_dir}", file=sys.stderr)
    sys.exit(2)


def metadata(doc):
    for field in ("name", "description", "author"):
        yield field, doc.get(field)
    for section in ("inputs", "outputs"):
        for key, spec in (doc.get(section) or {}).items():
            yield f"{section}.{key}.description", (spec or {}).get("description")


hits = []
for path in paths:
    try:
        doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as e:
        print(f"ERROR: {path}: {e}", file=sys.stderr)
        sys.exit(2)
    rel = path.relative_to(actions_dir)
    hits += [f"{rel}: {field}" for field, value in metadata(doc) if "${{" in str(value or "")]

for line in hits:
    print(line)
sys.exit(1 if hits else 0)
PY
