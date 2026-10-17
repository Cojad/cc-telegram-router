#!/usr/bin/env python3
"""Format a captured /usage screen as the cc /usage report.

    python3 usage_report.py [--now 2026-10-17T21:30:00+08:00] < screen.txt

Reads the /usage screen on stdin and prints the report: the usage rows
(Session, Weekly, Fable) and the burn rate of the Weekly (all models) row.
--now fixes the current time (tests); without it the clock is used.
The format and the burn rate are described in docs/operations.md
(「cc / 報表腳本」); router/test/usage-report.test.ts checks them.
"""
import math
import re
import sys
from datetime import datetime, timedelta, timezone

TZ8 = timezone(timedelta(hours=8))
PERIOD_DAYS = 7  # the weekly limit resets every 7 days
MIN_ELAPSED = timedelta(hours=1)  # less than this into the week: too early for a rate

SECTIONS = [  # (label, heading on the /usage screen)
    ('Session', 'Current session'),
    ('Weekly', 'Current week (all models)'),
    ('Fable', 'Current week (Fable)'),
]


def parse_reset(text, now):
    """'Resets 5am (UTC)', 'Resets 9:30am (UTC)', 'Resets Oct 20, 8pm (UTC)' -> aware datetime."""
    m = re.search(r'Resets(?: (\w+ \d+),)? (\d{1,2}):?(\d{2})?(am|pm) \(UTC\)', text)
    if not m:
        return None
    month_day, hour, minute, ampm = m.groups()
    hour = int(hour) % 12 + (12 if ampm == 'pm' else 0)
    minute = int(minute) if minute else 0
    now_utc = now.astimezone(timezone.utc)
    if month_day:
        day = datetime.strptime(f'{month_day} {now_utc.year}', '%b %d %Y')
        reset = day.replace(hour=hour, minute=minute, tzinfo=timezone.utc)
        if reset < now_utc - timedelta(days=180):  # Dec -> Jan
            reset = reset.replace(year=reset.year + 1)
        return reset
    reset = now_utc.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if reset < now_utc:
        reset += timedelta(days=1)
    return reset


def parse_usage(raw, now):
    """{label: (used %, reset datetime or None)} for the sections on the screen."""
    out = {}
    for label, heading in SECTIONS:
        m = re.search(re.escape(heading) + r'\n(.*?)(?=\n\s*\n|\nCurrent |\Z)', raw, re.S)
        if not m:
            continue
        used = re.search(r'(\d+(?:\.\d+)?)% used', m.group(1))
        if used:
            out[label] = (float(used.group(1)), parse_reset(m.group(1), now))
    return out


def countdown(delta):
    """Time to the reset in its two largest units, minutes at the smallest: 5d23h, 8h5m, 5m."""
    total_min = max(0, int(delta.total_seconds() // 60))
    d, rest = divmod(total_min, 24 * 60)
    h, m = divmod(rest, 60)
    if d:
        return f'{d}d{h}h'
    return f'{h}h{m}m' if h else f'{m}m'


def bar(pct):
    eighths = '▏▎▍▌▋▊▉█'
    pct = min(100.0, max(0.0, pct))
    full = int(pct // 10)
    idx = round((pct % 10) / 10 * 8)
    partial = ''
    if idx == 8:
        full += 1
    elif idx:
        partial = eighths[idx - 1]
    empty = 10 - full - (1 if partial else 0)
    return '█' * full + partial + '░' * max(0, empty)


def color(pct):
    if pct >= 90:
        return '🔴'
    if pct >= 70:
        return '🟡'
    return '🟢'


def fmt_pct(pct):
    return f'{pct:g}'


def floor1(x):
    """One decimal, rounded down (100/7 shows as 14.2)."""
    return f'{math.floor(x * 10 + 1e-9) / 10:.1f}'


def floor0(x):
    return f'{math.floor(x + 1e-9)}'


def burn_rate(used, left):
    """Burn-rate lines for the weekly limit: used % and the time left to the reset."""
    period = timedelta(days=PERIOD_DAYS)
    left = min(max(left, timedelta(0)), period)
    left_days = left.total_seconds() / 86400
    elapsed = period - left
    perfect = 100 / PERIOD_DAYS
    remaining = max(0.0, 100 - used)
    lines = ['--- 燃燒速率 ---', f'完美速率: {floor1(perfect)}%/天']
    if elapsed < MIN_ELAPSED:
        lines.append('當前速率: 資料不足 (這週剛開始)')
    else:
        current = used / (elapsed.total_seconds() / 86400)
        lines.append(f'當前速率: {floor1(current)}%/天 ({floor0(current / perfect * 100)}% ratio)')
    lines.append(f'剩下 {remaining:.1f}% / {countdown(left)}')
    if remaining <= 0:
        lines.append(f'本週額度已用完, {countdown(left)} 後重置 🛑')
        return lines
    if left_days <= 0:
        lines.append('即將重置')
        return lines
    best = remaining / left_days
    lines.append(f'最高可用 {floor1(best)}%/天燒完')
    if best >= perfect:
        lines.append(f'可以超速 {floor0(best / perfect * 100)}%喔! 🏎️')
    else:
        lines.append(f'超速了, 要減速! 每天最多 {floor1(best)}% 才撐得到重置 🐢')
    return lines


def render(raw, now):
    usage = parse_usage(raw, now)
    out = [f'📊 Token Usage (claude code cli @ {now.astimezone(TZ8):%H:%M})', '']
    for label, _ in SECTIONS:
        if label not in usage:
            continue
        pct, reset = usage[label]
        cd = countdown(reset - now) if reset else '?'
        out.append(f'{label:<7} {bar(pct)}  {fmt_pct(pct)}% used {color(pct)} ↻{cd}')
    weekly = usage.get('Weekly')
    if weekly and weekly[1]:
        out.append('')
        out.extend(burn_rate(weekly[0], weekly[1] - now))
    return '\n'.join(out)


def main(argv):
    now = datetime.now(timezone.utc)
    if len(argv) == 3 and argv[1] == '--now':
        now = datetime.fromisoformat(argv[2])
    elif len(argv) != 1:
        print('usage: usage_report.py [--now ISO-time]  (reads the /usage screen on stdin)', file=sys.stderr)
        return 1
    print(render(sys.stdin.read(), now))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
