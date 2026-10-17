// The hook's retries while the router restarts (docs/permissions.md 「router
// 連不到時」; shared/retry.ts). A fake clock and a fake send: the schedule and
// its checkpoints, the deadline cutting it short, only PreToolUse and
// SubagentStart retried, "connected but still answering" not retried, each
// request's wait following the deadline, the whole run under the hook's 60 s;
// the breaker (over 3 minutes unreached: one try; reset by any try that
// reaches the router; its state file broken or missing reads as normal).
// The router's side (waiting for a worker's plugin): risky.test.ts; both with
// the real router and hook: e2e-retry.test.ts. Keep in sync with
// docs/testing.md 驗收對照.

import { test, expect } from 'bun:test'
import { readFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, statSync, readdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { checkpoints, untilReached, reportEvent, answerWait, waitUntil, breakerOpen, fileBreaker, readReach, reachFile, UNREACHABLE, RETRY_WINDOW_MS, HOOK_LIMIT_MS, BREAKER_MS, type Clock } from '../../shared/retry'

/** A clock that only moves when slept on (or when a try says it took time). */
function fakeClock(): Clock & { t: number; slept: number[] } {
  const c = { t: 1_000_000, slept: [] as number[], now: () => c.t, async sleep(ms: number) { c.slept.push(ms); c.t += ms } }
  return c
}

test('the schedule: at once, then 3, 5, 7, 15, 15 s: checkpoints 0, 3, 8, 15, 30, 45 s, six tries in 45 s', () => {
  expect(checkpoints()).toEqual([0, 3000, 8000, 15_000, 30_000, 45_000])
  expect(RETRY_WINDOW_MS).toBe(45_000)
  // a shorter window drops the later checkpoints
  expect(checkpoints(10_000)).toEqual([0, 3000, 8000])
  expect(checkpoints(0)).toEqual([0])
})

test('untilReached: an unreachable router is tried at every checkpoint, six times, then null', async () => {
  const c = fakeClock(), start = c.t, at: number[] = []
  const r = await untilReached(async () => { at.push(c.t - start); return UNREACHABLE }, start, RETRY_WINDOW_MS, c)
  expect(r).toEqual({ value: null, tries: 6, waitedMs: 45_000 })
  expect(at).toEqual([0, 3000, 8000, 15_000, 30_000, 45_000])
})

test('untilReached: stops at the first try that reaches the router; a slow try does not push the later checkpoints', async () => {
  const c = fakeClock(), start = c.t, at: number[] = []
  const r = await untilReached(async n => { at.push(c.t - start); c.t += 4000; return n === 3 ? 'ok' : UNREACHABLE }, start, RETRY_WINDOW_MS, c)
  expect(r).toEqual({ value: 'ok', tries: 3, waitedMs: 12_000 })
  // try 1 took until 4 s: try 2 (due at 3 s) goes at once, try 3 at its 8 s
  expect(at).toEqual([0, 4000, 8000])
})

test('reportEvent: PreToolUse and SubagentStart retry an unreachable router with the deadline on every try; other events go once', async () => {
  for (const event of ['pre', 'subagent-start']) {
    const c = fakeClock(), start = c.t
    const sent: Array<{ at: number; msg: any; wait: number }> = []
    const d = await reportEvent(event, '/conv', { event }, async (msg, wait) => { sent.push({ at: c.t - start, msg, wait }); return UNREACHABLE }, RETRY_WINDOW_MS, c)
    expect(d).toBeNull()
    expect(sent.map(s => s.at)).toEqual([0, 3000, 8000, 15_000, 30_000, 45_000])
    expect(sent.every(s => s.msg.deadline === start + 45_000 && s.msg.t === 'hook' && s.msg.project_dir === '/conv')).toBe(true)
    // which try it is, from the second on
    expect(sent.map(s => s.msg.retry?.tries ?? 1)).toEqual([1, 2, 3, 4, 5, 6])
    expect(sent[0]!.msg.retry).toBeUndefined()
    expect(sent[5]!.msg.retry).toEqual({ tries: 6, waited_ms: 45_000 })
    // each request waits through the deadline plus 5 s
    expect(sent.map(s => s.wait)).toEqual([50_000, 47_000, 42_000, 35_000, 20_000, 5000])
  }
  for (const event of ['prompt', 'post', 'stop', 'compact-pre', 'compact-post', 'subagent-stop']) {
    const c = fakeClock()
    const sent: any[] = []
    expect(await reportEvent(event, '/conv', { event }, async (msg, wait) => { sent.push({ msg, wait }); return UNREACHABLE }, RETRY_WINDOW_MS, c)).toBeNull()
    expect([event, sent.length, sent[0].wait, sent[0].msg.deadline]).toEqual([event, 1, 5000, undefined])
    expect(c.slept).toEqual([])
  }
})

test('reportEvent: the router reached on a later try answers; connected but no answer in time is not a reason to retry', async () => {
  let c = fakeClock()
  let n = 0
  expect(await reportEvent('pre', '/conv', { event: 'pre' }, async () => ++n < 3 ? UNREACHABLE : { decision: 'deny', reason: 'r' }, RETRY_WINDOW_MS, c)).toEqual({ decision: 'deny', reason: 'r' })
  expect(n).toBe(3)
  // an empty answer (the router lets it through) is an answer
  c = fakeClock(); n = 0
  expect(await reportEvent('pre', '/conv', { event: 'pre' }, async () => { n++; return {} }, RETRY_WINDOW_MS, c)).toEqual({})
  expect(n).toBe(1)
  // timed out while connected (null): one try, no more
  c = fakeClock(); n = 0
  expect(await reportEvent('pre', '/conv', { event: 'pre' }, async () => { n++; return null }, RETRY_WINDOW_MS, c)).toBeNull()
  expect(n).toBe(1)
  expect(c.slept).toEqual([])
})

test('reportEvent: a shorter window (tests) cuts the schedule and moves the deadline; never longer than 45 s', async () => {
  let c = fakeClock()
  const sent: any[] = []
  await reportEvent('pre', '/conv', { event: 'pre' }, async msg => { sent.push(msg); return UNREACHABLE }, 10_000, c)
  expect(sent.length).toBe(3)
  expect(sent[0].deadline).toBe(1_000_000 + 10_000)
  c = fakeClock(); sent.length = 0
  await reportEvent('pre', '/conv', { event: 'pre' }, async msg => { sent.push(msg); return UNREACHABLE }, 999_999, c)
  expect(sent.length).toBe(6)
  expect(sent[0].deadline).toBe(1_000_000 + 45_000)
})

test('answerWait: the deadline plus 5 s; a package review keeps its 55 s; never past 55 s from the first try, inside the hook\'s 60 s', () => {
  const s = 0, dl = 45_000
  expect(answerWait(s, dl, 0)).toBe(50_000)
  expect(answerWait(s, dl, 45_000)).toBe(5000)
  expect(answerWait(s, dl, 0, true)).toBe(55_000)
  expect(answerWait(s, dl, 30_000, true)).toBe(25_000)
  expect(answerWait(s, dl, 60_000)).toBe(0)
  // the worst case: every try fails but the last, which then waits its full time
  for (const at of checkpoints()) for (const install of [false, true]) expect(at + answerWait(s, dl, at, install)).toBeLessThanOrEqual(HOOK_LIMIT_MS)
  const base = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'templates', 'base-settings.json'), 'utf8'))
  for (const ev of ['PreToolUse', 'SubagentStart']) expect(base.hooks[ev][0].hooks[0].timeout * 1000).toBeGreaterThan(HOOK_LIMIT_MS)
})

