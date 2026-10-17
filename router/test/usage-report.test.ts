// cc /usage and /status report scripts (scripts/): docs/operations.md 「cc / 報表腳本」.
// The /usage screen is fixed text and the current time is fixed (--now), so the
// whole report, burn rate included, is compared line by line.
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const SCRIPTS = join(import.meta.dir, '..', '..', 'scripts')

/** The /usage view as Claude Code draws it, with the Weekly (all models) row given. */
function screen(weeklyUsed: number, weeklyReset: string): string {
  return [
    '   Settings  Status   Config   Usage   Stats',
    '',
    '   Current session',
    '   ██                                                 4% used',
    '   Resets 5am (UTC)',
    '',
    '   Current week (all models)',
    `   ${'█'.repeat(Math.round(weeklyUsed / 2))}${' '.repeat(50 - Math.round(weeklyUsed / 2))} ${weeklyUsed}% used`,
    `   Resets ${weeklyReset} (UTC)`,
    '',
    '   Current week (Fable)',
    '                                                      0% used',
    `   Resets ${weeklyReset} (UTC)`,
    '',
    '   Esc to cancel',
  ].join('\n')
}

/** Run usage_report.py on a screen at a fixed time (GMT+8 ISO). */
function report(raw: string, now: string): string[] {
  const p = Bun.spawnSync(['python3', join(SCRIPTS, 'usage_report.py'), '--now', now], { stdin: Buffer.from(raw) })
  expect(p.exitCode).toBe(0)
  return p.stdout.toString().trimEnd().split('\n')
}

/** Only the burn-rate part of the report. */
const burn = (lines: string[]) => lines.slice(lines.indexOf('--- 燃燒速率 ---'))

// The weekly reset in these screens: Oct 20, 8pm UTC = 2026-10-21 04:00 GMT+8.
const RESET = 'Oct 20, 8pm'

test('usage report: rows and burn rate, the example from the spec (6% used, 5d23h15m left)', () => {
  expect(report(screen(6, RESET), '2026-10-15T04:45:00+08:00')).toEqual([
    '📊 Token Usage (claude code cli @ 04:45)',
    '',
    'Session ▍░░░░░░░░░  4% used 🟢 ↻8h15m',
    'Weekly  ▋░░░░░░░░░  6% used 🟢 ↻5d23h',
    'Fable   ░░░░░░░░░░  0% used 🟢 ↻5d23h',
    '',
    '--- 燃燒速率 ---',
    '完美速率: 14.2%/天',
    '當前速率: 5.8%/天 (40% ratio)',
    '剩下 94.0% / 5d23h',
    '最高可用 15.7%/天燒完',
    '可以超速 110%喔! 🏎️',
  ])
})

test('usage report: the week has just begun, less than an hour in: no current rate yet', () => {
  expect(burn(report(screen(0, RESET), '2026-10-14T04:30:00+08:00'))).toEqual([
    '--- 燃燒速率 ---',
    '完美速率: 14.2%/天',
    '當前速率: 資料不足 (這週剛開始)',
    '剩下 100.0% / 6d23h',
    '最高可用 14.3%/天燒完',
    '可以超速 100%喔! 🏎️',
  ])
  // an hour in, the rate shows
  expect(burn(report(screen(1, RESET), '2026-10-14T05:00:00+08:00'))[2]).toBe('當前速率: 24.0%/天 (168% ratio)')
})

test('usage report: burning faster than the perfect rate says to slow down, with the daily cap', () => {
  // 3 days in (4 days left), 60% used
  expect(burn(report(screen(60, RESET), '2026-10-17T04:00:00+08:00'))).toEqual([
    '--- 燃燒速率 ---',
    '完美速率: 14.2%/天',
    '當前速率: 20.0%/天 (140% ratio)',
    '剩下 40.0% / 4d0h',
    '最高可用 10.0%/天燒完',
    '超速了, 要減速! 每天最多 10.0% 才撐得到重置 🐢',
  ])
})

test('usage report: close to the reset, the time left is in hours and minutes', () => {
  // 2h left, 85% used
  expect(burn(report(screen(85, RESET), '2026-10-21T02:00:00+08:00'))).toEqual([
    '--- 燃燒速率 ---',
    '完美速率: 14.2%/天',
    '當前速率: 12.2%/天 (86% ratio)',
    '剩下 15.0% / 2h0m',
    '最高可用 180.0%/天燒完',
    '可以超速 1260%喔! 🏎️',
  ])
  // 20 minutes left
  expect(burn(report(screen(85, RESET), '2026-10-21T03:40:00+08:00'))[3]).toBe('剩下 15.0% / 20m')
})

