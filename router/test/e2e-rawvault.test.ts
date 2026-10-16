// Plan 10e 原始事件完整保存與密鑰保護 end to end: the real router against a
// fake Bot API and a fake claude. An approvals group set up before 10e gets
// its 🔑 密鑰偵測 topic at startup; a deletion that came due while the router
// was down is done at startup; a token pasted in a DM is masked in events
// (sealed in event_raw), reaches the worker and the messages table as a
// marker, is answered with a reminder and 取消刪除 (a stranger cannot press
// it, the sender can) and recorded in the topic; an edited message too;
// /secret set is still deleted at once; event_raw from the owner's worker
// (fixed agent, handles), secret_from_handle and then bot_api with the real
// token; a user conversation is refused; cli event raw writes a 600 file;
// a .env file with a key: the worker's download has a marker, the message is answered.
// Keep in sync with README 「原始事件與密鑰保護」; module level in rawvault.test.ts.
// Every token here is fake and built at runtime.

import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { connectRouter } from '../../plugin/client'
import { openRouterDb } from '../db'

const dir = mkdtempSync(join(tmpdir(), 'cctr-rawvault-'))
const state = join(dir, '.router')
mkdirSync(state)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const APPROVALS = -100900
const OWNER = { id: 555, is_bot: false, first_name: 'Boss', username: 'boss' }
const USER = { id: 666, is_bot: false, first_name: 'U', username: 'u' }, STRANGER = { id: 888, is_bot: false, first_name: 'S', username: 's' }
const PASTED = `${'7000000'}01:${'AAF'}${'x'.repeat(32)}`
const EDITED = `${'sk'}-proj-${'e'.repeat(24)}`
const IN_FILE = `${'gh'}p_${'F'.repeat(36)}`

const calls: Array<{ method: string; body: any; token?: string }> = []
const updates: unknown[] = []
const now = Math.floor(Date.now() / 1000)
const api = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    // a text attachment: a .env file with a key in it
    if (url.pathname.startsWith('/file/')) { calls.push({ method: 'file', body: url.pathname }); return new Response(`HOST=example\nGH_TOKEN=${IN_FILE}\n`) }
    const type = req.headers.get('content-type') ?? ''
    const body = type.includes('json') ? await req.json() : {}
    const parts = url.pathname.split('/')
    const method = parts.pop()!, token = parts.pop()!.replace(/^bot/, '')
    calls.push({ method, body, token })
    const ok = (result: unknown) => Response.json({ ok: true, result })
    switch (method) {
      case 'getMe': return token === '123:test' ? ok({ id: 1, is_bot: true, first_name: 'cc', username: 'cc_bot' }) : ok({ id: 7000000001, is_bot: true, first_name: 'p', username: 'pasted_bot' })
      case 'getUpdates': await sleep(100); return ok(updates.splice(0))
      case 'sendMessage': return ok({ message_id: 900 + calls.length, date: now, chat: { id: Number(body.chat_id) }, text: body.text })
      case 'getFile': return ok({ file_id: body.file_id, file_unique_id: 'uq9', file_path: 'documents/file_9.env' })
      case 'createForumTopic': return ok({ message_thread_id: 45, name: body.name })
      default: return ok(true)
    }
  },
})

