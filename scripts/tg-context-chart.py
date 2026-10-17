#!/usr/bin/env python3
"""Render a dark-theme donut chart for /context usage, for Telegram relay.

Usage:
  echo '{"total_tokens": 1000000, "used_tokens": 228300, "pct_used": 23,
         "model": "claude-sonnet-5", "ts_gmt8": "2026-09-15 12:41 GMT+8",
         "categories": [["System prompt", 10200], ["System tools", 29900],
                         ["MCP tools", 891], ["Custom agents", 92],
                         ["Memory files", 6100], ["Skills", 3500],
                         ["Messages", 180400], ["Autocompact buffer", 33000],
                         ["Free space", 735800]]}' \
    | python3 tg-context-chart.py /tmp/context_usage.png

Category order/colors are fixed by name below (matches the real /context
legend); pass whatever subset is present, extras are appended in a spare
color. Output PNG path is the required first argument.
"""
import json
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch

PALETTE = {
    "System prompt": "#8a8a8a",
    "System tools": "#9e9e9e",
    "MCP tools": "#12a3a3",
    "Custom agents": "#8fc7ff",
    "Memory files": "#d787af",
    "Skills": "#e8b400",
    "Messages": "#a074e0",
    "Autocompact buffer": "#4a4a55",
    "Free space": "#2b2b33",
}
FALLBACK_COLORS = ["#e07a5f", "#3d5a80", "#81b29a", "#f2cc8f"]


def main():
    if len(sys.argv) != 2:
        print("usage: tg-context-chart.py <output.png>  (reads JSON on stdin)", file=sys.stderr)
        sys.exit(1)
    out_path = sys.argv[1]
    data = json.load(sys.stdin)

    total = data["total_tokens"]
    categories = []
    fallback_i = 0
    for name, tok in data["categories"]:
        color = PALETTE.get(name)
        if color is None:
            color = FALLBACK_COLORS[fallback_i % len(FALLBACK_COLORS)]
            fallback_i += 1
        categories.append((name, tok, color))

    fig = plt.figure(figsize=(9, 6.2), dpi=200, facecolor="#0e0e14")
    ax = fig.add_axes([0.03, 0.04, 0.55, 0.86])
    ax.set_facecolor("#0e0e14")

    ax.pie(
        [c[1] for c in categories],
        colors=[c[2] for c in categories],
        startangle=90,
        counterclock=False,
        wedgeprops=dict(width=0.38, edgecolor="#0e0e14", linewidth=2),
        radius=1.15,
    )

    used_str = f"{data['used_tokens']/1000:.1f}k" if data["used_tokens"] >= 1000 else str(data["used_tokens"])
    total_str = f"{total/1_000_000:.0f}M" if total >= 1_000_000 else f"{total/1000:.0f}k"
    ax.text(0, 0.12, used_str, ha="center", va="center", fontsize=32, color="white", fontweight="bold")
    ax.text(0, -0.10, f"/ {total_str} tokens", ha="center", va="center", fontsize=13, color="#aaaaaa")
    ax.text(0, -0.30, f"{data['pct_used']:.0f}% used", ha="center", va="center", fontsize=14,
            color="#e8b400", fontweight="bold")

    legend_ax = fig.add_axes([0.60, 0.04, 0.38, 0.86])
    legend_ax.set_facecolor("#0e0e14")
    legend_ax.set_xlim(0, 1)
    legend_ax.set_ylim(0, 1)
    legend_ax.axis("off")

    n = len(categories)
    row_h = 1.0 / (n + 0.5)
    for i, (name, tok, color) in enumerate(categories):
        y = 1.0 - (i + 0.9) * row_h
        legend_ax.add_patch(FancyBboxPatch((0.0, y - row_h * 0.28), 0.07, row_h * 0.56,
                                            boxstyle="round,pad=0,rounding_size=0.02",
                                            linewidth=0, facecolor=color))
        pct = tok / total * 100
        tok_str = f"{tok/1000:.1f}k" if tok >= 1000 else str(tok)
        legend_ax.text(0.11, y, name, fontsize=11.5, color="white", va="center")
        legend_ax.text(0.99, y, f"{tok_str}  ({pct:.1f}%)", fontsize=11, color="#aaaaaa",
                        va="center", ha="right", family="monospace")

    fig.text(0.5, 0.965, "Context Usage", fontsize=17, color="white", ha="center", fontweight="bold")
    fig.text(0.5, 0.925, f"{data.get('model', '')}  ·  {data.get('ts_gmt8', '')}",
             fontsize=10.5, color="#888888", ha="center")

    fig.savefig(out_path, facecolor=fig.get_facecolor())


if __name__ == "__main__":
    main()
