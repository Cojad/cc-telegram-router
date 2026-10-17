// The hook keeps trying while the router restarts, and the router waits for
// a worker's plugin to come back (docs/permissions.md 「router 連不到時」,
// shared/retry.ts): the real router, stopped and started on the same
// router.db, the real hook (hooks/hook.ts), the real plugin client, a fake
// Bot API and a fake claude. Unit level: retry.test.ts, risky.test.ts.
// Keep in sync with docs/testing.md 驗收對照.
//   the router is stopped when the hook runs and back within 2 s: the hook
//   gets the router's own decision on a later try, not the unreachable
//   fallback, and the router logs the try; it stays stopped: after every
//   try the fallback (let through, never out of the sandbox);
//   SendMessage to the conversation's own subagent while the worker's plugin
//   is disconnected: let through once it is back about 1 s later; refused
//   at the deadline when it never comes back; a router unreached for over 3
//   minutes (the breaker's state file): one try, the fallback at once, and
//   the router back on that one try resets it. The hook's breaker state goes
//   in the test dir (XDG_RUNTIME_DIR).

import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { connectRouter } from '../../plugin/client'
import { reachFile, readReach, writeReach } from '../../shared/retry'

const dir = mkdtempSync(join(tmpdir(), 'cctr-retry-e2e-'))
const state = join(dir, '.router')
mkdirSync(state)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const OWNER = { id: 55500001, is_bot: false, first_name: 'Boss', username: 'boss' }
const USER = { id: 66600001, is_bot: false, first_name: 'U', username: 'u' }

const updates: unknown[] = []
const now = Math.floor(Date.now() / 1000)
const api = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    const body = (req.headers.get('content-type') ?? '').includes('json') ? await req.json() : {}
    const method = url.pathname.split('/').pop()!
    const ok = (result: unknown) => Response.json({ ok: true, result })
    switch (method) {
      case 'getMe': return ok({ id: 1, is_bot: true, first_name: 'cc', username: 'cc_bot', can_read_all_group_messages: true })
      case 'getUpdates': await sleep(100); return ok(updates.splice(0))
      case 'sendMessage': return ok({ message_id: 900, date: now, chat: { id: Number(body.chat_id) }, text: body.text })
      default: return ok(true)
    }
  },
})

const fakeClaude = join(dir, 'fake-claude')
writeFileSync(fakeClaude, `#!/bin/bash
case "$*" in *agents*) echo '[]' ;; *--bg*) echo "backgrounded · abcd1234 · tg-x (idle)" ;; esac
`)
chmodSync(fakeClaude, 0o755)
writeFileSync(join(state, 'config.json'), JSON.stringify({
  bots: [{ name: 'cc', token: '123:test' }], home: dir, stateDir: state, owners: [String(OWNER.id)],
  model: 'claude-opus-5-5', claudeBin: fakeClaude, apiRoot: `http://127.0.0.1:${api.port}`,
}))
writeFileSync(join(state, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [String(OWNER.id), String(USER.id)], groups: {}, pending: {} }))

let stderr = ''
function startRouter() {
  const p = Bun.spawn(['bun', join(import.meta.dir, '..', 'main.ts'), '--config', join(state, 'config.json')], { stdout: 'ignore', stderr: 'pipe' })
  void (async () => { for await (const c of p.stderr) stderr += new TextDecoder().decode(c) })()
  return p
}
let router = startRouter()
const plugins: Array<ReturnType<typeof connectRouter>> = []

afterAll(async () => {
  for (const p of plugins) p.close()
  router.kill('SIGTERM')
  await router.exited
  api.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

async function until<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 10000): Promise<T> {
  for (let t = 0; t < ms; t += 50) {
    try { const v = await fn(); if (v) return v } catch {}
    await sleep(50)
  }
  throw new Error(`timed out\n${stderr.slice(-2000)}`)
}
const db = () => new Database(join(state, 'router.db'))
const q = (sql: string, ...args: any[]) => {
  const d = db()
  try { return d.query(sql).all(...args) as any[] } finally { d.close() }
}
let mid = 1
const dm = (from: typeof OWNER, text: string) => { const id = mid++; updates.push({ update_id: id, message: { message_id: id, date: now, chat: { id: from.id, type: 'private' }, from, text } }); return id }
const folder = (key: string) => join(dir, 'bot123', key)
const ukey = `dm-${USER.id}`

/** Run the real hook; its output and how long it took. window: a shorter retry window (CC_TELEGRAM_ROUTER_RETRY_WINDOW_MS). */
async function hook(event: string, input: object, window?: number): Promise<{ out: any; ms: number }> {
  const t0 = Date.now()
  const p = Bun.spawn(['bun', join(import.meta.dir, '..', '..', 'hooks', 'hook.ts'), 'progress', event], {
    stdin: new Blob([JSON.stringify({ cwd: folder(ukey), ...input })]), stdout: 'pipe',
    env: { ...process.env, CC_TELEGRAM_ROUTER_SOCKET: join(state, 'router.sock'), CLAUDE_PROJECT_DIR: folder(ukey), XDG_RUNTIME_DIR: dir, ...(window ? { CC_TELEGRAM_ROUTER_RETRY_WINDOW_MS: String(window) } : {}) },
  })
  const text = await new Response(p.stdout).text()
  await p.exited
  return { out: text ? JSON.parse(text).hookSpecificOutput : null, ms: Date.now() - t0 }
}
const send = (to: string, window?: number) => hook('pre', { tool_name: 'SendMessage', tool_input: { to, message: 'hi' } }, window)
const plugin = (pid: number) => {
  const p = connectRouter({ socketPath: join(state, 'router.sock'), hello: { t: 'hello', project_dir: folder(ukey), session_id: 'sess-e2e-1', pid }, onMessage(m) { if (m.t === 'deliver') p.send({ t: 'ack', qid: m.qid }) } })
  plugins.push(p)
  return p
}
const ready = (p: ReturnType<typeof connectRouter>) => until(() => p.state().kind === 'ready')
async function stopRouter(): Promise<void> {
  router.kill('SIGTERM')
  await router.exited
  expect(existsSync(join(state, 'router.sock'))).toBe(false)
}


test('the router stopped when the hook runs, back within 2 s: the hook gets its decision on a later try, not the fallback', async () => {
  dm(USER, 'hi')
  await until(() => q(`SELECT key FROM conversations WHERE key = ?`, ukey).length === 1)
  // with the router up, ListAgents is refused for user
  expect((await hook('pre', { tool_name: 'ListAgents', tool_input: {} })).out).toMatchObject({ permissionDecision: 'deny' })
  await stopRouter()
  const pending = hook('pre', { tool_name: 'ListAgents', tool_input: {} })
  await sleep(1000)
  router = startRouter()
  const r = await pending
  expect(r.out).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('power 以下的角色不能使用 ListAgents') })
  // the second try (3 s) or, on a slow start, the third (8 s)
  expect(r.ms).toBeGreaterThanOrEqual(2900)
  expect(r.ms).toBeLessThan(12_000)
  await until(() => /hook pre dm-\d+: reached the router on try [23], \d+\.\ds after the first/.test(stderr))
}, 30000)

