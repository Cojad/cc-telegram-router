// bun run test:full's progress lines (docs/testing.md 「全套」「進度」,
// router/test/progress.ts, progress-preload.ts): the line's format with and
// without an estimate, ❌ on a failed file; the estimate from the timings
// (the .test-out file first, left over the workers, at least the longest
// file, none when a file has no time); a finished file waiting for bun's
// failure block, a later failure on a line of its own, pass and fail counts;
// and the preload in a real bun test --parallel run (one start and one done
// per file with the tests that ran, the junit the same as without it, bun's
// (fail) lines under each file's path).

import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { estimateMs, formatLine, loadTimings, parseEvent, Progress, GRACE_MS } from './progress'

const dir = mkdtempSync(join(tmpdir(), 'cctr-progress-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('the line: position, percent, elapsed, estimate, pass and fail so far, ❌ before a failed file; no estimate, no column', () => {
  expect(formatLine({ index: 23, total: 80, elapsedMs: 31_200, etaMs: 64_000, pass: 241, fail: 0, failed: false, file: 'router/test/e2e-managed.test.ts' }))
    .toBe('[ 23/80]  29%  經過 31s  預估剩 64s  pass 241  fail 0   e2e-managed.test.ts')
  expect(formatLine({ index: 24, total: 80, elapsedMs: 33_000, etaMs: 61_400, pass: 252, fail: 1, failed: true, file: 'router/test/diagnose.test.ts' }))
    .toBe('[ 24/80]  30%  經過 33s  預估剩 61s  pass 252  fail 1 ❌ diagnose.test.ts')
  expect(formatLine({ index: 3, total: 120, elapsedMs: 900, etaMs: null, pass: 7, fail: 0, failed: false, file: 'router/test/a.test.ts' }))
    .toBe('[  3/120]   3%  經過 1s  pass 7  fail 0   a.test.ts')
})

test('the estimate: this machine\'s timings before the baseline; what is left over the workers, at least the longest file; a started file counts what is left of it; none when a file has no time', () => {
  const local = join(dir, 'local.json'), base = join(dir, 'base.json')
  writeFileSync(local, JSON.stringify({ version: 1, files: { 'a.test.ts': 10_000 } }))
  writeFileSync(base, JSON.stringify({ version: 1, files: { 'a.test.ts': 99_000, 'b.test.ts': 2_000, 'c.test.ts': 2_000 } }))
  const t = loadTimings([local, base, join(dir, 'missing.json')])
  expect(Object.fromEntries(t)).toEqual({ 'a.test.ts': 10_000, 'b.test.ts': 2_000, 'c.test.ts': 2_000 })
  // 14 s over 4 workers is 3.5 s, but a.test.ts alone takes 10 s
  expect(estimateMs([{ file: 'a.test.ts' }, { file: 'b.test.ts' }, { file: 'c.test.ts' }], t, 4, 0)).toBe(10_000)
  // a.test.ts started 9 s ago: 1 s of it left, (1 + 2 + 2) / 2 = 2.5 s
  expect(estimateMs([{ file: 'a.test.ts', startedAt: 1_000 }, { file: 'b.test.ts' }, { file: 'c.test.ts' }], t, 2, 10_000)).toBe(2_500)
  expect(estimateMs([{ file: 'a.test.ts' }, { file: 'new.test.ts' }], t, 4, 0)).toBeNull()
  expect(estimateMs([], t, 4, 0)).toBe(0)
})

test('the preload\'s events: start and done with the tests that ran; anything else is skipped', () => {
  expect(parseEvent('{"ev":"done","file":"router/test/a.test.ts","ran":3,"pid":1,"at":5}')).toEqual({ ev: 'done', file: 'router/test/a.test.ts', ran: 3, at: 5 })
  expect(parseEvent('{"ev":"start","file":"router/test/a.test.ts","at":5}')).toEqual({ ev: 'start', file: 'router/test/a.test.ts', at: 5 })
  for (const l of ['', 'x', '{"ev":"other","file":"a","at":1}', '{"ev":"done","at":1}', '{"ev":"done","file":"a"}']) expect(parseEvent(l)).toBeNull()
})

