// First run of a bot, end to end (plan 03 初次設定, 審核頻道): the real router
// against a fake Bot API, starting with no owner. Keep in sync with those
// sections and README 「新 bot 初次設定」.
//   claim code -> owner; persona interview (<bootstrap>, save_bot_profile)
//   -> persona in every chat_context; approvals group checks and topics;
//   skip button.

import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { connectRouter } from '../../plugin/client'

const dir = mkdtempSync(join(tmpdir(), 'cctr-setup-'))
const state = join(dir, '.router')
mkdirSync(state)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const calls: Array<{ method: string; body: any }> = []
const updates: unknown[] = []
const now = Math.floor(Date.now() / 1000)
let forum = { type: 'supergroup', is_forum: false }
let member: Record<string, unknown> = { status: 'member' }
let topic = 40
const api = Bun.serve({
  port: 0,
  async fetch(req) {
    const method = new URL(req.url).pathname.split('/').pop()!
    const body = req.headers.get('content-type')?.includes('json') ? await req.json() : {}
    calls.push({ method, body })
    const ok = (result: unknown) => Response.json({ ok: true, result })
    switch (method) {
      case 'getMe': return ok({ id: 1, is_bot: true, first_name: 'new', username: 'new_bot' })
      case 'getUpdates': await sleep(100); return ok(updates.splice(0))
      case 'sendMessage': return ok({ message_id: 900 + calls.length, date: now, chat: { id: Number(body.chat_id) }, text: body.text })
      case 'getChat': return ok({ id: Number(body.chat_id), title: 'Approvals', ...forum })
      case 'getChatMember': return ok({ user: { id: 1 }, ...member })
      case 'createForumTopic': return ok({ message_thread_id: ++topic, name: body.name })
      default: return ok(true)
    }
  },
})

const fakeClaude = join(dir, 'fake-claude')
writeFileSync(fakeClaude, `#!/bin/bash\ncase "$*" in *agents*) echo '[]' ;; *--bg*) echo "backgrounded · abcd1234 · tg-x (idle)" ;; esac\n`)
chmodSync(fakeClaude, 0o755)
writeFileSync(join(state, 'config.json'), JSON.stringify({
  bots: [{ name: 'new', token: '123:test' }], home: dir, stateDir: state, owners: [],
  model: 'claude-opus-5-5', claudeBin: fakeClaude, apiRoot: `http://127.0.0.1:${api.port}`,
}))
writeFileSync(join(state, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['666'], groups: {}, pending: {} }))

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
const OWNER = { id: 555, is_bot: false, first_name: 'Boss', username: 'boss' }
let mid = 1
const dm = (from: typeof OWNER, text: string) => updates.push({ update_id: mid, message: { message_id: mid++, date: now, chat: { id: from.id, type: 'private' }, from, text } })
const inGroup = (text: string) => updates.push({ update_id: mid, message: { message_id: mid++, date: now, chat: { id: -100900, type: 'supergroup', title: 'Approvals' }, from: OWNER, text, entities: [{ type: 'bot_command', offset: 0, length: 7 }] } })
const sentTo = (chat: number, prefix: string) => calls.filter(c => c.method === 'sendMessage' && Number(c.body.chat_id) === chat && String(c.body.text).startsWith(prefix))

test('no owner: the log shows a claim code; only "/start <code>" in a DM makes the sender owner', async () => {
  const code = await until(() => /「\/start ([0-9a-f]+)」/.exec(stderr)?.[1])
  dm(OWNER, '/start wrong')
  await sleep(400)
  expect(sentTo(555, '✅')).toHaveLength(0)
  dm(OWNER, `/start ${code}`)
  await until(() => sentTo(555, '✅ 你現在是這個 router 的 owner').length === 1)
  expect(JSON.parse(readFileSync(join(state, 'config.json'), 'utf8')).owners).toEqual(['555'])
  expect(JSON.parse(readFileSync(join(state, 'access.json'), 'utf8')).allowFrom).toContain('555')
  dm(OWNER, `/start ${code}`) // used up
  await sleep(400)
  expect(sentTo(555, '✅ 你現在是')).toHaveLength(1)
})

