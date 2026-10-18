// bun run test:std | test:area <區名...> | test:changed [base] (docs/testing.md
// 「測試分區」). Runs from the repo root whatever the caller's directory, and
// stops if that is not this repo. The areas and std live in areas.ts. When
// test:changed decides on the whole suite it runs bun run test:full (full.ts).
// Imported (tiers.test.ts) it only exports what decides; run, it runs.

import { existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { AREAS, RUN_ALL, STD, STD_ONLY, type Area } from './areas'

const ROOT = resolve(import.meta.dir, '..', '..')
if (import.meta.main) {
  process.chdir(ROOT)
  let pkgName = ''
  try { pkgName = JSON.parse(readFileSync('package.json', 'utf8')).name } catch {}
  if (process.cwd() !== ROOT || pkgName !== 'claude-channel-telegram' || !existsSync('bunfig.toml') || !existsSync('router/test')) {
    console.error(`not the cc-telegram-router repo: ${process.cwd()}`)
    process.exit(1)
  }
  console.log(`pwd: ${process.cwd()}`)
}

const TEST_DIR = 'router/test'
const testPath = (f: string) => `./${TEST_DIR}/${f}`
const matches = (globs: string[], file: string) => globs.some(g => new Bun.Glob(g).match(file))

/** argv: what follows bun (bun test ..., or bun router/test/full.ts for the whole suite). */
export interface Run { label: string; argv: string[] }

/** The whole suite: full.ts, in parallel, with its log, junit and file list (docs/testing.md 「全套」). */
export const FULL: Run = { label: '全套', argv: [`${TEST_DIR}/full.ts`] }

// std: its whole files in one bun test, in parallel workers (they keep to
// their own temp folders), then each filtered file in its own. The areas'
// files (`whole`) run one after another as the full suite does, and a std
// file they include is not run filtered as well.
function plan(whole: string[]): Run[] {
  const stdWhole = STD.filter(e => !e.filter).map(e => e.file)
  const runs: Run[] = [{ label: 'std', argv: ['test', '--parallel', ...stdWhole.map(testPath)] }]
  for (const e of STD) if (e.filter && !whole.includes(e.file)) runs.push({ label: `std ${e.file}`, argv: ['test', testPath(e.file), '-t', e.filter] })
  const rest = [...new Set(whole)].filter(f => !stdWhole.includes(f))
  if (rest.length > 0) runs.push({ label: '區', argv: ['test', ...rest.map(testPath)] })
  return runs
}

async function exec(runs: Run[]): Promise<number> {
  const started = performance.now()
  const results: Array<{ label: string; code: number; s: number }> = []
  for (const r of runs) {
    console.log(`\n=== ${r.label}: bun ${r.argv.join(' ')}`)
    const t = performance.now()
    const p = Bun.spawn(['bun', ...r.argv], { stdout: 'inherit', stderr: 'inherit' })
    const code = await p.exited
    results.push({ label: r.label, code, s: (performance.now() - t) / 1000 })
  }
  console.log('\n=== 結果')
  for (const r of results) console.log(`${r.code === 0 ? 'ok  ' : 'FAIL'} ${r.s.toFixed(1)}s ${r.label}`)
  console.log(`共 ${((performance.now() - started) / 1000).toFixed(1)}s`)
  return results.some(r => r.code !== 0) ? 1 : 0
}

function findArea(name: string): Area {
  const a = AREAS.find(a => a.name === name)
  if (!a) {
    console.error(`沒有這個區: ${name}. 可用的區: ${AREAS.map(a => a.name).join(', ')}`)
    process.exit(2)
  }
  return a
}

function git(args: string[]): string[] {
  const p = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (p.exitCode !== 0) {
    console.error(`git ${args.join(' ')}: ${p.stderr.toString().trim()}`)
    process.exit(2)
  }
  return p.stdout.toString().split('\n').filter(Boolean)
}

// Changed since the merge base with base, committed or not, plus untracked files.
function changedFiles(base: string): string[] {
  const mb = git(['merge-base', base, 'HEAD'])[0]!
  return [...new Set([...git(['diff', '--name-only', mb]), ...git(['ls-files', '--others', '--exclude-standard'])])].sort()
}

function areasFor(file: string): Area[] {
  return AREAS.filter(a => matches(a.paths, file) || a.tests.some(t => `${TEST_DIR}/${t}` === file))
}

/** test:changed: where each changed file goes (lines, printed), and the runs: the whole suite (FULL)
 *  when a shared core file or one the areas do not cover changed, else std and the areas touched. */
export function decideChanged(files: string[]): { lines: string[]; runs: Run[] } {
  const lines: string[] = []
  const picked = new Set<Area>()
  const runAll: string[] = []
  for (const f of files) {
    if (matches(RUN_ALL, f)) { runAll.push(`${f} (共用核心或建置設定)`); lines.push(`  ${f} -> 全套`); continue }
    const as = areasFor(f)
    if (as.length > 0) { as.forEach(a => picked.add(a)); lines.push(`  ${f} -> ${as.map(a => a.name).join(', ')}`); continue }
    if (matches(STD_ONLY, f)) { lines.push(`  ${f} -> 只跑 std`); continue }
    runAll.push(`${f} (對照檔沒有涵蓋)`)
    lines.push(`  ${f} -> 全套 (對照檔沒有涵蓋)`)
  }
  if (runAll.length > 0) {
    lines.push(`\n決定: 跑全套 (bun run test:full), 原因: ${runAll.join('; ')}`)
    return { lines, runs: [FULL] }
  }
  const areas = AREAS.filter(a => picked.has(a))
  lines.push(`\n決定: std${areas.length ? ` + ${areas.map(a => `${a.name} (${a.title})`).join(', ')}` : ' (沒有受影響的區)'}`)
  return { lines, runs: plan(areas.flatMap(a => a.tests)) }
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2)
  if (cmd === 'std') return exec(plan([]))
  if (cmd === 'area') {
    if (rest.length === 0) {
      console.error('用法: bun run test:area <區名...>')
      for (const a of AREAS) console.error(`  ${a.name.padEnd(10)} ${a.title}: ${a.tests.join(', ')}`)
      return 2
    }
    const areas = rest.map(findArea)
    const files = [...new Set(areas.flatMap(a => a.tests))]
    return exec([{ label: `區 ${areas.map(a => a.name).join(' ')}`, argv: ['test', ...files.map(testPath)] }])
  }
  if (cmd === 'changed') {
    const base = rest[0] ?? 'main'
    const files = changedFiles(base)
    console.log(`對 ${base} 的改動 (含未 commit 與未追蹤的檔案): ${files.length} 個檔`)
    const d = decideChanged(files)
    for (const l of d.lines) console.log(l)
    return exec(d.runs)
  }
  console.error('用法: bun router/test/tiers.ts std | area <區名...> | changed [base]')
  return 2
}

if (import.meta.main) process.exit(await main())
