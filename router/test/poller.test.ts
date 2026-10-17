// Long polling's retry and notice policy (router/poller.ts, 柯姊 2026-10-17),
// on a fake clock: network errors and 5xx back off 5s, 10s, 30s, 1m, 2m, 5m,
// then every 5 minutes; the owner is told once after 2 minutes down and once
// on recovery; 409 retries every 60 seconds and tells at once; 401 stops and
// tells at once; 429 waits retry_after; the start (getMe) follows the same
// rules; /router status lines and notice texts (router/pollnotice.ts).
// Command replies (router/sendretry.ts): network errors, 5xx and 429 are
// tried again at most 3 times within a minute, other 4xx not.
// Keep in sync with README 「運作方式」 (輪詢).

import { test, expect } from 'bun:test'
import { createPoller, classify, type PollEvent } from '../poller'
import { pollNoticeText, describePoll, noticeVia } from '../pollnotice'
import { sendWithRetry } from '../sendretry'

const net = () => Object.assign(new Error('fetch failed'), { name: 'HttpError' })
const api = (code: number, extra: Record<string, unknown> = {}) => ({ error_code: code, description: `code ${code}`, ...extra })
const T0 = Date.parse('2026-10-17T00:00:00Z') // 08:00 GMT+8

/** A poller on a fake clock; script: what each getUpdates call does (an error to throw, or updates). */
function harness(o: { me?: Array<unknown>; updates: Array<unknown> }) {
  let now = T0
  const sleeps: number[] = [], events: Array<PollEvent & { at: number }> = [], handled: number[] = [], logs: string[] = []
  const me = [...(o.me ?? [])], ups = [...o.updates]
  let infos = 0, calls = 0
  const p = createPoller({
    now: () => now,
    sleep: async ms => { sleeps.push(ms / 1000); now += ms },
    getMe: async () => { const s = me.shift(); if (s) throw s; return { id: 1 } },
    deleteWebhook: async () => true,
    getUpdates: async () => {
      calls++
      now += 1000 // a call takes a second
      const s = ups.shift()
      if (s === undefined) { p.stop(); return [] }
      if (Array.isArray(s)) return s as Array<{ update_id: number }>
      throw s
    },
    onInfo: () => { infos++ },
    handle: async u => { handled.push(u.update_id) },
    notify: e => events.push({ ...e, at: now }),
    log: m => logs.push(m),
  })
  return { p, sleeps, events, handled, logs, infos: () => infos, calls: () => calls, now: () => now }
}

test('network errors and 5xx: back off 5s, 10s, 30s, 1m, 2m, 5m, then every 5 minutes; the owner is told once at 2 minutes down and once when it works again', async () => {
  const h = harness({ updates: [[{ update_id: 1 }], net(), api(502), net(), net(), net(), net(), net(), net(), [{ update_id: 2 }, { update_id: 3 }]] })
  await h.p.start()
  // the 2-minute notice splits the wait it falls in (5+10+30+60 = 105s, then 15s to the 2 minutes, then the rest of the 2m wait)
  expect(h.sleeps).toEqual([5, 10, 30, 60, 120 - 105 - 4, 120 - (120 - 105 - 4), 300, 300, 300])
  expect(h.events.map(e => e.kind)).toEqual(['down', 'recovered'])
  const down = h.events[0]!
  expect(down).toMatchObject({ kind: 'down', reason: expect.stringContaining('連不上 Telegram') })
  expect(down.at - (down as { since: number }).since).toBe(120_000) // exactly 2 minutes after the first failure
  expect(h.handled).toEqual([1, 2, 3])
  expect(h.p.offset()).toBe(4)
})

test('a short outage (under 2 minutes) tells nobody', async () => {
  const h = harness({ updates: [net(), api(500), net(), [{ update_id: 7 }]] })
  await h.p.start()
  expect(h.sleeps).toEqual([5, 10, 30])
  expect(h.events).toEqual([])
  expect(h.handled).toEqual([7])
  expect(h.p.state().kind).toBe('stopped')
})

test('409 conflict: retry every 60 seconds, the owner told at once (once), and when it is over', async () => {
  const h = harness({ updates: [api(409), api(409), api(409), [{ update_id: 1 }]] })
  const run = h.p.start()
  await run
  expect(h.sleeps).toEqual([60, 60, 60])
  expect(h.events.map(e => e.kind)).toEqual(['conflict', 'recovered'])
  expect(h.events[0]!.at).toBe(T0 + 1000) // right at the first 409
})

test('401: no more retries, the owner told at once; status says the token no longer works', async () => {
  const h = harness({ updates: [[{ update_id: 1 }], api(401)] })
  await h.p.start()
  expect(h.calls()).toBe(2)
  expect(h.sleeps).toEqual([])
  expect(h.events.map(e => e.kind)).toEqual(['unauthorized'])
  expect(h.p.state().kind).toBe('unauthorized')
  expect(describePoll(h.p.state())).toBe('token 失效 (08:00 起, 請用 /router bot rotate)')
})

