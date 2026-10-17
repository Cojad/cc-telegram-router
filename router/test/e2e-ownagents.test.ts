// A conversation's own subagents survive a router restart, bound to the
// worker process (docs/permissions.md 「高風險工具」 own subagents): the real
// router, restarted on the same router.db, the real hook (hooks/hook.ts), the
// real plugin client, a fake Bot API and a fake claude. Unit level:
// risky.test.ts. Keep in sync with docs/testing.md 驗收對照.
//   a named subagent started under the connected worker passes SendMessage;
//   after a router restart it still passes once the worker's plugin
//   reconnects (the same process); with no plugin connected nothing counts;
//   a plugin from another process (a restarted worker) drops the rows; a
//   plugin whose process start time cannot be read counts for nothing;
//   rows of a conversation that no longer exists go at start.

import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { connectRouter } from '../../plugin/client'

const dir = mkdtempSync(join(tmpdir(), 'cctr-own-e2e-'))
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
// another live process: its pid stands for a restarted worker's plugin
const other = Bun.spawn(['sleep', '60'])
const plugins: Array<ReturnType<typeof connectRouter>> = []

afterAll(async () => {
  for (const p of plugins) p.close()
  other.kill()
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

async function hook(event: string, input: object): Promise<any> {
  const p = Bun.spawn(['bun', join(import.meta.dir, '..', '..', 'hooks', 'hook.ts'), 'progress', event], {
    stdin: new Blob([JSON.stringify({ cwd: folder(ukey), ...input })]), stdout: 'pipe',
    env: { ...process.env, CC_TELEGRAM_ROUTER_SOCKET: join(state, 'router.sock'), CLAUDE_PROJECT_DIR: folder(ukey) },
  })
  const text = await new Response(p.stdout).text()
  await p.exited
  return text ? JSON.parse(text).hookSpecificOutput : null
}
/** SendMessage to: null when the router let it through, else its refusal. */
const send = (to: string) => hook('pre', { tool_name: 'SendMessage', tool_input: { to, message: 'hi' } })
const plugin = (pid: number) => {
  const p = connectRouter({ socketPath: join(state, 'router.sock'), hello: { t: 'hello', project_dir: folder(ukey), session_id: 'sess-e2e-1', pid }, onMessage(m) { if (m.t === 'deliver') p.send({ t: 'ack', qid: m.qid }) } })
  plugins.push(p)
  return p
}
const ready = (p: ReturnType<typeof connectRouter>) => until(() => p.state().kind === 'ready')
async function restart(): Promise<void> {
  router.kill('SIGTERM')
  await router.exited
  router = startRouter()
  await until(() => existsSync(join(state, 'router.sock')))
}

test('own subagents survive a router restart while the same worker runs; nothing counts with no plugin; another worker process drops them', async () => {
  dm(USER, 'hi')
  await until(() => q(`SELECT key FROM conversations WHERE key = ?`, ukey).length === 1)
  const u = plugin(process.pid)
  await ready(u)
  expect(await hook('pre', { tool_name: 'Agent', tool_input: { name: 'helper', subagent_type: 'general-purpose', description: 'd', prompt: 'p' } })).toBeNull()
  await hook('subagent-start', { agent_id: 'a77', agent_type: 'general-purpose' })
  expect(await send('helper')).toBeNull()
  expect(await send('a77')).toBeNull()
  const rows = q('SELECT conv, worker, name FROM own_agents ORDER BY rowid')
  expect(rows.map(r => [r.conv, r.name])).toEqual([[ukey, 'a77'], [ukey, 'helper']])
  expect(rows[0].worker).toStartWith(`sess-e2e-1:${process.pid}`)

  // a row of a conversation that no longer exists: removed when the router starts
  { const d = db(); d.run("INSERT INTO own_agents (conv, worker, name, at) VALUES ('dm-700100200', 'w', 'x', ?)", [new Date().toISOString()]); d.close() }

  // the router restarts; the worker (the same plugin process) reconnects by itself
  await restart()
  await until(async () => (await send('helper')) === null, 20000)
  expect(await send('a77')).toBeNull()
  expect(await send('worker [3fa9c1]')).toMatchObject({ permissionDecision: 'deny' })
  expect(q("SELECT name FROM own_agents WHERE conv = 'dm-700100200'")).toEqual([])

  // the plugin leaves, the router restarts: nothing counts until a plugin says hello again
  u.close()
  await restart()
  await until(async () => (await send('helper'))?.permissionDecision === 'deny', 20000)
  const back = plugin(process.pid)
  await ready(back)
  expect(await send('helper')).toBeNull()
  back.close()

  // a restarted worker (same session, another process): the rows of the earlier one go
  const fresh = plugin(other.pid)
  await ready(fresh)
  expect(await send('helper')).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('不是這個對話自己的 subagent') })
  expect(q('SELECT name FROM own_agents WHERE conv = ?', ukey)).toEqual([])
  // the new worker's own subagent counts
  await hook('subagent-start', { agent_id: 'b01', agent_type: 'general-purpose' })
  expect(await send('b01')).toBeNull()
  expect(q('SELECT worker FROM own_agents WHERE conv = ?', ukey)[0].worker).toMatch(new RegExp(`^sess-e2e-1:${other.pid}:\\d+$`))
  fresh.close()

  // a plugin whose process start time cannot be read (no such process): it cannot be told apart, nothing counts
  const ghost = plugin(999999999)
  await ready(ghost)
  expect(await send('b01')).toMatchObject({ permissionDecision: 'deny' })
  await until(() => stderr.includes('no start time for pid 999999999'))
}, 90000)