test('a finished file waits for bun\'s failure block, then gets its line; a failure after it gets a line of its own; counts across files', () => {
  const files = ['router/test/a.test.ts', 'router/test/b.test.ts', 'router/test/c.test.ts']
  const lines: string[] = []
  const timings = new Map(files.map(f => [f, 4_000]))
  const p = new Progress({ files, jobs: 2, timings, t0: 0, say: l => lines.push(l) })
  for (const f of files) p.event({ ev: 'start', file: f, at: 0 })
  p.event({ ev: 'start', file: 'elsewhere/x.test.ts', at: 0 })
  p.event({ ev: 'done', file: 'router/test/a.test.ts', ran: 5, at: 2_000 })
  p.tick(2_000 + GRACE_MS - 1)
  expect(lines).toEqual([])
  // bun's block for a.test.ts: its path, the failure, another stream's lines in between
  p.output('stderr', 'router/test/a.test.ts:')
  p.output('stdout', 'router/test/b.test.ts:')
  p.output('stderr', 'error: expect(received).toBe(expected)')
  p.output('stderr', '(fail) a > one [1.00ms]')
  p.output('stdout', 'just console output')
  p.tick(2_000 + GRACE_MS)
  // c.test.ts started at 0 and takes 4 s: 1 s left at 3 s; b likewise; (1 + 1) / 2 = 1 s, at least 1 s
  expect(lines).toEqual(['[  1/3]  33%  經過 3s  預估剩 1s  pass 4  fail 1 ❌ a.test.ts'])
  p.event({ ev: 'done', file: 'router/test/b.test.ts', ran: 2, at: 3_500 })
  p.event({ ev: 'done', file: 'router/test/b.test.ts', ran: 2, at: 3_600 })
  p.event({ ev: 'done', file: 'elsewhere/x.test.ts', ran: 9, at: 3_500 })
  p.tick(5_000)
  expect(lines[1]).toBe('[  2/3]  67%  經過 5s  預估剩 0s  pass 6  fail 1   b.test.ts')
  // a failure that comes after b.test.ts's line
  p.output('stdout', '(fail) b > late [2.00ms]')
  expect(lines[2]).toBe('      ❌ b.test.ts: 又一項失敗, fail 共 2')
  // a file that failed before any test ran (beforeAll threw): no pass taken off below zero
  p.output('stderr', 'router/test/c.test.ts:')
  p.output('stderr', '(fail) (unnamed) [0.07ms]')
  p.event({ ev: 'done', file: 'router/test/c.test.ts', ran: 0, at: 6_000 })
  p.tick(6_100)
  expect(lines).toHaveLength(3)
  // the run is over: the rest at once
  p.tick(6_100, true)
  expect(lines[3]).toBe('[  3/3] 100%  經過 6s  預估剩 0s  pass 6  fail 3 ❌ c.test.ts')
  // a (fail) line with no file before it counts nowhere
  const q = new Progress({ files, jobs: 2, timings, t0: 0, say: l => lines.push(l) })
  q.output('stderr', '(fail) orphan')
  q.event({ ev: 'done', file: files[0]!, ran: 1, at: 0 })
  q.tick(0, true)
  expect(lines.at(-1)).toBe('[  1/3]  33%  經過 0s  預估剩 4s  pass 1  fail 0   a.test.ts')
})

test('the preload in a real bun test --parallel: one start and one done per file with the tests that ran, the same junit as without it, (fail) lines under each file\'s path', async () => {
  const root = join(dir, 'run'), t = join(root, 't')
  mkdirSync(t, { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"name":"progress-fixture"}')
  writeFileSync(join(t, 'ok.test.ts'), `import { test, expect } from 'bun:test'\ntest('one', () => expect(1).toBe(1))\ntest('two', async () => { await Bun.sleep(50) })\ntest.skip('skipped', () => {})\n`)
  writeFileSync(join(t, 'bad.test.ts'), `import { test, expect, describe } from 'bun:test'\ndescribe('d', () => { test('passes', () => {}); test('fails', () => expect(2).toBe(1)) })\n`)
  writeFileSync(join(t, 'early.test.ts'), `import { test, beforeAll } from 'bun:test'\nbeforeAll(() => { throw new Error('early') })\ntest('never', () => {})\n`)
  const preload = join(import.meta.dir, 'progress-preload.ts')
  const run = async (withPreload: boolean) => {
    const junit = join(root, `${withPreload}.xml`), events = join(root, `${withPreload}.jsonl`)
    writeFileSync(events, '')
    const env = { ...process.env, CCTR_TEST_PROGRESS: withPreload ? events : '' }
    const p = Bun.spawn(['bun', 'test', './t', '--parallel=2', ...(withPreload ? ['--preload', preload] : []), '--reporter=junit', `--reporter-outfile=${junit}`], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' })
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
    await p.exited
    return { xml: readFileSync(junit, 'utf8'), events: readFileSync(events, 'utf8').split('\n').filter(Boolean).map(l => parseEvent(l)!), text: { stdout: out, stderr: err } }
  }
  const [a, b] = [await run(true), await run(false)]
  const strip = (x: string) => x.replace(/\stime="[^"]*"/g, '')
  expect(strip(a.xml)).toBe(strip(b.xml))
  expect(b.events).toEqual([])
  const done = Object.fromEntries(a.events.filter(e => e.ev === 'done').map(e => [e.file, e.ran]))
  expect(done).toEqual({ 't/ok.test.ts': 2, 't/bad.test.ts': 2, 't/early.test.ts': 0 })
  expect(a.events.filter(e => e.ev === 'start').map(e => e.file).sort()).toEqual(['t/bad.test.ts', 't/early.test.ts', 't/ok.test.ts'])
  // bun's own output, fed to Progress as full.ts does: the failures land on their files
  const files = ['t/bad.test.ts', 't/early.test.ts', 't/ok.test.ts']
  const lines: string[] = []
  const p = new Progress({ files, jobs: 2, timings: new Map(), t0: Date.now(), say: l => lines.push(l) })
  for (const [name, text] of Object.entries(a.text)) for (const l of text.split('\n')) p.output(name, l)
  for (const e of a.events) p.event(e)
  p.tick(Date.now(), true)
  expect(lines.map(l => l.replace(/經過 \d+s/, '經過 Ns'))).toEqual(expect.arrayContaining([
    expect.stringMatching(/fail \d ❌ bad\.test\.ts$/),
    expect.stringMatching(/fail \d ❌ early\.test\.ts$/),
    expect.stringMatching(/fail \d   ok\.test\.ts$/),
  ]))
  expect(lines.at(-1)).toMatch(/^\[  3\/3\] 100%  經過 \d+s  預估剩 0s  pass 3  fail 2 /)
})
