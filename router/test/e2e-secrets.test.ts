// Conversation secrets end to end (plan 10b 對話專屬密鑰): the real router
// against a fake Bot API and a fake HTTP API. Keep in sync with README
// 「對話專屬密鑰」 and /telegram:bot-skill; unit level in secrets.test.ts.
//   config.json secretKey generated; DM /secret set deleted, stored sealed,
//   masked in the events table and the worker log; a user conversation calls
//   http_api with it (key in the header, scrubbed from the response, logged
//   as secret:<名稱>); other conversations cannot; in a group any member
//   registers, the bot cannot delete there so the sender is reminded; a reply
//   quoting that message reaches the worker masked; bot_api with a group
//   telegram-bot secret; "cc /secret" answered by the router; list / rm;
//   /router secret. Also bot settings notices (router/setup.ts): group
//   privacy and bot-to-bot on joining a group, first-run setup and
//   /router setup group; getMe check of telegram-bot secrets; --header;
//   the one-time masking of tokens in old logged updates.

import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { connectRouter } from '../../plugin/client'
import { openRouterDb } from '../db'

const dir = mkdtempSync(join(tmpdir(), 'cctr-secrets-'))
const state = join(dir, '.router')
mkdirSync(state)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const GROUP = -100700, OWNER = { id: 555, is_bot: false, first_name: 'Boss', username: 'boss' }
const USER = { id: 666, is_bot: false, first_name: 'U', username: 'u' }, MEMBER = { id: 777, is_bot: false, first_name: 'M', username: 'm' }
const HTTP_KEY = 'sk-fake-e2e-0001', BOT_KEY = '999:fake-group-token-AAAAAAAAAAAAAAAAAAAAAAAAAAAA'

