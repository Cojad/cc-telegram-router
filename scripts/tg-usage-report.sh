#!/bin/bash
# cc /usage report: send /usage to the worker's pane, capture the screen and
# print the report made by usage_report.py (next to this script): the usage
# rows and the weekly burn rate. No LLM involved; the router sends stdout as
# it is (docs/operations.md, 「cc / 報表腳本」).
#
# Usage: tg-usage-report.sh <tmux_pane>
set -u
PANE="${1:?usage: tg-usage-report.sh <tmux_pane>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

tmux send-keys -t "$PANE" '/usage' Enter
sleep 1.3

RAW=$(tmux capture-pane -t "$PANE" -p -S -60)

# Leave the view: compare the whole screen, not keywords (old lines in the
# scrollback would match); a second Esc only when the first changed nothing.
BEFORE=$(tmux capture-pane -t "$PANE" -p)
tmux send-keys -t "$PANE" Escape
sleep 0.6
AFTER=$(tmux capture-pane -t "$PANE" -p)
if [ "$BEFORE" == "$AFTER" ]; then
  tmux send-keys -t "$PANE" Escape
  sleep 0.6
fi

printf '%s\n' "$RAW" | python3 "$HERE/usage_report.py"
