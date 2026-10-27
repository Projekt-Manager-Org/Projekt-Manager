#!/usr/bin/env bash
#
# Enforce the allowlist contract of ADR-0027 §Negative (formats:
# docs/ops/dep-management.md §Allowlist) for osv-scanner.toml,
# .trivyignore.yaml and .grype.yaml. The scanners read only the ids and
# scopes; the owner/reason/expiry convention is otherwise unenforced. Per the
# project's "refuse to serve, fail the deploy, or block the merge"
# principle (CLAUDE.md §Principles), the convention is gated in CI.
#
# Exit code:
#   0 — every active entry carries owner-prefixed reason + expiry
#       within [today, today+90d]; empty files are valid. Bounds are
#       closed on both ends: today (entry valid through end-of-day) and
#       today+90d (max 90-day window per ADR-0027 §Negative).
#   1 — at least one violation; one line per finding on stdout
#       formatted as `<file>:<line>: <field>: <description>`.

set -euo pipefail

# Repo root: parent of this script's directory. ALLOWLIST_REPO_ROOT
# override lets the test harness point at a fixture tree.
REPO_ROOT="${ALLOWLIST_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

OSV_FILE="$REPO_ROOT/osv-scanner.toml"

violations=0

if [[ -f "$OSV_FILE" ]]; then
  # Python carries tomllib (3.11+) and proper date arithmetic. Bash
  # alone can do neither cleanly. OSV_FILE flows in via env, NOT as
  # a positional argv into python heredoc, so quoting in the path
  # stays the shell's problem and the heredoc body stays literal.
  if ! OSV_FILE_PATH="$OSV_FILE" python3 - <<'PY'
import os, re, sys, tomllib
from datetime import date, datetime, timedelta

path = os.environ["OSV_FILE_PATH"]
today = date.today()
max_d = today + timedelta(days=90)
out = []

# GitHub handle: 1-39 chars, alnum + non-leading/trailing/consecutive
# hyphens. Anchored at the start of the reason field after the `@`.
handle_re = re.compile(
    r"^@[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}:"
)

try:
    with open(path, "rb") as f:
        data = tomllib.load(f)
except tomllib.TOMLDecodeError as e:
    print(f"{path}:0: parse: TOML decode error: {e}")
    sys.exit(1)

for i, entry in enumerate(data.get("IgnoredVulns", []), start=1):
    label = f"{path}:0: [[IgnoredVulns]]#{i}"
    if "id" not in entry:
        out.append(f"{label}: id: missing")
    else:
        # tomllib accepts any TOML value; we require a non-empty string
        # so `id = ""` and `id = 12345` are rejected at the gate rather
        # than being passed to OSV-Scanner verbatim.
        v = entry["id"]
        if not isinstance(v, str) or not v.strip():
            out.append(
                f"{label}: id: must be a non-empty TOML string, "
                f"got {type(v).__name__}"
            )
    if "ignoreUntil" not in entry:
        out.append(f"{label}: ignoreUntil: missing")
    else:
        v = entry["ignoreUntil"]
        # tomllib maps bare TOML dates to datetime.date; a TOML offset
        # datetime / local datetime parses to datetime.datetime (subclass
        # of date — the isinstance(date) check would pass, then the
        # `v < today` comparison raises TypeError). Reject both
        # datetimes and non-dates so the only accepted shape is the
        # bare YYYY-MM-DD date literal.
        if isinstance(v, datetime):
            out.append(
                f"{label}: ignoreUntil: must be a bare TOML date "
                f"(YYYY-MM-DD), got TOML datetime"
            )
        elif not isinstance(v, date):
            out.append(
                f"{label}: ignoreUntil: must be a bare TOML date "
                f"(YYYY-MM-DD without quotes), got {type(v).__name__}"
            )
        elif v < today:
            out.append(f"{label}: ignoreUntil: expired ({v} < {today})")
        elif v > max_d:
            out.append(
                f"{label}: ignoreUntil: too far ({v} > today+90d {max_d})"
            )
    if "reason" not in entry:
        out.append(f"{label}: reason: missing")
    else:
        r = entry["reason"]
        # Owner prefix is the only place OSV-Scanner carries
        # accountability — no dedicated owner field exists. Validate
        # the prefix is a real GitHub handle (otherwise `@:` / `@-:`
        # / `@-` slip through and the accountability gate is form-only).
        if not isinstance(r, str) or not handle_re.match(r.lstrip()):
            out.append(
                f"{label}: reason: must start with `@<github-handle>:` "
                f"prefix (1-39 alnum chars + non-leading/trailing hyphens)"
            )

for line in out:
    print(line)
sys.exit(1 if out else 0)
PY
  then
    violations=1
  fi
fi

# Trivy reads a plaintext .trivyignore by default. Since the move to
# .trivyignore.yaml (#637) one would be a global, unscoped allowlist this
# gate never validates, so its mere presence is a violation.
if [[ -f "$REPO_ROOT/.trivyignore" ]]; then
  echo "$REPO_ROOT/.trivyignore:0: file: plaintext allowlist is retired; use .trivyignore.yaml (path-scoped, validated below)"
  violations=1
