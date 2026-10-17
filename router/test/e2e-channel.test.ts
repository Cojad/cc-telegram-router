// Broadcast channels are not supported (docs/architecture.md 「廣播頻道」, docs/testing.md 頻道驗收對照):
// the real router process against a fake Bot API sending channel_post
// updates. Channel posts (edited ones and commands too) only go to events,
// even for a channel listed in access.json groups: no conversation, no
// worker, nothing said in the channel. Being added to a channel is a notice
// to the owner pointing to GitHub issues. All ids are example values.

import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'

const dir = mkdtempSync(join(tmpdir(), 'cctr-e2e-channel-'))
const state = join(dir, '.router')
mkdirSync(state)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const OWNER = 111
const CHAN = -100555 // listed in access.json groups, still not handled
const STRANGE = -100200 // a channel nobody allowed
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
  groups: { [String(CHAN)]: { requireMention: false, allowFrom: [] } }, pending: {},
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
const ownerTexts = () => calls.filter(c => c.method === 'sendMessage' && String(c.body.chat_id) === String(OWNER)).map(c => String(c.body.text))

test('channel posts only go to events: no conversation, no worker, nothing said in the channel, commands ignored', async () => {
  await until(() => q('SELECT count(*) n FROM events')[0].n >= UPDATES.length)
  expect(q("SELECT count(*) n FROM events WHERE update_json LIKE '%channel_post%'")[0].n).toBe(8)
  expect(q("SELECT count(*) n FROM events WHERE update_json LIKE '%edited_channel_post%'")[0].n).toBe(1)
  // the /secret value is masked in events like anywhere else
  expect(q("SELECT count(*) n FROM events WHERE update_json LIKE '%supersecretvalue123%'")[0].n).toBe(0)
  await sleep(1500)
  expect(q('SELECT count(*) n FROM conversations')[0].n).toBe(0)
  expect(q('SELECT count(*) n FROM queue')[0].n).toBe(0)
  expect(existsSync(argLog)).toBe(false)
  for (const id of [CHAN, STRANGE]) expect(calls.some(c => String(c.body?.chat_id) === String(id))).toBe(false)
})

test('added to a channel: the owner is told it is not supported and where to ask for it', async () => {
  const n = await until(() => ownerTexts().find(t => t.startsWith('📣')))
  expect(n).toBe([
    `📣 @cc_bot 被加入頻道「News」(${CHAN})`,
    '目前尚未正式支援 Telegram 頻道, bot 不會處理頻道貼文.',
    '如果有實際想要的應用場景, 請到 GitHub https://github.com/Cojad/cc-telegram-router/issues 提交使用情境與需要的功能, 作者會視情況加入頻道支援.',
  ].join('\n'))
})
