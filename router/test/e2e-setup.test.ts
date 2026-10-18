// First run of a bot, end to end (plan 03 初次設定, 審核頻道): the real router
// against a fake Bot API, starting with no owner. Keep in sync with those
// sections and docs/operations.md 「新 bot 初次設定與審核群組」.
//   claim code -> owner; persona interview (<bootstrap>, save_bot_profile)
//   -> <home>/bot<id>/CLAUDE.md, read by every conversation of the bot;
//   approvals group checks and topics; skip button. Also install_skill and
//   skill_check and skill_try through the router (docs/credentials-and-skills.md
//   技能範圍, 檢查技能草稿, 試跑技能草稿).

import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { connectRouter } from '../../plugin/client'

const dir = mkdtempSync(join(tmpdir(), 'cctr-setup-'))
const state = join(dir, '.router')
mkdirSync(state)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const calls: Array<{ method: string; body: any; token?: string }> = []
const updates: unknown[] = []
const now = Math.floor(Date.now() / 1000)
let forum = { type: 'group', is_forum: false }
let member: Record<string, unknown> = { status: 'member' }
let topic = 40
const api = Bun.serve({
  port: 0,
  async fetch(req) {
    const parts = new URL(req.url).pathname.split('/')
    const method = parts.pop()!, token = parts.pop()!.replace(/^bot/, '')
    const type = req.headers.get('content-type') ?? ''
    const body = type.includes('json') ? await req.json() : type.includes('multipart') ? Object.fromEntries([...(await req.formData()).entries()].map(([k, v]) => [k, typeof v === 'string' ? v : `<file ${v.size}>`])) : {}
    calls.push({ method, body, token })
    // a stand-in for an HTTP API credential (http_api): OpenAI-like image generation
    // an API that echoes the request (httpbin /anything): its answer carries the key back
    if (new URL(req.url).pathname.startsWith('/v1/echo')) return Response.json({ headers: { Authorization: req.headers.get('authorization') } })
    // an Anthropic-like API (docs/credentials-and-skills.md 「http 憑證的 key 放哪裡」): every header and the query as received
    if (new URL(req.url).pathname.startsWith('/x/')) { calls.push({ method: `http ${new URL(req.url).pathname}`, body: { search: new URL(req.url).search, headers: Object.fromEntries(req.headers) } }); return Response.json({ id: 'msg_1', echo: new URL(req.url).search }) }
    if (new URL(req.url).pathname.startsWith('/v1/')) { calls.push({ method: `http ${new URL(req.url).pathname}`, body: { auth: req.headers.get('authorization') } }); return Response.json({ data: [{ b64_json: Buffer.from('PNGDATA').toString('base64') }] }) }
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

test('persona interview: owner DMs carry <bootstrap> until save_bot_profile; the persona goes to the bot folder CLAUDE.md, the other workers rotate, the group guide follows', async () => {
  const delivered: string[] = []
  dm(OWNER, '嗨')
  await until(() => q("SELECT key FROM conversations WHERE key = 'dm-555'")[0])
  const client = connectRouter({
    socketPath: join(state, 'router.sock'), hello: { t: 'hello', project_dir: join(dir, 'bot123', 'dm-555'), pid: 1 },
    onMessage(m) { if (m.t === 'deliver') { delivered.push(m.params.content); client.send({ t: 'ack', qid: m.qid }) } },
  })
  const first = await until(() => delivered.find(d => d.endsWith('\n嗨')))
  expect(first).toContain('<bootstrap>')
  expect(first).toContain('呼叫 save_bot_profile')
  const before = delivered.length
  // only the owner's DM may save it
  dm({ id: 666, is_bot: false, first_name: 'U', username: 'u' }, 'hello')
  await until(() => q("SELECT key FROM conversations WHERE key = 'dm-666'")[0])
  const other = connectRouter({ socketPath: join(state, 'router.sock'), hello: { t: 'hello', project_dir: join(dir, 'bot123', 'dm-666'), pid: 2 }, onMessage(m) { if (m.t === 'deliver') other.send({ t: 'ack', qid: m.qid }) } })
  await until(() => other.state().kind === 'ready')
  expect((await other.call('save_bot_profile', { name: 'x', persona: 'y' })).isError).toBe(true)
  const r = await client.call('save_bot_profile', { name: '小鯨', persona: '你是小鯨, 沉穩簡潔, 用台灣中文.' })
  expect(r.isError).toBeFalsy()
  expect(q("SELECT persona_done FROM bot_setup WHERE bot = 'new'")[0]).toEqual({ persona_done: 1 })
  const md = readFileSync(join(dir, 'bot123', 'CLAUDE.md'), 'utf8')
  expect(md).toStartWith('# 小鯨 的人設')
  expect(md).toContain('你是小鯨, 沉穩簡潔, 用台灣中文.')
  // conversation folders sit under the bot folder, so Claude Code reads it there
  expect(q("SELECT folder FROM conversations WHERE key = 'dm-666'")[0].folder).toBe(join(dir, 'bot123', 'dm-666'))
  await until(() => stderr.includes(`persona saved to ${join(dir, 'bot123')}/CLAUDE.md, 1 other worker(s) marked for rotation`))
  const guide = await until(() => sentTo(555, '最後一步: 設定審核群組')[0])
  expect(guide.body.reply_markup.inline_keyboard[0][0].callback_data).toBe('setup:new:skip')
  dm(OWNER, '好了嗎')
  // nothing in front of it any more: no <bootstrap>, and the persona is CLAUDE.md, not chat_context
  await until(() => delivered.slice(before).includes('好了嗎'))
  client.close(); other.close()
}, 20000)

test('approvals group: refused until it is a supergroup with topics and the bot may manage them; then six topics are made (🔑 密鑰偵測 too, plan 10e; 🤝 配對申請) and notices go there', async () => {
  inGroup('/router setup group')
  await until(() => sentTo(-100900, '⛔ 審核群組必須是 supergroup').length === 1)
  forum = { type: 'supergroup', is_forum: false }
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
  expect(calls.filter(c => c.method === 'createForumTopic').map(c => c.body.name)).toEqual(['🔔 重要通知', '🔐 權限審核', '📜 提權紀錄', '🧾 執行授權', '🔑 密鑰偵測', '🤝 配對申請'])
  expect(q("SELECT approvals_chat, notices_topic, approvals_topic, elevlog_topic, authuse_topic, secret_topic, pairing_topic, group_skipped FROM bot_setup WHERE bot = 'new'")[0]).toEqual({ approvals_chat: '-100900', notices_topic: 41, approvals_topic: 42, elevlog_topic: 43, authuse_topic: 44, secret_topic: 45, pairing_topic: 46, group_skipped: 0 })
  expect(sentTo(-100900, '配對申請: ')[0]!.body.message_thread_id).toBe(46)
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
  expect(calls.filter(c => c.method === 'createForumTopic')).toHaveLength(6)
}, 20000)

test('a decision on a request: the turn it starts shows progress as a reply to the message that asked, and mirrored in the approvals topic under the pressed request', async () => {
  const U = { id: 666, is_bot: false, first_name: 'U', username: 'u' }
  const askId = mid
  dm(U, '請幫我送訊息到 -100777')
  const worker = connectRouter({ socketPath: join(state, 'router.sock'), hello: { t: 'hello', project_dir: join(dir, 'bot123', 'dm-666'), pid: 21 }, onMessage(m) { if (m.t === 'deliver') worker.send({ t: 'ack', qid: m.qid }) } })
  await until(() => worker.state().kind === 'ready')
  await until(() => q(`SELECT count(*) n FROM queue WHERE conv = 'dm-666' AND status = 'acked' AND params LIKE '%-100777%'`)[0].n === 1)
  const r = await worker.call('request_send_grant', { chat_id: '-100777', mode: 'owner', reason: 'test' })
  const gid = Number(/#(\d+)/.exec(r.content[0]!.text)![1])
  const req = await until(() => calls.find(c => c.method === 'sendMessage' && String(c.body.text).startsWith(`🔐 跨對話傳訊申請 #${gid}`)))
  expect(req.body.message_thread_id).toBe(42)
  const reqMsgId = 900 + calls.indexOf(req) + 1
  updates.push({ update_id: mid, callback_query: { id: `cb${mid++}`, from: OWNER, chat_instance: 'x', data: `grant:${gid}:once`, message: { message_id: reqMsgId, message_thread_id: 42, is_topic_message: true, date: now, chat: { id: -100900, type: 'supergroup', is_forum: true }, text: req.body.text } } })
  await until(() => q(`SELECT status FROM grants WHERE id = ${gid}`)[0].status === 'approved')
  // the worker's next turn (the router notice) starts: what its hook reports
  const hook = Bun.spawn(['bun', join(import.meta.dir, '..', '..', 'hooks', 'hook.ts'), 'progress', 'prompt'], {
    stdin: new Blob([JSON.stringify({ prompt: '<channel source="plugin:telegram:telegram" chat_id="666" user="router"><router_status>…</router_status></channel>' })]),
    env: { ...process.env, XDG_RUNTIME_DIR: state, CC_TELEGRAM_ROUTER_SOCKET: join(state, 'router.sock'), CLAUDE_PROJECT_DIR: join(dir, 'bot123', 'dm-666') },
  })
  await hook.exited
  const own = await until(() => calls.find(c => c.method === 'sendMessage' && Number(c.body.chat_id) === 666 && c.body.text === '🤔 思考中…'))
  expect(own.body.reply_parameters.message_id).toBe(askId)
  const mirror = await until(() => calls.find(c => c.method === 'sendMessage' && Number(c.body.chat_id) === -100900 && String(c.body.text).includes('🤔 思考中…')))
  expect(mirror.body).toMatchObject({ message_thread_id: 42, reply_parameters: { message_id: reqMsgId } })
  expect(mirror.body.text).toStartWith('↪ @u:U (dm-666) 收到結果, 處理中:')
  worker.close()
}, 30000)

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

test('credentials end to end: cred-import moves a token from a file into config without printing it, the router reloads, bot_api calls the API with it for an owner conversation only', async () => {
  const CRED = '777:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
  writeFileSync(join(dir, 'old.env'), `OTHER=x\nEAGLE_TOKEN=${CRED}\n`)
  const p = Bun.spawn(['bun', join(import.meta.dir, '..', 'main.ts'), '--config', join(state, 'config.json'), 'cred-import', 'eagle', join(dir, 'old.env'), 'EAGLE_TOKEN', 'addStickerToSet,getStickerSet'], { stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(p.stdout).text()
  expect(await p.exited).toBe(0)
  expect(out).toContain('已存入憑證 eagle: @new_bot (1), 方法 addStickerToSet, getStickerSet')
  expect(out).toContain('已重新讀取 1 個憑證')
  expect(out).not.toContain(CRED.split(':')[1]!)
  expect(JSON.parse(readFileSync(join(state, 'config.json'), 'utf8')).credentials.eagle).toMatchObject({ token: CRED, roles: ['owner', 'admin'], addedBy: 'terminal' })
  const owner = connectRouter({ socketPath: join(state, 'router.sock'), hello: { t: 'hello', project_dir: join(dir, 'bot123', 'dm-555'), pid: 7 }, onMessage(m) { if (m.t === 'deliver') owner.send({ t: 'ack', qid: m.qid }) } })
  const user = connectRouter({ socketPath: join(state, 'router.sock'), hello: { t: 'hello', project_dir: join(dir, 'bot123', 'dm-666'), pid: 8 }, onMessage(m) { if (m.t === 'deliver') user.send({ t: 'ack', qid: m.qid }) } })
  await until(() => owner.state().kind === 'ready' && user.state().kind === 'ready')
  writeFileSync(join(dir, 'bot123', 'dm-555', 's.webp'), 'WEBP')
  const r = await owner.call('bot_api', { credential: 'eagle', method: 'addStickerToSet', params: { user_id: 555, name: 'set_by_x', sticker: { sticker: 'attach://file', emoji_list: ['🐳'], format: 'static' } }, files: { file: join(dir, 'bot123', 'dm-555', 's.webp') } })
  expect(r.isError).toBeFalsy()
  const hit = calls.find(c => c.method === 'addStickerToSet')!
  expect(hit.token).toBe(CRED)
  expect(hit.body).toMatchObject({ name: 'set_by_x', file: '<file 4>' })
  expect(q("SELECT bot, conv FROM outbound WHERE method = 'addStickerToSet'")[0]).toEqual({ bot: 'cred:eagle', conv: 'dm-555' })
  expect((await owner.call('bot_api', { credential: 'eagle', method: 'sendMessage', params: {} })).content[0]!.text).toContain('沒有開放 sendMessage')
  // router state (config.json holds the tokens) can never be uploaded, not even by an owner conversation
  const leak = await owner.call('bot_api', { credential: 'eagle', method: 'getStickerSet', params: {}, files: { f: join(state, 'config.json') } })
  expect(leak.content[0]!.text).toStartWith('refusing to send router state')
  // the role is the only problem: refused like any block, with the elevation advice, and logged
  const low = (await user.call('bot_api', { credential: 'eagle', method: 'getStickerSet', params: {} })).content[0]!.text
  expect(low).toStartWith('權限不足 (本對話角色 user): 憑證 eagle 只開放 owner, admin 角色的對話使用, 這個對話是 user.')
  expect(low).toContain('request_elevation')
  expect(q("SELECT kind FROM elev_log WHERE conv = 'dm-666'").map((r: any) => r.kind)).toContain('blocked')
  owner.close(); user.close()
}, 30000)

test('http credentials end to end: cred-import --http stores an API key; http_api calls it with the key in a header and saves the base64 image into the conversation folder', async () => {
  writeFileSync(join(dir, 'openai.env'), 'OPENAI_API_KEY=sk-test-123\n')
  const p = Bun.spawn(['bun', join(import.meta.dir, '..', 'main.ts'), '--config', join(state, 'config.json'), 'cred-import', 'openai', join(dir, 'openai.env'), 'OPENAI_API_KEY', '/v1/images/generations,/v1/echo', '--http', `http://127.0.0.1:${api.port}`], { stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(p.stdout).text()
  expect(await p.exited).toBe(0)
  expect(out).toContain(`已存入憑證 openai: http http://127.0.0.1:${api.port}, 路徑 /v1/images/generations, /v1/echo`)
  expect(out).not.toContain('sk-test-123')
  const owner = connectRouter({ socketPath: join(state, 'router.sock'), hello: { t: 'hello', project_dir: join(dir, 'bot123', 'dm-555'), pid: 31 }, onMessage(m) { if (m.t === 'deliver') owner.send({ t: 'ack', qid: m.qid }) } })
  await until(() => owner.state().kind === 'ready')
  const r = await owner.call('http_api', { credential: 'openai', path: '/v1/images/generations', json: { prompt: 'whale' }, save_b64: { at: 'data.0.b64_json', to: 'stickers/raw.png' } })
  expect(r.isError).toBeFalsy()
  expect(JSON.parse(r.content[0]!.text)).toEqual({ status: 200, body: { saved: join(dir, 'bot123', 'dm-555', 'stickers', 'raw.png'), bytes: 7, response: { data: [{ b64_json: '<已存檔, 7 bytes>' }] } } })
  expect(readFileSync(join(dir, 'bot123', 'dm-555', 'stickers', 'raw.png'), 'utf8')).toBe('PNGDATA')
  expect(calls.find(c => c.method === 'http /v1/images/generations')!.body.auth).toBe('Bearer sk-test-123')
  // an echoed key is scrubbed before the worker sees the response
  const echo = (await owner.call('http_api', { credential: 'openai', method: 'GET', path: '/v1/echo' })).content[0]!.text
  expect(echo).not.toContain('sk-test-123')
  expect(JSON.parse(echo)).toEqual({ status: 200, body: { headers: { Authorization: 'Bearer <密鑰>' } } })
  expect((await owner.call('http_api', { credential: 'openai', path: '/v1/chat/completions', json: {} })).content[0]!.text).toContain('沒有開放 /v1/chat/completions')
  expect((await owner.call('http_api', { credential: 'openai', path: '/v1/images/generations', json: {}, save_b64: { at: 'data.0.b64_json', to: '/etc/x.png' } })).content[0]!.text).toBe('save_b64.to 要在這個對話的資料夾裡 (不能是 .chat)')
  owner.close()
}, 30000)


test('API keys without --http are never sent to getMe (/router cred add and cred-import); --header puts the key in that header only, worker headers pass through (x-csrf-token too), the key header, Authorization, Cookie and transport headers are refused; --query puts it in the URL; no paths means every path', async () => {
  const KEY = 'sk-ant-TESTxxxxxxxxxxxxxxxxxxxx'
  const base = `http://127.0.0.1:${api.port}/x`
  const getMes = () => calls.filter(c => c.method === 'getMe' && c.token === KEY).length
  // a DM from the owner without --http: a hint, the message deleted later, no getMe with the key
  const msg = mid++
  updates.push({ update_id: msg, message: { message_id: msg, date: now, chat: { id: 555, type: 'private' }, from: OWNER, text: `/router cred add anthropic ${KEY}`, entities: [{ type: 'bot_command', offset: 0, length: 7 }] } })
  const hint = await until(() => sentTo(555, '這看起來不是 Telegram bot token')[0])
  expect(hint.body.text).toContain('像是 Anthropic API key')
  expect(hint.body.text).toContain('/router cred add anthropic <key> --http https://api.anthropic.com --header x-api-key')
  expect(hint.body.text).not.toContain(KEY)
  // deleted 60 seconds later unless the sender, an owner or an admin cancels (router/rawvault.ts scheduleCommand)
  await until(() => q(`SELECT kind FROM secret_deletions WHERE message_id = ${msg} AND status = 'pending'`)[0]?.kind === 'command')
  expect(getMes()).toBe(0)
  // cred-import of the same key without --http: refused in the terminal, no getMe either
  writeFileSync(join(dir, 'anthropic.env'), `ANTHROPIC_API_KEY=${KEY}\n`)
  const imp = Bun.spawn(['bun', join(import.meta.dir, '..', 'main.ts'), '--config', join(state, 'config.json'), 'cred-import', 'anthropic', join(dir, 'anthropic.env'), 'ANTHROPIC_API_KEY'], { stdout: 'pipe', stderr: 'pipe' })
  const err = await new Response(imp.stderr).text()
  expect(await imp.exited).toBe(1)
  expect(err).toContain('看起來不是 Telegram bot token (像是 Anthropic API key), 沒有存入')
  expect(err).not.toContain(KEY)
  expect(getMes()).toBe(0)
  // with --http and --header x-api-key, no paths: stored with every path
  const msg2 = mid++
  updates.push({ update_id: msg2, message: { message_id: msg2, date: now, chat: { id: 555, type: 'private' }, from: OWNER, text: `/router cred add anthropic ${KEY} --http ${base} --header x-api-key`, entities: [{ type: 'bot_command', offset: 0, length: 7 }] } })
  const added = await until(() => sentTo(555, '已加入憑證 anthropic')[0])
  expect(added.body.text).toStartWith(`已加入憑證 anthropic: http ${base}, 標頭 x-api-key\n路徑: 全部`)
  expect(JSON.parse(readFileSync(join(state, 'config.json'), 'utf8')).credentials.anthropic).toMatchObject({ kind: 'http', baseUrl: base, header: 'x-api-key', scheme: '', methods: ['*'] })
  expect(getMes()).toBe(0)
  const owner = connectRouter({ socketPath: join(state, 'router.sock'), hello: { t: 'hello', project_dir: join(dir, 'bot123', 'dm-555'), pid: 71 }, onMessage(m) { if (m.t === 'deliver') owner.send({ t: 'ack', qid: m.qid }) } })
  await until(() => owner.state().kind === 'ready')
  const r = await owner.call('http_api', { credential: 'anthropic', path: '/v1/messages', json: { model: 'm' }, headers: { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'b1' } })
  expect(r.isError).toBeFalsy()
  const got = calls.filter(c => c.method === 'http /x/v1/messages').at(-1)!.body
  expect(got.headers['x-api-key']).toBe(KEY)
  expect(got.headers['anthropic-version']).toBe('2023-06-01')
  expect(got.headers['anthropic-beta']).toBe('b1')
  // not auth for the router: passed on as they are
  await owner.call('http_api', { credential: 'anthropic', path: '/v1/messages', json: {}, headers: { 'x-csrf-token': 'c1', 'X-Auth-Token': 't1' } })
  const more = calls.filter(c => c.method === 'http /x/v1/messages').at(-1)!.body.headers
  expect([more['x-csrf-token'], more['x-auth-token'], more['x-api-key']]).toEqual(['c1', 't1', KEY])
  expect(got.headers.authorization).toBeUndefined()
  expect(got.search).toBe('')
  // the key is nowhere else in the request
  expect(Object.entries(got.headers).filter(([, v]) => String(v).includes(KEY)).map(([k]) => k)).toEqual(['x-api-key'])
  // the key's header, Authorization, Cookie and transport headers from the worker are refused before anything is sent
  const sentHttp = () => calls.filter(c => c.method.startsWith('http ')).length
  const n = sentHttp()
  for (const h of ['Authorization', 'X-Api-Key', 'Cookie', 'Proxy-Authorization', 'Host']) {
    const bad = await owner.call('http_api', { credential: 'anthropic', path: '/v1/messages', json: {}, headers: { [h]: 'other' } })
    expect(bad.isError).toBe(true)
    expect(bad.content[0]!.text).toContain(`標頭 ${h}`)
  }
  expect(sentHttp()).toBe(n)
  // --query: the key in the URL, no auth header; an echoed key comes back masked
  const msg3 = mid++
  updates.push({ update_id: msg3, message: { message_id: msg3, date: now, chat: { id: 555, type: 'private' }, from: OWNER, text: `/router cred add gq ${KEY} --http ${base} --query key /v1/*`, entities: [{ type: 'bot_command', offset: 0, length: 7 }] } })
  await until(() => sentTo(555, '已加入憑證 gq')[0])
  const qr = await owner.call('http_api', { credential: 'gq', method: 'GET', path: '/v1/models?page=2' })
  const qgot = calls.filter(c => c.method === 'http /x/v1/models').at(-1)!.body
  expect(new URLSearchParams(qgot.search).get('key')).toBe(KEY)
  expect(new URLSearchParams(qgot.search).get('page')).toBe('2')
  expect(qgot.headers.authorization).toBeUndefined()
  expect(qr.content[0]!.text).not.toContain(KEY)
  expect(JSON.parse(qr.content[0]!.text).body.echo).toContain('key=<密鑰>')
  expect((await owner.call('http_api', { credential: 'gq', method: 'GET', path: '/v2/models' })).content[0]!.text).toContain('沒有開放 /v2/models')
  const before = sentHttp()
  expect((await owner.call('http_api', { credential: 'gq', method: 'GET', path: '/v1/models?key=other' })).content[0]!.text).toBe('query 參數 key 是憑證放 key 的地方, 由 router 設定, path 裡不能自己帶')
  expect(sentHttp()).toBe(before)
  owner.close()
}, 30000)

test('install_skill end to end: from <folder>/skills into the conversation\'s own .claude/skills (owner here); a user conversation is refused like any block, with the elevation advice, and logged', async () => {
  const owner = connectRouter({ socketPath: join(state, 'router.sock'), hello: { t: 'hello', project_dir: join(dir, 'bot123', 'dm-555'), pid: 51 }, onMessage(m) { if (m.t === 'deliver') owner.send({ t: 'ack', qid: m.qid }) } })
  const user = connectRouter({ socketPath: join(state, 'router.sock'), hello: { t: 'hello', project_dir: join(dir, 'bot123', 'dm-666'), pid: 52 }, onMessage(m) { if (m.t === 'deliver') user.send({ t: 'ack', qid: m.qid }) } })
  await until(() => owner.state().kind === 'ready' && user.state().kind === 'ready')
  for (const c of ['dm-555', 'dm-666']) { mkdirSync(join(dir, 'bot123', c, 'skills', 'hello'), { recursive: true }); writeFileSync(join(dir, 'bot123', c, 'skills', 'hello', 'SKILL.md'), '---\nname: hello\n---\n') }
  const r = await owner.call('install_skill', { name: 'hello', scope: 'conversation' })
  expect(r.isError).toBeFalsy()
  expect(r.content[0]!.text).toStartWith(`已安裝到 ${join(dir, 'bot123', 'dm-555', '.claude', 'skills', 'hello')} (只有這個對話)`)
  expect(readFileSync(join(dir, 'bot123', 'dm-555', '.claude', 'skills', 'hello', 'SKILL.md'), 'utf8')).toBe('---\nname: hello\n---\n')
  const low = (await user.call('install_skill', { name: 'hello', scope: 'conversation' })).content[0]!.text
  expect(low).toStartWith('權限不足 (本對話角色 user): 只有 power 以上的對話能安裝這個對話自己的技能, 這個對話是 user.')
  expect(low).toContain('request_elevation')
  expect(existsSync(join(dir, 'bot123', 'dm-666', '.claude', 'skills', 'hello'))).toBe(false)
  expect(q("SELECT kind FROM elev_log WHERE conv = 'dm-666' AND text LIKE '%install_skill%'").length).toBeGreaterThan(0)
  owner.close(); user.close()
}, 30000)

test('skill_check end to end: a user conversation checks its draft (nothing installed, nothing run), skill_try refuses it; guest is refused (docs/credentials-and-skills.md 「檢查技能草稿」)', async () => {
  const user = connectRouter({ socketPath: join(state, 'router.sock'), hello: { t: 'hello', project_dir: join(dir, 'bot123', 'dm-666'), pid: 53 }, onMessage(m) { if (m.t === 'deliver') user.send({ t: 'ack', qid: m.qid }) } })
  await until(() => user.state().kind === 'ready')
  const skill = join(dir, 'bot123', 'dm-666', 'skills', 'notes')
  mkdirSync(join(skill, 'scripts'), { recursive: true })
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: notes\ndescription: 測試用\n---\n')
  writeFileSync(join(skill, 'scripts', 'n.sh'), 'echo hi\n')
  writeFileSync(join(skill, 'privileged.json'), JSON.stringify({ actions: { add: { run: ['bash', 'scripts/n.sh', '{text}'], args: { text: { pattern: '.{1,50}' } }, store: { NOTES: 'notes' } } } }))
  const r = await user.call('skill_check', { path: 'skills/notes' })
  expect(r.isError).toBeFalsy()
  expect(r.content[0]!.text).toStartWith('skill check: ok')
  expect(r.content[0]!.text).toContain('add: bash scripts/n.sh {text}; 角色 owner, admin, power, user; 資料庫 notes (append)')
  expect(r.content[0]!.text).toContain('下一步: user 角色現在還不能安裝技能')
  expect((await user.call('skill_check', { path: '../dm-555' })).content[0]!.text).toContain('不在這個對話的資料夾裡')
  // skill_try: power and up only, a user conversation waits for phase 2 (docs/credentials-and-skills.md 「試跑技能草稿」)
  const t = await user.call('skill_try', { path: 'skills/notes', action: 'add', args: { text: 'x' } })
  expect(t.isError).toBe(true)
  expect(t.content[0]!.text).toStartWith('skill try: refused\nskill_try 只開放 power 以上的對話 (這個對話是 user)')
  expect(existsSync(join(dir, 'bot123', 'dm-666', 'skill-try'))).toBe(false)
  dm(OWNER, '/router role 666 guest')
  await until(() => q("SELECT role FROM conversations WHERE key = 'dm-666'")[0]?.role === 'guest')
  const g = await user.call('skill_check', { path: 'skills/notes' })
  expect(g.isError).toBe(true)
  expect(g.content[0]!.text).toBe('guest 角色的對話不能寫檔, 也就沒有技能可以檢查')
  dm(OWNER, '/router role 666 none')
  await until(() => q("SELECT role FROM conversations WHERE key = 'dm-666'")[0]?.role === 'user')
  user.close()
}, 30000)

test('bot_api "self": owner and admin conversations call any Bot API method as their own bot; others are refused; methods that would break the router are blocked', async () => {
  const owner = connectRouter({ socketPath: join(state, 'router.sock'), hello: { t: 'hello', project_dir: join(dir, 'bot123', 'dm-555'), pid: 41 }, onMessage(m) { if (m.t === 'deliver') owner.send({ t: 'ack', qid: m.qid }) } })
  const user = connectRouter({ socketPath: join(state, 'router.sock'), hello: { t: 'hello', project_dir: join(dir, 'bot123', 'dm-666'), pid: 42 }, onMessage(m) { if (m.t === 'deliver') user.send({ t: 'ack', qid: m.qid }) } })
  await until(() => owner.state().kind === 'ready' && user.state().kind === 'ready')
  const r = await owner.call('bot_api', { credential: 'self', method: 'deleteMessage', params: { chat_id: 555, message_id: 157192 } })
  expect(r.isError).toBeFalsy()
  const hit = calls.filter(c => c.method === 'deleteMessage').at(-1)!
  expect(hit.token).toBe('123:test')
  expect(hit.body).toEqual({ chat_id: 555, message_id: 157192 })
  expect(q("SELECT bot, conv FROM outbound WHERE method = 'deleteMessage' ORDER BY id DESC LIMIT 1")[0]).toEqual({ bot: 'new', conv: 'dm-555' })
  expect((await owner.call('bot_api', { credential: 'new', method: 'getChat', params: { chat_id: 555 } })).isError).toBeFalsy() // the bot's own name works too
  expect((await owner.call('bot_api', { credential: 'self', method: 'getUpdates', params: {} })).content[0]!.text).toBe('getUpdates 會讓 router 收不到訊息或讓 bot 登出, 不開放')
  expect((await user.call('bot_api', { credential: 'self', method: 'deleteMessage', params: {} })).content[0]!.text).toStartWith('權限不足 (本對話角色 user): 只有 owner 與 admin 的對話能用這隻 bot 自己的 token, 這個對話是 user.')
  owner.close(); user.close()
}, 30000)