test('usage report: every countdown shows its two largest units, minutes at the smallest', () => {
  // session reset 5am UTC = 13:00 GMT+8, weekly 2026-10-21 04:00 GMT+8
  const rows = (now: string) => report(screen(6, RESET), now).slice(2, 4)
  expect(rows('2026-10-15T04:55:00+08:00')).toEqual(['Session ▍░░░░░░░░░  4% used 🟢 ↻8h5m', 'Weekly  ▋░░░░░░░░░  6% used 🟢 ↻5d23h'])
  expect(rows('2026-10-20T12:55:00+08:00')).toEqual(['Session ▍░░░░░░░░░  4% used 🟢 ↻5m', 'Weekly  ▋░░░░░░░░░  6% used 🟢 ↻15h5m'])
  expect(rows('2026-10-17T13:00:00+08:00')[1]).toBe('Weekly  ▋░░░░░░░░░  6% used 🟢 ↻3d15h')
})

test('usage report: the weekly limit used up', () => {
  expect(burn(report(screen(100, RESET), '2026-10-20T04:00:00+08:00'))).toEqual([
    '--- 燃燒速率 ---',
    '完美速率: 14.2%/天',
    '當前速率: 16.6%/天 (116% ratio)',
    '剩下 0.0% / 1d0h',
    '本週額度已用完, 1d0h 後重置 🛑',
  ])
})

test('usage report: a reset in January seen in December is next year', () => {
  // Jan 2, 8pm UTC = 2027-01-03 04:00 GMT+8; 2 days left
  expect(burn(report(screen(50, 'Jan 2, 8pm'), '2027-01-01T04:00:00+08:00'))[3]).toBe('剩下 50.0% / 2d0h')
})

test('usage report: no burn rate without a weekly row or its reset time', () => {
  const noWeekly = screen(6, RESET).replace(/   Current week \(all models\)[\s\S]*?\n\n/, '')
  const lines = report(noWeekly, '2026-10-15T04:45:00+08:00')
  expect(lines).not.toContain('--- 燃燒速率 ---')
  expect(lines.some(l => l.startsWith('Weekly'))).toBe(false)
  const noReset = report(screen(6, RESET).replace(`Resets ${RESET} (UTC)`, ''), '2026-10-15T04:45:00+08:00')
  expect(noReset).toContain('Weekly  ▋░░░░░░░░░  6% used 🟢 ↻?')
  expect(noReset).not.toContain('--- 燃燒速率 ---')
})

// The shell wrappers, with a fake tmux that shows the screen and records the keys.
let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'usage-report-'))
  writeFileSync(join(dir, 'screen.txt'), screen(6, RESET) + '\n   Session ID: 00000000-0000-0000-0000-000000000000\n   Email: user@example.com\n   Version: 2.1.302\n   Model: claude-opus-5-5\n')
  writeFileSync(join(dir, 'tmux'), `#!/bin/sh\necho "$*" >> "${dir}/keys.log"\n[ "$1" = capture-pane ] && cat "${dir}/screen.txt"\nexit 0\n`, { mode: 0o755 })
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('the report scripts in the repo are executable', () => {
  for (const f of ['tg-usage-report.sh', 'tg-status-report.sh', 'tg-context-chart.py', 'usage_report.py']) {
    expect(statSync(join(SCRIPTS, f)).mode & 0o111).not.toBe(0)
  }
})

test('tg-usage-report.sh sends /usage, leaves the view and prints the report with the burn rate', () => {
  const p = Bun.spawnSync([join(SCRIPTS, 'tg-usage-report.sh'), 'relay-w'], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } })
  expect(p.exitCode).toBe(0)
  const out = p.stdout.toString()
  expect(out).toStartWith('📊 Token Usage (claude code cli @ ')
  expect(out).toContain('Weekly  ▋░░░░░░░░░  6% used')
  expect(out).toContain('--- 燃燒速率 ---\n完美速率: 14.2%/天\n')
  const keys = Bun.file(join(dir, 'keys.log'))
  return keys.text().then(t => {
    expect(t).toContain('send-keys -t relay-w /usage Enter')
    expect(t).toContain('send-keys -t relay-w Escape')
  })
}, 15_000)

test('tg-status-report.sh prints only Version, Session kind and Model', () => {
  const p = Bun.spawnSync([join(SCRIPTS, 'tg-status-report.sh'), 'relay-w'], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } })
  expect(p.exitCode).toBe(0)
  expect(p.stdout.toString()).toBe('Version  2.1.302\nModel    claude-opus-5-5\n')
}, 15_000)
