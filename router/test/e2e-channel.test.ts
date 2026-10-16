// Broadcast channels end to end (README 運作方式 11, 頻道驗收對照): the real
// router process against a fake Bot API sending channel_post updates.
// Channel posts have no `from` (the sender is the channel, sender_chat) and
// live in update.channel_post, not update.message. Covers: events, the
// allowlist (access.json groups, /router access group add), mention,
// channel-<id> conversation with role guest, sender_role guest,
// author_signature, the worker replying with a new post, commands in a
// channel ignored, edited posts not delivered, the discussion group's
// automatic copy of a post dropped, and the notice when the bot is made a
// channel administrator. All ids are example values.

import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { connectRouter } from '../../plugin/client'

const dir = mkdtempSync(join(tmpdir(), 'cctr-e2e-channel-'))
const state = join(dir, '.router')
mkdirSync(state)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const OWNER = 111
const CHAN = -100555 // allowed in access.json
const STRANGE = -100200 // a channel nobody allowed
const LATER = -100888 // allowed later with /router access group add
const DISC = -100666 // CHAN's discussion group, allowed without mention
const now = Math.floor(Date.now() / 1000)
const chan = (id: number, title = 'News') => ({ id, type: 'channel', title })
const mention = (text: string) => ({ text, entities: [{ type: 'mention', offset: 0, length: 7 }] })
const post = (update_id: number, chatId: number, message_id: number, extra: Record<string, unknown>) =>
  ({ update_id, channel_post: { message_id, date: now, chat: chan(chatId), sender_chat: chan(chatId), ...extra } })

