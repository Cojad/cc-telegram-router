// Automatic elevation end to end (docs/permissions.md 「提權」 這一輪的發話者 /
// 自動提權, 「使用者覆寫」; docs/operations.md /router perm user): the real
// router process, the real hook (hooks/hook.ts), the plugin client, a fake
// Bot API and a fake claude. Unit level: autoelev.test.ts. Keep in sync with
// docs/testing.md 驗收對照.
//   a worker already running when the router started has no sender until
//   its next Stop; then an owner's turn in a user group makes ListAgents at
//   once (hook allow, elev_log auto, tool_history with the owner's role);
//   a user's message and the owner's read in one turn: no automatic pass,
//   ListAgents asked in the chat (once only), a path block not asked;
//   /router perm user (cli) on the user: their DM's settings carry it (not
//   the group's), and their own turn in the group passes.
// All ids and names are example values.

import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { connectRouter } from '../../plugin/client'

const dir = mkdtempSync(join(tmpdir(), 'cctr-e2e-autoelev-'))
const state = join(dir, '.router')
mkdirSync(state)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const OWNER = { id: 700100100, is_bot: false, first_name: 'Example', last_name: 'Owner' }
const USER = { id: 700100200, is_bot: false, first_name: 'Example', last_name: 'User' }
const GROUP = { id: -1009990000001, type: 'supergroup', title: 'Example Group' }
const GKEY = 'group-1009990000001', UKEY = `dm-${USER.id}`
const now = Math.floor(Date.now() / 1000)