test('persona interview: owner DMs carry <bootstrap> until save_bot_profile; then the persona is in chat_context and the group guide follows', async () => {
  const delivered: string[] = []
  dm(OWNER, '嗨')
  await until(() => q("SELECT key FROM conversations WHERE key = 'dm-555'")[0])
  const client = connectRouter({
    socketPath: join(state, 'router.sock'), hello: { t: 'hello', project_dir: join(dir, 'dm-555'), pid: 1 },
    onMessage(m) { if (m.t === 'deliver') { delivered.push(m.params.content); client.send({ t: 'ack', qid: m.qid }) } },
  })
  const first = await until(() => delivered.find(d => d.endsWith('\n嗨')))
  expect(first).toContain('<bootstrap>')
  expect(first).toContain('呼叫 save_bot_profile')
  const before = delivered.length
  // only the owner's DM may save it
  dm({ id: 666, is_bot: false, first_name: 'U', username: 'u' }, 'hello')
  await until(() => q("SELECT key FROM conversations WHERE key = 'dm-666'")[0])
  const other = connectRouter({ socketPath: join(state, 'router.sock'), hello: { t: 'hello', project_dir: join(dir, 'dm-666'), pid: 2 }, onMessage(m) { if (m.t === 'deliver') other.send({ t: 'ack', qid: m.qid }) } })
  await until(() => other.state().kind === 'ready')
  expect((await other.call('save_bot_profile', { name: 'x', persona: 'y' })).isError).toBe(true)
  const r = await client.call('save_bot_profile', { name: '小鯨', persona: '你是小鯨, 沉穩簡潔, 用台灣中文.' })
  expect(r.isError).toBeFalsy()
  expect(q("SELECT persona_done, persona FROM bot_setup WHERE bot = 'new'")[0]).toEqual({ persona_done: 1, persona: '名字: 小鯨\n你是小鯨, 沉穩簡潔, 用台灣中文.' })
  const guide = await until(() => sentTo(555, '最後一步: 設定審核群組')[0])
  expect(guide.body.reply_markup.inline_keyboard[0][0].callback_data).toBe('setup:new:skip')
  dm(OWNER, '好了嗎')
  const after = await until(() => delivered.slice(before).find(d => d.endsWith('\n好了嗎')))
  expect(after).not.toContain('<bootstrap>')
  expect(after).toContain('bot 人設 (owner 設定, 這隻 bot 的所有對話共用):\n名字: 小鯨')
  expect(JSON.parse(readFileSync(join(dir, 'dm-666', '.chat', 'context.json'), 'utf8')).persona).toContain('小鯨')
  client.close(); other.close()
}, 20000)

test('approvals group: refused until the group has topics and the bot may manage them; then two topics are made and notices go there', async () => {
  inGroup('/router setup group')
  await until(() => sentTo(-100900, '⛔ 這個群組還沒打開「話題」').length === 1)
  forum = { type: 'supergroup', is_forum: true }
  inGroup('/router setup group')
  await until(() => sentTo(-100900, '⛔ 我還不是這個群組的管理員').length === 1)
  member = { status: 'administrator', can_manage_topics: false }
  inGroup('/router setup group')
  await until(() => sentTo(-100900, '⛔ 我是管理員但沒有「管理話題」權限').length === 1)
  member = { status: 'administrator', can_manage_topics: true }
  inGroup('/router setup group')
  await until(() => sentTo(-100900, '✅ 審核群組設定完成').length === 1)
  expect(calls.filter(c => c.method === 'createForumTopic').map(c => c.body.name)).toEqual(['🔔 重要通知', '🔐 權限審核'])
  expect(q("SELECT approvals_chat, notices_topic, approvals_topic, group_skipped FROM bot_setup WHERE bot = 'new'")[0]).toEqual({ approvals_chat: '-100900', notices_topic: 41, approvals_topic: 42, group_skipped: 0 })
  // a new conversation is now announced in the notices topic
  const access = JSON.parse(readFileSync(join(state, 'access.json'), 'utf8'))
  access.allowFrom.push('777')
  writeFileSync(join(state, 'access.json'), JSON.stringify(access))
  dm({ id: 777, is_bot: false, first_name: 'N', username: 'n' }, 'hi')
  const notice = await until(() => sentTo(-100900, '🆕 新對話 dm-777')[0])
  expect(notice.body.message_thread_id).toBe(41)
  // running it again reuses the topics
  inGroup('/router setup group')
  await until(() => sentTo(-100900, '✅ 審核群組設定完成 (沿用既有話題)').length === 1)
  expect(calls.filter(c => c.method === 'createForumTopic')).toHaveLength(2)
}, 20000)

test('skip: only the owner may press it; afterwards everything goes to the owner DM; /router setup shows the state', async () => {
  const press = (from: typeof OWNER) => updates.push({ update_id: mid, callback_query: { id: `cb${mid++}`, from, chat_instance: 'x', data: 'setup:new:skip', message: { message_id: 1, date: now, chat: { id: 555, type: 'private' }, text: 'guide' } } })
  press({ id: 666, is_bot: false, first_name: 'U', username: 'u' })
  await until(() => calls.find(c => c.method === 'answerCallbackQuery' && c.body.text === '只有 owner 能決定'))
  press(OWNER)
  await until(() => calls.find(c => c.method === 'answerCallbackQuery' && c.body.text === '已略過, 通知與申請都會私訊給你'))
  expect(q("SELECT approvals_chat, group_skipped FROM bot_setup WHERE bot = 'new'")[0]).toEqual({ approvals_chat: null, group_skipped: 1 })
  updates.push({ update_id: mid, message: { message_id: mid++, date: now, chat: { id: 555, type: 'private' }, from: OWNER, text: '/router setup', entities: [{ type: 'bot_command', offset: 0, length: 7 }] } })
  const shown = await until(() => sentTo(555, '人設: 已完成')[0])
  expect(shown.body.text).toBe('人設: 已完成\n審核與通知: owner 私訊 555 (已略過群組設定)')
}, 20000)