// the fixed agent: answers with handles only (and records what it was given)
const fakeClaude = join(dir, 'fake-claude')
writeFileSync(fakeClaude, `#!/bin/bash\ncase "$*" in *--system-prompt*) cat > "${dir}/agent-input"; echo '{"type":"result","result":"這則訊息貼了一個 bot token, 遮掉的是 h1, 可以用 secret_from_handle 登記.","is_error":false}' ;; *agents*) echo '[]' ;; *--bg*) echo "backgrounded · abcd1234 · tg-x (idle)" ;; esac\n`)
chmodSync(fakeClaude, 0o755)
writeFileSync(join(state, 'config.json'), JSON.stringify({
  bots: [{ name: 'cc', token: '123:test' }], home: dir, stateDir: state, owners: ['555'],
  model: 'claude-opus-5-5', claudeBin: fakeClaude, apiRoot: `http://127.0.0.1:${api.port}`,
}))
writeFileSync(join(state, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['555', '666'], groups: {}, pending: {} }))
// before 10e: an approvals group with four topics, and a deletion that came due while the router was down
{
  const old = openRouterDb(join(state, 'router.db'))
  old.updateBotSetup('cc', { approvals_chat: String(APPROVALS), notices_topic: 41, approvals_topic: 42, elevlog_topic: 43, authuse_topic: 44, persona_done: 1 })
  old.scheduleDeletion({ event_id: 0, bot: 'cc', chat_id: '666', message_id: 77, sender: '666', notice_id: null, due_at: new Date(Date.now() - 60_000).toISOString() })
  old.close()
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
const dm = (from: typeof OWNER, text: string) => { const id = mid++; updates.push({ update_id: id, message: { message_id: id, date: now, chat: { id: from.id, type: 'private' }, from, text } }); return id }
const sentTo = (chat: number, prefix: string) => calls.filter(c => c.method === 'sendMessage' && Number(c.body.chat_id) === chat && String(c.body.text).startsWith(prefix))
const worker = (key: string, pid: number, delivered: string[] = []) => {
  const c = connectRouter({ socketPath: join(state, 'router.sock'), hello: { t: 'hello', project_dir: join(dir, 'bot123', key), pid }, onMessage(m) { if (m.t === 'deliver') { delivered.push(JSON.stringify(m.params)); c.send({ t: 'ack', qid: m.qid }) } } })
  return c
}

test('startup: an approvals group from before gets its 🔑 密鑰偵測 topic; a deletion due while the router was down is done', async () => {
  await until(() => calls.some(c => c.method === 'createForumTopic'))
  expect(calls.filter(c => c.method === 'createForumTopic').map(c => c.body.name)).toEqual(['🔑 密鑰偵測'])
  expect(await until(() => q("SELECT secret_topic FROM bot_setup WHERE bot = 'cc'")[0].secret_topic)).toBe(45)
  await until(() => sentTo(APPROVALS, '密鑰偵測: ').length === 1)
  expect(sentTo(APPROVALS, '密鑰偵測: ')[0]!.body.message_thread_id).toBe(45)
  await until(() => calls.some(c => c.method === 'deleteMessage' && Number(c.body.chat_id) === 666 && c.body.message_id === 77))
  expect(await until(() => q('SELECT status FROM secret_deletions WHERE id = 1')[0].status === 'deleted' && 'deleted')).toBe('deleted')
})

test('a token pasted in a DM: events masked and the original sealed; the worker and the messages table get a marker; a reminder with 取消刪除 (stranger refused, sender may); recorded in the topic', async () => {
  const delivered: string[] = []
  dm(USER, 'hi')
  await until(() => q("SELECT key FROM conversations WHERE key = 'dm-666'").length === 1)
  const w = worker('dm-666', 11, delivered)
  await until(() => w.state().kind === 'ready')
  const msg = dm(USER, `我的 bot ${PASTED} 幫我看看`)
  const ev = await until(() => q('SELECT id, update_json, masked FROM events WHERE masked = 1')[0])
  expect(JSON.parse(ev.update_json).message.text).toBe(`我的 bot <已遮蔽 #${ev.id}.1> 幫我看看`)
  expect(q(`SELECT count(*) n FROM event_raw WHERE event_id = ${ev.id}`)[0].n).toBe(1)
  const got = await until(() => delivered.find(d => d.includes('已遮蔽')))
  expect(JSON.parse(got).content).toBe(`我的 bot <已遮蔽 #${ev.id}.1: Telegram bot token, 末 4 碼 xxxx> 幫我看看`)
  // nowhere in plain text: events, event_raw, messages, router_log, outbound
  for (const [t, c] of [['events', 'update_json'], ['event_raw', 'sealed'], ['messages', 'content'], ['router_log', 'text'], ['outbound', 'payload_json']]) expect(q(`SELECT count(*) n FROM ${t} WHERE CAST(${c} AS TEXT) LIKE '%${PASTED}%'`)[0].n).toBe(0)
  expect(stderr).not.toContain(PASTED)
  const reminder = await until(() => sentTo(666, '⚠️ 這則訊息含有密鑰')[0])
  expect(reminder.body.reply_parameters.message_id).toBe(msg)
  expect(reminder.body.text).toContain('(Telegram bot token 末 4 碼 xxxx)')
  expect(reminder.body.reply_markup.inline_keyboard[0]).toEqual([{ text: '取消刪除', callback_data: 'sdel:2:cancel' }])
  const due = q('SELECT due_at, status FROM secret_deletions WHERE id = 2')[0]
  expect(due.status).toBe('pending')
  expect(Math.abs(Date.parse(due.due_at) - Date.now() - 5 * 60_000)).toBeLessThan(15_000)
  const log = await until(() => sentTo(APPROVALS, `🔑 偵測到密鑰 event #${ev.id}`)[0])
  expect(log.body.message_thread_id).toBe(45)
  expect(log.body.text).toContain('發送者: U(@u) (666)')
  expect(log.body.text).toContain('處理: 已提醒')
  expect(log.body.text).not.toContain(PASTED)
  // 取消刪除: someone else is refused, the sender may
  const press = (from: typeof OWNER, id: string) => updates.push({ update_id: mid++, callback_query: { id, from, chat_instance: 'x', data: 'sdel:2:cancel', message: { message_id: reminder.body.message_id ?? 1, date: now, chat: { id: 666, type: 'private' } } } })
  press(STRANGER, 'cb1')
  expect((await until(() => calls.find(c => c.method === 'answerCallbackQuery' && c.body.callback_query_id === 'cb1'))).body.text).toBe('只有發送者, owner, admin 能取消刪除')
  press(USER, 'cb2')
  expect((await until(() => calls.find(c => c.method === 'answerCallbackQuery' && c.body.callback_query_id === 'cb2'))).body.text).toBe('已取消刪除')
  expect(q('SELECT status, decided_by FROM secret_deletions WHERE id = 2')[0]).toEqual({ status: 'cancelled', decided_by: '666' })
  w.close()
})

test('an edited message with a key is masked and reminded too; /secret set is still deleted at once and its value sealed, not just <已遮蔽>', async () => {
  updates.push({ update_id: mid++, edited_message: { message_id: 50, date: now, edit_date: now, chat: { id: 666, type: 'private' }, from: USER, text: `改成 ${EDITED}` } })
  const ev = await until(() => q(`SELECT id, update_json FROM events WHERE masked = 1 AND update_json LIKE '%edited_message%'`)[0])
  expect(JSON.parse(ev.update_json).edited_message.text).toBe(`改成 <已遮蔽 #${ev.id}.1>`)
  await until(() => sentTo(666, '⚠️ 這則訊息含有密鑰 (OpenAI API key').length === 1)
  const msg = dm(USER, '/secret set mine sk-short-value --http https://api.example.com')
  await until(() => calls.some(c => c.method === 'deleteMessage' && Number(c.body.chat_id) === 666 && c.body.message_id === msg))
  const sec = await until(() => q(`SELECT id, update_json FROM events WHERE masked = 1 AND update_json LIKE '%/secret set mine%'`)[0])
  expect(JSON.parse(sec.update_json).message.text).toBe(`/secret set mine <已遮蔽 #${sec.id}.1> --http https://api.example.com`)
  const log = await until(() => sentTo(APPROVALS, `🔑 偵測到密鑰 event #${sec.id}`)[0])
  expect(log.body.text).toContain('處理: 登記或 router 指令: router 處理, 訊息立刻刪除')
})

test('event_raw: a user conversation is refused; the owner\'s worker gets the handle version and the fixed agent\'s answer; secret_from_handle, then bot_api with the real token; cli event raw writes a 600 file', async () => {
  const ev = q('SELECT id FROM events WHERE masked = 1 ORDER BY id LIMIT 1')[0].id as number
  const user = worker('dm-666', 12)
  await until(() => user.state().kind === 'ready')
  expect((await user.call('event_raw', { event_id: ev, question: '原本是什麼' })).content[0]!.text).toStartWith('⛔ event_raw 只限 owner 或 admin')
  user.close()
  dm(OWNER, 'hi')
  await until(() => q("SELECT key FROM conversations WHERE key = 'dm-555'").length === 1)
  const owner = worker('dm-555', 13)
  await until(() => owner.state().kind === 'ready')
  await sleep(300)
  const r = await owner.call('event_raw', { event_id: ev, question: '原本是什麼' })
  expect(r.isError).toBeFalsy()
  const text = r.content[0]!.text
  expect(text).toContain('«密鑰 h1: Telegram bot token, getMe: @pasted_bot (7000000001), 末 4 碼 xxxx, 不等於任何已登記的憑證或對話密鑰»')
  expect(text).toContain('固定 agent 的回答:\n這則訊息貼了一個 bot token, 遮掉的是 h1')
  expect(text).not.toContain(PASTED)
  const input = readFileSync(join(dir, 'agent-input'), 'utf8')
  expect(input).toContain('«密鑰 h1:')
  expect(input).not.toContain(PASTED)
  expect(q("SELECT conv, event_id, status FROM secret_requests")[0]).toEqual({ conv: 'dm-555', event_id: ev, status: 'answered' })
  await until(() => sentTo(APPROVALS, '🔎 原文請求 #1').length === 1)
  // registered as this conversation's secret, then used: Telegram sees the real token
  const reg = await owner.call('secret_from_handle', { handle: 'h1', name: 'pasted', scope: 'getMe' })
  expect(reg.content[0]!.text).toStartWith('已登記這個對話的密鑰 pasted: telegram-bot @pasted_bot (7000000001), 方法 getMe')
  const use = await owner.call('bot_api', { credential: 'pasted', method: 'getMe' })
  expect(use.isError).toBeFalsy()
  expect(calls.filter(c => c.method === 'getMe' && c.token === PASTED).length).toBeGreaterThanOrEqual(3)
  expect(q("SELECT registered, uses FROM secret_handles WHERE code = 'h1'")[0]).toEqual({ registered: 'pasted', uses: 2 })
  owner.close()
  // the owner's terminal: plaintext only into a 600 file, only the path printed
  const cli = Bun.spawn(['bun', join(import.meta.dir, '..', 'main.ts'), '--config', join(state, 'config.json'), 'cli', 'event', 'raw', String(ev)], { stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(cli.stdout).text()
  expect(out).not.toContain(PASTED)
  const file = /已寫入 (\S+) \(權限 600\)/.exec(out)![1]!
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(JSON.parse(readFileSync(file, 'utf8')).message.text).toContain(PASTED)
  await until(() => sentTo(APPROVALS, `🗝 owner 在終端機取出 event #${ev} 的明文`).length === 1)
}, 30000)

test('download_attachment of a .env file with a key: the file in the worker\'s folder has a marker, the original is sealed, the message it came with is answered', async () => {
  const delivered: string[] = []
  const w = worker('dm-666', 14, delivered)
  await until(() => w.state().kind === 'ready')
  const id = mid++
  updates.push({ update_id: id, message: { message_id: id, date: now, chat: { id: 666, type: 'private' }, from: USER, document: { file_id: 'DOC1', file_unique_id: 'uq9', file_name: 'app.env', mime_type: 'text/plain', file_size: 40 } } })
  await until(() => delivered.some(d => d.includes('DOC1')))
  const r = await w.call('download_attachment', { file_id: 'DOC1' })
  expect(r.isError).toBeFalsy()
  const path = r.content[0]!.text
  expect(path).toStartWith(join(dir, 'bot123', 'dm-666', 'attachments'))
  const text = readFileSync(path, 'utf8')
  const ev = q(`SELECT id, update_json FROM events WHERE update_json LIKE '{"attachment":%'`)[0]
  expect(text).toBe(`HOST=example\nGH_TOKEN=<已遮蔽 #${ev.id}.1: GitHub token, 末 4 碼 FFFF>\n`)
  expect(calls.some(c => c.method === 'file' && c.body === '/file/bot123:test/documents/file_9.env')).toBe(true)
  for (const [t, c] of [['events', 'update_json'], ['event_raw', 'sealed'], ['messages', 'content'], ['outbound', 'payload_json'], ['outbound', 'result_json']]) expect(q(`SELECT count(*) n FROM ${t} WHERE CAST(${c} AS TEXT) LIKE '%${IN_FILE}%'`)[0].n).toBe(0)
  const reminder = await until(() => sentTo(666, '⚠️ 這則訊息的附件 app.env 含有密鑰')[0])
  expect(reminder.body.reply_parameters.message_id).toBe(id)
  expect(reminder.body.text).toContain('(GitHub token 末 4 碼 FFFF)')
  const log = await until(() => sentTo(APPROVALS, `🔑 偵測到密鑰 event #${ev.id}`)[0])
  expect(log.body.text).toContain('附件: app.env (worker 下載時偵測)')
  w.close()
})
