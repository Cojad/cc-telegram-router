// DM pairing with buttons end to end (docs/permissions.md 「私訊配對」, docs/operations.md
// 「新 bot 初次設定與審核群組」): the real router against a fake Bot API, started
// on a router.db of the version before (an approvals group with five topics,
// no pairing_requests, no bot_setup.pairing_topic). At startup the group gets
// its 🤝 配對申請 topic; a stranger's first DM in pairing mode gets a code and
// the request lands in that topic with ✅ 同意 / ❌ 拒絕; a reminder posts
// nothing new; a user cannot press, an admin can; the greeting, the edited
// request, access.json, pairing_requests and router_log follow; the command
// after a press and a press after the command are told it was handled.
// Module level: pairing.test.ts.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { openRouterDb } from '../db'

const dir = mkdtempSync(join(tmpdir(), 'cctr-pairing-'))
const state = join(dir, '.router')
mkdirSync(state)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const APPROVALS = -100900
const OWNER = { id: 555, is_bot: false, first_name: 'Boss', username: 'boss' }
const ADMIN = { id: 556, is_bot: false, first_name: 'Ad', username: 'ad' }
const USER = { id: 557, is_bot: false, first_name: 'Us', username: 'us' }
const S1 = { id: 888, is_bot: false, first_name: 'Stranger', last_name: 'One', username: 'strange1' }
const S2 = { id: 889, is_bot: false, first_name: 'Two' }
const calls: Array<{ method: string; body: any }> = []
const updates: unknown[] = []
const now = Math.floor(Date.now() / 1000)
let msgId = 900
const api = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    const type = req.headers.get('content-type') ?? ''
    const body = type.includes('json') ? await req.json() : {}
    const method = url.pathname.split('/').pop()!
    calls.push({ method, body })
    const ok = (result: unknown) => Response.json({ ok: true, result })
    switch (method) {
      case 'getMe': return ok({ id: 1, is_bot: true, first_name: 'cc', username: 'cc_bot' })
      case 'getUpdates': await sleep(100); return ok(updates.splice(0))
      case 'sendMessage': return ok({ message_id: ++msgId, date: now, chat: { id: Number(body.chat_id) }, text: body.text })
      case 'createForumTopic': return ok({ message_thread_id: 46, name: body.name })
      default: return ok(true)
    }
  },
})
const fakeClaude = join(dir, 'fake-claude')
writeFileSync(fakeClaude, `#!/bin/bash\ncase "$*" in *agents*) echo '[]' ;; *--bg*) echo "backgrounded · abcd1234 · tg-x (idle)" ;; esac\n`)
chmodSync(fakeClaude, 0o755)
writeFileSync(join(state, 'config.json'), JSON.stringify({
  bots: [{ name: 'cc', token: '123:test' }], home: dir, stateDir: state, owners: ['555'],
  model: 'claude-opus-5-5', claudeBin: fakeClaude, apiRoot: `http://127.0.0.1:${api.port}`,
}))
writeFileSync(join(state, 'access.json'), JSON.stringify({ dmPolicy: 'pairing', allowFrom: ['555', '556', '557'], groups: {}, pending: {} }))
// router.db of the version before, with data: an approvals group with five topics, an admin
{
  const old = openRouterDb(join(state, 'router.db'))
  old.updateBotSetup('cc', { approvals_chat: String(APPROVALS), notices_topic: 41, approvals_topic: 42, elevlog_topic: 43, authuse_topic: 44, secret_topic: 45, persona_done: 1 })
  old.setUserRole('556', 'admin')
  old.close()
  const raw = new Database(join(state, 'router.db'))
  raw.exec('DROP TABLE pairing_requests')
  raw.exec('ALTER TABLE bot_setup DROP COLUMN pairing_topic')
  raw.close()
}
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
let mid = 1
const dm = (from: { id: number }, text: string) => updates.push({ update_id: mid, message: { message_id: mid++, date: now, chat: { id: from.id, type: 'private' }, from, text } })
const command = (text: string) => updates.push({ update_id: mid, message: { message_id: mid++, date: now, chat: { id: OWNER.id, type: 'private' }, from: OWNER, text, entities: [{ type: 'bot_command', offset: 0, length: 7 }] } })
const sentTo = (chat: number, prefix: string) => calls.filter(c => c.method === 'sendMessage' && Number(c.body.chat_id) === chat && String(c.body.text).startsWith(prefix))
const press = (from: { id: number }, messageId: number, data: string) => {
  const id = `cb${mid}`
  updates.push({ update_id: mid++, callback_query: { id, from, chat_instance: 'x', data, message: { message_id: messageId, date: now, chat: { id: APPROVALS, type: 'supergroup' }, message_thread_id: 46 } } })
  return until(() => calls.find(c => c.method === 'answerCallbackQuery' && c.body.callback_query_id === id)?.body.text as string | undefined)
}
const access = () => JSON.parse(readFileSync(join(state, 'access.json'), 'utf8'))

