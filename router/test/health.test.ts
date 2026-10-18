// The health endpoint (router/health.ts), module level: config health is off
// when missing, any address listens (one that is not loopback is warned
// about, louder when public: loopback, private and public told apart), a
// wrong listen or a port in use only turns it off; the bearer
// token (401 without it or wrong, constant-time comparison, never shown by
// /router config show); 200 while every bot's last successful getUpdates is
// within staleAfterS and 503 once one is not; the report's fields, in GMT+8,
// and nothing private in it (tokens, chat ids, user ids and usernames,
// conversation keys, titles, messages), checked on fake data full of ids;
// the poller's lastOk; the start notice (version, health URL, public, no
// token) and the stop notice with where it came from (cli, telegram,
// systemd or a signal), a SIGTERM under systemd told restart from stop by
// the unit's job in systemctl --user list-jobs (a fake runner here). End to end in e2e-health.test.ts.
// Keep in sync with docs/operations.md 「健康檢查端點」 and 「設定欄位」.

import { test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { parseHealth, describeHealth, exposure, exposureWarnings, startNotice, stopNotice, stopSource, parseJobType, systemdJob, sameSecret, authorized, scrubPrivate, countWorkers, healthReport, handleHealth, startHealthServer, DEFAULT_STALE_AFTER_S, type HealthInput } from '../health'
import { createPoller } from '../poller'
import { wakeCause } from '../diagnose'

const TOKEN = 's3cret-health-token'
const T0 = Date.parse('2026-10-18T02:00:00Z') // 10:00 GMT+8

test('config: missing or false is off without a warning; listen, token and staleAfterS are read; staleAfterS defaults to 90', () => {
  const w: string[] = []
  expect(parseHealth(undefined, w)).toBeUndefined()
  expect(parseHealth(null, w)).toBeUndefined()
  expect(parseHealth(false, w)).toBeUndefined()
  expect(w).toEqual([])
  expect(parseHealth({ listen: '127.0.0.1:8787' }, w)).toEqual({ host: '127.0.0.1', port: 8787, staleAfterS: 90 })
  expect(DEFAULT_STALE_AFTER_S).toBe(90)
  expect(parseHealth({ listen: '[::1]:9000', token: TOKEN, staleAfterS: 120 }, w)).toEqual({ host: '::1', port: 9000, token: TOKEN, staleAfterS: 120 })
  expect(parseHealth({ listen: 'localhost:1' }, w)).toEqual({ host: 'localhost', port: 1, staleAfterS: 90 })
  expect(parseHealth({ listen: 'LOCALHOST:65535', token: '' }, w)).toEqual({ host: 'localhost', port: 65535, staleAfterS: 90 })
  // not loopback: still on (warned about where it listens, exposureWarnings)
  expect(parseHealth({ listen: '0.0.0.0:8787' }, w)).toEqual({ host: '0.0.0.0', port: 8787, staleAfterS: 90 })
  expect(parseHealth({ listen: '[::]:8787' }, w)).toEqual({ host: '::', port: 8787, staleAfterS: 90 })
  expect(parseHealth({ listen: '192.168.1.10:8787' }, w)).toEqual({ host: '192.168.1.10', port: 8787, staleAfterS: 90 })
  expect(parseHealth({ listen: 'monitor.example.com:8787' }, w)).toEqual({ host: 'monitor.example.com', port: 8787, staleAfterS: 90 })
  expect(w).toEqual([])
})

test('config: a bad listen or port, or a token that is not a string turns it off with a warning (the token never echoed)', () => {
  for (const [v, says] of [
    [{ listen: '999.1.1.1:8787' }, '不是 IP 位址或主機名稱'],
    [{ listen: '[1::2::3]:8787' }, '不是 IP 位址或主機名稱'],
    [{ listen: 'bad_host!:8787' }, '不是 IP 位址或主機名稱'],
    [{ listen: '::1:8787' }, '.listen 要是'],
    [{ listen: '127.0.0.1' }, '.listen 要是'],
    [{ listen: 8787 }, '.listen 要是'],
    [{}, '.listen 要是'],
    [{ listen: '127.0.0.1:0' }, 'port 要是 1 到 65535'],
    [{ listen: '127.0.0.1:70000' }, 'port 要是 1 到 65535'],
    ['127.0.0.1:8787', '要是 {'],
    [true, '要是 {'],
  ] as const) {
    const w: string[] = []
    expect(parseHealth(v, w)).toBeUndefined()
    expect(w.length).toBe(1)
    expect(w[0]).toContain(says)
    expect(w[0]).toContain('健康檢查端點不開')
  }
  const w: string[] = []
  expect(parseHealth({ listen: '127.0.0.1:8787', token: 1234567890 }, w)).toBeUndefined()
  expect(w[0]).toContain('.token 要是字串')
  expect(w[0]).not.toContain('1234567890')
})

test('config: a wrong staleAfterS warns and uses the default; the endpoint stays on', () => {
  for (const v of [0, -5, 'soon', Infinity]) {
    const w: string[] = []
    expect(parseHealth({ listen: '127.0.0.1:8787', staleAfterS: v }, w)).toEqual({ host: '127.0.0.1', port: 8787, staleAfterS: 90 })
    expect(w[0]).toContain('用預設 90')
  }
})

test('/router config show: where it listens and that a token is set, never the token', () => {
  expect(describeHealth(undefined)).toBe('關閉')
  expect(describeHealth({ host: '127.0.0.1', port: 8787, staleAfterS: 90 })).toBe('127.0.0.1:8787/healthz (未設 token), 門檻 90 秒')
  const s = describeHealth({ host: '::1', port: 8787, token: TOKEN, staleAfterS: 90 })
  expect(s).toBe('[::1]:8787/healthz (要 token, 已設定), 門檻 90 秒')
  expect(s).not.toContain(TOKEN)
  expect(readFileSync(join(import.meta.dir, '..', 'commands.ts'), 'utf8')).toContain('`health: ${describeHealth(cfg.health)}`')
})

test('token: Bearer <token> only, any other header or none is refused; no token configured lets everyone in', () => {
  expect(authorized(null, undefined)).toBe(true)
  expect(authorized('Bearer whatever', undefined)).toBe(true)
  expect(authorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true)
  expect(authorized(`bearer  ${TOKEN} `, TOKEN)).toBe(true)
  for (const h of [null, '', 'Bearer', 'Bearer ', `Basic ${TOKEN}`, TOKEN, `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(0, -1)}`, `Bearer x${TOKEN}`]) expect(authorized(h, TOKEN)).toBe(false)
})

test('token: compared in constant time (timingSafeEqual on equal-length digests): any length, never a throw, never ===', () => {
  expect(sameSecret(TOKEN, TOKEN)).toBe(true)
  expect(sameSecret('', TOKEN)).toBe(false)
  expect(sameSecret('a'.repeat(10_000), TOKEN)).toBe(false)
  expect(sameSecret(TOKEN + TOKEN, TOKEN)).toBe(false)
  const src = readFileSync(join(import.meta.dir, '..', 'health.ts'), 'utf8')
  const fn = src.slice(src.indexOf('export function sameSecret'), src.indexOf('\n}\n', src.indexOf('export function sameSecret')))
  expect(fn).toContain('timingSafeEqual(a, b)')
  expect(fn).toContain("createHash('sha256')")
  expect(src).not.toMatch(/===\s*token|token\s*===/)
})

test('requests: /healthz with GET or HEAD; other paths 404, other methods 405; 401 with the token configured and missing or wrong, with no report in it', async () => {
  let asked = 0
  const report = async () => { asked++; return { status: 200, body: { status: 'ok' } } }
  const at = (path: string, init: RequestInit = {}) => handleHealth(new Request(`http://127.0.0.1:8787${path}`, init), TOKEN, report)
  const auth = { authorization: `Bearer ${TOKEN}` }
  expect((await at('/', { headers: auth })).status).toBe(404)
  expect((await at('/healthz/x', { headers: auth })).status).toBe(404)
  expect((await at('/metrics', { headers: auth })).status).toBe(404)
  const post = await at('/healthz', { method: 'POST', headers: auth })
  expect(post.status).toBe(405)
  expect(post.headers.get('allow')).toBe('GET, HEAD')
  expect(asked).toBe(0)
  const none = await at('/healthz')
  expect(none.status).toBe(401)
  expect(none.headers.get('www-authenticate')).toBe('Bearer')
  expect(await none.json()).toEqual({ error: 'unauthorized' })
  expect((await at('/healthz', { headers: { authorization: 'Bearer nope' } })).status).toBe(401)
  expect(asked).toBe(0)
  const good = await at('/healthz', { headers: auth })
  expect(good.status).toBe(200)
  expect(good.headers.get('content-type')).toContain('application/json')
  expect(await good.json()).toEqual({ status: 'ok' })
  const head = await at('/healthz', { method: 'HEAD', headers: auth })
  expect(head.status).toBe(200)
  expect(await head.text()).toBe('')
  // no token configured: no header needed
  expect((await handleHealth(new Request('http://127.0.0.1:8787/healthz'), undefined, report)).status).toBe(200)
})

test('listening: on the configured address; a port in use gives null and a log line, no throw', async () => {
  const taken = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('other') })
  try {
    const logs: string[] = []
    const r = startHealthServer({ host: '127.0.0.1', port: taken.port!, token: TOKEN, staleAfterS: 90 }, async () => ({ status: 200, body: {} }), m => logs.push(m))
    expect(r).toBeNull()
    expect(logs.join('\n')).toContain(`health: cannot listen on 127.0.0.1:${taken.port}`)
    expect(logs.join('\n')).toContain('router 照常運作')
    expect(logs.join('\n')).not.toContain(TOKEN)
    // the other program still answers
    expect(await (await fetch(`http://127.0.0.1:${taken.port}/`)).text()).toBe('other')
  } finally { taken.stop(true) }
  // a free port: it listens there, with the token
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
  const port = probe.port!
  probe.stop(true)
  const logs: string[] = []
  const s = startHealthServer({ host: '127.0.0.1', port, token: TOKEN, staleAfterS: 90 }, async () => ({ status: 503, body: { status: 'down' } }), m => logs.push(m))!
  try {
    expect(s).not.toBeNull()
    expect(logs).toEqual([`health: listening on 127.0.0.1:${port}/healthz (要 token, 已設定), 門檻 90 秒`])
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(401)
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({ status: 'down' })
  } finally { s.stop() }
})

