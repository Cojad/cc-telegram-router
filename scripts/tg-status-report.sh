#!/bin/bash
# cc /status report: send /status to the worker's pane, capture the screen,
# print a few whitelisted fields. No LLM involved; the router sends stdout
# as it is (docs/operations.md, 「cc / 報表腳本」).
#
# Whitelist, not blacklist: only the fields listed below are ever printed.
# Session ID, Email, Organization, Peer address (socket path) and Login
# method are private identifiers and must never appear here.
#
# Usage: tg-status-report.sh <tmux_pane>
set -u
PANE="${1:?usage: tg-status-report.sh <tmux_pane>}"

tmux send-keys -t "$PANE" '/status' Enter
sleep 1.0

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

echo "$RAW" | python3 -c "
import re, sys

raw = sys.stdin.read()

# (display label, regex for the value on its own line)
WHITELIST = [
    ('Version',      r'Version:\s*(.+)'),
    ('Session kind', r'Session kind:\s*(.+)'),
    ('Model',        r'Model:\s*(.+)'),
]

rows = []
for label, pat in WHITELIST:
    m = re.search(pat, raw)
    if m:
        rows.append((label, m.group(1).strip()))

if not rows:
    print('(/status 擷取失敗, 沒抓到任何欄位)')
else:
    width = max(len(l) for l, _ in rows)
    for label, val in rows:
        print(f'{label:<{width}}  {val}')
"
