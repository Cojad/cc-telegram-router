// scripts/tg-context-chart.py: docs/operations.md 「cc / 報表腳本」.
// With matplotlib: a PNG. Without (a matplotlib package that fails to import is put
// first on PYTHONPATH, which is what a missing or broken install looks like):
// exit 3, a text chart and the install hint on stdout, no PNG.
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const SCRIPT = join(import.meta.dir, '..', '..', 'scripts', 'tg-context-chart.py')
const DATA = {
  total_tokens: 750000, used_tokens: 100600, pct_used: 13, model: 'claude-opus-5-5', ts_gmt8: '2026-10-16 09:40 GMT+8',
  categories: [['System prompt', 4900], ['Messages', 63500], ['Free space', 616400], ['Autocompact buffer', 33000]],
}
const HAS_MATPLOTLIB = Bun.spawnSync(['python3', '-c', 'import matplotlib']).exitCode === 0

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'context-chart-'))
  mkdirSync(join(dir, 'nompl', 'matplotlib'), { recursive: true })
  writeFileSync(join(dir, 'nompl', 'matplotlib', '__init__.py'), "raise ImportError('simulated: no matplotlib')\n")
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const run = (out: string, env: Record<string, string> = {}) =>
  Bun.spawnSync(['python3', SCRIPT, out], { stdin: Buffer.from(JSON.stringify(DATA)), env: { ...process.env, ...env } })

test.skipIf(!HAS_MATPLOTLIB)('tg-context-chart.py with matplotlib writes the donut chart PNG', () => {
  const out = join(dir, 'chart.png')
  const p = run(out)
  expect(p.exitCode).toBe(0)
  expect(p.stdout.toString()).toBe('')
  expect(readFileSync(out).subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
}, 30_000)

test('tg-context-chart.py without matplotlib: exit 3, a text bar per category, each starting where the one above ends, and how to install matplotlib; no PNG', () => {
  const out = join(dir, 'none.png')
  const p = run(out, { PYTHONPATH: join(dir, 'nompl') })
  expect(p.exitCode).toBe(3)
  expect(existsSync(out)).toBe(false)
  expect(p.stdout.toString().split('\n')).toEqual([
    'System prompt       ▏░░░░░░░░░░░░░░░░░░░    0.7%',
    'Messages            █▉░░░░░░░░░░░░░░░░░░    8.5%',
    'Free space          ░▕████████████████▎░   82.2%',
    'Autocompact buffer  ░░░░░░░░░░░░░░░░░░█▏    4.4%',
    '',
    '(沒有 matplotlib, 改用文字圖. 想要圖片請安裝: python3 -m pip install --user matplotlib 或 sudo apt-get install python3-matplotlib)',
    '',
  ])
})

test('tg-context-chart.py text chart: the bars follow on from each other up to 100%; a category with tokens always shows', () => {
  const chart = (categories: Array<[string, number]>) => Bun.spawnSync(['python3', SCRIPT, join(dir, 'x.png')], {
    stdin: Buffer.from(JSON.stringify({ ...DATA, total_tokens: 100, categories })), env: { ...process.env, PYTHONPATH: join(dir, 'nompl') },
  }).stdout.toString().split('\n').slice(0, categories.length)
  expect(chart([['A', 30], ['B', 25], ['C', 45]])).toEqual([
    'A  ██████░░░░░░░░░░░░░░   30.0%',
    'B  ░░░░░░█████░░░░░░░░░   25.0%',
    'C  ░░░░░░░░░░░█████████   45.0%',
  ])
  // 0.01% is far less than an eighth of a cell: it still gets one, right after A
  expect(chart([['A', 30], ['tiny', 0.01], ['C', 69.99]])[1]).toBe('tiny  ░░░░░░▏░░░░░░░░░░░░░    0.0%')
})