// --- fake Bot API ---------------------------------------------------------
const calls: Array<{ method: string; body: any }> = []
let updatesServed = false
const laterUpdates: unknown[] = []
const UPDATES = [
  // made an administrator of CHAN, may post
  { update_id: 1, my_chat_member: { chat: chan(CHAN), from: { id: OWNER, is_bot: false, first_name: 'O' }, date: now,
    old_chat_member: { status: 'left', user: { id: 1, is_bot: true, first_name: 'cc' } },
    new_chat_member: { status: 'administrator', user: { id: 1, is_bot: true, first_name: 'cc' }, can_post_messages: true } } },
  post(2, CHAN, 10, { ...mention('@cc_bot 今天的重點?'), author_signature: 'Alice' }),
  post(3, CHAN, 11, { text: 'no mention, not for the bot' }),
  post(4, STRANGE, 12, mention('@cc_bot hello?')),
  post(5, CHAN, 13, { text: '/router status', entities: [{ type: 'bot_command', offset: 0, length: 7 }] }),
  post(6, CHAN, 14, { text: '/secret set k supersecretvalue123 @cc_bot' }),
  post(7, CHAN, 15, { text: 'cc /status' }),
  { update_id: 8, edited_channel_post: { message_id: 10, date: now, edit_date: now, chat: chan(CHAN), sender_chat: chan(CHAN), ...mention('@cc_bot 改過的貼文') } },
  // the discussion group: Telegram's copy of a post, then a member's comment
  { update_id: 9, message: { message_id: 50, date: now, chat: { id: DISC, type: 'supergroup', title: 'News chat' }, from: { id: 777000, is_bot: false, first_name: 'Telegram' }, sender_chat: chan(CHAN), is_automatic_forward: true, text: 'auto copy of a post' } },
  { update_id: 10, message: { message_id: 51, date: now, chat: { id: DISC, type: 'supergroup', title: 'News chat' }, from: { id: 222, is_bot: false, first_name: 'U' }, text: 'a comment' } },
  // a document posted with a caption that mentions the bot
  post(11, CHAN, 16, { document: { file_id: 'DOC1', file_unique_id: 'u1', file_name: 'report.pdf', mime_type: 'application/pdf', file_size: 10 }, caption: '@cc_bot 看這份', caption_entities: [{ type: 'mention', offset: 0, length: 7 }] }),
]
const api = Bun.serve({
  port: 0,
  async fetch(req) {
    const method = new URL(req.url).pathname.split('/').pop()!
    const body = req.headers.get('content-type')?.includes('json') ? await req.json() : {}
    calls.push({ method, body })
    const ok = (result: unknown) => Response.json({ ok: true, result })
    switch (method) {
      case 'getMe': return ok({ id: 1, is_bot: true, first_name: 'cc', username: 'cc_bot' })
      case 'getUpdates':
        if (!updatesServed) { updatesServed = true; return ok(UPDATES) }
        await sleep(200)
        return ok(laterUpdates.splice(0))
      case 'sendMessage': return ok({ message_id: 900 + calls.length, date: now, chat: { id: Number(body.chat_id) }, text: body.text })
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
  bots: [{ name: 'cc', token: '123:test' }], home: dir, stateDir: state, owners: [String(OWNER)],
  model: 'claude-opus-5-5', claudeBin: fakeClaude, apiRoot: `http://127.0.0.1:${api.port}`,
}))
writeFileSync(join(state, 'access.json'), JSON.stringify({
  dmPolicy: 'allowlist', allowFrom: [String(OWNER)],
  groups: { [String(CHAN)]: { requireMention: true, allowFrom: [] }, [String(DISC)]: { requireMention: false, allowFrom: [] } }, pending: {},
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
const queued = () => q('SELECT conv, params FROM queue ORDER BY qid').map(r => ({ conv: r.conv, ...JSON.parse(r.params) }))
const ownerTexts = () => calls.filter(c => c.method === 'sendMessage' && String(c.body.chat_id) === String(OWNER)).map(c => String(c.body.text))

test('every channel update is in events; an allowed channel post that mentions the bot becomes channel-<id> with role guest', async () => {
  await until(() => q('SELECT count(*) n FROM events')[0].n >= UPDATES.length)
  expect(q("SELECT count(*) n FROM events WHERE update_json LIKE '%channel_post%'")[0].n).toBe(8)
  expect(q("SELECT count(*) n FROM events WHERE update_json LIKE '%edited_channel_post%'")[0].n).toBe(1)
  await until(() => queued().length >= 3)
  await sleep(300)
  const qs = queued()
  // CHAN: the mention and the document caption; DISC: only the member's comment
  expect(qs.map(x => [x.conv, x.content])).toEqual([
    ['channel-100555', '@cc_bot 今天的重點?'],
    ['group-100666', 'a comment'],
    ['channel-100555', '@cc_bot 看這份'],
  ])
  expect(qs[0].meta).toMatchObject({ chat_id: String(CHAN), message_id: '10', user_id: String(CHAN), author_signature: 'Alice' })
  expect(qs[2].meta).toMatchObject({ attachment_kind: 'document', attachment_file_id: 'DOC1', attachment_name: 'report.pdf' })
  const convs = q("SELECT key, type, role, title FROM conversations ORDER BY key")
  expect(convs).toEqual([
    { key: 'channel-100555', type: 'channel', role: 'guest', title: 'News' },
    { key: 'group-100666', type: 'group', role: 'user', title: 'News chat' },
  ])
  expect(existsSync(join(dir, 'bot123', 'channel-100555', 'CLAUDE.md'))).toBe(true)
  // the guest template: talk only
  const s = JSON.parse(readFileSync(join(state, 'sessions', 'channel-100555.json'), 'utf8'))
  expect(s.permissions.defaultMode).toBe('dontAsk')
  expect(readFileSync(argLog, 'utf8')).toContain('tg-channel-100555')
})

test('commands posted in a channel are neither answered nor forwarded; the /secret value is masked in events', async () => {
  for (const t of ['/router status', '/secret set', 'cc /status']) expect(queued().some(x => String(x.content).includes(t))).toBe(false)
  expect(calls.some(c => c.method === 'sendMessage' && String(c.body.chat_id) === String(CHAN))).toBe(false)
  expect(q("SELECT count(*) n FROM events WHERE update_json LIKE '%supersecretvalue123%'")[0].n).toBe(0)
  // the unmentioned post, the stranger channel and the edited post went nowhere
  expect(queued().some(x => ['no mention, not for the bot', '@cc_bot hello?', '@cc_bot 改過的貼文'].includes(x.content))).toBe(false)
})

test('made a channel administrator: the owner gets the channel id and how to allow it', async () => {
  const n = await until(() => ownerTexts().find(t => t.startsWith('📣')))
  expect(n).toContain(`chat_id ${CHAN}`)
  expect(n).toContain(`/router access group add ${CHAN}`)
  expect(n).toContain('guest')
})

test('the channel worker sees sender_role guest and replies with a new post to the original', async () => {
  const delivered: any[] = []
  const client = connectRouter({
    socketPath: join(state, 'router.sock'),
    hello: { t: 'hello', project_dir: join(dir, 'bot123', 'channel-100555'), pid: 1 },
    onMessage(m) { if (m.t === 'deliver') { delivered.push(m.params); client.send({ t: 'ack', qid: m.qid }) } },
  })
  await until(() => delivered.length >= 2)
  expect(delivered[0].content).toContain('role: guest')
  expect(delivered[0].meta).toMatchObject({ sender_role: 'guest', author_signature: 'Alice' })
  expect(delivered[0].meta.elevated).toBeUndefined()
  const r = await client.call('reply', { chat_id: String(CHAN), text: '重點如下', reply_to: '10' })
  expect(r.isError).toBeFalsy()
  const sent = calls.find(c => c.method === 'sendMessage' && c.body.text === '重點如下')!
  expect(String(sent.body.chat_id)).toBe(String(CHAN))
  expect(sent.body.reply_parameters?.message_id).toBe(10)
  // a guest channel cannot post anywhere else
  const denied = await client.call('reply', { chat_id: String(OWNER), text: 'leak' })
  expect(denied.isError).toBe(true)
  client.close()
})

test('/router access group add lets a new channel in', async () => {
  const from = { id: OWNER, is_bot: false, first_name: 'O' }
  laterUpdates.push(post(20, LATER, 30, mention('@cc_bot before')))
  await until(() => q(`SELECT count(*) n FROM events WHERE update_json LIKE '%before%'`)[0].n === 1)
  laterUpdates.push({ update_id: 21, message: { message_id: 60, date: now, chat: { id: OWNER, type: 'private' }, from, text: `/router access group add ${LATER}`, entities: [{ type: 'bot_command', offset: 0, length: 7 }] } })
  await until(() => ownerTexts().some(t => t.includes(`${LATER} 已加入`)))
  laterUpdates.push(post(22, LATER, 31, mention('@cc_bot after')))
  const x = await until(() => queued().find(x => x.content === '@cc_bot after'))
  expect(x.conv).toBe('channel-100888')
  expect(queued().some(x => x.content === '@cc_bot before')).toBe(false)
  expect(JSON.parse(readFileSync(join(state, 'access.json'), 'utf8')).groups[String(LATER)]).toEqual({ requireMention: true, allowFrom: [] })
})
