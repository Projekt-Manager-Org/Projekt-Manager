#!/usr/bin/env bash
#
# Enforce the allowlist contract of ADR-0027 §Negative (formats:
# docs/ops/dep-management.md §Allowlist) for osv-scanner.toml,
# .trivyignore.yaml and .grype.yaml. No scanner enforces owner and reason,
# Grype ignores expiry, and Trivy and Grype accept unknown keys. Per the
# project's "refuse to serve, fail the deploy, or block the merge"
# principle (CLAUDE.md §Principles), the convention is gated in CI.
#
# Exit code:
#   0 — every active entry meets §Negative (id, owner, reason, expiry
#       within [today, today+90d], scope); empty files are valid. Bounds are
#       closed on both ends: today (entry valid through end-of-day) and
#       today+90d (max 90-day window per ADR-0027 §Negative).
#   1 — at least one violation; one line per finding on stdout
#       formatted as `<file>:<line>: <field>: <description>`.
#   2 — bad arguments.
#
# --base-dir <dir> (the PR gate in `lint`, #668): an expired entry that is
# unchanged from the base's copy of its file in <dir> is a warning, not a
# violation. Expiry is `main`'s state, not the change's: the nightlies run
# without the flag and turn red on it (ADR-0027 § 2026-10-31). An entry a
# change adds or edits is held to the full contract, expiry included.

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
export BASE_DIR

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
base_dir = os.environ.get("BASE_DIR", "")
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

# `[[PackageOverrides]]` (`ignore = true` per package) and the scanner's
# other keys would suppress with no owner or expiry.
for k in sorted(set(data) - {"IgnoredVulns"}):
    out.append(f"{path}:0: {k}: top-level key not allowed (IgnoredVulns only)")

# Entries exactly as the base has them (see --base-dir). An unreadable base
# copy counts as none: every expired entry then stays a violation.
base_entries = []
base_path = os.path.join(base_dir, "osv-scanner.toml") if base_dir else ""
if base_path and os.path.isfile(base_path):
    try:
        with open(base_path, "rb") as f:
            base_entries = tomllib.load(f).get("IgnoredVulns", [])
    except tomllib.TOMLDecodeError:
        pass

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
        elif v < today and entry in base_entries:
            print(f"warning: {label}: ignoreUntil: expired ({v} < {today}), unchanged from the base", file=sys.stderr)
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
base_dir = os.environ.get("BASE_DIR", "")
today = date.today()
max_d = today + timedelta(days=90)
handle_re = re.compile(r"^@[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$")

SPECS = {
    ".trivyignore.yaml": dict(
        sections=("vulnerabilities", "misconfigurations", "secrets", "licenses"),
        id="id", reason="statement", expiry="expired_at",
        scope=("paths", "purls"),
        # Only vulnerability findings carry a PURL; Trivy matches `purls`
        # against a finding without one as "any", so elsewhere it is global.
        scope_by_section={"vulnerabilities": ("paths", "purls")},
        default_scope=("paths",),
    ),
    ".grype.yaml": dict(
        sections=("ignore",),
        id="vulnerability", reason="reason", expiry="expires",
        scope=("package",),
    ),
}
GRYPE_PACKAGE_KEYS = {"name", "version", "type", "location", "upstream-name"}
# Trivy matches `paths` and Grype `location` as globs; Grype switches
# `name` and `upstream-name` to regex mode on any of REGEX_CHARS (its
# isRegexPattern, v0.120.1; `.` alone stays literal). A pattern matching
# everything is a global ignore (`{,x}` reads like a path), so scopes are
# literal. `purls` are exempt: `?` starts a purl's qualifiers.
GLOB_CHARS = set("*?[]{}")
REGEX_CHARS = set("^$*+?[](){}|\\")
GO_STDLIB_PURL = "pkg:golang/stdlib"

out = []


def nonempty_str(v):
    return isinstance(v, str) and v.strip() != ""