test('waitUntil: the router waits until the hook\'s deadline, never more than 45 s from now', () => {
  expect(waitUntil(10_000, 0)).toBe(10_000)
  expect(waitUntil(10_000_000, 0)).toBe(45_000)
  expect(waitUntil(-5, 0)).toBe(-5)
})

// --- the breaker: a router unreached for over 3 minutes gets one try per request

const tmp = () => mkdtempSync(join(tmpdir(), 'cctr-breaker-'))

test('breakerOpen: open only past 3 minutes from the first failed try, with no try reaching the router since', () => {
  expect(BREAKER_MS).toBe(180_000)
  const t0 = 1_000_000
  expect(breakerOpen({ down_since: null, last_ok: null }, t0 + 999_999)).toBe(false)
  expect(breakerOpen({ down_since: t0, last_ok: null }, t0 + 180_000)).toBe(false)
  expect(breakerOpen({ down_since: t0, last_ok: null }, t0 + 180_001)).toBe(true)
  expect(breakerOpen({ down_since: t0, last_ok: t0 - 5 }, t0 + 180_001)).toBe(true)
  // a try reached it after the first failed one (another hook process): not open
  expect(breakerOpen({ down_since: t0, last_ok: t0 + 1 }, t0 + 999_999)).toBe(false)
})

