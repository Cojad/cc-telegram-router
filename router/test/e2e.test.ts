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
import { openRouterDb } from '../db'

const dir = mkdtempSync(join(tmpdir(), 'cctr-e2e-'))
const state = join(dir, '.router')
mkdirSync(state)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// --- fake Bot API ---------------------------------------------------------
const calls: Array<{ method: string; body: any; token?: string }> = []
let updatesServed = false
const laterUpdates: unknown[] = []
const twoUpdates: unknown[] = [] // for the second bot (added by bot add)
let helpFailed = false
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
    // a bot whose token dies right after bot add checked it: its poller gets 401
    if (token.startsWith('789:')) {
      if (method === 'getMe' && calls.filter(c => c.method === 'getMe' && c.token === token).length === 1) return ok({ id: 789, is_bot: true, first_name: 'Dead', username: 'dead_bot' })
      return Response.json({ ok: false, error_code: 401, description: 'Unauthorized' })
    }
    // a second bot (bot add): its poller's own getMe is slow, its updates empty
    if (token.startsWith('456:')) {
      if (method === 'getMe') {
        if (calls.filter(c => c.method === 'getMe' && c.token === token).length > 1) await sleep(3000)
        return ok({ id: 456, is_bot: true, first_name: 'Two', username: 'two_bot' })
      }
      if (method === 'getUpdates') { await sleep(200); return ok(twoUpdates.splice(0)) }
      return ok(true)
    }
    switch (method) {
      case 'getMe': return ok({ id: 1, is_bot: true, first_name: 'cc', username: 'cc_bot' })
      case 'getUpdates':
        if (!updatesServed) { updatesServed = true; return ok(UPDATES) }
        await sleep(200)
        return ok(laterUpdates.splice(0))
      case 'sendMessage':
        // the first reply to /router help hits a Telegram 502 (the router tries again)
        if (String(body.text).startsWith('/router status\n') && !helpFailed) { helpFailed = true; return Response.json({ ok: false, error_code: 502, description: 'Bad Gateway' }) }
        return ok({ message_id: 900 + calls.length, date: now, chat: { id: Number(body.chat_id) }, text: body.text })
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

// a setup left from another bot under the name cc (config.json now has bot 123's token): reset at start, the owner told
{ const pre = openRouterDb(join(state, 'router.db')); pre.updateBotSetup('cc', { bot_id: '999', persona_done: 1, persona: '舊的人設', group_skipped: 1 }); pre.close() }
const router = Bun.spawn(['bun', join(import.meta.dir, '..', 'main.ts'), '--config', join(state, 'config.json')], { stdout: 'ignore', stderr: 'pipe' })
let stderr = ''
void (async () => { for await (const c of router.stderr) stderr += new TextDecoder().decode(c) })()

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

test('a name whose token is now another bot\'s: its setup starts over at start, logged, and the owner is told', async () => {
  const notice = await until(() => calls.find(c => c.method === 'sendMessage' && String(c.body.text).startsWith('⚠️ config.json 裡 bot cc')))
  expect(notice.body).toMatchObject({ chat_id: '111', text: '⚠️ config.json 裡 bot cc 的 token 換成了另一隻 bot (id 999 → 123): 它的設定已重置 (人設, 審核群組), 當成新 bot. 私訊它任何一句話就會開始初次設定.' })
  expect(q("SELECT bot_id, persona_done, persona, group_skipped FROM bot_setup WHERE bot = 'cc'")[0]).toEqual({ bot_id: '123', persona_done: 0, persona: null, group_skipped: 0 })
  expect(stderr).toContain('bot cc: token is another bot (999 -> 123), setup starts over')
})

test('a plugin for the conversation gets the queued message, and its reply goes out and is logged', async () => {
  const delivered: string[] = [], metas: Array<Record<string, string>> = []
  const client = connectRouter({
    socketPath: join(state, 'router.sock'),
    hello: { t: 'hello', project_dir: join(dir, 'bot123', 'dm-111'), pid: 1 },
    onMessage(m) { if (m.t === 'deliver') { delivered.push(m.params.content); metas.push(m.params.meta as Record<string, string>); client.send({ t: 'ack', qid: m.qid }) } },
  })
  await until(() => delivered.length >= 1)
  // first delivery on a connection carries the chat_context (plan 06)
  expect(delivered).toHaveLength(1)
  expect(delivered[0]).toStartWith('<chat_context v="')
  expect(delivered[0]).toContain('role: owner')
  expect(delivered[0]).toEndWith('\nhello router')
  // the router's log lines carry GMT+8 time, never UTC or Z
  const lines = stderr.split('\n').filter(Boolean)
  expect(lines.some(l => l.includes('router up'))).toBe(true)
  for (const l of lines.filter(l => /^\d{4}-/.test(l))) expect(l).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}\+08:00 /)
  expect(stderr).not.toMatch(/\d\d:\d\d:\d\d(\.\d+)?Z/)
  // so does the message time the worker sees
  expect(metas[0]!.ts).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}\+08:00$/)
  expect(Date.parse(metas[0]!.ts!)).toBe(now * 1000)
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

