// End-to-end Phase 1 acceptance (plan 10 Phase 1 驗收; flows in 03 邏輯流程):
// the real router process against a fake Bot API and a fake claude CLI.
// Every update lands in events, delivered messages are queued per
// conversation and woken, a plugin-side client receives them, and its reply
// goes out through the Bot API and is logged in outbound.

import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { connectRouter } from '../../plugin/client'

const dir = mkdtempSync(join(tmpdir(), 'cctr-e2e-'))
const state = join(dir, '.router')
mkdirSync(state)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// --- fake Bot API ---------------------------------------------------------
const calls: Array<{ method: string; body: any; token?: string }> = []
let updatesServed = false
const laterUpdates: unknown[] = []
const now = Math.floor(Date.now() / 1000)
const UPDATES = [
  { update_id: 1, message: { message_id: 10, date: now, chat: { id: 111, type: 'private' }, from: { id: 111, is_bot: false, first_name: 'O', username: 'owner' }, text: 'hello router' } },
  { update_id: 2, message: { message_id: 11, date: now, chat: { id: -100777, type: 'supergroup', title: 'G' }, from: { id: 222, is_bot: false, first_name: 'U', username: 'user' }, text: 'hi group' } },
  { update_id: 3, message: { message_id: 12, date: now, chat: { id: 333, type: 'private' }, from: { id: 333, is_bot: false, first_name: 'X', username: 'stranger' }, text: 'let me in' } },
]
const api = Bun.serve({
  port: 0,
  async fetch(req) {
    const parts = new URL(req.url).pathname.split('/')
    const method = parts.pop()!
    const token = parts.pop()!.replace(/^bot/, '')
    const body = req.headers.get('content-type')?.includes('json') ? await req.json() : {}
    calls.push({ method, body, token })
    const ok = (result: unknown) => Response.json({ ok: true, result })
    switch (method) {
      case 'getMe': return ok({ id: 1, is_bot: true, first_name: 'cc', username: 'cc_bot' })
      case 'getUpdates':
        if (!updatesServed) { updatesServed = true; return ok(UPDATES) }
        await sleep(200)
        return ok(laterUpdates.splice(0))
      case 'sendMessage': return ok({ message_id: 900 + calls.length, date: now, chat: { id: Number(body.chat_id) }, text: body.text })
      case 'deleteMessage':
        // like Telegram: the bot is not an admin in groups, so it cannot delete others' messages there
        if (String(body.chat_id).startsWith('-')) return Response.json({ ok: false, error_code: 400, description: "Bad Request: message can't be deleted" })
        return ok(true)
      default: return ok(true)
    }
  },
})

// --- fake claude CLI --------------------------------------------------------
const argLog = join(dir, 'claude-args.log')
const fakeClaude = join(dir, 'fake-claude')
writeFileSync(fakeClaude, `#!/bin/bash
echo "$*" >> '${argLog}'
case "$*" in
  *agents*) echo '[]' ;;
  *--bg*) echo "backgrounded · abcd1234 · tg-x (idle)" ;;
esac
`)
chmodSync(fakeClaude, 0o755)

writeFileSync(join(state, 'config.json'), JSON.stringify({
  bots: [{ name: 'cc', token: '123:test' }], home: dir, stateDir: state, owners: ['111'],
  model: 'claude-opus-5-5', claudeBin: fakeClaude, apiRoot: `http://127.0.0.1:${api.port}`,
}))
writeFileSync(join(state, 'access.json'), JSON.stringify({
  dmPolicy: 'allowlist', allowFrom: ['111', '222'], groups: { '-100777': { requireMention: false, allowFrom: [] } }, pending: {},
}))

const router = Bun.spawn(['bun', join(import.meta.dir, '..', 'main.ts'), '--config', join(state, 'config.json')], { stdout: 'ignore', stderr: 'pipe' })

