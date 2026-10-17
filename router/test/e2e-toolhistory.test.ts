// Tool call history and the high-risk tools end to end (docs/operations.md
// 「工具呼叫紀錄」, docs/permissions.md 「高風險工具」): the real router, the
// real hook (hooks/hook.ts), a fake Bot API and a fake claude. Unit level:
// toolhistory.test.ts, risky.test.ts. Keep in sync with docs/testing.md 驗收對照.
//   every PreToolUse the hook reports is one tool_history row (owner
//   conversations too), with the router's decision; a user conversation's
//   ListAgents and SendMessage to another session are blocked, an owner's are
//   not; SendMessage to its own named subagent passes once SubagentStart came;
//   a Telegram reply the router runs is recorded router-side; no arguments
//   are stored; `cli tools` prints the report.

import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { connectRouter } from '../../plugin/client'

const dir = mkdtempSync(join(tmpdir(), 'cctr-th-e2e-'))
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

const router = Bun.spawn(['bun', join(import.meta.dir, '..', 'main.ts'), '--config', join(state, 'config.json')], { stdout: 'ignore', stderr: 'pipe' })
let stderr = ''
void (async () => { for await (const c of router.stderr) stderr += new TextDecoder().decode(c) })()

afterAll(async () => {
  router.kill('SIGTERM')
  await router.exited
  api.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

async function until<T>(fn: () => T | undefined | false, ms = 10000): Promise<T> {
  for (let t = 0; t < ms; t += 50) {
    try { const v = fn(); if (v) return v } catch {}
    await sleep(50)
  }
  throw new Error(`timed out\n${stderr.slice(-2000)}`)
}
const q = (sql: string) => {
  const db = new Database(join(state, 'router.db'), { readonly: true })
  try { return db.query(sql).all() as any[] } finally { db.close() }
}
let mid = 1
const dm = (from: typeof OWNER, text: string) => { const id = mid++; updates.push({ update_id: id, message: { message_id: id, date: now, chat: { id: from.id, type: 'private' }, from, text } }); return id }
const folder = (key: string) => join(dir, 'bot123', key)
const ukey = `dm-${USER.id}`, okey = `dm-${OWNER.id}`

/** The worker's hook (hooks/hook.ts progress <event>): the PreToolUse decision it printed. */
async function hook(key: string, event: string, input: object): Promise<any> {
  const p = Bun.spawn(['bun', join(import.meta.dir, '..', '..', 'hooks', 'hook.ts'), 'progress', event], {
    stdin: new Blob([JSON.stringify({ cwd: folder(key), ...input })]), stdout: 'pipe',
    env: { ...process.env, CC_TELEGRAM_ROUTER_SOCKET: join(state, 'router.sock'), CLAUDE_PROJECT_DIR: folder(key) },
  })
  const text = await new Response(p.stdout).text()
  await p.exited
  return text ? JSON.parse(text).hookSpecificOutput : null
}
const pre = (key: string, tool_name: string, tool_input: object, extra: object = {}) => hook(key, 'pre', { tool_name, tool_input, ...extra })

test('every PreToolUse is a tool_history row with the router\'s decision; high-risk tools blocked for user, not for owner; own subagent by name; no arguments stored', async () => {
  dm(USER, 'hi'); dm(OWNER, 'hi')
  await until(() => q(`SELECT key FROM conversations WHERE key IN ('${ukey}', '${okey}')`).length === 2)
  expect(await pre(ukey, 'Read', { file_path: join(folder(ukey), 'notes.md') })).toBeNull()
  expect(await pre(ukey, 'ListAgents', {})).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('power 以下的角色不能使用 ListAgents') })
  expect(await pre(okey, 'ListAgents', {})).toBeNull()
  expect(await pre(ukey, 'SendMessage', { to: 'worker [3fa9c1]', message: '機密內容 do-not-store' })).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('power 以下的角色不能傳訊給其他 session') })
  // its own named subagent: once SubagentStart came
  expect(await pre(ukey, 'Agent', { name: 'helper', subagent_type: 'general-purpose', description: 'd', prompt: 'do-not-store prompt' })).toBeNull()
  await hook(ukey, 'subagent-start', { agent_id: 'a77', agent_type: 'general-purpose' })
  expect(await pre(ukey, 'SendMessage', { to: 'helper', message: 'hi' })).toBeNull()
  expect(await pre(ukey, 'SendMessage', { to: 'main', message: 'done' }, { agent_id: 'a77' })).toBeNull()
  const rows = await until(() => { const r = q('SELECT conv, conv_role, eff_role, tool, decision, target, subagent FROM tool_history ORDER BY id'); return r.length >= 7 && r })
  expect(rows).toEqual([
    { conv: ukey, conv_role: 'user', eff_role: null, tool: 'Read', decision: 'allow', target: null, subagent: 0 },
    { conv: ukey, conv_role: 'user', eff_role: null, tool: 'ListAgents', decision: 'deny', target: null, subagent: 0 },
    { conv: okey, conv_role: 'owner', eff_role: null, tool: 'ListAgents', decision: 'allow', target: null, subagent: 0 },
    { conv: ukey, conv_role: 'user', eff_role: null, tool: 'SendMessage', decision: 'deny', target: 'worker [3fa9c1]', subagent: 0 },
    { conv: ukey, conv_role: 'user', eff_role: null, tool: 'Agent', decision: 'allow', target: null, subagent: 0 },
    { conv: ukey, conv_role: 'user', eff_role: null, tool: 'SendMessage', decision: 'allow', target: 'helper', subagent: 0 },
    { conv: ukey, conv_role: 'user', eff_role: null, tool: 'SendMessage', decision: 'allow', target: 'main', subagent: 1 },
  ])
  const all = JSON.stringify(q('SELECT * FROM tool_history'))
  expect(all).not.toContain('do-not-store')
  expect(all).not.toContain('notes.md')
  expect(q("SELECT reason FROM tool_history WHERE tool = 'ListAgents' AND decision = 'deny'")[0].reason).toStartWith('權限不足 (本對話角色 user): power 以下的角色不能使用 ListAgents.')
}, 30000)

