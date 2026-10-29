#!/usr/bin/env bash
#
# Every scheduled workflow is hooked into notify.yml.
#
# notify.yml subscribes to `workflow_run` by workflow NAME. A scheduled
# workflow missing from its `workflows:` list fails red with nobody told:
# the run has no PR to sit on and no triggering human to email, so the
# nightly controls of ADR-0027 § 2026-10-29 — whose whole job is to go
# red — would be inert. Renaming a workflow unhooks it the same way.
#
# Unscheduled workflows are not required: their failures land on a PR or
# a push someone is watching.
#
# Exit codes:
#   0  every scheduled workflow is listed
#   1  at least one is not; one line per workflow on stdout
#   2  notify.yml has no `on.workflow_run.workflows` list — the check
#      cannot run, which must not read as a pass

set -euo pipefail

# NOTIFY_REPO_ROOT lets the test harness point at a fixture tree.
REPO_ROOT="${NOTIFY_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

WORKFLOWS_DIR="$REPO_ROOT/.github/workflows" python3 - <<'PY'
import os, sys
from pathlib import Path

import yaml

wf_dir = Path(os.environ["WORKFLOWS_DIR"])


def triggers(doc):
    # YAML 1.1 reads a bare `on:` key as boolean True.
    on = doc.get("on", doc.get(True)) or {}
    return on if isinstance(on, dict) else {t: None for t in ([on] if isinstance(on, str) else on)}


notify = yaml.safe_load((wf_dir / "notify.yml").read_text(encoding="utf-8")) or {}
listed = (triggers(notify).get("workflow_run") or {}).get("workflows")
if not isinstance(listed, list):
    print(f"ERROR: {wf_dir / 'notify.yml'}: no on.workflow_run.workflows list", file=sys.stderr)
    sys.exit(2)

missing = []
for path in sorted([*wf_dir.glob("*.yml"), *wf_dir.glob("*.yaml")]):
    doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if "schedule" in triggers(doc):
        # GitHub falls back to the file path when a workflow has no name.
        name = doc.get("name") or str(path.relative_to(wf_dir.parent.parent))
        if name not in listed:
            missing.append(f"{path.name}: scheduled workflow '{name}' is not in notify.yml's workflows: list")

for line in missing:
    print(line)
sys.exit(1 if missing else 0)
PY