test('the router stays stopped: after every try the fallback, let through but never out of the sandbox', async () => {
  await stopRouter()
  // a 3 s window: tries at 0 and 3 s
  let r = await hook('pre', { tool_name: 'ListAgents', tool_input: {} }, 3000)
  expect(r.out).toBeNull()
  expect(r.ms).toBeGreaterThanOrEqual(2900)
  r = await hook('pre', { tool_name: 'Bash', tool_input: { command: 'ls', dangerouslyDisableSandbox: true } }, 3000)
  expect(r.out).toEqual({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'router unreachable: no unsandboxed commands' })
  // other events go once: no waiting
  r = await hook('post', { tool_name: 'Bash', tool_input: { command: 'ls' } }, 3000)
  expect(r.ms).toBeLessThan(2500)
  router = startRouter()
  await until(() => existsSync(join(state, 'router.sock')))
}, 30000)

test('SendMessage to the conversation\'s own subagent while its plugin is disconnected: let through once it is back, refused at the deadline when it never is', async () => {
  let u = plugin(process.pid)
  await ready(u)
  expect((await hook('pre', { tool_name: 'Agent', tool_input: { name: 'helper', subagent_type: 'general-purpose', description: 'd', prompt: 'p' } })).out).toBeNull()
  await hook('subagent-start', { agent_id: 'a77', agent_type: 'general-purpose' })
  expect((await send('helper')).out).toBeNull()

  // the plugin drops; the same worker process says hello again about 1 s later
  u.close()
  const gone = () => stderr.split(`worker ${ukey} said bye`).length - 1
  await until(() => gone() === 1)
  const pending = send('helper')
  await sleep(1000)
  u = plugin(process.pid)
  const r = await pending
  expect(r.out).toBeNull()
  expect(r.ms).toBeGreaterThanOrEqual(900)
  expect(r.ms).toBeLessThan(5000)
  await until(() => /own subagent helper of dm-\d+: waited \d+\.\ds for the worker's plugin, the same worker is back: counted/.test(stderr))

  // it never comes back: refused at the deadline (a 4 s window), as cross-session
  u.close()
  await until(() => gone() === 2)
  const late = await send('helper', 4000)
  expect(late.out).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('不是這個對話自己的 subagent') })
  expect(late.ms).toBeGreaterThanOrEqual(3900)
  expect(late.ms).toBeLessThan(9000)
  await until(() => stderr.includes("for the worker's plugin, the plugin did not say hello in time: not counted"))
}, 60000)

test('the breaker: a router unreached for over 3 minutes gets one try, the fallback at once; back on that try, normal again', async () => {
  const file = reachFile(join(state, 'router.sock'), { XDG_RUNTIME_DIR: dir })
  await stopRouter()
  writeReach(file, { down_since: Date.now() - 200_000, last_ok: null })
  let r = await hook('pre', { tool_name: 'ListAgents', tool_input: {} })
  expect(r.out).toBeNull()
  expect(r.ms).toBeLessThan(2500)
  r = await hook('pre', { tool_name: 'Bash', tool_input: { command: 'ls', dangerouslyDisableSandbox: true } })
  expect(r.out).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: 'router unreachable: no unsandboxed commands' })
  expect(r.ms).toBeLessThan(2500)
  // the router is back: the one try reaches it, its decision, and the breaker closes
  router = startRouter()
  await until(() => existsSync(join(state, 'router.sock')))
  r = await hook('pre', { tool_name: 'ListAgents', tool_input: {} })
  expect(r.out).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('power 以下的角色不能使用 ListAgents') })
  expect(readReach(file)).toMatchObject({ down_since: null })
  expect(readReach(file).last_ok).toBeGreaterThan(Date.now() - 10_000)
}, 30000)