test('a Telegram reply the router runs is recorded router-side (the hook leaves it to the router), once', async () => {
  const u = connectRouter({ socketPath: join(state, 'router.sock'), hello: { t: 'hello', project_dir: folder(ukey), pid: 21 }, onMessage(m) { if (m.t === 'deliver') u.send({ t: 'ack', qid: m.qid }) } })
  await sleep(200)
  expect(await pre(ukey, 'mcp__plugin_telegram_telegram__reply', { chat_id: String(USER.id), text: 'hi' })).toBeNull() // main session: not forwarded
  expect((await u.call('reply', { chat_id: String(USER.id), text: '好了' })).isError).toBeFalsy()
  const r = await until(() => q("SELECT conv, conv_role, tool, decision, subagent FROM tool_history WHERE tool LIKE 'mcp__plugin_telegram%'"))
  expect(r).toEqual([{ conv: ukey, conv_role: 'user', tool: 'mcp__plugin_telegram_telegram__reply', decision: 'allow', subagent: 0 }])
}, 20000)

test('cli tools [天數]: the report from the owner terminal', async () => {
  const p = Bun.spawn(['bun', join(import.meta.dir, '..', 'main.ts'), '--config', join(state, 'config.json'), 'cli', 'tools', '7'], { stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(p.stdout).text()
  await p.exited
  expect(out).toStartWith('工具呼叫統計: 近 7 天 (')
  expect(out).toContain('SendMessage 3 次: user 3; 被擋 1')
  expect(out).toContain('ListAgents 2 次: owner 1, user 1; 被擋 1')
  expect(out).toContain('mcp__plugin_telegram_telegram__reply 1 次: user 1')
  expect(out).toContain('合計 8 次: owner 1, user 7; 被擋 2')
}, 20000)