/** A report input full of ids; names only from config. */
const base = (o: Partial<HealthInput> = {}): HealthInput => ({
  now: T0, version: '2.30.0', startedAt: T0 - 3_600_000, staleAfterS: 90,
  bots: [{ name: 'cc', state: 'ok', lastOk: T0 - 20_000, since: T0 - 3_600_000 }, { name: 'router', state: 'ok', lastOk: T0 - 90_000, since: T0 - 3_600_000 }],
  workers: { total: 3, standby: 1, asleep: 2, backoff: 1, pluginDisconnected: 0 },
  lastWakeFailure: null,
  ...o,
})

test('200 while every bot\'s last success is within staleAfterS (the edge included), 503 once one is past it', () => {
  const ok = healthReport(base())
  expect(ok.status).toBe(200)
  expect(ok.body.status).toBe('ok')
  expect((ok.body.bots as any).router).toEqual({ ok: true, state: 'ok', lastOkAt: '2026-10-18T09:58:30.000+08:00', lastOkAgoS: 90 })
  const late = healthReport(base({ now: T0 + 1000 }))
  expect(late.status).toBe(503)
  expect(late.body.status).toBe('down')
  expect((late.body.bots as any).router.ok).toBe(false)
  expect((late.body.bots as any).cc.ok).toBe(true)
  // a threshold from config
  expect(healthReport(base({ staleAfterS: 10 })).status).toBe(503)
  // no bots at all: nothing is polling
  expect(healthReport(base({ bots: [] })).status).toBe(503)
})

