# shellcheck shell=bash
# Shared by the notify.yml step tests: `workflow_run` only fires from the
# default branch's copy, so a step's logic is tested by running its real
# `run:` body, not a copy that can drift from what ships.
#
# extract_run_step <workflow> <step-id>
#   Prints the `run: |` body of the step whose `id:` is <step-id>, dedented.
#   Exits 3 when there is no such step or it has no `run: |` block.
#
# Structural, not line-numbered: reordering the steps or reindenting the file
# does not fool it. awk rather than a YAML parser for the same reason as
# check-workflow-drift.sh — this must run with nothing beyond a standard
# POSIX toolchain.
extract_run_step() {
  awk -v id="$2" '
    # `id: <id>` arms the extractor; the next `run: |` is ours.
    $0 ~ "^[[:space:]]*id:[[:space:]]*" id "[[:space:]]*$" { armed = 1; next }
    # The next step began first: ours has no `run: |`.
    armed && /^[[:space:]]*-[[:space:]]/ { armed = 0 }

    armed && /^[[:space:]]*run:[[:space:]]*\|[[:space:]]*$/ {
      match($0, /^[[:space:]]*/)
      run_indent = RLENGTH
      armed = 0
      in_run = 1
      next
    }

    in_run {
      if ($0 ~ /^[[:space:]]*$/) { lines[++n] = ""; next }   # blank lines belong to the block
      match($0, /^[[:space:]]*/)
      indent = RLENGTH
      if (indent <= run_indent) { in_run = 0; next }        # dedent ends the block
      lines[++n] = $0
      if (!have_min || indent < min) { min = indent; have_min = 1 }
    }

    END {
      if (!have_min) { exit 3 }
      for (i = 1; i <= n; i++) print substr(lines[i], min + 1)
    }
  ' "$1"
}