const calls: Array<{ method: string; body: any }> = []
const updates: unknown[] = []
let mid = 1001, uid = 1, sent = 5000
const msg = (chat: { id: number; type: string }, from: typeof USER, text: string) => {
  const id = mid++
  updates.push({ update_id: uid++, message: { message_id: id, date: now, chat, from, text } })
  return id
}
const api = Bun.serve({
  port: 0,
  async fetch(req) {
    const method = new URL(req.url).pathname.split('/').pop()!
    const body = req.headers.get('content-type')?.includes('json') ? await req.json() : {}
    calls.push({ method, body })
    const ok = (result: unknown) => Response.json({ ok: true, result })
    switch (method) {
      case 'getMe': return ok({ id: 1, is_bot: true, first_name: 'cc', username: 'cc_bot', can_read_all_group_messages: true })
      case 'getUpdates': await sleep(100); return ok(updates.splice(0))
      case 'sendMessage': return ok({ message_id: ++sent, date: now, chat: { id: Number(body.chat_id) }, text: body.text })
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
writeFileSync(join(state, 'access.json'), JSON.stringify({
  dmPolicy: 'allowlist', allowFrom: [String(OWNER.id), String(USER.id)], pending: {},
  groups: { [String(GROUP.id)]: { requireMention: false, allowFrom: [] } },
}))

const router = Bun.spawn(['bun', join(import.meta.dir, '..', 'main.ts'), '--config', join(state, 'config.json')], { stdout: 'ignore', stderr: 'pipe' })
let stderr = ''
void (async () => { for await (const c of router.stderr) stderr += new TextDecoder().decode(c) })()
const delivered: Array<{ content: string; meta: Record<string, string> }> = []
let worker: ReturnType<typeof connectRouter> | null = null

afterAll(async () => {
  worker?.close()
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
const folder = join(dir, 'bot123', GKEY)
/** The group worker's hook (hooks/hook.ts progress <event>): the PreToolUse decision it printed. */
async function hook(event: string, input: object): Promise<any> {
  const p = Bun.spawn(['bun', join(import.meta.dir, '..', '..', 'hooks', 'hook.ts'), 'progress', event], {
    stdin: new Blob([JSON.stringify({ cwd: folder, ...input })]), stdout: 'pipe',
    env: { ...process.env, XDG_RUNTIME_DIR: state, CC_TELEGRAM_ROUTER_SOCKET: join(state, 'router.sock'), CLAUDE_PROJECT_DIR: folder },
  })
  const text = await new Response(p.stdout).text()
  await p.exited
  return text ? JSON.parse(text).hookSpecificOutput : null
}
const tag = (id: number, from: typeof USER) => `<channel source="plugin:telegram:telegram" chat_id="${GROUP.id}" message_id="${id}" user="${from.first_name}" user_id="${from.id}">…</channel>`
/** Claude Code starts a turn with these messages. */
const prompt = (...ids: Array<[number, typeof USER]>) => hook('prompt', { prompt: ids.map(([i, f]) => tag(i, f)).join('\n') })
const cli = async (...args: string[]) => {
  const p = Bun.spawn(['bun', join(import.meta.dir, '..', 'main.ts'), '--config', join(state, 'config.json'), 'cli', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(p.stdout).text()
  await p.exited
  return out
}
const asked = () => calls.filter(c => c.method === 'sendMessage' && String(c.body.text).startsWith('🔐 提權請求'))

test('a worker running when the router started has no sender until its Stop; then an owner\'s turn in a user group makes ListAgents at once, logged with the owner\'s role', async () => {
  const hello = msg(GROUP, OWNER, 'hello group')
  await until(() => q(`SELECT role FROM conversations WHERE key = '${GKEY}'`)[0]?.role === 'user')
  // pid 1 started long before this router: the worker may be mid-turn
  worker = connectRouter({
    socketPath: join(state, 'router.sock'),
    hello: { t: 'hello', project_dir: folder, pid: 1 },
    onMessage(m) { if (m.t === 'deliver') { delivered.push({ content: m.params.content, meta: m.params.meta as Record<string, string> }); worker!.send({ t: 'ack', qid: m.qid }) } },
  })
  await until(() => delivered.some(d => d.meta.message_id === String(hello)))
  expect(await hook('pre', { tool_name: 'ListAgents', tool_input: {} })).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('power 以下的角色不能使用 ListAgents') })
  await hook('stop', {})
  // known from here on: the owner's next message starts a turn
  const next = msg(GROUP, OWNER, '列出 agents')
  await until(() => delivered.some(d => d.meta.message_id === String(next)))
  await prompt([next, OWNER])
  expect(await hook('pre', { tool_name: 'ListAgents', tool_input: {} })).toEqual({ hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: `自動提權 (發起者 Example Owner (${OWNER.id}) [owner]), 以 owner 角色執行` })
  expect(await hook('pre', { tool_name: 'SendMessage', tool_input: { to: 'worker [3fa9c1]', message: 'do-not-store' } })).toMatchObject({ permissionDecision: 'allow' })
  const log = await until(() => { const r = q(`SELECT kind, text FROM elev_log WHERE conv = '${GKEY}' AND kind = 'auto' ORDER BY id`); return r.length === 2 && r })
  expect(log[0].text).toStartWith(`⚡ 自動提權 ${GKEY} (Example Group): ListAgents`)
  expect(log[1].text).toContain('收件對象 worker [3fa9c1]')
  expect(log[1].text).toContain(`發起者 Example Owner (${OWNER.id}) [owner]: 這一輪的發話者都有權限, 以 owner 角色執行`)
  const rows = await until(() => { const r = q(`SELECT tool, decision, eff_role, reason FROM tool_history WHERE conv = '${GKEY}' AND decision = 'allow' ORDER BY id`); return r.length === 2 && r })
  expect(rows.map(r => [r.tool, r.decision, r.eff_role])).toEqual([['ListAgents', 'allow', 'owner'], ['SendMessage', 'allow', 'owner']])
  expect(rows[0].reason).toStartWith('自動提權 (發起者 Example Owner')
  expect(asked()).toEqual([])
  await hook('stop', {})
}, 30000)

test('a user\'s message and the owner\'s read in one turn: no automatic pass; ListAgents is asked in the chat (the owner may), any other block is not', async () => {
  const a = msg(GROUP, USER, '幫我看一下')
  const b = msg(GROUP, OWNER, '順便列出 agents')
  await until(() => delivered.some(d => d.meta.message_id === String(b)) && delivered.some(d => d.meta.message_id === String(a)))
  await prompt([a, USER], [b, OWNER])
  expect(await hook('pre', { tool_name: 'Bash', tool_input: { command: 'touch /etc/example-file' } })).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('請改用不越權的方法完成') })
  await sleep(300)
  expect(asked()).toEqual([])
  expect(q(`SELECT text FROM elev_log WHERE conv = '${GKEY}' AND kind = 'blocked' ORDER BY id DESC LIMIT 1`)[0].text).toEndWith(`發起者 Example User (${USER.id}) [user], Example Owner (${OWNER.id}) [owner]`)
  expect(await hook('pre', { tool_name: 'ListAgents', tool_input: {} })).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('router 已在對話裡詢問是否提權') })
  const ask = await until(() => asked()[0])
  expect(Number(ask.body.chat_id)).toBe(GROUP.id)
  expect(ask.body.reply_markup.inline_keyboard.flat().map((k: any) => k.callback_data)).toEqual([expect.stringMatching(/^elev:\d+:once$/), expect.stringMatching(/^elev:\d+:deny$/)])
  await hook('stop', {})
}, 30000)

test('/router perm user from the terminal: the user\'s DM settings carry it (rotation: autoelev.test.ts); their own turn in the group passes as user', async () => {
  msg({ id: USER.id, type: 'private' }, USER, 'hi')
  await until(() => q(`SELECT key FROM conversations WHERE key = '${UKEY}'`).length === 1)
  const out = await cli('perm', 'user', String(USER.id), 'tool', 'allow', 'ListAgents')
  expect(out).toContain(`tool allow ListAgents\n使用者覆寫: tool-allow ListAgents\n私訊 ${UKEY} 的 worker 閒置時會停掉`)
  expect(q(`SELECT kind, value FROM user_overrides WHERE uid = '${USER.id}'`)).toEqual([{ kind: 'tool-allow', value: 'ListAgents' }])
  const settings = JSON.parse(readFileSync(join(state, 'sessions', `${UKEY}.json`), 'utf8'))
  expect(settings.permissions.allow).toContain('ListAgents')
  expect(JSON.parse(readFileSync(join(state, 'sessions', `${GKEY}.json`), 'utf8')).permissions.allow).not.toContain('ListAgents')
  // marked for rotation (autoelev.test.ts); with no worker running the mark is cleared at once (router/rotate.ts)
  const m = msg(GROUP, USER, '列出 agents')
  await until(() => delivered.some(d => d.meta.message_id === String(m)))
  await prompt([m, USER])
  expect(await hook('pre', { tool_name: 'ListAgents', tool_input: {} })).toMatchObject({ permissionDecision: 'allow', permissionDecisionReason: `自動提權 (發起者 Example User (${USER.id}) [user]), 以 user 角色執行` })
  expect(await hook('pre', { tool_name: 'CronCreate', tool_input: {} })).toMatchObject({ permissionDecision: 'deny' })
  await hook('stop', {})
}, 30000)