test('a bot that never polled yet counts from its start: fine at first, 503 after staleAfterS; a token that stopped working goes 503 by the same rule', () => {
  const starting = { name: 'cc', state: 'starting', lastOk: null, since: T0 - 30_000 }
  const r = healthReport(base({ bots: [starting] }))
  expect(r.status).toBe(200)
  expect((r.body.bots as any).cc).toEqual({ ok: true, state: 'starting', lastOkAt: null, lastOkAgoS: null, waitingS: 30 })
  expect(healthReport(base({ bots: [{ ...starting, since: T0 - 91_000 }] })).status).toBe(503)
  expect(healthReport(base({ bots: [{ name: 'cc', state: 'unauthorized', lastOk: T0 - 100_000, since: T0 - 3_600_000 }] })).status).toBe(503)
})

test('the report: version, uptime, times in GMT+8 (never Z or +00), worker counts, the last failed wake', () => {
  const r = healthReport(base({ lastWakeFailure: { at: T0 - 300_000, bot: 'cc', failures: 2, cause: '資料夾沒有被信任 (Workspace not trusted)' } }))
  expect(r.body).toEqual({
    status: 'ok',
    version: '2.30.0',
    now: '2026-10-18T10:00:00.000+08:00',
    startedAt: '2026-10-18T09:00:00.000+08:00',
    uptimeS: 3600,
    staleAfterS: 90,
    bots: {
      cc: { ok: true, state: 'ok', lastOkAt: '2026-10-18T09:59:40.000+08:00', lastOkAgoS: 20 },
      router: { ok: true, state: 'ok', lastOkAt: '2026-10-18T09:58:30.000+08:00', lastOkAgoS: 90 },
    },
    workers: { total: 3, standby: 1, asleep: 2, backoff: 1, pluginDisconnected: 0 },
    lastWakeFailure: { at: '2026-10-18T09:55:00.000+08:00', agoS: 300, bot: 'cc', failures: 2, cause: '資料夾沒有被信任 (Workspace not trusted)' },
  })
  const text = JSON.stringify(r.body)
  expect(text).not.toMatch(/\d{2}Z|\+00|UTC/)
})