test('startup on the version before: the column and table are added, the data kept, the approvals group gets its 🤝 配對申請 topic', async () => {
  await until(() => calls.some(c => c.method === 'createForumTopic'))
  expect(calls.filter(c => c.method === 'createForumTopic').map(c => c.body.name)).toEqual(['🤝 配對申請'])
  expect(await until(() => q("SELECT pairing_topic FROM bot_setup WHERE bot = 'cc'")[0].pairing_topic)).toBe(46)
  expect(q("SELECT approvals_chat, notices_topic, secret_topic FROM bot_setup WHERE bot = 'cc'")[0]).toEqual({ approvals_chat: String(APPROVALS), notices_topic: 41, secret_topic: 45 })
  expect(q("SELECT role FROM users WHERE uid = '556'")[0]).toEqual({ role: 'admin' })
  const intro = await until(() => sentTo(APPROVALS, '配對申請: ')[0])
  expect(intro.body.message_thread_id).toBe(46)
})

let req1 = 0, code1 = ''
test('a stranger\'s first DM: a code for them, a request with buttons in the topic; a reminder posts nothing new', async () => {
  dm(S1, '你好, 我是朋友介紹的\n請讓我用')
  const reply = await until(() => sentTo(S1.id, '需要配對')[0])
  code1 = /access pair ([0-9a-f]+)/.exec(reply.body.text)![1]!
  const r = await until(() => sentTo(APPROVALS, '🤝 配對申請 #')[0])
  expect(r.body.message_thread_id).toBe(46)
  req1 = Number(/#(\d+)/.exec(r.body.text)![1])
  const exp = access().pending[code1].expiresAt as number
  const at = new Date(exp + 8 * 3_600_000).toISOString().replace('T', ' ').slice(0, 16)
  expect(r.body.text).toBe([
    `🤝 配對申請 #${req1} (bot cc)`,
    '對方: Stranger One @strange1',
    'uid: 888',
    `配對碼: ${code1}, 到期 ${at} (GMT+8)`,
    '第一則訊息的開頭 (對方傳來的內容, 未經驗證, 只供參考): 「你好, 我是朋友介紹的 請讓我用」',
    `同意等同 /router access pair ${code1}, 拒絕等同 /router access deny ${code1}.`,
  ].join('\n'))
  expect(r.body.reply_markup.inline_keyboard).toEqual([[{ text: '✅ 同意', callback_data: `pair:${req1}:approve` }, { text: '❌ 拒絕', callback_data: `pair:${req1}:deny` }]])
  dm(S1, '還在嗎')
  await until(() => sentTo(S1.id, '配對仍在等待').length === 1)
  await sleep(300)
  expect(sentTo(APPROVALS, '🤝 配對申請 #')).toHaveLength(1)
  expect(q('SELECT count(*) AS n FROM pairing_requests')[0].n).toBe(1)
})

test('a user cannot press; an admin\'s ✅ 同意 lets them in, greets them, edits the request; the command afterwards is told it was handled', async () => {
  const msg = sentTo(APPROVALS, '🤝 配對申請 #')[0]!
  // the fake gives sendMessage ids in order; find the one the request got
  const requestId = 900 + calls.filter(c => c.method === 'sendMessage').indexOf(msg) + 1
  expect(await press(USER, requestId, `pair:${req1}:approve`)).toBe('你沒有權限: 只有 owner 與 admin 能處理配對申請')
  expect(access().allowFrom).not.toContain('888')
  expect(await press(ADMIN, requestId, `pair:${req1}:approve`)).toBe('已核可 888')
  expect(access().allowFrom).toContain('888')
  expect(access().pending[code1]).toBeUndefined()
  await until(() => sentTo(S1.id, '配對完成, 可以開始對話了.').length === 1)
  const edit = await until(() => calls.find(c => c.method === 'editMessageText' && c.body.message_id === requestId))
  expect(edit.body.text).toStartWith(`${msg.body.text}\n\n✅ 已同意 (`)
  expect(edit.body.text).toContain('556, 經由按鈕, ')
  expect(edit.body.reply_markup.inline_keyboard).toEqual([])
  expect(q(`SELECT status, decided_by, decided_via FROM pairing_requests WHERE id = ${req1}`)[0]).toEqual({ status: 'approved', decided_by: '556', decided_via: 'button' })
  expect(q("SELECT text FROM router_log WHERE conv = 'router:pairing'").map(r => r.text)).toEqual([expect.stringMatching(/^同意配對 Stranger One 888, 由 .*556 經由按鈕 \(配對碼 [0-9a-f]+\)$/)])
  expect(stderr).toContain(`pairing #${req1} ${code1}: approved by 556 via button (uid 888)`)
  command(`/router access pair ${code1}`)
  const told = await until(() => sentTo(OWNER.id, `配對碼 ${code1} 已處理: ✅ 已同意`)[0])
  expect(told.body.text).toContain('經由按鈕')
  expect(q("SELECT count(*) AS n FROM router_log WHERE conv = 'router:pairing'")[0].n).toBe(1)
})

test('the command first: /router access deny settles it and edits the request; the button afterwards is told it was handled', async () => {
  dm(S2, 'hey')
  const reply = await until(() => sentTo(S2.id, '需要配對')[0])
  const code = /access pair ([0-9a-f]+)/.exec(reply.body.text)![1]!
  const msg = await until(() => sentTo(APPROVALS, '🤝 配對申請 #').find(c => c.body.text.includes('uid: 889')))
  expect(msg.body.text).toContain('對方: Two (沒有 username)')
  const req = Number(/#(\d+)/.exec(msg.body.text)![1])
  const requestId = 900 + calls.filter(c => c.method === 'sendMessage').indexOf(msg) + 1
  command(`/router access deny ${code}`)
  await until(() => sentTo(OWNER.id, `已拒絕配對碼 ${code}`).length === 1)
  const edit = await until(() => calls.find(c => c.method === 'editMessageText' && c.body.message_id === requestId))
  expect(edit.body.text).toContain('\n\n❌ 已拒絕 (')
  expect(edit.body.text).toContain('555, 經由指令, ')
  expect(access().allowFrom).not.toContain('889')
  expect(await press(OWNER, requestId, `pair:${req}:approve`)).toStartWith(`配對碼 ${code} 已處理: ❌ 已拒絕`)
  expect(access().allowFrom).not.toContain('889')
  expect(sentTo(S2.id, '配對完成')).toHaveLength(0)
  expect(q(`SELECT status, decided_by, decided_via FROM pairing_requests WHERE id = ${req}`)[0]).toEqual({ status: 'denied', decided_by: '555', decided_via: 'command' })
})