test('429 waits its retry_after; the start (getMe) follows the same rules, a 401 there stops before polling', async () => {
  const h = harness({ updates: [api(429, { parameters: { retry_after: 7 } }), [{ update_id: 1 }]] })
  await h.p.start()
  expect(h.sleeps).toEqual([7])
  const s = harness({ me: [net(), net(), api(503)], updates: [[{ update_id: 1 }]] })
  await s.p.start()
  expect(s.sleeps).toEqual([5, 10, 30])
  expect(s.infos()).toBe(1)
  expect(s.handled).toEqual([1])
  const bad = harness({ me: [api(401)], updates: [] })
  await bad.p.start()
  expect(bad.infos()).toBe(0)
  expect(bad.calls()).toBe(0)
  expect(bad.events.map(e => e.kind)).toEqual(['unauthorized'])
})

test('status lines and notice texts (GMT+8)', () => {
  expect(describePoll({ kind: 'ok', since: T0 })).toBe('收訊中')
  expect(describePoll({ kind: 'retrying', since: T0, reason: '連不上 Telegram (fetch failed)' })).toBe('重試中 (從 08:00 開始, 連不上 Telegram (fetch failed))')
  expect(describePoll({ kind: 'retrying', since: T0, reason: classify(api(409)).reason, conflict: true })).toBe('重試中 (從 08:00 開始, 409 衝突: 另一個程式在用這個 token 收訊息)')
  expect(classify(api(401)).kind).toBe('unauthorized')
  expect(classify(api(500)).kind).toBe('server')
  expect(classify(net()).kind).toBe('network')
  expect(pollNoticeText('cc', 'cc_bot', { kind: 'down', since: T0, reason: '連不上 Telegram (fetch failed)' })).toBe('⚠️ bot cc (@cc_bot) 收不到訊息超過 2 分鐘 (從 08:00 開始): 連不上 Telegram (fetch failed). router 會持續重試 (間隔逐步拉長到每 5 分鐘), 恢復時會再通知.')
  expect(pollNoticeText('cc', null, { kind: 'conflict', since: T0 })).toStartWith('⚠️ bot cc 的 token 被另一個程式拿去收訊息 (409 衝突, 從 08:00 開始)')
  expect(pollNoticeText('cc', 'cc_bot', { kind: 'unauthorized', reason: '401 Unauthorized' })).toBe('⛔ bot cc (@cc_bot) 的 token 失效 (401 Unauthorized): router 已停止這隻 bot 收訊息, 不再重試. 請到 @BotFather 取得新 token, 在私訊用 /router bot rotate cc <新 token>.')
  expect(pollNoticeText('cc', 'cc_bot', { kind: 'recovered', since: T0, at: T0 + 7 * 60_000 })).toBe('✅ bot cc (@cc_bot) 恢復收訊 (從 08:00 中斷到 08:07, 約 7 分鐘).')
})

test('command replies: network errors, 5xx and 429 are tried again at most 3 times within a minute; other 4xx are not; the last failure is logged', async () => {
  const run = async (script: unknown[]) => {
    let now = T0
    const sleeps: number[] = [], logs: string[] = []
    let tries = 0
    const r = await sendWithRetry(async () => { tries++; const s = script.shift(); if (s) throw s; return 'sent' }, { what: 'command reply', log: m => logs.push(m), now: () => now, sleep: async ms => { sleeps.push(ms / 1000); now += ms } }).catch(e => e)
    return { r, sleeps, logs, tries }
  }
  expect(await run([net(), api(502)])).toEqual({ r: 'sent', sleeps: [2, 5], logs: [], tries: 3 })
  const gaveUp = await run([api(502), api(502), api(503), api(500)])
  expect(gaveUp.tries).toBe(4)
  expect(gaveUp.sleeps).toEqual([2, 5, 15])
  expect(gaveUp.logs).toEqual(['command reply failed after 4 tries: Telegram 500 code 500'])
  expect(await run([api(429, { parameters: { retry_after: 3 } })])).toEqual({ r: 'sent', sleeps: [3], logs: [], tries: 2 })
  const tooLong = await run([api(429, { parameters: { retry_after: 90 } })]) // past the minute: not waited for
  expect([tooLong.tries, tooLong.sleeps, tooLong.logs]).toEqual([1, [], ['command reply failed: 429 請求太頻繁']])
  const bad = await run([api(400)])
  expect([bad.tries, bad.logs]).toEqual([1, ['command reply failed: 400 code 400']])
})

test('notices go through other bots that still work; a 409 or a recovery may also go through the bot itself (a single-bot router hears of a conflict); a down or dead bot alone: nobody (only the log)', () => {
  const two = [{ name: 'cc', ok: false }, { name: 'router', ok: true }]
  expect(noticeVia('cc', 'down', two)).toEqual(['router'])
  expect(noticeVia('cc', 'conflict', two)).toEqual(['router', 'cc'])
  expect(noticeVia('cc', 'recovered', two)).toEqual(['router', 'cc'])
  const one = [{ name: 'cc', ok: false }]
  expect(noticeVia('cc', 'conflict', one)).toEqual(['cc']) // polling stopped, sending still works
  expect(noticeVia('cc', 'down', one)).toEqual([])
  expect(noticeVia('cc', 'unauthorized', one)).toEqual([])
})
