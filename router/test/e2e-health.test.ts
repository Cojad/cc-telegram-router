// The health endpoint end to end (docs/operations.md 「健康檢查端點」): the
// real router from source against a fake Bot API and a fake claude, with a
// temporary HOME. With a token configured, GET /healthz without it or with a
// wrong one is 401 and with it 200 (HEAD too), other paths 404; a worker
// claude --bg refuses shows as the last failed wake and one conversation in
// backoff; the Bot API stops answering getUpdates for longer than
// staleAfterS: 503 with that bot not ok, and 200 again once it answers; the
// body never has the token, the bot token, the chat or user id, the
// username, the conversation key or the message. Without a token, 200
// without a header; 0.0.0.0 listens too, warned about in the log. Every
// start tells 🔔 重要通知 (here the owner's DM) the version and the health
// URL, with lines for a public address and a missing token; every stop
// tells it 重啟 or 關機 and where from: /restart in Telegram (telegram:
// @name), cli restart (cli), SIGTERM under systemd (systemd (SIGTERM)); a
// stop notice the Bot API never answers holds the stop up 5 seconds at most.
// Module level in health.test.ts.

import { test, expect, afterAll } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const OWNER_ID = 5550001
const OWNER = { id: OWNER_ID, is_bot: false, first_name: 'Boss', username: 'boss_user' }
const BOT_TOKEN = `7000000123:${'A'.repeat(35)}`
const HEALTH_TOKEN = 'e2e-health-token-xyz'
const MESSAGE = 'a private message nobody else should see'
const now = Math.floor(Date.now() / 1000)
const cleanups: Array<() => Promise<void> | void> = []
afterAll(async () => { for (const c of cleanups.reverse()) await c() })

/** A port nothing listens on right now (the router opens it a moment later). */
function freePort(): number {
  const s = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
  const p = s.port!
  s.stop(true)
  return p
}

/** A fake Bot API, a fake claude whose --bg fails saying its folder, and the router from source with this health config. */
function startRouter(name: string, health: unknown) {
  const dir = mkdtempSync(join(tmpdir(), `cctr-e2e-health-${name}-`))
  const state = join(dir, '.router'), userHome = join(dir, 'user-home')
  for (const d of [state, userHome]) mkdirSync(d, { recursive: true })
  writeFileSync(join(userHome, '.claude.json'), JSON.stringify({ projects: { [dir]: { hasTrustDialogAccepted: true } } }))
  const calls: string[] = []
  const sent: string[] = []
  // holdSends: sendMessage hangs (the notice never confirmed)
  let holdSends = false
  const updates: unknown[] = []
  // frozen: getUpdates hangs until thawed (the Bot API stopped answering)
  let thaw: (() => void) | null = null
  let frozen: Promise<void> | null = null
  const api = Bun.serve({
    port: 0,
    async fetch(req) {
      const method = new URL(req.url).pathname.split('/').pop()!
      calls.push(method)
      const ok = (result: unknown) => Response.json({ ok: true, result })
      const body = (req.headers.get('content-type') ?? '').includes('json') ? await req.json() as any : {}
      if (method === 'getMe') return ok({ id: 7000000123, is_bot: true, first_name: 'cc', username: 'cc_test_bot' })
      if (method === 'getUpdates') { if (frozen) await frozen; await sleep(100); return ok(updates.splice(0)) }
      if (method === 'sendMessage') sent.push(String(body.text))
      if (method === 'sendMessage' && holdSends) await new Promise(() => {})
      if (method === 'sendMessage') return ok({ message_id: 900 + calls.length, date: now, chat: { id: Number(body.chat_id), type: 'private' }, text: body.text })
      return ok(true)
    },
  })
  const fakeClaude = join(dir, 'fake-claude')
  writeFileSync(fakeClaude, `#!/bin/bash\ncase "$*" in *agents*) echo '[]' ;; *--bg*) echo "Error: cannot start the session in $PWD" >&2; exit 1 ;; esac\n`)
  chmodSync(fakeClaude, 0o755)
  writeFileSync(join(state, 'config.json'), JSON.stringify({ bots: [{ name: 'cc', token: BOT_TOKEN }], home: dir, stateDir: state, owners: [String(OWNER_ID)], claudeBin: fakeClaude, apiRoot: `http://127.0.0.1:${api.port}`, health, channelMode: 'legacy' }))
  writeFileSync(join(state, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [String(OWNER_ID)], groups: {}, pending: {} }))
  // INVOCATION_ID: as under systemd, so /restart only exits (no detached copy left behind)
  const env = { HOME: userHome, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, INVOCATION_ID: 'e2e' }
  const router = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'main.ts'), '--config', join(state, 'config.json')], { env, stdout: 'ignore', stderr: 'pipe' })
  const r = {
    dir, calls, sent, updates, router, stderr: '',
    freeze() { frozen = new Promise(res => { thaw = res }) }, thaw() { frozen = null; thaw?.() }, holdSends() { holdSends = true },
    /** cc-telegram-router cli <words> against this router. */
    cli: (...words: string[]) => Bun.spawn([process.execPath, join(import.meta.dir, '..', 'main.ts'), '--config', join(state, 'config.json'), 'cli', ...words], { env, stdout: 'pipe', stderr: 'pipe' }).exited,
  }
  void (async () => { for await (const c of router.stderr) r.stderr += new TextDecoder().decode(c) })()
  cleanups.push(async () => { r.thaw(); router.kill('SIGTERM'); await router.exited; api.stop(true); rmSync(dir, { recursive: true, force: true }) })
  return r
}