test('worker counts by the router\'s definitions: standby = plugin connected, the rest asleep; backoff and plugin not connected among the asleep; null when the daemon was not asked', () => {
  const keys = ['dm-1', 'group-2', 'group-3', 'dm-4']
  const o = { isConnected: (k: string) => k === 'dm-1', heldUntil: (k: string) => (k === 'group-2' ? T0 + 60_000 : k === 'group-3' ? T0 - 1 : 0), running: new Set(['dm-1', 'dm-4']), now: T0 }
  expect(countWorkers(keys, o)).toEqual({ total: 4, standby: 1, asleep: 3, backoff: 1, pluginDisconnected: 1 })
  expect(countWorkers(keys, { ...o, running: null })).toEqual({ total: 4, standby: 1, asleep: 3, backoff: 1, pluginDisconnected: null })
  expect(countWorkers([], o)).toEqual({ total: 0, standby: 0, asleep: 0, backoff: 0, pluginDisconnected: 0 })
})

test('nothing private: a failed wake\'s cause full of ids and names comes out without the folder, key, chat id, title, username or token, and the whole report has none of them', () => {
  const chat = '-1009876543210', uid = '5550001', botId = '7000000123'
  const botToken = `${botId}:${'A'.repeat(35)}`
  const folder = `/srv/cc/bot${botId}/group-${chat}`
  const key = `cc:group:${chat}`
  // what claude --bg might say, with every kind of id in it
  const spawnOut = `Error: cannot start in ${folder} for ${key} (Secret Club Chat) user ${uid} @boss_user via ${botToken}`
  const w = wakeCause({ spawnOut, home: '/srv/cc', folder })
  const cause = scrubPrivate(w.cause, [folder, key, chat, 'Secret Club Chat', 'cc_test_bot', 'boss_user'])
  for (const bad of [chat, chat.slice(1), uid, botId, botToken, 'A'.repeat(35), 'AAAA', folder, key, 'Secret Club Chat', 'boss_user']) expect(cause).not.toContain(bad)
  expect(cause).toContain('claude --bg 失敗')
  const r = healthReport(base({ lastWakeFailure: { at: T0, bot: 'cc', failures: 1, cause } }))
  const text = JSON.stringify(r.body)
  for (const bad of [chat, uid, botId, botToken, folder, key, 'Secret Club Chat', 'boss_user', 'chat_id', 'username', 'title']) expect(text).not.toContain(bad)
  // bots by their config names only
  expect(Object.keys(r.body.bots as object)).toEqual(['cc', 'router'])
  // no run of 6 digits anywhere but the times
  expect(text.replace(/"(now|startedAt|lastOkAt|at)":"[^"]+"/g, '')).not.toMatch(/\d{6,}/)
})

test('poller: lastOk is when a call last worked (deleteWebhook, then every getUpdates), null before; createdAt is when it was made', async () => {
  let now = T0
  const seen: Array<number | null> = []
  let n = 0
  const p = createPoller({
    now: () => now,
    sleep: async ms => { now += ms },
    getMe: async () => { now += 1000; seen.push(p.lastOk()); return { id: 1 } },
    deleteWebhook: async () => { now += 1000; return true },
    getUpdates: async () => {
      n++
      seen.push(p.lastOk())
      now += 30_000
      if (n === 2) throw Object.assign(new Error('fetch failed'), { name: 'HttpError' })
      if (n === 4) p.stop()
      return []
    },
    onInfo: () => {}, handle: async () => {}, notify: () => {}, log: () => {},
  })
  expect(p.createdAt()).toBe(T0)
  expect(p.lastOk()).toBeNull()
  await p.start()
  // before getMe: null; after deleteWebhook at +2s; after the first getUpdates at +32s;
  // the second failed (+62s, retry 5s later): still +32s; the third worked at +97s
  expect(seen).toEqual([null, T0 + 2000, T0 + 32_000, T0 + 32_000, T0 + 97_000])
  expect(p.createdAt()).toBe(T0)
})

test('docs/operations.md 「健康檢查端點」 says what the code does: the default threshold, the body\'s fields, the Gatus example with a token and host network', () => {
  const ops = readFileSync(join(import.meta.dir, '..', '..', 'docs', 'operations.md'), 'utf8')
  const start = ops.indexOf('\n## 健康檢查端點\n')
  const sec = ops.slice(start, ops.indexOf('\n## ', start + 5))
  expect(sec).toContain(`沒寫是 **${DEFAULT_STALE_AFTER_S}**`)
  expect(sec).toContain('long polling timeout (30 秒) 的三倍')
  expect(readFileSync(join(import.meta.dir, '..', 'main.ts'), 'utf8')).toContain('bot.api.getUpdates({ offset, timeout: 30,')
  // the example body has the fields a report has, bot entries and the failed wake included
  const example = JSON.parse(sec.slice(sec.indexOf('```json\n{') + 8, sec.indexOf('\n```', sec.indexOf('```json\n{'))))
  const real = healthReport(base({ lastWakeFailure: { at: T0, bot: 'cc', failures: 1, cause: 'x' }, channel: { mode: 'managed', managedOk: true } })).body as any
  expect(Object.keys(example)).toEqual(Object.keys(real))
  expect(Object.keys(example.bots.cc)).toEqual(Object.keys(real.bots.cc))
  expect(Object.keys(example.workers)).toEqual(Object.keys(real.workers))
  expect(Object.keys(example.lastWakeFailure)).toEqual(Object.keys(real.lastWakeFailure))
  for (const t of ['- "[STATUS] == 200"', '- "[BODY].status == ok"', '- "[BODY].bots.cc.ok == true"', 'Authorization: "Bearer ${CCTR_HEALTH_TOKEN}"', 'network_mode: host', '`127.0.0.1:<port>`, `[::1]:<port>` 或 `localhost:<port>`', '回 401', '回 404', '回 405']) expect(sec).toContain(t)
})

test('how far an address reaches: loopback, private (10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16, fc00::/7, fe80::/10), public (the rest, 0.0.0.0, :: and host names)', () => {
  const cases: Record<string, string[]> = {
    loopback: ['127.0.0.1', '127.5.5.5', 'localhost', '::1', '0:0:0:0:0:0:0:1', '[::1]', '::ffff:127.0.0.1'],
    private: ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '100.127.255.255', '169.254.1.1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', '::ffff:10.0.0.1'],
    public: ['0.0.0.0', '::', '8.8.8.8', '172.15.255.255', '172.32.0.1', '192.169.0.1', '100.63.255.255', '100.128.0.1', '169.255.0.1', '11.0.0.1', 'fec0::1', '2001:db8::1', '::ffff:8.8.8.8', 'monitor.example.com'],
  }
  for (const [want, hosts] of Object.entries(cases)) for (const h of hosts) expect([h, exposure(h)]).toEqual([h, want])
})