test('a group worker answers the asker in their DM (reply on_behalf_of their group message): no grant, the DM says which group; anyone else is refused', async () => {
  const g = connectRouter({ socketPath: join(state, 'router.sock'), hello: { t: 'hello', project_dir: join(dir, 'bot123', 'group-100777'), pid: 3 }, onMessage(m) { if (m.t === 'deliver') g.send({ t: 'ack', qid: m.qid }) } })
  await until(() => g.state().kind === 'ready')
  // message 11 in the group came from 222: their DM is fine, with a heading naming the group and the message
  const ok = await g.call('reply', { chat_id: '222', text: '明天的天氣預報', on_behalf_of: '11', reply_to: '11' })
  expect(ok.isError).toBeFalsy()
  const sent = await until(() => calls.find(c => c.method === 'sendMessage' && String(c.body.chat_id) === '222'))
  expect(sent.body.text).toBe('(回覆你在群組「G」的訊息: hi group)\n\n明天的天氣預報')
  expect(sent.body.reply_parameters).toBeUndefined() // the group message id means nothing in the DM
  // not the asker, or no such message: refused, nothing sent
  for (const [chat_id, on_behalf_of] of [['111', '11'], ['222', '999']]) {
    const r = await g.call('reply', { chat_id, text: `wrong ${chat_id} ${on_behalf_of}`, on_behalf_of })
    expect(r.isError).toBe(true)
    expect(String(r.content[0].text)).toContain('只能回到提出要求的那個人的私訊')
  }
  expect(calls.some(c => String(c.body?.text).startsWith('wrong'))).toBe(false)
  // markdownv2: the heading is escaped
  await g.call('reply', { chat_id: '222', text: '*hi*', format: 'markdownv2', on_behalf_of: '11' })
  const md = await until(() => calls.find(c => c.method === 'sendMessage' && String(c.body.chat_id) === '222' && String(c.body.text).endsWith('*hi*')))
  expect(md.body.text).toStartWith('\\(回覆你在群組「G」的訊息: hi group\\)')
  // no authorization use is logged for it
  expect(q("SELECT count(*) n FROM auth_uses")[0].n).toBe(0)
  g.close()
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
  expect(delivered.join('\n')).toContain('/router bot rotate cc <已遮蔽>') // the whole token is left out of the log
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

test('「cc /router status」is answered as the router command itself: never typed into a worker terminal', async () => {
  const from = { id: 111, is_bot: false, first_name: 'O', username: 'owner' }
  const before = existsSync(argLog) ? readFileSync(argLog, 'utf8') : ''
  laterUpdates.push({ update_id: 30, message: { message_id: 60, date: now, chat: { id: 111, type: 'private' }, from, text: 'cc /router status' } })
  const answer = await until(() => calls.find(c => c.method === 'sendMessage' && c.body.reply_parameters?.message_id === 60))
  expect(String(answer.body.text)).toStartWith('router 已運作')
  const after = readFileSync(argLog, 'utf8').slice(before.length)
  expect(after).not.toContain('attach') // no terminal was opened
}, 15000)

test('bot add answers once its getMe is in: bot list right after shows the new bot, never @? (id 0), even before its poller has started', async () => {
  const from = { id: 111, is_bot: false, first_name: 'O', username: 'owner' }
  laterUpdates.push({ update_id: 80, message: { message_id: 90, date: now, chat: { id: 111, type: 'private' }, from, text: '/router bot add two 456:TWOTWOTWOTWOTWOTWOTWOTWOTWOTWOTWO00' } })
  const added = await until(() => calls.find(c => c.method === 'sendMessage' && String(c.body.text).startsWith('已新增 bot two')))
  expect(added.body.text).toStartWith('已新增 bot two: @two_bot\n')
  expect(added.body.text).toContain('它會帶你完成初次設定') // a new bot
  expect(q("SELECT bot_id FROM bot_setup WHERE bot = 'two'")[0].bot_id).toBe('456') // the setup belongs to that bot
  expect(q("SELECT bot_id FROM bot_setup WHERE bot = 'cc'")[0].bot_id).toBe('123') // from the token at start
  // the new bot's poller is still waiting on its own (slow) getMe
  laterUpdates.push({ update_id: 81, message: { message_id: 91, date: now, chat: { id: 111, type: 'private' }, from, text: '/router bot list' } })
  const list = await until(() => calls.find(c => c.method === 'sendMessage' && String(c.body.text).startsWith('cc: @')))
  expect(list.body.text).toBe('cc: @cc_bot (id 1, cc)\ntwo: @two_bot (id 456, Two)')
}, 15000)

test('two bots in the same group get the same message: each records it and delivers it to its own conversation (message ids are the group\'s, not one bot\'s)', async () => {
  const from = { id: 222, is_bot: false, first_name: 'U', username: 'user' }
  const msg = { message_id: 77, date: now, chat: { id: -100777, type: 'supergroup', title: 'G' }, from, text: 'hello both bots' }
  laterUpdates.push({ update_id: 90, message: msg })
  twoUpdates.push({ update_id: 5, message: msg })
  const rows = await until(() => { const r = q("SELECT bot, delivered FROM messages WHERE chat_id = '-100777' AND message_id = '77' ORDER BY bot"); return r.length === 2 && r }, 12000)
  expect(rows).toEqual([{ bot: 'cc', delivered: 1 }, { bot: 'two', delivered: 1 }])
  const queued = await until(() => { const r = q("SELECT conv FROM queue WHERE params LIKE '%hello both bots%' ORDER BY conv").map((x: any) => x.conv); return r.length === 2 && r }, 12000)
  expect(queued).toEqual(['group-100777', 'two-group-100777'])
  expect(stderr).not.toContain('duplicate message dropped')
}, 20000)

test('a bot whose token stops working: polling stops, the owner hears it through a bot that still works, /router status says so', async () => {
  const from = { id: 111, is_bot: false, first_name: 'O', username: 'owner' }
  laterUpdates.push({ update_id: 95, message: { message_id: 96, date: now, chat: { id: 111, type: 'private' }, from, text: '/router bot add dead 789:DEADDEADDEADDEADDEADDEADDEADDEADDEAD0' } })
  await until(() => calls.find(c => c.method === 'sendMessage' && String(c.body.text).startsWith('已新增 bot dead')))
  const notice = await until(() => calls.find(c => c.method === 'sendMessage' && String(c.body.text).startsWith('⛔ bot dead')), 10000)
  expect(notice.token).not.toStartWith('789:') // sent by another bot
  expect(notice.body.chat_id).toBe('111')
  expect(notice.body.text).toContain('token 失效 (401 Unauthorized)')
  expect(notice.body.text).toContain('/router bot rotate dead <新 token>')
  const getUpdatesAfter = () => calls.filter(c => c.method === 'getUpdates' && c.token?.startsWith('789:')).length
  expect(getUpdatesAfter()).toBe(0) // it never polled
  const statuses = () => calls.filter(c => c.method === 'sendMessage' && String(c.body.text).startsWith('router 已運作'))
  const before = statuses().length
  laterUpdates.push({ update_id: 97, message: { message_id: 98, date: now, chat: { id: 111, type: 'private' }, from, text: '/router status' } })
  const status = await until(() => statuses().length > before && statuses().at(-1))
  expect(status.body.text).toMatch(/Dead\(@dead_bot\) token 失效 \(\d\d:\d\d 起, 請用 \/router bot rotate\)/)
  expect(status.body.text).toMatch(/cc\(@cc_bot\) 收訊中/)
  expect(stderr).toContain('dead: getMe: 401 Unauthorized; the token no longer works, polling stopped')
}, 20000)

test('a command reply that hits a Telegram 5xx is sent again', async () => {
  const from = { id: 111, is_bot: false, first_name: 'O', username: 'owner' }
  laterUpdates.push({ update_id: 99, message: { message_id: 100, date: now, chat: { id: 111, type: 'private' }, from, text: '/router help' } })
  await until(() => calls.filter(c => c.method === 'sendMessage' && String(c.body.text).startsWith('/router status\n')).length === 2, 10000)
  expect(helpFailed).toBe(true)
  expect(stderr).not.toContain('command reply failed')
}, 15000)