async function until<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, why: () => string, ms = 15000): Promise<T> {
  for (let t = 0; t < ms; t += 100) { try { const v = await fn(); if (v) return v } catch {} await sleep(100) }
  throw new Error(`timed out; router stderr:\n${why().slice(-2000)}`)
}

const port = freePort()
const A = startRouter('token', { listen: `127.0.0.1:${port}`, token: HEALTH_TOKEN, staleAfterS: 2 })
const url = `http://127.0.0.1:${port}/healthz`
const get = (init: RequestInit = {}) => fetch(url, init)
const auth = { authorization: `Bearer ${HEALTH_TOKEN}` }
const VERSION = (await import('../../package.json')).default.version
// these routers run with channelMode legacy (docs/managed-channel.md): the start notice's second line
const CHANNEL_LINE = 'channel 模式: legacy (config 的 channelMode 是 legacy; worker 用官方 plugin 的快取)'
const dm = (r: ReturnType<typeof startRouter>, id: number, text: string) => r.updates.push({ update_id: id, message: { message_id: id, date: now, chat: { id: OWNER_ID, type: 'private' }, from: OWNER, text } })
/** Nothing private anywhere in a body. */
function noPrivate(text: string): void {
  for (const bad of [HEALTH_TOKEN, BOT_TOKEN, 'A'.repeat(35), String(OWNER_ID), '7000000123', 'boss_user', 'Boss', 'cc_test_bot', `dm-${OWNER_ID}`, MESSAGE, A.dir, 'chat_id']) expect(text).not.toContain(bad)
  expect(text).not.toMatch(/\d{2}Z"|\+00:00|UTC/)
}

test('with a token: 401 without it or wrong, 200 with it (HEAD too), other paths 404; the report is the router\'s', async () => {
  const body = await until(async () => { const r = await get({ headers: auth }); return r.status === 200 && await r.json() as any }, () => A.stderr)
  expect(A.stderr).toContain(`health: listening on 127.0.0.1:${port}/healthz (要 token, 已設定), 門檻 2 秒`)
  expect((await get()).status).toBe(401)
  expect((await get({ headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
  expect(await (await get()).text()).toBe('{"error":"unauthorized"}')
  expect((await get({ method: 'HEAD', headers: auth })).status).toBe(200)
  expect((await fetch(`http://127.0.0.1:${port}/`, { headers: auth })).status).toBe(404)
  expect((await get({ method: 'POST', headers: auth })).status).toBe(405)
  expect(body.status).toBe('ok')
  expect(body.version).toBe(VERSION)
  expect(body.uptimeS).toBeGreaterThanOrEqual(0)
  expect(body.staleAfterS).toBe(2)
  expect(Object.keys(body.bots)).toEqual(['cc'])
  expect(body.bots.cc.ok).toBe(true)
  expect(body.bots.cc.state).toBe('ok')
  expect(body.bots.cc.lastOkAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}\+08:00$/)
  expect(body.bots.cc.lastOkAgoS).toBeLessThanOrEqual(2)
  expect(body.workers).toEqual({ total: 0, standby: 0, asleep: 0, backoff: 0, pluginDisconnected: 0 })
  expect(body.lastWakeFailure).toBeNull()
  noPrivate(JSON.stringify(body))
  // the start notice: version and URL; loopback with a token adds nothing
  expect(await until(() => A.sent.find(t => t.startsWith('🟢')), () => A.stderr)).toBe(`🟢 cc-telegram-router ${VERSION} 啟動\n${CHANNEL_LINE}\nhealth point (http://127.0.0.1:${port}/healthz) 啟動`)
  expect(A.stderr).not.toContain('health: ⚠️')
}, 30000)

test('a worker that does not wake: the last failed wake with its cause and the bot\'s name, one conversation in backoff, none of the chat\'s ids or the message', async () => {
  dm(A, 1, MESSAGE)
  const body = await until(async () => { const b = await (await get({ headers: auth })).json() as any; return b.lastWakeFailure && b }, () => A.stderr)
  expect(body.lastWakeFailure.bot).toBe('cc')
  expect(body.lastWakeFailure.failures).toBe(1)
  expect(body.lastWakeFailure.at).toMatch(/\+08:00$/)
  // claude said its folder (which has the bot and chat ids): it is hidden
  expect(body.lastWakeFailure.cause).toBe('claude --bg 失敗: Error: cannot start the session in <隱藏>')
  expect(body.workers).toEqual({ total: 1, standby: 0, asleep: 1, backoff: 1, pluginDisconnected: 0 })
  expect(body.status).toBe('ok')
  noPrivate(JSON.stringify(body))
  // the router itself did log it with the conversation (its own log, not the endpoint)
  expect(A.stderr).toContain(`dm-${OWNER_ID}: wake failed (1 in a row)`)
}, 30000)

test('the Bot API stops answering getUpdates for longer than staleAfterS: 503 with the bot not ok; answering again: 200', async () => {
  A.freeze()
  const down = await until(async () => { const r = await get({ headers: auth }); return r.status === 503 && await r.json() as any }, () => A.stderr, 10000)
  expect(down.status).toBe('down')
  expect(down.bots.cc.ok).toBe(false)
  expect(down.bots.cc.lastOkAgoS).toBeGreaterThan(2)
  // still 401 without the token, whatever the state
  expect((await get()).status).toBe(401)
  noPrivate(JSON.stringify(down))
  A.thaw()
  const up = await until(async () => { const r = await get({ headers: auth }); return r.status === 200 && await r.json() as any }, () => A.stderr, 10000)
  expect(up.bots.cc.ok).toBe(true)
  expect(A.stderr).not.toContain(HEALTH_TOKEN)
  expect(A.stderr).not.toContain(BOT_TOKEN)
}, 30000)

test('/restart in Telegram: the stop notice says 重啟 and telegram: @name before the router exits', async () => {
  dm(A, 2, '/restart')
  expect(await until(() => A.sent.find(t => t.startsWith('🔴')), () => A.stderr)).toBe(`🔴 cc-telegram-router ${VERSION} 重啟 (來源: telegram: @boss_user)`)
  expect(await Promise.race([A.router.exited, sleep(10000).then(() => 'still running')])).toBe(0)
  expect(A.stderr).toContain(`stop notice: 🔴 cc-telegram-router ${VERSION} 重啟 (來源: telegram: @boss_user)`)
}, 30000)

test('without a token: 200 with no header, the start notice says no token, cli restart says cli; 0.0.0.0 listens, warned as public, and SIGTERM under systemd says systemd (SIGTERM) even when the notice hangs (5 seconds at most)', async () => {
  const p2 = freePort(), p3 = freePort()
  const B = startRouter('open', { listen: `localhost:${p2}`, staleAfterS: 30 })
  const C = startRouter('wide', { listen: `0.0.0.0:${p3}`, token: HEALTH_TOKEN })
  const b = await until(async () => { const r = await fetch(`http://localhost:${p2}/healthz`); return r.status === 200 && await r.json() as any }, () => B.stderr)
  expect(b.bots.cc.ok).toBe(true)
  expect(B.stderr).toContain(`health: listening on localhost:${p2}/healthz (未設 token), 門檻 30 秒`)
  expect(B.stderr).toContain(`health: ⚠️ 未設 token: 連得到 localhost:${p2} 的這台機器上的程式都看得到狀態`)
  expect(await until(() => B.sent.find(t => t.startsWith('🟢')), () => B.stderr)).toBe(`🟢 cc-telegram-router ${VERSION} 啟動\n${CHANNEL_LINE}\nhealth point (http://localhost:${p2}/healthz) 啟動\n⚠️ health point 未設 token, 連得到的都看得到狀態`)
  expect(await B.cli('restart')).toBe(0)
  expect(await until(() => B.sent.find(t => t.startsWith('🔴')), () => B.stderr)).toBe(`🔴 cc-telegram-router ${VERSION} 重啟 (來源: cli)`)
  expect(await Promise.race([B.router.exited, sleep(10000).then(() => 'still running')])).toBe(0)

  // 0.0.0.0: open on every address, 127.0.0.1 included; public in the log and the notice
  const c = await until(async () => { const r = await fetch(`http://127.0.0.1:${p3}/healthz`, { headers: auth }); return r.status === 200 && await r.json() as any }, () => C.stderr)
  expect(c.bots.cc.ok).toBe(true)
  expect((await fetch(`http://127.0.0.1:${p3}/healthz`)).status).toBe(401)
  expect(C.stderr).toContain(`health: ⚠️ 聽在 0.0.0.0:${p3}, 不是本機也不是私有網段: health point 對外開放, 請注意防範`)
  expect(await until(() => C.sent.find(t => t.startsWith('🟢')), () => C.stderr)).toBe(`🟢 cc-telegram-router ${VERSION} 啟動\n${CHANNEL_LINE}\nhealth point (http://0.0.0.0:${p3}/healthz) 啟動\n⚠️ health point 對外開放, 請注意防範`)
  // the Bot API stops answering sendMessage: the stop still ends, after 5 seconds
  C.holdSends()
  const t0 = Date.now()
  C.router.kill('SIGTERM')
  expect(await Promise.race([C.router.exited, sleep(15000).then(() => 'still running')])).toBe(0)
  expect(Date.now() - t0).toBeGreaterThanOrEqual(4500)
  expect(C.sent.find(t => t.startsWith('🔴'))).toBe(`🔴 cc-telegram-router ${VERSION} 關機 (來源: systemd (SIGTERM))`)
  expect(C.stderr).toContain('stop notice: not confirmed within 5s, stopping anyway')
  for (const r of [B, C]) { expect(r.stderr).not.toContain(HEALTH_TOKEN); expect(r.stderr).not.toContain(BOT_TOKEN) }
}, 60000)
