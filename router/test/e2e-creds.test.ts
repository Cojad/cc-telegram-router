// Registering credentials end to end (柯姊 2026-10-17): the real router
// against a fake Bot API and a fake HTTP API. Keep in sync with
// docs/credentials-and-skills.md 「登記訊息的延遲刪除」「同名憑證: 覆蓋或取消」
// 「換 key: cred rotate」「預設標頭」「http_api 的 json_file」, docs/secrets.md
// 「登記訊息何時刪除」 and /router help cred; unit level in cred-flows.test.ts.
//   A message with a key (/router cred add|rotate, /secret set, /router bot
//   add|rotate) in a DM is deleted 60 seconds after the answer: a notice
//   with 取消刪除 its sender, an owner or an admin may press (anyone else has
//   no right); /secret set in a group is deleted 10 seconds after it with a
//   notice and no button, a refused /router cred add there at once; a
//   deletion due while the router was down is done at startup. /router cred add of a name that exists asks 覆蓋 / 取消 (only
//   the sender decides; 取消 changes nothing, 覆蓋 takes this add's
//   settings). /router cred rotate changes only the key (getMe first for a
//   bot token). --default-header and /router cred header: http_api adds
//   them unless the worker sends one of that name; /router cred header and
//   /secret header list, set, update and rm. json_file sent as the JSON
//   body: owner and admin conversations anywhere but router state, a user
//   conversation only inside its folder; the size limit, invalid JSON and
//   json + json_file refused.

import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync, truncateSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { connectRouter } from '../../plugin/client'
import { openRouterDb } from '../db'

const dir = mkdtempSync(join(tmpdir(), 'cctr-creds-'))
const state = join(dir, '.router')
mkdirSync(state)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const GROUP = -100710
const OWNER = { id: 555, is_bot: false, first_name: 'Boss', username: 'boss' }
const USER = { id: 666, is_bot: false, first_name: 'U', username: 'u' }
const ADMIN = { id: 777, is_bot: false, first_name: 'A', username: 'adm' }
const USER2 = { id: 888, is_bot: false, first_name: 'V', username: 'v' }
const KEY1 = 'sk-ant-fake-e2e-key-one-0001', KEY2 = 'sk-ant-fake-e2e-key-two-0002', SKEY = 'sk-fake-e2e-secret-0003'
const BOT1 = `424242:${'A'.repeat(35)}`, BOT2 = `434343:${'B'.repeat(35)}`