test('log warnings: an address that is not loopback (public: 對外開放, 請注意防範; private: the network), and no token, always; nothing on loopback with a token', () => {
  const h = (host: string, token?: string) => ({ host, port: 8787, staleAfterS: 90, ...(token ? { token } : {}) })
  expect(exposureWarnings(h('127.0.0.1', TOKEN))).toEqual([])
  expect(exposureWarnings(h('127.0.0.1'))).toEqual(['health: ⚠️ 未設 token: 連得到 127.0.0.1:8787 的這台機器上的程式都看得到狀態'])
  expect(exposureWarnings(h('0.0.0.0', TOKEN))).toEqual(['health: ⚠️ 聽在 0.0.0.0:8787, 不是本機也不是私有網段: health point 對外開放, 請注意防範'])
  expect(exposureWarnings(h('::'))).toEqual(['health: ⚠️ 聽在 [::]:8787, 不是本機也不是私有網段: health point 對外開放, 請注意防範', 'health: ⚠️ 未設 token: 連得到 [::]:8787 的人都看得到狀態'])
  expect(exposureWarnings(h('192.168.1.10', TOKEN))).toEqual(['health: ⚠️ 聽在 192.168.1.10:8787, 不是本機位址: 同一個私有網段的其他機器連得到'])
  for (const w of exposureWarnings(h('0.0.0.0', TOKEN))) expect(w).not.toContain(TOKEN)
})

