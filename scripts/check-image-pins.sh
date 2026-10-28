#!/usr/bin/env bash
#
# Pin gate (ADR-0027 § 2026-10-27 amendment, control 3): every image
# reference in the repo carries an `@sha256:` digest.
#
# A floating tag resolves to whatever the registry serves on the day it is
# pulled, so "scanned" and "running" stop being the same image: #637 found
# `postgres:17-alpine` scanning as 17.11 while 17.9 ran. With a digest in
# every reference, what the nightly scans is what a deploy pulls, and
# Renovate proposes every change to it as a PR.
#
# Scope — compose `image:`, Dockerfile `FROM` / `# syntax=`, and `image:`
# keys in workflows and actions, in: docker-compose*.y{a,}ml at the root,
# Dockerfile* at the root and under docker/, .github/workflows/*,
# .github/actions/*/*. Not scanned: images named in shell scripts, a
# string-form `container:`, `uses: docker://` (none unpinned today).
#
# Exempt:
#   - refs tagged `${APP_IMAGE_TAG…}` — first-party images, built by this
#     repo's CI and tagged by commit SHA; the file that selects them
#     cannot know their digest. Any other variable tag is NOT exempt.
#   - `FROM scratch`, and `FROM <stage>` naming an earlier `AS <stage>`.
#
# Exit codes:
#   0  every reference pinned
#   1  at least one unpinned reference; one `<file>:<line>: <ref>: …` per
#      finding on stdout
#   2  docker-compose.yml not found — discovery is pointed at the wrong
#      tree, which must not read as "nothing to pin"

set -euo pipefail

# IMAGE_PINS_REPO_ROOT lets the test harness point at a fixture tree.
REPO_ROOT="${IMAGE_PINS_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

if [[ ! -f "$REPO_ROOT/docker-compose.yml" ]]; then
  echo "ERROR: $REPO_ROOT/docker-compose.yml not found." >&2
  exit 2
fi

REPO_ROOT="$REPO_ROOT" python3 - <<'PY'
import os, re, sys
from pathlib import Path

root = Path(os.environ["REPO_ROOT"])

DIGEST = re.compile(r"@sha256:[0-9a-f]{64}$")
FIRST_PARTY = re.compile(r":\$\{APP_IMAGE_TAG\b")
YAML_IMAGE = re.compile(r"^\s*(?:-\s*)?image:\s*(\S+)")
FROM = re.compile(r"^\s*FROM\s+((?:--\S+\s+)*)(\S+)(?:\s+AS\s+(\S+))?", re.I)
SYNTAX = re.compile(r"^#\s*syntax\s*=\s*(\S+)")


def files():
    yield from sorted(root.glob("docker-compose*.y*ml"))
    yield from sorted(root.glob("Dockerfile*"))
    yield from sorted((root / "docker").rglob("Dockerfile*"))
    yield from sorted((root / ".github/workflows").glob("*.y*ml"))
    yield from sorted((root / ".github/actions").glob("*/*.y*ml"))


def refs(path):
    """(line number, image ref) for every image reference in the file."""
    dockerfile = path.name.startswith("Dockerfile")
    stages = set()
    for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if dockerfile:
            m = SYNTAX.match(line)
            if m:
                yield n, m.group(1)
                continue
            m = FROM.match(line)
            if not m:
                continue
            ref, alias = m.group(2), m.group(3)
            if ref.lower() != "scratch" and ref.lower() not in stages:
                yield n, ref
            if alias:
                stages.add(alias.lower())
        else:
            m = YAML_IMAGE.match(line)
            if m:
                yield n, m.group(1).strip("'\"")


out = []
for path in files():
    for n, ref in refs(path):
        if DIGEST.search(ref) or FIRST_PARTY.search(ref):
            continue
        out.append(f"{path.relative_to(root)}:{n}: {ref}: no @sha256 digest")

for line in out:
    print(line)
sys.exit(1 if out else 0)
PY