def as_date(v):
    # Only a bare YYYY-MM-DD, which PyYAML reads as datetime.date — the
    # shape Trivy's own `expired_at` parser is guaranteed to accept. Same
    # rule as OSV's ignoreUntil above; a timestamp is rejected too.
    return v if isinstance(v, date) and not isinstance(v, datetime) else None


def base_entries(name, section):
    # Entries exactly as the base has them (see --base-dir); merge keys are
    # resolved on both sides. An unreadable base copy counts as none.
    p = Path(base_dir) / name if base_dir else None
    if p is None or not p.is_file():
        return []
    try:
        doc = yaml.safe_load(p.read_text(encoding="utf-8"))
    except yaml.YAMLError:
        return []
    entries = doc.get(section) if isinstance(doc, dict) else None
    return entries if isinstance(entries, list) else []


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
    for section in spec["sections"]:
        scope_keys = spec.get("scope_by_section", {}).get(section, spec.get("default_scope", spec["scope"]))
        allowed = {spec["id"], "owner", spec["reason"], spec["expiry"], *scope_keys}
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
            # Empty VALUES count as missing too: Trivy matches an empty path
            # against every OS package, Grype skips empty package fields.
            scopes = [k for k in scope_keys if k in e]
            if not scopes:
                out.append(f"{label}: scope: missing ({' or '.join(scope_keys)}); an unscoped entry ignores everywhere")
            for k in scopes:
                v = e[k]
                values = list(v.values()) if isinstance(v, dict) else v if isinstance(v, list) else None
                if not values or not all(nonempty_str(x) for x in values):
                    out.append(f"{label}: {k}: must hold only non-empty strings; an empty scope ignores everywhere")
                    continue
                literal = {"paths": v} if k == "paths" else {f: v.get(f) for f in ("location", "name", "upstream-name")} if k == "package" else {}
                for f, vals in literal.items():
                    for x in vals if isinstance(vals, list) else [vals] if vals is not None else []:
                        if set(x) & (REGEX_CHARS if f in ("name", "upstream-name") else GLOB_CHARS):
                            out.append(f"{label}: {k}: {x!r} is a pattern; scopes must be literal (a wildcard ignores everywhere)")
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
                elif d < today and e in base_entries(name, section):
                    print(f"warning: {label}: {spec['expiry']}: expired ({d} < {today}), unchanged from the base", file=sys.stderr)
                elif d < today:
                    out.append(f"{label}: {spec['expiry']}: expired ({d} < {today})")
                elif d > max_d:
                    out.append(f"{label}: {spec['expiry']}: too far ({d} > today+90d {max_d})")
            # Go's stdlib is compiled into every Go binary (gosu, Caddy), so
            # by name or purl alone a waiver for one hides the CVE in all.
            purls = e.get("purls")
            if name == ".trivyignore.yaml" and "paths" not in e and isinstance(purls, list) and any(
                isinstance(p, str) and p.startswith(GO_STDLIB_PURL) for p in purls
            ):
                out.append(f"{label}: purls: Go stdlib must be scoped by `paths` (the binary); a purl matches every Go binary built with that Go")
            pkg = e.get("package")
            if name == ".grype.yaml" and pkg is not None:
                if not isinstance(pkg, dict):
                    out.append(f"{label}: package: must be a mapping")
                else:
                    for k in sorted(set(pkg) - GRYPE_PACKAGE_KEYS, key=str):
                        out.append(f"{label}: package.{k}: unknown key")
                    # Type and version are shared by many packages: `{type:
                    # go-module, version: go1.24.6}` is the stdlib of every
                    # binary built with that Go.
                    if not {"name", "upstream-name", "location"} & set(pkg):
                        out.append(f"{label}: package: needs name, upstream-name or location; type and version alone match many packages")
                    elif "stdlib" in (pkg.get("name"), pkg.get("upstream-name")) and "location" not in pkg:
                        out.append(f"{label}: package: Go stdlib needs `location` (the binary); by name it matches every Go binary")

for line in out:
    print(line)
sys.exit(1 if out else 0)
PY
then
  violations=1
fi

exit "$violations"
