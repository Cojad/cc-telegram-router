// Broadcast channels, module level (README 運作方式 11, 頻道驗收對照):
// transport.ts inboundView (a channel post in the message shape, the
// channel as the sender), policy.ts gate for channels and for a discussion
// group's automatic copy of a post, the guest role for a channel
// conversation and for a channel as the sender (conversations.ts
// defaultRole, commands.ts roleOf), and the notice when the bot is made a
// channel administrator (setup.ts channelJoinNotice), and the /telegram:doc
// channel section (plugin/skills/doc/SKILL.md 「頻道」). End to end:
// e2e-channel.test.ts. All ids are example values.

import { expect, test } from 'bun:test'
import type { Context } from 'grammy'
import { inboundView } from '../telegram/transport'
import { defaultAccess, gate, type Access } from '../telegram/policy'
import { defaultRole } from '../conversations'
import { roleOf } from '../commands'
import { channelJoinNotice } from '../setup'

const CHAN = -100555
const chan = { id: CHAN, type: 'channel', title: 'News', username: 'news_example' }
const postCtx = (extra: Record<string, unknown>) =>
  ({ channelPost: { message_id: 10, date: 0, chat: chan, sender_chat: chan, ...extra }, reply: async () => {} }) as unknown as Context
const mentioned = { text: '@cc_bot 你好', entities: [{ type: 'mention', offset: 0, length: 7 }] }
const access = (groups: Access['groups']): Access => ({ ...defaultAccess(), dmPolicy: 'allowlist', groups })
const run = (ctx: Context, a: Access) => gate(inboundView(ctx), a, 'cc_bot', () => {}, () => 'code').action

test('inboundView: a channel post becomes a message from the channel itself; other updates pass through', () => {
  const v = inboundView(postCtx({ ...mentioned, author_signature: 'Alice' }))
  expect(v.chat).toEqual(chan as never)
  expect(v.from).toEqual({ id: CHAN, username: 'news_example' })
  expect(v.message?.text).toBe('@cc_bot 你好')
  expect(v.message?.author_signature).toBe('Alice')
  const plain = { message: { text: 'hi' }, chat: { id: 1, type: 'private' }, from: { id: 1 } } as unknown as Context
  expect(inboundView(plain)).toBe(plain as never)
})

test('gate: a channel must be in access.json groups; mention required by default, --no-mention takes every post', () => {
  expect(run(postCtx(mentioned), access({}))).toBe('drop')
  const needs = access({ [String(CHAN)]: { requireMention: true, allowFrom: [] } })
  expect(run(postCtx(mentioned), needs)).toBe('deliver')
  expect(run(postCtx({ text: 'just news' }), needs)).toBe('drop')
  const all = access({ [String(CHAN)]: { requireMention: false, allowFrom: [] } })
  expect(run(postCtx({ text: 'just news' }), all)).toBe('deliver')
  // mentionPatterns work in channels too
  expect(run(postCtx({ text: '柯柯 看這個' }), { ...needs, mentionPatterns: ['^柯柯'] })).toBe('deliver')
})

test('gate: the discussion group drops Telegram\'s automatic copy of a channel post, keeps members\' comments', () => {
  const a = access({ '-100666': { requireMention: false, allowFrom: [] } })
  const msg = (extra: Record<string, unknown>) => ({ chat: { id: -100666, type: 'supergroup' }, from: { id: 777000 }, message: { message_id: 1, ...extra } }) as unknown as Context
  expect(run(msg({ text: 'copy', is_automatic_forward: true }), a)).toBe('drop')
  expect(run(msg({ text: 'a comment' }), a)).toBe('deliver')
})

test('roles: a channel conversation is guest, and a channel as the sender is always guest', () => {
  const cfg = { owners: ['111'] }
  expect(defaultRole(cfg, 'channel', String(CHAN))).toBe('guest')
  expect(defaultRole(cfg, 'group', '-100666')).toBe('user')
  const deps = { cfg: cfg as never, db: { getUserRole: () => 'admin' } as never }
  expect(roleOf(deps, String(CHAN))).toBe('guest')
  expect(roleOf(deps, '111')).toBe('owner')
  expect(roleOf(deps, '222')).toBe('admin')
})

test('channelJoinNotice: chat id, the allow command, guest, and whether the bot may post', () => {
  const n = channelJoinNotice('cc_bot', { id: CHAN, title: 'News' }, { can_post_messages: true })
  expect(n).toContain(`chat_id ${CHAN}`)
  expect(n).toContain(`/router access group add ${CHAN}`)
  expect(n).toContain('--no-mention')
  expect(n).toContain('guest')
  expect(n).not.toContain('沒有「發布訊息」權限')
  expect(channelJoinNotice('cc_bot', { id: CHAN }, {})).toContain('沒有「發布訊息」權限')
})

test('/telegram:doc has the channel section: allowlist, mention, guest, replies, commands, discussion group', async () => {
  const doc = await Bun.file(new URL('../../plugin/skills/doc/SKILL.md', import.meta.url)).text()
  const sec = doc.slice(doc.indexOf('## 頻道'), doc.indexOf('## 審核群組與新 bot 初次設定'))
  for (const s of ['/router access group add', '--no-mention', 'channel-<id>', 'guest', '發布訊息', '/router`, `/secret` 與 `cc /`', '討論群組']) expect(sec).toContain(s)
})