const calls: Array<{ method: string; body: any; token?: string; headers?: Record<string, string>; raw?: string }> = []
const updates: unknown[] = []
const now = Math.floor(Date.now() / 1000)
const api = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    // the fake HTTP API: every header and the body as it came
    if (url.pathname.startsWith('/api/')) {
      const raw = await req.text()
      calls.push({ method: `http ${url.pathname}`, body: null, raw, headers: Object.fromEntries(req.headers.entries()) })
      return Response.json({ ok: true })
    }
    const type = req.headers.get('content-type') ?? ''
    const body = type.includes('json') ? await req.json() : {}
    const parts = url.pathname.split('/')
    const method = parts.pop()!, token = parts.pop()!.replace(/^bot/, '')
    calls.push({ method, body, token })
    const ok = (result: unknown) => Response.json({ ok: true, result })
    switch (method) {
      case 'getMe': return token === '123:test' ? ok({ id: 1, is_bot: true, first_name: 'cc', username: 'cc_bot', can_read_all_group_messages: true })
        : ok({ id: Number(token.split(':')[0]), is_bot: true, first_name: 't', username: token.startsWith('434343') ? 'tool2_bot' : 'tool_bot' })
      case 'getUpdates': await sleep(100); return ok(updates.splice(0))
      // the bot is an admin of the group with the right to delete
      case 'getChatMember': return ok({ user: { id: 1 }, status: 'administrator', can_delete_messages: true })
      case 'sendMessage': return ok({ message_id: 900 + calls.length, date: now, chat: { id: Number(body.chat_id) }, text: body.text })
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
writeFileSync(join(state, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['555', '666', '777', '888'], groups: { [String(GROUP)]: { requireMention: false, allowFrom: [] } }, pending: {} }))
// deletions of registration messages scheduled before a restart: one due while the router was down, one not yet
{
  const old = openRouterDb(join(state, 'router.db'))
  old.updateBotSetup('cc', { group_skipped: 1, persona_done: 1 })
  old.setUserRole('777', 'admin')
  old.scheduleDeletion({ event_id: 0, bot: 'cc', chat_id: '555', message_id: 88, sender: '555', notice_id: 5088, due_at: new Date(Date.now() - 5_000).toISOString(), kind: 'command' })
  old.scheduleDeletion({ event_id: 0, bot: 'cc', chat_id: '555', message_id: 89, sender: '555', notice_id: 5089, due_at: new Date(Date.now() + 3_600_000).toISOString(), kind: 'command' })
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
const config = () => JSON.parse(readFileSync(join(state, 'config.json'), 'utf8'))
let mid = 1
const dm = (from: typeof OWNER, text: string) => { const id = mid++; updates.push({ update_id: id, message: { message_id: id, date: now, chat: { id: from.id, type: 'private' }, from, text } }); return id }
const inGroup = (from: typeof OWNER, text: string) => { const id = mid++; updates.push({ update_id: id, message: { message_id: id, date: now, chat: { id: GROUP, type: 'supergroup', title: 'Test group' }, from, text } }); return id }
const press = (from: typeof OWNER, chat: number, messageId: number, data: string) => {
  const id = `cb${mid++}`
  updates.push({ update_id: mid++, callback_query: { id, from, chat_instance: 'x', data, message: { message_id: messageId, date: now, chat: { id: chat, type: chat > 0 ? 'private' : 'supergroup' } } } })
  return until(() => calls.find(c => c.method === 'answerCallbackQuery' && c.body.callback_query_id === id)?.body.text as string | undefined)
}
const replyTo = (chat: number, msg: number, prefix: string) => until(() => calls.find(c => c.method === 'sendMessage' && Number(c.body.chat_id) === chat && c.body.reply_parameters?.message_id === msg && String(c.body.text).startsWith(prefix)))
const deleted = (chat: number, msg: number) => calls.some(c => c.method === 'deleteMessage' && Number(c.body.chat_id) === chat && c.body.message_id === msg)
// the message_id the fake API gave a sendMessage it answered
const sentId = (c: (typeof calls)[number]) => 901 + calls.indexOf(c)
const edits = (msg: number) => calls.filter(c => c.method === 'editMessageText' && c.body.message_id === msg).map(c => String(c.body.text))
const worker = (key: string, pid: number) => {
  const c = connectRouter({ socketPath: join(state, 'router.sock'), hello: { t: 'hello', project_dir: join(dir, 'bot123', key), pid }, onMessage(m) { if (m.t === 'deliver') c.send({ t: 'ack', qid: m.qid }) } })
  return c
}

test('router restart: a registration message whose deletion fell due while the router was down is deleted at startup and its notice says so; one not yet due waits', async () => {
  await until(() => deleted(555, 88))
  await until(() => edits(5088).length)
  expect(edits(5088)).toEqual(['🗑 已刪除含 key 的登記訊息'])
  expect(q('SELECT message_id, kind, status FROM secret_deletions ORDER BY id')).toEqual([
    { message_id: 88, kind: 'command', status: 'deleted' },
    { message_id: 89, kind: 'command', status: 'pending' },
  ])
  expect(deleted(555, 89)).toBe(false)
})

test('/router cred add in the owner DM: the message waits 60 seconds with a 取消刪除 notice; a user who is not the sender has no right, the sender may; the key reaches no log', async () => {
  dm(OWNER, 'hi')
  dm(USER, 'hi')
  await until(() => q("SELECT key FROM conversations WHERE key IN ('dm-555', 'dm-666')").length === 2)
  const msg = dm(OWNER, `/router cred add anthropic ${KEY1} --http http://127.0.0.1:${api.port} --header x-api-key --default-header anthropic-version:2023-06-01 /api/*`)
  const r = await replyTo(555, msg, '已加入憑證 anthropic')
  expect(r.body.text).toBe(`已加入憑證 anthropic: http http://127.0.0.1:${api.port}, 標頭 x-api-key, 預設標頭 anthropic-version: 2023-06-01\n路徑: /api/*\n角色: owner, admin\nAPI key 只存在 router 設定檔, worker 用 http_api 工具使用`)
  expect(config().credentials.anthropic).toMatchObject({ token: KEY1, kind: 'http', header: 'x-api-key', defaultHeaders: { 'anthropic-version': '2023-06-01' }, methods: ['/api/*'] })
  const notice = await replyTo(555, msg, '⏳ 這則訊息含有 key, 60 秒後')
  expect(notice.body.text).toMatch(/^⏳ 這則訊息含有 key, 60 秒後 \(\d\d:\d\d\) 刪除\. 要保留請按「取消刪除」\(發訊者本人, owner, admin 能按\)\.$/)
  const del = q(`SELECT id, kind, status, sender, due_at FROM secret_deletions WHERE message_id = ${msg}`)[0]
  expect(del).toMatchObject({ kind: 'command', status: 'pending', sender: '555' })
  expect(Math.abs(Date.parse(del.due_at) - Date.now() - 60_000)).toBeLessThan(10_000)
  expect(notice.body.reply_markup.inline_keyboard[0]).toEqual([{ text: '取消刪除', callback_data: `sdel:${del.id}:cancel` }])
  expect(deleted(555, msg)).toBe(false)
  // someone else (here a user who saw the button somehow) is refused; the sender may
  expect(await press(USER, 555, notice.body.message_id ?? 0, `sdel:${del.id}:cancel`)).toBe('沒有權限: 只有發訊者本人, owner, admin 能取消刪除')
  expect(await press(OWNER, 555, notice.body.message_id ?? 0, `sdel:${del.id}:cancel`)).toBe('已取消刪除')
  expect(q(`SELECT status, decided_by FROM secret_deletions WHERE id = ${del.id}`)[0]).toEqual({ status: 'cancelled', decided_by: '555' })
  expect(calls.find(c => c.method === 'editMessageText' && String(c.body.text).startsWith('⚠️ 這則訊息含有 key. 已取消刪除'))!.body.text).toBe('⚠️ 這則訊息含有 key. 已取消刪除, 訊息保留; 不需要時請自己刪掉.')
  // not in the events table, the conversation log, outbound
  for (const [t, c] of [['events', 'update_json'], ['router_log', 'text'], ['outbound', 'payload_json']]) expect(q(`SELECT count(*) n FROM ${t} WHERE CAST(${c} AS TEXT) LIKE '%${KEY1}%'`)[0].n).toBe(0)
  expect(stderr).not.toContain(KEY1)
})

test('/secret set in a DM: its sender, an owner or an admin cancels, another user has no right; in a group /secret set is deleted 10 seconds later with a notice and no button, a refused /router cred add at once', async () => {
  // in a group first: its 10 seconds (and the 10 second check) run while the DM part does
  const g1 = inGroup(USER, `/secret set gk ${SKEY} --http http://127.0.0.1:${api.port}`)
  const g2 = inGroup(OWNER, `/router cred add other ${KEY2} --http http://127.0.0.1:${api.port}`)
  expect((await replyTo(GROUP, g1, '已登記')).body.text).toStartWith('已登記這個對話的密鑰 gk')
  const gNotice = await replyTo(GROUP, g1, '⏳')
  expect(gNotice.body.text).toMatch(/^⏳ 這則訊息含有 key, 10 秒後 \(\d\d:\d\d\) 刪除\.$/)
  expect(gNotice.body.reply_markup).toBeUndefined()
  const gDel = q(`SELECT kind, status, due_at FROM secret_deletions WHERE chat_id = '${GROUP}' AND message_id = ${g1}`)[0]
  expect(gDel).toMatchObject({ kind: 'command', status: 'pending' })
  expect(Math.abs(Date.parse(gDel.due_at) - Date.now() - 10_000)).toBeLessThan(5_000)
  // refused: at once, no notice, nothing scheduled
  await until(() => deleted(GROUP, g2))
  expect((await replyTo(GROUP, g2, '⛔')).body.text).toContain('只能在你自己和 bot 的私訊使用; token 曾出現在群組')
  expect(q(`SELECT count(*) n FROM secret_deletions WHERE chat_id = '${GROUP}' AND message_id = ${g2}`)[0].n).toBe(0)
  expect(config().credentials.other).toBeUndefined()

  const msg = dm(USER, `/secret set mine ${SKEY} --http http://127.0.0.1:${api.port} --default-header x-team:whales`)
  const r = await replyTo(666, msg, '已登記這個對話的密鑰 mine')
  expect(r.body.text).toStartWith(`已登記這個對話的密鑰 mine: http http://127.0.0.1:${api.port}, 預設標頭 x-team: whales, 路徑 全部`)
  const notice = await replyTo(666, msg, '⏳ 這則訊息含有 key')
  expect(notice.body.text).toEndWith('要保留請按「取消刪除」(發訊者本人, owner, admin 能按).')
  const del = q(`SELECT id FROM secret_deletions WHERE message_id = ${msg} AND chat_id = '666'`)[0]
  expect(await press(USER2, 666, 1, `sdel:${del.id}:cancel`)).toBe('沒有權限: 只有發訊者本人, owner, admin 能取消刪除')
  expect(q(`SELECT status FROM secret_deletions WHERE id = ${del.id}`)[0].status).toBe('pending')
  expect(await press(ADMIN, 666, 1, `sdel:${del.id}:cancel`)).toBe('已取消刪除')
  expect(q(`SELECT status, decided_by FROM secret_deletions WHERE id = ${del.id}`)[0]).toEqual({ status: 'cancelled', decided_by: '777' })
  expect(edits(sentId(notice)).at(-1)).toMatch(/^⚠️ 這則訊息含有 key\. \S+ 已取消刪除, 訊息保留; 不需要時請自己刪掉\.$/)
  // the owner too
  const msg2 = dm(USER, `/secret set mine2 ${SKEY} --http http://127.0.0.1:${api.port}`)
  await replyTo(666, msg2, '⏳ 這則訊息含有 key')
  const del2 = q(`SELECT id FROM secret_deletions WHERE message_id = ${msg2} AND chat_id = '666'`)[0]
  expect(await press(OWNER, 666, 1, `sdel:${del2.id}:cancel`)).toBe('已取消刪除')
  expect(q(`SELECT decided_by FROM secret_deletions WHERE id = ${del2.id}`)[0].decided_by).toBe('555')

  // the group one is deleted about 10 seconds after its answer
  await until(() => deleted(GROUP, g1), 25_000)
  await until(() => edits(sentId(gNotice)).length)
  expect(edits(sentId(gNotice))).toEqual(['🗑 已刪除含 key 的登記訊息'])
  expect(q(`SELECT status FROM secret_deletions WHERE chat_id = '${GROUP}' AND message_id = ${g1}`)[0].status).toBe('deleted')
}, 40000)

test('/router cred add of a name that exists: the current settings without the value and 覆蓋 / 取消; only the sender decides; 取消 keeps the old one, 覆蓋 takes this add\'s settings', async () => {
  const msg = dm(OWNER, `/router cred add anthropic ${KEY2} --http http://127.0.0.1:${api.port}/v2`)
  const ask = await replyTo(555, msg, '已經有名為 anthropic 的憑證')
  expect(ask.body.text).toBe([
    '已經有名為 anthropic 的憑證:',
    `anthropic: http http://127.0.0.1:${api.port}, 標頭 x-api-key, 預設標頭 anthropic-version: 2023-06-01, 路徑 /api/*, 角色 owner, admin, 加入者 555`,
    '要用這次的設定整個取代嗎? (新的值只暫存在 router 記憶體 2 分鐘, 逾時或取消就丟棄)',
    '只想換 key, 其他設定不變: /router cred rotate anthropic <新的 key>',
  ].join('\n'))
  expect(ask.body.text).not.toContain(KEY1)
  const [ok, no] = ask.body.reply_markup.inline_keyboard[0]
  expect([ok.text, no.text]).toEqual(['覆蓋', '取消'])
  // still the old one, and the add message is deleted later like any other
  expect(config().credentials.anthropic.token).toBe(KEY1)
  await replyTo(555, msg, '⏳ 這則訊息含有 key')
  const askId = (calls.indexOf(ask) + 900 + 1) // the fake's message_id for that sendMessage
  expect(await press(USER, 555, askId, ok.callback_data)).toBe('只有下指令的人能決定')
  expect(await press(OWNER, 555, askId, no.callback_data)).toBe('已取消')
  expect(edits(askId).at(-1)).toBe('已取消, 沒有覆蓋憑證 anthropic, 新的值已丟棄')
  expect(config().credentials.anthropic.token).toBe(KEY1)
  // pressed again after it is settled: the value is gone
  expect(await press(OWNER, 555, askId, ok.callback_data)).toBe('已逾時或處理過, 新的值已丟棄')
  expect(config().credentials.anthropic.token).toBe(KEY1)

  const again = dm(OWNER, `/router cred add anthropic ${KEY2} --http http://127.0.0.1:${api.port}/v2`)
  const ask2 = await replyTo(555, again, '已經有名為 anthropic 的憑證')
  const ask2Id = calls.indexOf(ask2) + 900 + 1
  expect(await press(OWNER, 555, ask2Id, ask2.body.reply_markup.inline_keyboard[0][0].callback_data)).toBe('已覆蓋')
  expect(edits(ask2Id).at(-1)).toStartWith(`已覆蓋. 已加入憑證 anthropic: http http://127.0.0.1:${api.port}/v2\n路徑: 全部`)
  const c = config().credentials.anthropic
  expect(c).toMatchObject({ token: KEY2, baseUrl: `http://127.0.0.1:${api.port}/v2`, methods: ['*'] })
  expect(c.header).toBeUndefined()
  expect(c.defaultHeaders).toBeUndefined()
})

test('/router cred rotate: only the key changes (URL, header, default headers, paths, roles stay); a bot token is checked with getMe first; a value that is not a bot token is never sent', async () => {
  dm(OWNER, `/router cred add anthropic ${KEY1} --http http://127.0.0.1:${api.port} --header x-api-key /api/*`)
  const ask = await until(() => calls.find(c => c.method === 'sendMessage' && String(c.body.text).startsWith('已經有名為 anthropic') && c.body.text.includes('/v2')))
  expect(await press(OWNER, 555, calls.indexOf(ask) + 901, ask.body.reply_markup.inline_keyboard[0][0].callback_data)).toBe('已覆蓋')
  dm(OWNER, '/router cred roles anthropic owner')
  await until(() => config().credentials.anthropic.roles?.length === 1)
  const msg = dm(OWNER, `/router cred rotate anthropic ${KEY2} --default-header anthropic-version:2023-06-01`)
  const r = await replyTo(555, msg, '已更換憑證 anthropic')
  expect(r.body.text).toBe(`已更換憑證 anthropic 的 key\n其他設定不變: anthropic: http http://127.0.0.1:${api.port}, 標頭 x-api-key, 預設標頭 anthropic-version: 2023-06-01, 路徑 /api/*, 角色 owner, 加入者 555`)
  expect(config().credentials.anthropic).toMatchObject({ token: KEY2, kind: 'http', baseUrl: `http://127.0.0.1:${api.port}`, header: 'x-api-key', methods: ['/api/*'], roles: ['owner'], defaultHeaders: { 'anthropic-version': '2023-06-01' } })
  await replyTo(555, msg, '⏳ 這則訊息含有 key')
  expect(q(`SELECT id FROM events WHERE id = (SELECT event_id FROM secret_deletions WHERE message_id = ${msg})`).length).toBe(1)
  // a bot token credential: getMe with the new token before it is stored
  dm(OWNER, `/router cred add tool ${BOT1} getStickerSet`)
  await until(() => config().credentials.tool)
  const rot = dm(OWNER, `/router cred rotate tool ${BOT2}`)
  expect((await replyTo(555, rot, '已更換憑證 tool')).body.text).toBe('已更換憑證 tool 的 token: @tool2_bot (434343)\n其他設定不變: tool: Telegram bot token @tool2_bot (434343), 方法 getStickerSet, 角色 owner, admin, 加入者 555')
  expect(calls.some(c => c.method === 'getMe' && c.token === BOT2)).toBe(true)
  expect(config().credentials.tool).toMatchObject({ token: BOT2, label: '@tool2_bot (434343)', methods: ['getStickerSet'] })
  const bad = dm(OWNER, `/router cred rotate tool ${KEY1}`)
  expect((await replyTo(555, bad, 'tool 是 Telegram bot token 憑證')).body.text).toContain('沒有更換, 也沒有拿去 Telegram 驗證')
  expect(calls.some(c => c.method === 'getMe' && c.token === KEY1)).toBe(false)
  expect(config().credentials.tool.token).toBe(BOT2)
  // the log line masks the value
  expect(q("SELECT text FROM router_log WHERE conv = 'dm-555'").map(r => r.text).join('\n')).toContain('/router cred rotate anthropic <已遮蔽>')
  for (const [t, c] of [['events', 'update_json'], ['router_log', 'text']]) expect(q(`SELECT count(*) n FROM ${t} WHERE CAST(${c} AS TEXT) LIKE '%${KEY2}%' OR CAST(${c} AS TEXT) LIKE '%${BOT2}%'`)[0].n).toBe(0)
})

test('default headers: http_api adds them unless the worker sends one of that name (any case); /router cred header and /secret header list, set, update, rm without the key; the key header and refused headers cannot be defaults', async () => {
  const owner = worker('dm-555', 21), user = worker('dm-666', 22)
  await until(() => owner.state().kind === 'ready' && user.state().kind === 'ready')
  const sentHeaders = async (w: ReturnType<typeof worker>, args: Record<string, unknown>) => {
    const n = calls.length
    const res = await w.call('http_api', args)
    expect(res.isError).toBeFalsy()
    return calls.slice(n).find(c => c.method.startsWith('http '))!.headers!
  }
  let h = await sentHeaders(owner, { credential: 'anthropic', path: '/api/count', json: {} })
  expect(h['anthropic-version']).toBe('2023-06-01')
  expect(h['x-api-key']).toBe(KEY2)
  h = await sentHeaders(owner, { credential: 'anthropic', path: '/api/count', json: {}, headers: { 'Anthropic-Version': '2099-01-01' } })
  expect(h['anthropic-version']).toBe('2099-01-01')
  // the conversation secret from /secret set --default-header
  h = await sentHeaders(user, { credential: 'mine', path: '/api/x', json: {} })
  expect(h['x-team']).toBe('whales')
  expect(h.authorization).toBe(`Bearer ${SKEY}`)

  const cmd = async (text: string) => { const m = dm(OWNER, text); return String((await until(() => calls.find(c => c.method === 'sendMessage' && c.body.reply_parameters?.message_id === m))).body.text) }
  expect(await cmd('/router cred header anthropic')).toBe('anthropic 的預設標頭: anthropic-version: 2023-06-01')
  expect(await cmd('/router cred header anthropic set anthropic-beta:tools-1')).toBe('anthropic 的預設標頭: anthropic-version: 2023-06-01, anthropic-beta: tools-1')
  expect(await cmd('/router cred header anthropic set Anthropic-Beta:tools-2')).toBe('anthropic 的預設標頭: anthropic-version: 2023-06-01, Anthropic-Beta: tools-2')
  expect(await cmd('/router cred header anthropic set x-api-key:nope')).toBe('預設標頭 x-api-key 是憑證放 key 的地方, 由 router 設定, 不能自己帶')
  expect(await cmd('/router cred header anthropic set Cookie:a=b')).toStartWith('預設標頭 Cookie 不能自己帶')
  expect(await cmd('/router cred header anthropic set content-type:text/plain')).toStartWith('預設標頭 content-type 不能自己帶')
  expect(await cmd('/router cred header anthropic set novalue')).toStartWith('--default-header 後面要接 <名稱>:<值>')
  expect(await cmd('/router cred header anthropic rm anthropic-beta')).toBe('anthropic 的預設標頭: anthropic-version: 2023-06-01')
  expect(await cmd('/router cred header anthropic rm nothing')).toBe('anthropic 沒有預設標頭 nothing')
  expect(await cmd('/router cred header tool set a:b')).toBe('tool 是 Telegram bot token 憑證, 沒有標頭可設')
  expect(await cmd('/router cred list')).toContain('anthropic: http http://127.0.0.1:' + api.port + ', 標頭 x-api-key, 預設標頭 anthropic-version: 2023-06-01, 路徑 /api/*')
  // on add and rotate: refused before anything is stored
  expect(await cmd(`/router cred add z ${KEY1} --http http://127.0.0.1:${api.port} --default-header authorization:x`)).toStartWith('預設標頭 authorization 是憑證放 key 的地方')
  expect(await cmd(`/router cred rotate anthropic ${KEY1} --default-header x-api-key:x`)).toBe('預設標頭 x-api-key 是憑證放 key 的地方, 由 router 設定, 不能自己帶; 沒有更換')
  expect(config().credentials.z).toBeUndefined()
  expect(config().credentials.anthropic.token).toBe(KEY2)

  // /secret header in the user's DM: the conversation secret's default headers, without the key
  const ucmd = async (text: string) => { const m = dm(USER, text); return String((await until(() => calls.find(c => c.method === 'sendMessage' && c.body.reply_parameters?.message_id === m))).body.text) }
  expect(await ucmd('/secret header mine')).toBe('mine 的預設標頭: x-team: whales')
  expect(await ucmd('/secret header mine set x-team:orcas')).toBe('mine 的預設標頭: x-team: orcas')
  expect(await ucmd('/secret header mine set X-Extra:1')).toBe('mine 的預設標頭: x-team: orcas, X-Extra: 1')
  h = await sentHeaders(user, { credential: 'mine', path: '/api/x', json: {} })
  expect(h['x-team']).toBe('orcas')
  expect(h['x-extra']).toBe('1')
  expect(h.authorization).toBe(`Bearer ${SKEY}`)
  expect(await ucmd('/secret header mine rm x-extra')).toBe('mine 的預設標頭: x-team: orcas')
  expect(await ucmd('/secret header mine set authorization:x')).toBe('預設標頭 authorization 是憑證放 key 的地方, 由 router 設定, 不能自己帶')
  expect(await ucmd('/secret header nope')).toBe('這個對話沒有名為 nope 的密鑰')
  h = await sentHeaders(user, { credential: 'mine', path: '/api/x', json: {} })
  expect(h['x-extra']).toBeUndefined()
  expect(h['x-team']).toBe('orcas')
  owner.close(); user.close()
})

test('http_api json_file: sent as the JSON body as it is; owner and admin conversations may name a file outside the folder (router state never), a user conversation only inside it (.., a symlink out refused); over 20 MB, not JSON, or with json is refused and nothing is sent', async () => {
  dm(ADMIN, 'hi')
  // the rotate test left anthropic to owner conversations only
  const roles = dm(OWNER, '/router cred roles anthropic owner,admin')
  await until(() => calls.find(c => c.method === 'sendMessage' && c.body.reply_parameters?.message_id === roles))
  expect(config().credentials.anthropic.roles).toEqual(['owner', 'admin'])
  await until(() => q("SELECT key FROM conversations WHERE key = 'dm-777'")[0])
  expect(q("SELECT role FROM conversations WHERE key = 'dm-777'")[0].role).toBe('admin')
  const owner = worker('dm-555', 31), admin = worker('dm-777', 32), user = worker('dm-666', 33)
  await until(() => owner.state().kind === 'ready' && admin.state().kind === 'ready' && user.state().kind === 'ready')
  const folder = q("SELECT folder FROM conversations WHERE key = 'dm-555'")[0].folder as string
  const userFolder = q("SELECT folder FROM conversations WHERE key = 'dm-666'")[0].folder as string
  mkdirSync(join(folder, 'req'), { recursive: true })
  const body = '{"model":"m","messages":[{"role":"user","content":"' + 'whale '.repeat(1000) + '"}]}'
  writeFileSync(join(folder, 'req', 'count.json'), body)
  const call = (args: Record<string, unknown>, w = owner) => w.call('http_api', { credential: 'anthropic', path: '/api/count_tokens', ...args })
  let n = calls.length
  let res = await call({ json_file: 'req/count.json' })
  expect(res.isError).toBeFalsy()
  let got = calls.slice(n).find(c => c.method === 'http /api/count_tokens')!
  expect(got.raw).toBe(body)
  expect(got.headers!['content-type']).toBe('application/json')
  expect(got.headers!['anthropic-version']).toBe('2023-06-01')
  n = calls.length
  res = await call({ json_file: join(folder, 'req', 'count.json') })
  expect(res.isError).toBeFalsy()
  expect(calls.slice(n).find(c => c.method === 'http /api/count_tokens')!.raw).toBe(body)
  // logged with the path and size, not the content
  const logged = q("SELECT payload_json FROM outbound WHERE bot = 'cred:anthropic' AND method = 'POST /api/count_tokens' ORDER BY id DESC LIMIT 1")[0].payload_json
  expect(JSON.parse(logged).json_file).toEqual({ path: join(folder, 'req', 'count.json'), bytes: body.length })

  const refused = async (args: Record<string, unknown>, w = owner, cred = 'anthropic') => {
    const before = calls.filter(c => c.method.startsWith('http ')).length
    const r = await w.call('http_api', { credential: cred, path: '/api/count_tokens', ...args })
    expect(r.isError).toBe(true)
    expect(calls.filter(c => c.method.startsWith('http ')).length).toBe(before)
    return r.content[0]!.text
  }
  const sentRaw = async (args: Record<string, unknown>, w: ReturnType<typeof worker>, cred = 'anthropic') => {
    const m = calls.length
    const r = await w.call('http_api', { credential: cred, path: '/api/count_tokens', ...args })
    expect(r.isError ? r.content[0]!.text : '').toBe('')
    return calls.slice(m).find(c => c.method === 'http /api/count_tokens')!.raw
  }
  // outside the folder: owner and admin (relative, absolute, through a symlink); router state never
  writeFileSync(join(dir, 'outside.json'), '{"outside":1}')
  symlinkSync(join(dir, 'outside.json'), join(folder, 'link.json'))
  expect(await sentRaw({ json_file: join(dir, 'outside.json') }, owner)).toBe('{"outside":1}')
  expect(await sentRaw({ json_file: 'link.json' }, owner)).toBe('{"outside":1}')
  expect(await sentRaw({ json_file: join(dir, 'outside.json') }, admin)).toBe('{"outside":1}')
  expect(await sentRaw({ json_file: join(folder, 'req', 'count.json') }, admin)).toBe(body)
  expect(await refused({ json_file: join(state, 'config.json') })).toBe(`json_file ${join(state, 'config.json')} 在 router 的狀態目錄裡, 不能送出`)
  expect(await refused({ json_file: join(state, 'config.json') }, admin)).toBe(`json_file ${join(state, 'config.json')} 在 router 的狀態目錄裡, 不能送出`)
  symlinkSync(join(state, 'config.json'), join(folder, 'cfg.json'))
  expect(await refused({ json_file: 'cfg.json' })).toBe('json_file cfg.json 在 router 的狀態目錄裡, 不能送出')
  // a user conversation (its own secret mine): only inside its folder
  writeFileSync(join(userFolder, 'mine.json'), '{"mine":1}')
  symlinkSync(join(dir, 'outside.json'), join(userFolder, 'link.json'))
  expect(await sentRaw({ json_file: 'mine.json' }, user, 'mine')).toBe('{"mine":1}')
  expect(await refused({ json_file: join(dir, 'outside.json') }, user, 'mine')).toBe(`json_file ${join(dir, 'outside.json')} 要在這個對話的資料夾裡`)
  expect(await refused({ json_file: '../../outside.json' }, user, 'mine')).toBe('json_file ../../outside.json 要在這個對話的資料夾裡')
  expect(await refused({ json_file: 'link.json' }, user, 'mine')).toBe('json_file link.json 要在這個對話的資料夾裡')
  expect(await refused({ json_file: join(folder, 'req', 'count.json') }, user, 'mine')).toBe(`json_file ${join(folder, 'req', 'count.json')} 要在這個對話的資料夾裡`)
  expect(await refused({ json_file: 'nope.json' })).toBe('找不到 json_file nope.json')
  writeFileSync(join(folder, 'big.json'), '')
  truncateSync(join(folder, 'big.json'), 20 * 1024 * 1024 + 1)
  expect(await refused({ json_file: 'big.json' })).toBe(`json_file big.json 有 ${20 * 1024 * 1024 + 1} bytes, 超過上限 20971520 bytes (20 MB)`)
  writeFileSync(join(folder, 'bad.json'), '{"a": 1,}')
  expect(await refused({ json_file: 'bad.json' })).toStartWith('json_file bad.json 不是合法的 JSON (')
  expect(await refused({ json_file: 'bad.json' })).toEndWith('), 沒有送出')
  expect(await refused({ json_file: 'req/count.json', json: {} })).toBe('json_file 與 json, form, files 只能擇一: 請求內容只能有一種')
  expect(await refused({ json_file: 'req/count.json', form: { a: 1 } })).toBe('json_file 與 json, form, files 只能擇一: 請求內容只能有一種')
  expect(await refused({ json_file: 'req' })).toBe('json_file req 不是檔案')
  owner.close(); admin.close(); user.close()
}, 30000)