test('start notice: always the version; with health its URL, then a public address and a missing token each on a line; a configured endpoint that did not listen is said so', () => {
  const h = (host: string, token?: string) => ({ host, port: 8787, staleAfterS: 90, ...(token ? { token } : {}) })
  expect(startNotice('2.30.0', undefined, false)).toBe('🟢 cc-telegram-router 2.30.0 啟動')
  expect(startNotice('2.30.0', h('127.0.0.1', TOKEN), true)).toBe('🟢 cc-telegram-router 2.30.0 啟動\nhealth point (http://127.0.0.1:8787/healthz) 啟動')
  expect(startNotice('2.30.0', h('0.0.0.0', TOKEN), true)).toBe('🟢 cc-telegram-router 2.30.0 啟動\nhealth point (http://0.0.0.0:8787/healthz) 啟動\n⚠️ health point 對外開放, 請注意防範')
  expect(startNotice('2.30.0', h('::'), true)).toBe('🟢 cc-telegram-router 2.30.0 啟動\nhealth point (http://[::]:8787/healthz) 啟動\n⚠️ health point 對外開放, 請注意防範\n⚠️ health point 未設 token, 連得到的都看得到狀態')
  expect(startNotice('2.30.0', h('10.0.0.5', TOKEN), true)).toBe('🟢 cc-telegram-router 2.30.0 啟動\nhealth point (http://10.0.0.5:8787/healthz) 啟動\n⚠️ health point 不在本機位址, 同一個私有網段的其他機器連得到')
  expect(startNotice('2.30.0', h('127.0.0.1'), true)).toBe('🟢 cc-telegram-router 2.30.0 啟動\nhealth point (http://127.0.0.1:8787/healthz) 啟動\n⚠️ health point 未設 token, 連得到的都看得到狀態')
  expect(startNotice('2.30.0', h('127.0.0.1', TOKEN), false)).toBe('🟢 cc-telegram-router 2.30.0 啟動\n⚠️ health point (http://127.0.0.1:8787/healthz) 沒有啟動, 原因見 router 的 log')
  expect(startNotice('2.30.0', h('0.0.0.0', TOKEN), true)).not.toContain(TOKEN)
  // the channel mode (router/claudecmd.ts describeMode) on its own line after the version
  expect(startNotice('2.30.0', undefined, false, 'managed (x)')).toBe('🟢 cc-telegram-router 2.30.0 啟動\nchannel 模式: managed (x)')
})