const calls: Array<{ method: string; body: any; token?: string; auth?: string | null; xkey?: string | null }> = []
const updates: unknown[] = []
let forumOk = true
const now = Math.floor(Date.now() / 1000)
const api = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    const type = req.headers.get('content-type') ?? ''
    const body = type.includes('json') ? await req.json() : {}
    // the fake HTTP API echoes the key back: it must not reach the worker
    if (url.pathname.startsWith('/api/')) { calls.push({ method: `http ${url.pathname}`, body, auth: req.headers.get('authorization'), xkey: req.headers.get('x-api-key') }); return Response.json({ echo: req.headers.get('authorization'), echoKey: req.headers.get('x-api-key'), long: 'x'.repeat(5000) }) }
    const parts = url.pathname.split('/')
    const method = parts.pop()!, token = parts.pop()!.replace(/^bot/, '')
    calls.push({ method, body, token })
    const ok = (result: unknown) => Response.json({ ok: true, result })
    // like Telegram, parse_mode HTML with a stray < > or & is refused (the settings notices are HTML)
    if (body.parse_mode === 'HTML' && badHtml(String(body.text))) return Response.json({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" })
    switch (method) {
      // a token Telegram does not know; the router's own bot keeps privacy mode on
      case 'getMe': return token.includes('unknown') ? Response.json({ ok: false, error_code: 401, description: 'Unauthorized' }, { status: 401 })
        : token === '123:test' ? ok({ id: 1, is_bot: true, first_name: 'cc', username: 'cc_bot', can_read_all_group_messages: false }) : ok({ id: 9, is_bot: true, first_name: 'g', username: 'group_tool_bot' })
      case 'getUpdates': await sleep(100); return ok(updates.splice(0))
      case 'sendMessage': return ok({ message_id: 900 + calls.length, date: now, chat: { id: Number(body.chat_id) }, text: body.text, token_seen: token })
      // not an admin in the group: it cannot delete other people's messages there
      case 'deleteMessage': return Number(body.chat_id) === GROUP ? Response.json({ ok: false, error_code: 400, description: "Bad Request: message can't be deleted" }) : ok(true)
      case 'getChat': return ok(forumOk ? { id: Number(body.chat_id), title: 'Approvals', type: 'supergroup', is_forum: true } : { id: Number(body.chat_id), title: 'Plain', type: 'group' })
      case 'getChatMember': return ok({ user: { id: 1 }, status: 'administrator', can_manage_topics: true })
      case 'createForumTopic': return ok({ message_thread_id: 40 + calls.length, name: body.name })
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
// updates logged by an older router, with tokens in them: masked once at startup
{
  const old = openRouterDb(join(state, 'router.db'))
  old.logEvent('cc', { update_id: 0, message: { text: '/router cred add eagle 777:OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLD' } })
  old.logEvent('cc', { update_id: 0, message: { text: '/router bot rotate cc 778:OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLD' } })
  old.close()
}
writeFileSync(join(state, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['555', '666'], groups: { [String(GROUP)]: { requireMention: false, allowFrom: [] } }, pending: {} }))

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
const inGroup = (from: typeof OWNER, text: string, reply?: { message_id: number; text: string; from: typeof OWNER }) => {
  const id = mid++
  updates.push({ update_id: id, message: { message_id: id, date: now, chat: { id: GROUP, type: 'supergroup', title: 'Test group' }, from, text, ...(reply ? { reply_to_message: { ...reply, date: now, chat: { id: GROUP, type: 'supergroup', title: 'Test group' } } } : {}) } })
  return id
}
/** What Telegram refuses in parse_mode HTML: tags other than <b>, or an & that is not an entity. */
const badHtml = (t: string) => { const rest = t.replace(/<\/?b>/g, ''); return /[<>]/.test(rest) || /&(?!(amp|lt|gt|quot);)/.test(rest) }
const sentTo = (chat: number, prefix: string) => calls.filter(c => c.method === 'sendMessage' && Number(c.body.chat_id) === chat && String(c.body.text).startsWith(prefix))
const worker = (key: string, pid: number, delivered: string[] = []) => {
  const c = connectRouter({ socketPath: join(state, 'router.sock'), hello: { t: 'hello', project_dir: join(dir, 'bot123', key), pid }, onMessage(m) { if (m.t === 'deliver') { delivered.push(JSON.stringify(m.params)); c.send({ t: 'ack', qid: m.qid }) } } })
  return c
}

test('the router generates config.json secretKey (32 bytes) when missing; tokens in updates logged before are masked once, only the count is logged', async () => {
  const k = await until(() => JSON.parse(readFileSync(join(state, 'config.json'), 'utf8')).secretKey as string | undefined)
  expect(Buffer.from(k, 'base64')).toHaveLength(32)
  await until(() => stderr.includes('masked tokens in 2 logged updates'))
  expect(q("SELECT count(*) n FROM events WHERE update_json LIKE '%OLDOLD%'")[0].n).toBe(0)
  // (other one-time migrations, e.g. store.ts messages-legacy-by-time, share the table)
  expect(q("SELECT name, changed FROM migrations WHERE name = 'mask-command-tokens-2026-10'")).toEqual([{ name: 'mask-command-tokens-2026-10', changed: 2 }])
  expect(stderr).not.toContain('OLDOLD')
})

test('DM: a user registers an http secret; the message is deleted, the value is sealed, masked in events and in the worker log; only this conversation can use it, within its paths', async () => {
  dm(USER, 'hi')
  dm(OWNER, 'hi')
  await until(() => q("SELECT key FROM conversations WHERE key IN ('dm-666', 'dm-555')").length === 2)
  const msg = dm(USER, `/secret set img ${HTTP_KEY} --http http://127.0.0.1:${api.port} /api/*`)
  const r = await until(() => sentTo(666, '已登記')[0])
  expect(r.body.text).toBe(`已登記這個對話的密鑰 img: http http://127.0.0.1:${api.port}, 路徑 /api/*\n值加密存在 router, 只有這個對話能用 (http_api 工具, credential 填 img)\n已刪除含密鑰的訊息`)
  expect(calls.some(c => c.method === 'deleteMessage' && Number(c.body.chat_id) === 666 && c.body.message_id === msg)).toBe(true)
  const row = q("SELECT * FROM conv_secrets WHERE name = 'img'")[0]
  expect(row).toMatchObject({ bot: 'cc', chat_id: '666', kind: 'http', added_by: '666' })
  expect(row.value).toStartWith('v1:')
  // nowhere in router.db in plain text: not the events table, not the worker log
  for (const t of ['events', 'router_log', 'outbound', 'conv_secrets']) expect(q(`SELECT count(*) n FROM ${t} WHERE CAST(${t === 'events' ? 'update_json' : t === 'router_log' ? 'text' : t === 'outbound' ? 'payload_json' : 'value'} AS TEXT) LIKE '%${HTTP_KEY}%'`)[0].n).toBe(0)
  expect(q("SELECT text FROM router_log WHERE conv = 'dm-666'").map(r => r.text).join('\n')).toContain('/secret set img <已遮蔽> --http')
  expect(stderr).not.toContain(HTTP_KEY)

  const user = worker('dm-666', 11), owner = worker('dm-555', 12)
  await until(() => user.state().kind === 'ready' && owner.state().kind === 'ready')
  const res = await user.call('http_api', { credential: 'img', method: 'POST', path: '/api/gen', json: { prompt: 'whale' } })
  expect(res.isError).toBeFalsy()
  expect(calls.find(c => c.method === 'http /api/gen')!.auth).toBe(`Bearer ${HTTP_KEY}`)
  expect(res.content[0]!.text).not.toContain(HTTP_KEY)
  const body = JSON.parse(res.content[0]!.text)
  expect(body.status).toBe(200)
  expect(body.body.echo).toBe('Bearer <密鑰>')
  expect(body.body.long).toContain('已截斷')
  expect(q("SELECT bot, conv, method FROM outbound WHERE bot = 'secret:img'")).toEqual([{ bot: 'secret:img', conv: 'dm-666', method: 'POST /api/gen' }])
  expect((await user.call('http_api', { credential: 'img', path: '/other' })).content[0]!.text).toContain('沒有開放 /other')
  expect((await user.call('bot_api', { credential: 'img', method: 'getMe' })).content[0]!.text).toBe('密鑰 img 是 http 類, 要用 http_api 工具')
  // another conversation (even the owner's) does not have it
  expect((await owner.call('http_api', { credential: 'img', path: '/api/gen' })).content[0]!.text).toStartWith('沒有名為 img 的憑證')
  user.close(); owner.close()
}, 30000)

test('group: any member registers a telegram-bot secret; the bot cannot delete there, so the sender is reminded; a reply quoting it reaches the worker masked; bot_api uses it without role or authorization', async () => {
  inGroup(MEMBER, 'hello group')
  await until(() => q(`SELECT key FROM conversations WHERE key = 'group-100700'`)[0])
  const delivered: string[] = []
  const g = worker('group-100700', 21, delivered)
  await until(() => g.state().kind === 'ready')
  const text = `/secret set gbot ${BOT_KEY} sendMessage`
  const msg = inGroup(MEMBER, text)
  // a token getMe does not accept is not stored
  inGroup(MEMBER, '/secret set nobot 555:unknown-token-AAAAAAAAAAAAAAAAAAAAAAAAA')
  expect((await until(() => sentTo(GROUP, '這不是可用的 bot token')[0])).body.text).toStartWith('這不是可用的 bot token (getMe 失敗: 401: Unauthorized), 沒有登記')
  const r = await until(() => sentTo(GROUP, '已登記')[0])
  expect(r.body.text).toStartWith('已登記這個對話的密鑰 gbot: telegram-bot @group_tool_bot (9), 方法 sendMessage')
  expect(r.body.text).toEndWith('\n⚠️ 無法刪除含密鑰的訊息 (bot 沒有刪除權限), 請自己刪掉那則訊息')
  expect(q("SELECT added_by FROM conv_secrets WHERE chat_id = '-100700' AND name = 'gbot'")).toEqual([{ added_by: '777' }])
  // someone replies to the message the bot could not delete
  inGroup(OWNER, 'is this safe?', { message_id: msg, text, from: MEMBER })
  const d = await until(() => delivered.find(x => x.includes('is this safe?')))
  expect(d).not.toContain(BOT_KEY.split(':')[1]!)
  expect(d).toContain('/secret set gbot <已遮蔽>')

  const res = await g.call('bot_api', { credential: 'gbot', method: 'sendMessage', params: { chat_id: 42, text: 'from my bot' } })
  expect(res.isError).toBeFalsy()
  expect(calls.filter(c => c.method === 'sendMessage' && c.body.text === 'from my bot').at(-1)!.token).toBe(BOT_KEY)
  expect(res.content[0]!.text).not.toContain(BOT_KEY.split(':')[1]!)
  expect((await g.call('bot_api', { credential: 'gbot', method: 'getMe' })).content[0]!.text).toContain('沒有開放 getMe')
  expect(q("SELECT conv FROM outbound WHERE bot = 'secret:gbot'")).toEqual([{ conv: 'group-100700' }])
  // nothing went to an approvals topic: no authorization use was recorded
  expect(q('SELECT count(*) n FROM auth_uses')[0].n).toBe(0)
  g.close()
}, 30000)

test('list and rm: /secret list shows names, kinds and scopes; "cc /secret" is answered by the router; /secret rm; /router secret for owner', async () => {
  inGroup(MEMBER, 'cc /secret list')
  const l = await until(() => sentTo(GROUP, '這個對話的密鑰')[0])
  expect(l.body.text).toBe('這個對話的密鑰 (1/20):\ngbot: telegram-bot @group_tool_bot (9), 方法 sendMessage')
  dm(OWNER, '/router secret list')
  const all = await until(() => sentTo(555, 'cc ')[0])
  expect(all.body.text).toBe('cc -100700: 1 把\ncc 666: 1 把')
  dm(OWNER, '/router secret rm 666 img')
  await until(() => sentTo(555, '已移除對話 666 的密鑰 img')[0])
  inGroup(MEMBER, '/secret rm gbot')
  await until(() => sentTo(GROUP, '已移除密鑰 gbot')[0])
  expect(q('SELECT count(*) n FROM conv_secrets')[0].n).toBe(0)
  dm(USER, '/router secret list')
  await until(() => sentTo(666, '⛔ /router 只開放 owner 與 admin')[0])
}, 30000)

test('--header: the key goes in that header as it is (x-api-key), not in Authorization; scrubbed from the echo', async () => {
  dm(USER, `/secret set xk sk-fake-header-02 --http http://127.0.0.1:${api.port} --header x-api-key /api/*`)
  expect((await until(() => sentTo(666, '已登記這個對話的密鑰 xk')[0])).body.text).toStartWith(`已登記這個對話的密鑰 xk: http http://127.0.0.1:${api.port}, 標頭 x-api-key, 路徑 /api/*`)
  const user = worker('dm-666', 31)
  await until(() => user.state().kind === 'ready')
  const res = await user.call('http_api', { credential: 'xk', method: 'GET', path: '/api/hdr' })
  expect(calls.find(c => c.method === 'http /api/hdr')).toMatchObject({ xkey: 'sk-fake-header-02', auth: null })
  expect(JSON.parse(res.content[0]!.text).body.echoKey).toBe('<密鑰>')
  user.close()
}, 30000)

test('added to a group: the owner is told about privacy mode (re-add after changing it, admins get everything) and bot-to-bot; as admin only bot-to-bot', async () => {
  const added = (status: string) => updates.push({ update_id: mid, my_chat_member: { chat: { id: -100800 - mid, type: 'supergroup', title: `New group ${mid++}` }, from: OWNER, date: now, old_chat_member: { status: 'left', user: { id: 1, is_bot: true, first_name: 'cc' } }, new_chat_member: { status, user: { id: 1, is_bot: true, first_name: 'cc' } } } })
  added('member')
  const n = await until(() => sentTo(555, '➕ @cc_bot 被加入群組 New group')[0])
  for (const s of ['你目前 Group Privacy 設定: ⚠️ 開啟', '從群組移除再重新加入才會生效', '不受隱私模式限制', '/setprivacy', 'Bot-to-Bot Communication Mode']) expect(n.body.text).toContain(s)
  added('administrator')
  const a = await until(() => sentTo(555, '➕').find(c => String(c.body.text).includes('(管理員)')))
  expect(a.body.text).not.toContain('群組隱私模式')
  expect(a.body.text).toContain('Bot-to-Bot Communication Mode')
  // HTML with 柯姊's bold; a group title with < > & still goes out, escaped
  expect(n.body.parse_mode).toBe('HTML')
  expect(n.body.text).toContain('<b>群組隱私模式 (Group Privacy)</b>')
  updates.push({ update_id: mid, my_chat_member: { chat: { id: -100799, type: 'supergroup', title: 'R&D <team> "1"' }, from: OWNER, date: now, old_chat_member: { status: 'left', user: { id: 1, is_bot: true, first_name: 'cc' } }, new_chat_member: { status: 'member', user: { id: 1, is_bot: true, first_name: 'cc' } } } })
  const odd = await until(() => sentTo(555, '➕ @cc_bot 被加入群組 R&amp;D &lt;team&gt; "1"')[0])
  expect(odd.body.parse_mode).toBe('HTML')
  expect(badHtml(odd.body.text)).toBe(false)
  expect(calls.some(c => c.method === 'sendMessage' && c.body.parse_mode === 'HTML' && badHtml(String(c.body.text)))).toBe(false) // nothing refused
}, 30000)

test('bot settings notices on first-run setup and /router setup group: the group guide and the setup result (done or refused) carry the privacy notice and bot-to-bot', async () => {
  // the bot is new here (no persona): the owner's worker saves one, the router sends the group guide
  const owner = worker('dm-555', 41)
  await until(() => owner.state().kind === 'ready')
  expect((await owner.call('save_bot_profile', { name: '小鯨', persona: '你是小鯨.' })).isError).toBeFalsy()
  const guide = await until(() => sentTo(555, '最後一步: 設定審核群組')[0], 10000)
  expect(guide.body.parse_mode).toBe('HTML')
  for (const s of ['你目前 Group Privacy 設定: ⚠️ 開啟', '從群組移除再重新加入才會生效', '不受隱私模式限制', 'Bot-to-Bot Communication Mode']) expect(guide.body.text).toContain(s)
  owner.close()
  // a plain group cannot be the approvals group: refused, with the notice all the same
  forumOk = false
  updates.push({ update_id: mid, message: { message_id: mid++, date: now, chat: { id: -100802, type: 'group', title: 'Plain' }, from: OWNER, text: '/router setup group', entities: [{ type: 'bot_command', offset: 0, length: 7 }] } })
  const no = await until(() => sentTo(-100802, '⛔ 審核群組必須是 supergroup')[0])
  for (const s of ['你目前 Group Privacy 設定: ⚠️ 開啟', 'Bot-to-Bot Communication Mode']) expect(no.body.text).toContain(s)
  forumOk = true
  updates.push({ update_id: mid, message: { message_id: mid++, date: now, chat: { id: -100801, type: 'supergroup', title: 'Approvals' }, from: OWNER, text: '/router setup group', entities: [{ type: 'bot_command', offset: 0, length: 7 }] } })
  const done = await until(() => sentTo(-100801, '✅ 審核群組設定完成')[0])
  for (const s of ['你目前 Group Privacy 設定: ⚠️ 開啟', '從群組移除再重新加入才會生效', 'Bot-to-Bot Communication Mode']) expect(done.body.text).toContain(s)
  expect([no.body.parse_mode, done.body.parse_mode]).toEqual(['HTML', 'HTML'])
}, 30000)