test('the breaker through reportEvent (fake clock, real state file): six tries until 3 minutes have passed, then one; any try that reaches the router resets it', async () => {
  const dir = tmp()
  try {
    const file = join(dir, 'reach.json'), br = fileBreaker(file), c = fakeClock()
    let up = false, sent = 0
    const send = async () => { sent++; return up ? {} : UNREACHABLE }
    const pre = async () => { sent = 0; const d = await reportEvent('pre', '/conv', { event: 'pre' }, send, RETRY_WINDOW_MS, c, br); return { d, sent } }
    const t0 = c.t
    expect(await pre()).toEqual({ d: null, sent: 6 })
    expect(readReach(file)).toEqual({ down_since: t0, last_ok: null })
    // 3 minutes have not passed since the first failed try: still the full schedule
    c.t = t0 + 179_000
    expect((await pre()).sent).toBe(6)
    // past 3 minutes: one try, the fallback at once
    const before = c.t
    expect(await pre()).toEqual({ d: null, sent: 1 })
    expect(c.t).toBe(before)
    expect((await pre()).sent).toBe(1)
    expect(readReach(file).down_since).toBe(t0)
    // the router answers (any event): normal again, and the time is kept
    up = true
    c.t += 1000
    expect(await reportEvent('post', '/conv', { event: 'post' }, send, RETRY_WINDOW_MS, c, br)).toEqual({})
    expect(readReach(file)).toEqual({ down_since: null, last_ok: c.t })
    // down again: a new outage counts from its own first failed try, the full schedule
    up = false
    const t1 = c.t
    expect((await pre()).sent).toBe(6)
    expect(readReach(file)).toEqual({ down_since: t1, last_ok: t1 })
    // a router reached while the breaker is open: answered on that one try
    c.t = t1 + 200_000
    up = true
    expect(await pre()).toEqual({ d: {}, sent: 1 })
    expect(readReach(file).down_since).toBeNull()
    // connected but no answer in time still counts as reached
    expect(await reportEvent('pre', '/conv', { event: 'pre' }, async () => null, RETRY_WINDOW_MS, c, br)).toBeNull()
    expect(readReach(file).down_since).toBeNull()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the breaker\'s state file: written only when it changes, atomically (no temp file left, 0600); missing, broken or unreadable reads as normal', async () => {
  const dir = tmp()
  try {
    const file = join(dir, 'sub', 'reach.json'), br = fileBreaker(file)
    // reached with nothing failed: no file at all
    br.result(true, 5)
    expect(existsSync(file)).toBe(false)
    br.result(false, 10)
    expect(readReach(file)).toEqual({ down_since: 10, last_ok: null })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    // a later failed try of the same outage does not move its start
    br.result(false, 20)
    expect(readReach(file).down_since).toBe(10)
    expect(readdirSync(join(dir, 'sub'))).toEqual(['reach.json'])
    // broken content: normal, the full schedule; the next failed try writes a good state over it
    for (const junk of ['{not json', '[]', '{"down_since":"yesterday","last_ok":{}}', '']) {
      writeFileSync(file, junk)
      expect(readReach(file)).toEqual({ down_since: null, last_ok: null })
      expect(br.open(999_999_999)).toBe(false)
    }
    const c = fakeClock()
    let sent = 0
    await reportEvent('pre', '/conv', { event: 'pre' }, async () => { sent++; return UNREACHABLE }, RETRY_WINDOW_MS, c, br)
    expect(sent).toBe(6)
    expect(readReach(file).down_since).toBe(1_000_000)
    // unreadable (a folder where the file should be): normal, and writing fails quietly
    const odd = join(dir, 'odd.json')
    mkdirSync(odd)
    const b2 = fileBreaker(odd)
    expect(b2.open(999_999_999)).toBe(false)
    expect(() => b2.result(false, 1)).not.toThrow()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('reachFile: one file per router socket in $XDG_RUNTIME_DIR, else ~/.cache', () => {
  const a = reachFile('/srv/a.sock', { XDG_RUNTIME_DIR: '/run/user/1000', HOME: '/home/u' })
  expect(a).toMatch(/^\/run\/user\/1000\/cc-telegram-router\/reach-[0-9a-f]{16}\.json$/)
  expect(reachFile('/srv/b.sock', { XDG_RUNTIME_DIR: '/run/user/1000' })).not.toBe(a)
  expect(reachFile('/srv/a.sock', { XDG_RUNTIME_DIR: '/run/user/1000' })).toBe(a)
  expect(reachFile('/srv/a.sock', { HOME: '/home/u' })).toMatch(/^\/home\/u\/\.cache\/cc-telegram-router\/reach-[0-9a-f]{16}\.json$/)
  expect(reachFile('/srv/a.sock', { XDG_RUNTIME_DIR: 'relative', HOME: '/home/u' })).toStartWith('/home/u/.cache/')
})