fi

# YAML allowlists — .trivyignore.yaml and .grype.yaml, each in its
# scanner's native key names (SPECS below; schema: dep-management.md
# § Allowlist). Unknown keys and non-allowlist top-level keys are
# rejected because both scanners silently accept them (measured: Trivy
# v0.70.0, Grype v0.120.1): a misspelt `path:` turns a scoped ignore
# global, and `.grype.yaml` doubles as Grype's config, where `exclude:`
# silenced every node finding. Grype reads no expiry; this is the only
# place it is enforced.
if ! REPO_ROOT="$REPO_ROOT" python3 - <<'PY'
import os, re, sys
from datetime import date, datetime, timedelta
from pathlib import Path

import yaml

root = Path(os.environ["REPO_ROOT"])
today = date.today()
max_d = today + timedelta(days=90)
handle_re = re.compile(r"^@[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$")

SPECS = {
    ".trivyignore.yaml": dict(
        sections=("vulnerabilities", "misconfigurations", "secrets", "licenses"),
        id="id", reason="statement", expiry="expired_at",
        scope=("paths", "purls"),
    ),
    ".grype.yaml": dict(
        sections=("ignore",),
        id="vulnerability", reason="reason", expiry="expires",
        scope=("package",),
    ),
}
GRYPE_PACKAGE_KEYS = {"name", "version", "type", "location", "upstream-name"}

out = []


def nonempty_str(v):
    return isinstance(v, str) and v.strip() != ""


def as_date(v):
    # Only a bare YYYY-MM-DD, which PyYAML reads as datetime.date — the
    # shape Trivy's own `expired_at` parser is guaranteed to accept. Same
    # rule as OSV's ignoreUntil above; a timestamp is rejected too.
    return v if isinstance(v, date) and not isinstance(v, datetime) else None


for name, spec in SPECS.items():
    path = root / name
    if not path.is_file():
        continue
    try:
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as e:
        out.append(f"{path}:0: parse: {e}".replace("\n", " "))
        continue
    if doc is None:
        continue
    if not isinstance(doc, dict):
        out.append(f"{path}:0: parse: top level must be a mapping")
        continue
    for k in sorted(set(doc) - set(spec["sections"]), key=str):
        out.append(
            f"{path}:0: {k}: top-level key not allowed "
            f"(allowlist sections only: {', '.join(spec['sections'])})"
        )
    allowed = {spec["id"], "owner", spec["reason"], spec["expiry"], *spec["scope"]}
    for section in spec["sections"]:
        entries = doc.get(section) or []
        if not isinstance(entries, list):
            out.append(f"{path}:0: {section}: must be a list")
            continue
        for i, e in enumerate(entries, start=1):
            label = f"{path}:0: {section}#{i}"
            if not isinstance(e, dict):
                out.append(f"{label}: must be a mapping")
                continue
            for k in sorted(set(e) - allowed, key=str):
                out.append(f"{label}: {k}: unknown key (allowed: {', '.join(sorted(allowed))})")
            # Mandatory, and non-empty: both scanners read a missing or empty
            # scope as "everywhere" — a gosu entry would also hide Caddy's CVE.
            scopes = [k for k in spec["scope"] if k in e]
            if not scopes:
                out.append(f"{label}: scope: missing ({' or '.join(spec['scope'])}); an unscoped entry ignores everywhere")
            for k in scopes:
                if not e[k]:
                    out.append(f"{label}: {k}: empty scope ignores everywhere")
            if not nonempty_str(e.get(spec["id"])):
                out.append(f"{label}: {spec['id']}: missing or empty")
            if not (isinstance(e.get("owner"), str) and handle_re.match(e["owner"].strip())):
                out.append(
                    f"{label}: owner: must be '@<github-handle>' "
                    f"(1-39 alnum chars + non-leading/trailing hyphens)"
                )
            if not nonempty_str(e.get(spec["reason"])):
                out.append(f"{label}: {spec['reason']}: missing or empty")
            if spec["expiry"] not in e:
                out.append(f"{label}: {spec['expiry']}: missing")
            else:
                d = as_date(e[spec["expiry"]])
                if d is None:
                    out.append(f"{label}: {spec['expiry']}: must be a bare YYYY-MM-DD date")
                elif d < today:
                    out.append(f"{label}: {spec['expiry']}: expired ({d} < {today})")
                elif d > max_d:
                    out.append(f"{label}: {spec['expiry']}: too far ({d} > today+90d {max_d})")
            pkg = e.get("package")
            if name == ".grype.yaml" and pkg is not None:
                if not isinstance(pkg, dict):
                    out.append(f"{label}: package: must be a mapping")
                else:
                    for k in sorted(set(pkg) - GRYPE_PACKAGE_KEYS, key=str):
                        out.append(f"{label}: package.{k}: unknown key")

for line in out:
    print(line)
sys.exit(1 if out else 0)
PY
then
  violations=1
fi

exit "$violations"