afterAll(async () => {
  router.kill('SIGTERM')
  await router.exited
  api.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

async function until<T>(fn: () => T | undefined | false, ms = 8000): Promise<T> {
  for (let t = 0; t < ms; t += 50) {
    try { const v = fn(); if (v) return v } catch {}
    await sleep(50)
  }
  throw new Error('timed out')
}
const q = (sql: string) => {
  const db = new Database(join(state, 'router.db'), { readonly: true })
  try { return db.query(sql).all() as any[] } finally { db.close() }
}

test('every update is logged; allowlisted messages become conversations, settings and a worker spawn; strangers are dropped', async () => {
  await until(() => q("SELECT count(*) n FROM events")[0].n >= 3)
  await until(() => q("SELECT count(*) n FROM queue")[0].n >= 2)
  const convs = q('SELECT key, role FROM conversations ORDER BY key')
  expect(convs).toEqual([{ key: 'dm-111', role: 'owner' }, { key: 'group-100777', role: 'user' }])
  for (const k of ['dm-111', 'group-100777']) {
    expect(existsSync(join(dir, 'bot123', k, 'CLAUDE.md'))).toBe(true)
    expect(existsSync(join(state, 'sessions', `${k}.json`))).toBe(true)
  }
  expect(JSON.parse(readFileSync(join(state, 'sessions', 'group-100777.json'), 'utf8')).permissions.defaultMode).toBe('dontAsk')
  expect(JSON.parse(readFileSync(join(state, 'sessions', 'dm-111.json'), 'utf8')).permissions.defaultMode).toBe('bypassPermissions')
  const spawned = await until(() => { const l = readFileSync(argLog, 'utf8'); return l.includes('tg-dm-111') && l.includes('tg-group-100777') && l })
  expect(spawned).toContain('--channels plugin:telegram@claude-plugins-official')
  // each new conversation is an important notice to the owner (no approvals group set)
  await until(() => calls.filter(c => c.method === 'sendMessage' && String(c.body.chat_id) === '111' && String(c.body.text).startsWith('🆕 新對話')).length === 2)
  // the stranger (333) is in events but never queued
  expect(q("SELECT count(*) n FROM queue WHERE params LIKE '%let me in%'")[0].n).toBe(0)
})

test('a plugin for the conversation gets the queued message, and its reply goes out and is logged', async () => {
  const delivered: string[] = []
  const client = connectRouter({
    socketPath: join(state, 'router.sock'),
    hello: { t: 'hello', project_dir: join(dir, 'bot123', 'dm-111'), pid: 1 },
    onMessage(m) { if (m.t === 'deliver') { delivered.push(m.params.content); client.send({ t: 'ack', qid: m.qid }) } },
  })
  await until(() => delivered.length >= 1)
  // first delivery on a connection carries the chat_context (plan 06)
  expect(delivered).toHaveLength(1)
  expect(delivered[0]).toStartWith('<chat_context v="')
  expect(delivered[0]).toContain('role: owner')
  expect(delivered[0]).toEndWith('\nhello router')
  const r = await client.call('reply', { chat_id: '111', text: 'pong' })
  expect(r.isError).toBeFalsy()
  expect(calls.some(c => c.method === 'sendMessage' && c.body.text === 'pong')).toBe(true)
  const out = await until(() => q("SELECT conv, method, payload_json, error FROM outbound WHERE method = 'sendMessage' AND payload_json LIKE '%pong%'")[0])
  expect(out.conv).toBe('dm-111')
  expect(JSON.parse(out.payload_json)).toMatchObject({ chat_id: '111', text: 'pong' })
  expect(out.error).toBeNull()
  // a user-role conversation cannot write to another chat
  const g = connectRouter({ socketPath: join(state, 'router.sock'), hello: { t: 'hello', project_dir: join(dir, 'bot123', 'group-100777'), pid: 2 }, onMessage(m) { if (m.t === 'deliver') g.send({ t: 'ack', qid: m.qid }) } })
  await until(() => g.state().kind === 'ready')
  const denied = await g.call('reply', { chat_id: '111', text: 'leak' })
  expect(denied.isError).toBe(true)
  expect(calls.some(c => c.body?.text === 'leak')).toBe(false)
  await until(() => q("SELECT count(*) n FROM queue WHERE status != 'acked'")[0].n === 0)
  client.close(); g.close()
  expect(q("SELECT count(*) n FROM outbound WHERE method = 'getUpdates'")[0].n).toBe(0)
}, 15000)

test('a /router command is answered by the router, not forwarded, and the next delivery carries router_log', async () => {
  const delivered: string[] = []
  const client = connectRouter({
    socketPath: join(state, 'router.sock'),
    hello: { t: 'hello', project_dir: join(dir, 'bot123', 'dm-111'), pid: 3 },
    onMessage(m) { if (m.t === 'deliver') { delivered.push(m.params.content); client.send({ t: 'ack', qid: m.qid }) } },
  })
  await until(() => client.state().kind === 'ready')
  const from = { id: 111, is_bot: false, first_name: 'O', username: 'owner' }
  laterUpdates.push({ update_id: 10, message: { message_id: 20, date: now, chat: { id: 111, type: 'private' }, from, text: '/router chat compact 300k', entities: [{ type: 'bot_command', offset: 0, length: 7 }] } })
  const answer = await until(() => calls.find(c => c.method === 'sendMessage' && String(c.body.text).startsWith('dm-111 autoCompactWindow')))
  expect(answer.body.text).toBe('dm-111 autoCompactWindow → 300000')
  await sleep(300)
  expect(delivered).toEqual([]) // the command itself never reaches the worker
  laterUpdates.push({ update_id: 11, message: { message_id: 21, date: now, chat: { id: 111, type: 'private' }, from, text: 'after the command' } })
  await until(() => delivered.length >= 1)
  expect(delivered[0]).toContain('<router_log>')
  expect(delivered[0]).toContain('@owner(owner) /router chat compact 300k → dm-111 autoCompactWindow → 300000')
  expect(delivered[0]).toContain('autoCompactWindow: 300000') // context bumped with the change
  expect(delivered[0]).toEndWith('\nafter the command')
  expect(JSON.parse(readFileSync(join(state, 'sessions', 'dm-111.json'), 'utf8')).autoCompactWindow).toBe(300000)
  client.close()
}, 15000)

test('terminal CLI runs the same commands as owner through the router socket', async () => {
  const p = Bun.spawn(['bun', join(import.meta.dir, '..', 'main.ts'), '--config', join(state, 'config.json'), 'cli', 'status'], { stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(p.stdout).text()
  expect(await p.exited).toBe(0)
  expect(out).toStartWith('router 已運作')
  expect(out).toMatch(/ 💤😀🥇 +\d+m前: @owner:O/)
  const q2 = Bun.spawn(['bun', join(import.meta.dir, '..', 'main.ts'), '--config', join(state, 'config.json'), 'cli', 'role', 'user', '222', 'admin'], { stdout: 'pipe' })
  expect((await new Response(q2.stdout).text()).trim()).toBe('U(@user) (222) 的角色: user → admin') // name from the people table
}, 15000)

test('a plugin or hook reporting a subfolder of a conversation is still that conversation', async () => {
  const sub = connectRouter({ socketPath: join(state, 'router.sock'), hello: { t: 'hello', project_dir: join(dir, 'bot123', 'dm-111', 'memory'), pid: 9 }, onMessage() {} })
  await until(() => sub.state().kind !== 'connecting')
  expect(sub.state()).toMatchObject({ kind: 'ready', welcome: { conv: 'dm-111' } })
  const other = connectRouter({ socketPath: join(state, 'router.sock'), hello: { t: 'hello', project_dir: join(dir, '.router'), pid: 10 }, onMessage() {} })
  await until(() => other.state().kind !== 'connecting')
  expect(other.state().kind).toBe('rejected')
  sub.close(); other.close()
}, 15000)

test('bot rotate (owner DM): the poller moves to the new token, the token message is deleted, nothing sent meanwhile is lost', async () => {
  const from = { id: 111, is_bot: false, first_name: 'O', username: 'owner' }
  const NEW = '123:ROTATEDROTATEDROTATEDROTATEDROTATED00'
  const delivered: string[] = []
  const client = connectRouter({
    socketPath: join(state, 'router.sock'),
    hello: { t: 'hello', project_dir: join(dir, 'bot123', 'dm-111'), pid: 11 },
    onMessage(m) { if (m.t === 'deliver') { delivered.push(m.params.content); client.send({ t: 'ack', qid: m.qid }) } },
  })
  await until(() => client.state().kind === 'ready')
  laterUpdates.push({ update_id: 30, message: { message_id: 40, date: now, chat: { id: 111, type: 'private' }, from, text: `/router bot rotate cc ${NEW}` } })
  const done = await until(() => calls.find(c => c.method === 'sendMessage' && String(c.body.text).startsWith('已更換 bot cc')))
  expect(done.body.text).toBe('已更換 bot cc: @cc_bot\n已刪除含 token 的訊息')
  expect(calls.some(c => c.method === 'deleteMessage' && c.body.message_id === 40)).toBe(true)
  // a message that arrives right after the switch is picked up by the new poller
  laterUpdates.push({ update_id: 31, message: { message_id: 41, date: now, chat: { id: 111, type: 'private' }, from, text: 'after rotate' } })
  await until(() => delivered.some(d => d.endsWith('after rotate')))
  const lastPoll = calls.filter(c => c.method === 'getUpdates').at(-1)!
  expect(lastPoll.token).toBe(NEW)
  expect(JSON.parse(readFileSync(join(state, 'config.json'), 'utf8')).bots[0].token).toBe(NEW)
  // the token is in events (kept as is) but never in what the worker saw
  expect(delivered.join('\n')).not.toContain('ROTATEDROTATED')
  expect(delivered.join('\n')).toContain('123:…ED00')
  client.close()
}, 20000)

test('a token posted in a group the bot cannot delete from: the refusal says so and asks for a manual delete', async () => {
  const from = { id: 111, is_bot: false, first_name: 'O', username: 'owner' }
  laterUpdates.push({ update_id: 40, message: { message_id: 50, date: now, chat: { id: -100777, type: 'supergroup', title: 'G' }, from, text: '/router bot add x 123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } })
  const r = await until(() => calls.find(c => c.method === 'sendMessage' && String(c.body.text).startsWith('⛔ /router bot add')))
  expect(r.body.text).toBe('⛔ /router bot add 只能在 owner 私訊使用; token 曾出現在群組, 建議 /router bot rotate\n⚠️ 無法刪除含 token 的訊息 (bot 沒有刪除權限), 請手動刪除')
}, 15000)

test('a listing in a group goes to the sender\'s DM; the group only hears it was sent; people and titles are tracked', async () => {
  const from = { id: 111, is_bot: false, first_name: 'O', username: 'owner' }
  laterUpdates.push({ update_id: 60, message: { message_id: 70, date: now, chat: { id: -100777, type: 'supergroup', title: 'G' }, from, text: '/router chat' } })
  const dm = await until(() => calls.find(c => c.method === 'sendMessage' && String(c.body.chat_id) === '111' && String(c.body.text).startsWith('(/router chat 的結果')))
  expect(dm.body.text).toContain('group-100777 (G)')
  expect(dm.body.text).toContain('dm-111 (O(@owner))')
  const ack = await until(() => calls.find(c => c.method === 'sendMessage' && String(c.body.chat_id) === '-100777' && c.body.text === '已私訊給你'))
  expect(ack.body.reply_parameters.message_id).toBe(70)
  // nothing of the listing was posted in the group
  expect(calls.some(c => c.method === 'sendMessage' && String(c.body.chat_id) === '-100777' && String(c.body.text).includes('dm-111'))).toBe(false)
  const people = q("SELECT uid, name, username FROM people WHERE uid = '111'")
  expect(people).toEqual([{ uid: '111', name: 'O', username: 'owner' }])
}, 15000)