test('the report\'s channel: the mode, why legacy, whether the daemon sees the managed settings; left out when not given', () => {
  expect((healthReport(base({ channel: { mode: 'legacy', reason: 'r', managedOk: null } })).body as any).channel).toEqual({ mode: 'legacy', reason: 'r', managedOk: null })
  expect('channel' in healthReport(base({})).body).toBe(false)
  expect(healthReport(base({ channel: { mode: 'managed', managedOk: false } })).status).toBe(200)
})

test('stop notice: 重啟 or 關機, with where it came from: cli, telegram: <name>, systemd (SIGTERM) under systemd, else the signal', () => {
  expect(stopSource({ by: 'cli', signal: '/restart' })).toBe('cli')
  expect(stopSource({ by: 'telegram: @boss_user', signal: '/restart', systemd: true })).toBe('telegram: @boss_user')
  expect(stopSource({ signal: 'SIGTERM', systemd: true })).toBe('systemd (SIGTERM)')
  expect(stopSource({ signal: 'SIGTERM' })).toBe('訊號 SIGTERM')
  expect(stopSource({ signal: 'SIGINT' })).toBe('訊號 SIGINT')
  expect(stopNotice('2.30.0', true, 'cli')).toBe('🔴 cc-telegram-router 2.30.0 重啟 (來源: cli)')
  expect(stopNotice('2.30.0', false, 'systemd (SIGTERM)')).toBe('🔴 cc-telegram-router 2.30.0 關機 (來源: systemd (SIGTERM))')
  // /restart from the terminal says cli, from Telegram the sender's name (commands.ts)
  expect(readFileSync(join(import.meta.dir, '..', 'commands.ts'), 'utf8')).toContain("deps.restartRouter(input.terminal ? 'cli' : `telegram: ${input.senderName}`)")
})

test('docs/operations.md: 「健康檢查端點」 has the three levels, 「router 重啟」 the start and stop notices as the code writes them', () => {
  const ops = readFileSync(join(import.meta.dir, '..', '..', 'docs', 'operations.md'), 'utf8')
  const sec = (h: string) => { const i = ops.indexOf(`\n## ${h}\n`); return ops.slice(i, ops.indexOf('\n## ', i + 5)) }
  const health = sec('健康檢查端點'), restart = sec('router 重啟')
  for (const t of ['10/8, 172.16/12, 192.168/16, 100.64/10 (CGNAT), 169.254/16 (link-local), IPv6 的 fc00::/7 與 fe80::/10', '包含 `0.0.0.0` 與 `::`', '「health point 對外開放, 請注意防範」', '「未設 token」']) expect(health).toContain(t)
  const h = { host: '0.0.0.0', port: 8787, staleAfterS: 90 }
  const [first, url, pub, noToken] = startNotice('<版本>', h, true).split('\n')
  expect(restart).toContain(`\`${first}\``)
  expect(restart).toContain(`\`${url!.replace('0.0.0.0:8787', '<listen 位址>')}\``)
  expect(restart).toContain(`\`${pub}\``)
  expect(restart).toContain(`\`${noToken!.split(',')[0]}, ...\``)
  expect(restart).toContain(`\`${stopNotice('<版本>', true, '...')}\``)
  for (const t of ['`cli`', '`telegram: <顯示名稱或 @username>`', '`重啟 (來源: systemd)`', '`關機 (來源: systemd)`', '`關機 (來源: systemd (SIGTERM))`', '`systemctl --user list-jobs --no-legend`', '(最多等 2 秒)', '`訊號 SIGTERM`', '最多等 5 秒', '`stop notice: not confirmed within 5s`']) expect(restart).toContain(t)
  expect(readFileSync(join(import.meta.dir, '..', 'main.ts'), 'utf8')).toContain('const STOP_NOTICE_MS = 5_000')
})

const LIST_JOBS = (type: string) => `  2041 cc-telegram-router.service ${type} running\n  2042 other.service start waiting\n`

test('systemd job: the unit\'s job type in list-jobs (restart or stop), nothing for another unit or another type', () => {
  expect(parseJobType(LIST_JOBS('restart'), 'cc-telegram-router.service')).toBe('restart')
  expect(parseJobType(LIST_JOBS('stop'), 'cc-telegram-router.service')).toBe('stop')
  expect(parseJobType(LIST_JOBS('start'), 'cc-telegram-router.service')).toBeNull()
  expect(parseJobType(LIST_JOBS('restart'), 'cc-telegram-router-2.service')).toBeNull()
  expect(parseJobType('', 'cc-telegram-router.service')).toBeNull()
  expect(parseJobType('No jobs running.\n', 'cc-telegram-router.service')).toBeNull()
})

test('systemd job: asked with systemctl --user list-jobs; a failed command, a throw or no answer within the timeout is null, and the wait ends then', async () => {
  const asked: string[][] = []
  const fake = (out: { code: number; stdout: string }) => async (args: string[]) => { asked.push(args); return out }
  expect(await systemdJob('cc-telegram-router.service', fake({ code: 0, stdout: LIST_JOBS('restart') }))).toBe('restart')
  expect(asked[0]).toEqual(['systemctl', '--user', 'list-jobs', '--no-legend', '--full'])
  expect(await systemdJob('cc-telegram-router.service', fake({ code: 0, stdout: LIST_JOBS('stop') }))).toBe('stop')
  expect(await systemdJob('cc-telegram-router.service', fake({ code: 1, stdout: LIST_JOBS('restart') }))).toBeNull()
  expect(await systemdJob('cc-telegram-router.service', async () => { throw new Error('no bus') })).toBeNull()
  let aborted = false
  const t0 = Date.now()
  expect(await systemdJob('cc-telegram-router.service', (_a, signal) => new Promise(() => { signal.addEventListener('abort', () => { aborted = true }) }), 200)).toBeNull()
  expect(Date.now() - t0).toBeLessThan(1000)
  expect(aborted).toBe(true)
})

test('stop notice under systemd: a restart job says 重啟 (來源: systemd), a stop job 關機 (來源: systemd), none known stays systemd (SIGTERM); main.ts asks for its own unit within 2 seconds', () => {
  const notice = (job: 'restart' | 'stop' | null) => stopNotice('2.30.0', job === 'restart', stopSource({ signal: 'SIGTERM', systemd: true, job }))
  expect(notice('restart')).toBe('🔴 cc-telegram-router 2.30.0 重啟 (來源: systemd)')
  expect(notice('stop')).toBe('🔴 cc-telegram-router 2.30.0 關機 (來源: systemd)')
  expect(notice(null)).toBe('🔴 cc-telegram-router 2.30.0 關機 (來源: systemd (SIGTERM))')
  // not under systemd: the signal, whatever a job says
  expect(stopSource({ signal: 'SIGTERM', systemd: false, job: 'restart' })).toBe('訊號 SIGTERM')
  // cli and telegram keep their own source
  expect(stopSource({ by: 'cli', signal: '/restart', systemd: true, job: 'stop' })).toBe('cli')
  const main = readFileSync(join(import.meta.dir, '..', 'main.ts'), 'utf8')
  expect(main).toContain("const job = !o.by && sig === 'SIGTERM' && systemd ? await systemdJob(UNIT_NAME, jobRunner) : null")
  expect(main).toContain("stopNotice(pkg.version, !!o.restart || job === 'restart', stopSource({ by: o.by, signal: sig, systemd, job }))")
  expect(readFileSync(join(import.meta.dir, '..', 'health.ts'), 'utf8')).toContain('timeoutMs = 2_000')
  expect(readFileSync(join(import.meta.dir, '..', 'diagnose.ts'), 'utf8')).toContain("export const UNIT_NAME = 'cc-telegram-router.service'")
})
