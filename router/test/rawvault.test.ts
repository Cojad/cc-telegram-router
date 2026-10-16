// Plan 10e 原始事件完整保存與密鑰保護, module level: detection (known
// formats, command values, held values, no entropy guessing), events masked
// with the original sealed in event_raw (bound to the event id), markers for
// the worker, the 🔑 密鑰偵測 record, reminder and deletion in 5 minutes
// (cancel by sender, owner, admin; survives a restart), event_raw (role,
// handles, the fixed agent, the exit check, haiku refused), secret_from_handle,
// cli event raw (600 file), /secret handles|revoke, /router secret
// handles|revoke, /router event raw; text attachments scanned when a worker
// downloads them; the fixed agent's language rule. Keep in sync with README 「原始事件與密鑰保護」
// and /telegram:doc; end to end in e2e-rawvault.test.ts.
// Every token here is fake and built at runtime (no token-shaped literal in the repo).

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, statSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openRouterDb, type RouterDb, type Conversation } from '../db'
import { newSecretKey, sealRaw, openRaw, openSecret, runSecretCommand, type SecretDeps } from '../secrets'
import { detectSecrets, scanUpdate, ownFindings, workerMarker, CMD_KIND, KNOWN_KIND } from '../detect'
import { createVault, claudeAsk, isTextAttachment, RAW_SYSTEM, DELETE_AFTER_MS, MAX_TEXT_ATTACHMENT, type VaultApi, type VaultDeps } from '../rawvault'
import { runCommand, type CommandDeps } from '../commands'
import type { Access } from '../telegram/policy'
import type { ApprovalDeps } from '../approvals'

const OWNER = '555', ADMIN = '600', USER = '666', STRANGER = '800', GROUP = '-100700', APPROVALS = '-100900'
const rep = (c: string, n: number) => c.repeat(n)
// fake values, assembled so the source has no token-shaped literal
const BOT_TOKEN = `${'7000000'}01:${'AAF'}${rep('x', 32)}`
const HELD_TOKEN = `${'7000000'}02:${'AAG'}${rep('y', 32)}`
const OPENAI = `${'sk'}-proj-${rep('o', 24)}`
const ANTHROPIC = `${'sk'}-ant-api03-${rep('a', 24)}`
const GITHUB = `${'gh'}p_${rep('G', 36)}`, GITHUB_PAT = `${'github'}_pat_${rep('P', 30)}`
const AWS = `${'AK'}IA${rep('Q', 16)}`, GOOGLE = `${'AI'}za${rep('g', 35)}`, SLACK = `${'xo'}xb-${rep('1', 12)}`
const PEM = `-----BEGIN ${'PRIVATE'} KEY-----\nMIIfake${rep('k', 40)}WXYZ\n-----END ${'PRIVATE'} KEY-----`

let dir: string, db: RouterDb, key: string, access: Access
let sent: Array<{ chatId: string; text: string; replyTo?: number; buttons?: unknown[]; thread?: number }>, edits: Array<{ chatId: string; id: number; text: string }>, removed: Array<{ chatId: string; id: number }>, notices: string[]
let canDelete: boolean, removeOk: boolean, clock: number, asked: Array<{ system: string; input: string }>, answer: string | Error, model: string
const roles: Record<string, string> = { [ADMIN]: 'admin', [OWNER]: 'owner' }
let globalCreds: Record<string, string>

function makeVault(extra: Partial<VaultDeps> = {}) {
  const api: VaultApi = {
    async send(chatId, text, o) { sent.push({ chatId, text, replyTo: o?.replyTo, buttons: o?.buttons }); return 1000 + sent.length },
    async remove(chatId, id) { removed.push({ chatId, id }); return removeOk },
    async edit(chatId, id, text) { edits.push({ chatId, id, text }) },
    async canDelete() { return canDelete },
  }
  const approvals: ApprovalDeps = {
    db, owners: [OWNER], isAdmin: uid => roles[uid] === 'admin',
    async send(_bot, to, text) { sent.push({ chatId: to.chat_id, text, thread: to.thread_id }); return 2000 + sent.length },
    async edit(_bot, chatId, id, text) { edits.push({ chatId, id, text }) },
  }
  const secretDeps: SecretDeps = { cfg: { owners: [OWNER], bots: [{ name: 'cc', token: BOT_TOKEN }], secretKey: key }, db, loadAccess: () => access, verifyBot: async t => { if (!/^\d+:/.test(t)) throw new Error('401'); return '@held_bot (7000000002)' } }
  return createVault({
    db, owners: [OWNER], approvals, secretKey: () => key,
    known: () => [{ value: BOT_TOKEN, label: 'router 的 bot cc' }, ...Object.entries(globalCreds).map(([n, v]) => ({ value: v, label: `全域憑證 ${n}` }))],
    roleOf: uid => roles[uid] ?? 'user',
    api: () => api,
    verifyBot: secretDeps.verifyBot,
    async ask(system, input) { asked.push({ system, input }); if (answer instanceof Error) throw answer; return answer },
    model: () => model,
    secretDeps, rawDir: join(dir, '.router', 'raw'),
    async notice(_bot, text) { notices.push(text) },
    personLabel: uid => `p${uid}`, chatLabel: (_b, c) => `chat ${c}`,
    served: (_t, chatId, uid) => chatId === uid ? access.allowFrom.includes(uid) : chatId in access.groups,
    now: () => clock, ...extra,
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cctr-raw-'))
  mkdirSync(join(dir, '.router'))
  db = openRouterDb(join(dir, '.router', 'router.db'))
  key = newSecretKey()
  access = { dmPolicy: 'allowlist', allowFrom: [OWNER, ADMIN, USER], groups: { [GROUP]: { requireMention: false, allowFrom: [] } }, pending: {} }
  sent = []; edits = []; removed = []; notices = []; asked = []
  canDelete = true; removeOk = true; clock = Date.parse('2026-10-17T02:00:00Z'); answer = '這是一則貼了 bot token 的訊息, 遮掉的是 h1.'; model = 'claude-opus-5-5'
  globalCreds = { eagle: HELD_TOKEN }
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

const dmUpdate = (uid: string, text: string, id = 10) => ({ update_id: id, message: { message_id: id, date: 0, chat: { id: Number(uid), type: 'private' }, from: { id: Number(uid), is_bot: false, first_name: 'X' }, text } })
const conv = (key: string, chat_id: string, role: string): Conversation => {
  const c = { key, bot: 'cc', chat_id, type: chat_id.startsWith('-') ? 'group' as const : 'dm' as const, folder: join(dir, key), role, session_id: null, created_at: '' }
  if (!db.getConversation(key)) db.insertConversation(c)
  return db.getConversation(key)!
}
const info = (uid: string, over: Record<string, unknown> = {}) => ({ chatId: uid, chatType: 'private', messageId: 10, senderId: uid, served: true, command: false, ...over })

test('detection: each known format, command values and held values (exact, 8+ chars); nothing guessed from randomness', () => {
  const kinds = (t: string) => detectSecrets(t).map(h => h.kind)
  expect(kinds(`token ${BOT_TOKEN} ok`)).toEqual(['Telegram bot token'])
  expect(kinds(OPENAI)).toEqual(['OpenAI API key'])
  expect(kinds(ANTHROPIC)).toEqual(['Anthropic API key'])
  expect(kinds(`${GITHUB} ${GITHUB_PAT}`)).toEqual(['GitHub token', 'GitHub token'])
  expect(kinds(AWS)).toEqual(['AWS access key'])
  expect(kinds(GOOGLE)).toEqual(['Google API key'])
  expect(kinds(SLACK)).toEqual(['Slack token'])
  expect(kinds(`key:\n${PEM}\nend`)).toEqual(['PEM 私鑰'])
  // no entropy guessing: a hash, a uuid, a random-looking word are left alone
  expect(detectSecrets('sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 uuid 3f2504e0-4f89-11d3-9a0c-0305e82c3301 Xk9qLm2Pz8Rt5Vw')).toEqual([])
  // the value of a token-carrying command, whatever it looks like
  expect(detectSecrets('/secret set img sk-short --http https://x.example').map(h => [h.kind, h.value])).toEqual([[CMD_KIND, 'sk-short']])
  expect(detectSecrets('/router cred add eagle abcdefgh').map(h => h.value)).toEqual(['abcdefgh'])
  // a format inside a command is named by the format
  expect(detectSecrets(`/secret set b ${BOT_TOKEN}`).map(h => h.kind)).toEqual(['Telegram bot token'])
  // held values: exact match, with what it is; shorter than 8 never
  const held = [{ value: 'plain-held-value', label: '對話密鑰 img (dm-1)' }, { value: 'short', label: 'x' }]
  expect(detectSecrets('see plain-held-value and short', held)).toEqual([{ start: 4, end: 20, kind: KNOWN_KIND, value: 'plain-held-value', known: '對話密鑰 img (dm-1)' }])
  expect(detectSecrets(`a ${HELD_TOKEN}`, [{ value: HELD_TOKEN, label: '全域憑證 eagle' }])[0]).toMatchObject({ kind: 'Telegram bot token', known: '全域憑證 eagle' })
})

test('scanning covers text, captions, edited messages, button data and quotes; the same value has one number; own findings leave quotes out', () => {
  const u = {
    update_id: 1,
    message: { text: `a ${OPENAI}`, caption: `b ${OPENAI}`, reply_to_message: { text: `q ${AWS}` } },
  }
  const fs = scanUpdate(u)
  expect(fs.map(f => [f.path.join('.'), f.n, f.kind])).toEqual([['message.text', 1, 'OpenAI API key'], ['message.caption', 1, 'OpenAI API key'], ['message.reply_to_message.text', 2, 'AWS access key']])
  expect(fs[0]).toMatchObject({ last4: 'oooo' })
  expect(fs[0]!.hash8).toMatch(/^[0-9a-f]{8}$/)
  expect(ownFindings(fs).map(f => f.path.join('.'))).toEqual(['message.text', 'message.caption'])
  expect(scanUpdate({ edited_message: { text: GOOGLE } }).map(f => f.path.join('.'))).toEqual(['edited_message.text'])
  expect(scanUpdate({ callback_query: { data: SLACK } }).map(f => f.path.join('.'))).toEqual(['callback_query.data'])
  expect(workerMarker(12, { n: 1, kind: 'Telegram bot token', last4: 'xxxx' })).toBe('<已遮蔽 #12.1: Telegram bot token, 末 4 碼 xxxx>')
})

test('event_raw sealing: AES-256-GCM bound to the event id; another row or key does not open it', () => {
  const s = sealRaw(key, 5, '{"a":1}')
  expect(openRaw(key, 5, s)).toBe('{"a":1}')
  expect(() => openRaw(key, 6, s)).toThrow()
  expect(() => openRaw(newSecretKey(), 5, s)).toThrow()
})

test('record: events keeps the masked update (masked = 1), event_raw the sealed original with fields and fingerprints; no plaintext anywhere in router.db; the worker sees markers', () => {
  const v = makeVault()
  const u = dmUpdate(USER, `my bot ${HELD_TOKEN} and ${OPENAI}`)
  const rec = v.record('cc', u)
  expect(rec.findings).toHaveLength(2)
  const ev = db.getEvent(rec.id)!
  expect(ev.masked).toBe(1)
  expect(JSON.parse(ev.update_json).message.text).toBe(`my bot <已遮蔽 #${rec.id}.1> and <已遮蔽 #${rec.id}.2>`)
  const raw = db.getEventRaw(rec.id)!
  expect(JSON.parse(openRaw(key, rec.id, raw.sealed))).toEqual(u)
  expect(JSON.parse(raw.fields).map((f: any) => [f.kind, f.last4, f.known ?? null])).toEqual([['Telegram bot token', 'yyyy', '全域憑證 eagle'], ['OpenAI API key', 'oooo', null]])
  db.close()
  const bytes = readFileSync(join(dir, '.router', 'router.db')).toString('latin1') + (() => { try { return readFileSync(join(dir, '.router', 'router.db-wal')).toString('latin1') } catch { return '' } })()
  expect(bytes).not.toContain(HELD_TOKEN)
  expect(bytes).not.toContain(OPENAI)
  db = openRouterDb(join(dir, '.router', 'router.db'))
  // what handlers (messages table, worker) read from then on
  v.maskForWorker(u, rec)
  expect(u.message.text).toBe(`my bot <已遮蔽 #${rec.id}.1: Telegram bot token, 末 4 碼 yyyy> and <已遮蔽 #${rec.id}.2: OpenAI API key, 末 4 碼 oooo>`)
  // nothing found: stored as it is, masked = 0, no event_raw
  const plain = makeVault().record('cc', dmUpdate(USER, 'hello'))
  expect(db.getEvent(plain.id)!.masked).toBe(0)
  expect(db.getEventRaw(plain.id)).toBeNull()
})

test('a served chat: the router answers the message (kind and last 4, 取消刪除 button), deletes it 5 minutes later; each detection goes to 🔑 密鑰偵測 with chat, sender, kind, last 4, event id and outcome', async () => {
  db.updateBotSetup('cc', { approvals_chat: APPROVALS, notices_topic: 41, secret_topic: 45 })
  const v = makeVault()
  const rec = v.record('cc', dmUpdate(USER, `here ${OPENAI}`))
  await v.detected('cc', rec, info(USER))
  const reminder = sent.find(s => s.chatId === USER)!
  expect(reminder.replyTo).toBe(10)
  expect(reminder.text).toBe('⚠️ 這則訊息含有密鑰 (OpenAI API key 末 4 碼 oooo), 10:05 會刪除. 要保留請按「取消刪除」(發送者, owner, admin 可以按). 密鑰出現在對話裡就可能外流, 建議到發出它的地方換一把新的.')
  expect(reminder.buttons).toEqual([{ text: '取消刪除', data: 'sdel:1:cancel' }])
  const d = db.getDeletion(1)!
  expect(d).toMatchObject({ event_id: rec.id, chat_id: USER, message_id: 10, sender: USER, status: 'pending', notice_id: 1001 })
  expect(Date.parse(d.due_at) - clock).toBe(DELETE_AFTER_MS)
  const log = sent.find(s => s.chatId === APPROVALS)!
  expect(log.thread).toBe(45)
  expect(log.text).toBe([`🔑 偵測到密鑰 event #${rec.id}`, `對話: chat ${USER}`, `發送者: p${USER} (${USER})`, '內容: #1 OpenAI API key 末 4 碼 oooo', '欄位: message.text', '處理: 已提醒, 10:05 刪除 (可取消)'].join('\n'))
  expect(log.text).not.toContain(OPENAI)
  expect(db.secretLog(5)[0]).toMatchObject({ kind: 'detect', ref: rec.id })
  // not yet due
  clock += DELETE_AFTER_MS - 1000
  expect(await v.tick()).toBe(0)
  clock += 1000
  expect(await v.tick()).toBe(1)
  expect(removed).toEqual([{ chatId: USER, id: 10 }])
  expect(db.getDeletion(1)!.status).toBe('deleted')
  expect(edits.find(e => e.chatId === USER)!.text).toStartWith('🗑 已刪除含密鑰的訊息')
  expect(edits.find(e => e.chatId === APPROVALS)!.text).toEndWith('結果: 🗑 已刪除含密鑰的訊息')
  expect(await v.tick()).toBe(0)
})

test('no right to delete: only a reminder; not served, quoted only, a command, a button: recorded only; without an approvals group the record goes to the owner DM', async () => {
  const v = makeVault()
  canDelete = false
  await v.detected('cc', v.record('cc', { update_id: 2, message: { message_id: 11, chat: { id: Number(GROUP), type: 'supergroup' }, from: { id: Number(USER) }, text: AWS } }), info(USER, { chatId: GROUP, chatType: 'supergroup', messageId: 11 }))
  expect(sent[0]).toMatchObject({ chatId: GROUP, replyTo: 11, text: '⚠️ 這則訊息含有密鑰 (AWS access key 末 4 碼 QQQQ). bot 沒有刪除權限, 請自己刪掉這則訊息, 並到發出它的地方換一把新的.' })
  expect(sent[0]!.buttons).toBeUndefined()
  expect(db.getDeletion(1)).toBeNull()
  expect(sent[1]).toMatchObject({ chatId: OWNER })
  expect(sent[1]!.text).toEndWith('處理: 已提醒, bot 沒有刪除權限 (請發送者自己刪)')
  sent = []
  canDelete = true
  await v.detected('cc', v.record('cc', dmUpdate(STRANGER, OPENAI)), info(STRANGER, { served: false }))
  await v.detected('cc', v.record('cc', { update_id: 3, message: { message_id: 12, chat: { id: Number(USER), type: 'private' }, text: 'hi', reply_to_message: { text: OPENAI } } }), info(USER))
  await v.detected('cc', v.record('cc', dmUpdate(USER, `/secret set k ${OPENAI}`)), info(USER, { command: true }))
  await v.detected('cc', v.record('cc', { update_id: 4, callback_query: { data: SLACK, message: { chat: { id: Number(USER) } } } }), info(USER, { messageId: null }))
  // a pressed button under the reminder: the message quotes the one with the key
  await v.detected('cc', v.record('cc', { update_id: 5, callback_query: { data: 'sdel:9:cancel', message: { chat: { id: Number(USER) }, reply_to_message: { text: OPENAI } } } }), info(USER, { messageId: null }))
  expect(sent.map(s => [s.chatId, s.text.split('\n').pop()])).toEqual([
    [OWNER, '處理: 不是 router 服務的對話, 只記錄'],
    [OWNER, '處理: 只在引用的訊息裡, 不提醒'],
    [OWNER, '處理: 登記或 router 指令: router 處理, 訊息立刻刪除'],
    [OWNER, '處理: 按鈕資料, 只記錄'],
    [OWNER, '處理: 只在引用的訊息裡, 不提醒'],
  ])
  expect(db.getDeletion(1)).toBeNull()
})

test('取消刪除: the sender, an owner or an admin; anyone else is refused; a cancelled one is never deleted; a failed delete is said so', async () => {
  const v = makeVault()
  for (let i = 0; i < 3; i++) await v.detected('cc', v.record('cc', dmUpdate(USER, OPENAI, 20 + i)), info(USER, { messageId: 20 + i }))
  expect(await v.cancel('sdel:1:cancel', STRANGER)).toBe('只有發送者, owner, admin 能取消刪除')
  expect(await v.cancel('sdel:1:cancel', USER)).toBe('已取消刪除')
  expect(await v.cancel('sdel:1:cancel', USER)).toBe('已經處理過了')
  expect(await v.cancel('sdel:2:cancel', OWNER)).toBe('已取消刪除')
  expect(await v.cancel('sdel:3:cancel', ADMIN)).toBe('已取消刪除')
  expect(edits.find(e => e.chatId === USER)!.text).toBe(`⚠️ 這則訊息含有密鑰. p${USER} 取消了刪除, 訊息保留. 建議到發出它的地方換一把新的.`)
  clock += DELETE_AFTER_MS
  expect(await v.tick()).toBe(0)
  expect(removed).toEqual([])
  await v.detected('cc', v.record('cc', dmUpdate(USER, OPENAI, 30)), info(USER, { messageId: 30 }))
  removeOk = false
  clock += DELETE_AFTER_MS
  expect(await v.tick()).toBe(1)
  expect(db.getDeletion(4)!.status).toBe('failed')
  expect(edits.pop()!.text).toContain('刪除失敗')
})

test('the deletion schedule survives a restart: a new router on the same router.db deletes what came due while it was down', async () => {
  const v = makeVault()
  await v.detected('cc', v.record('cc', dmUpdate(USER, OPENAI)), info(USER))
  db.close()
  db = openRouterDb(join(dir, '.router', 'router.db'))
  clock += DELETE_AFTER_MS + 60_000
  expect(await makeVault().tick()).toBe(1)
  expect(removed).toEqual([{ chatId: USER, id: 10 }])
})

test('event_raw: only when the sender or the conversation is owner or admin; any conversation\'s event; the agent gets handles with router facts and never a value; the worker gets the handle version and the answer', async () => {
  const v = makeVault()
  const rec = v.record('cc', dmUpdate(OWNER, `bot ${HELD_TOKEN}, key ${OPENAI}`))
  const userConv = conv('dm-666', USER, 'user'), ownerConv = conv('dm-555', OWNER, 'owner')
  expect(await v.requestRaw(userConv, USER, { event_id: rec.id, question: 'q' })).toEqual({ ok: false, text: '⛔ event_raw 只限 owner 或 admin: 這一輪的發話者 (user) 或這個對話的角色 (user) 要是 owner 或 admin' })
  // an admin's turn in a user conversation may, for an event of the owner's DM
  const r = await v.requestRaw(userConv, ADMIN, { event_id: rec.id, question: '這則訊息原本是什麼' })
  expect(r.ok).toBe(true)
  expect(asked).toHaveLength(1)
  expect(asked[0]!.system).toBe(RAW_SYSTEM)
  const input = asked[0]!.input
  expect(input).not.toContain(HELD_TOKEN)
  expect(input).not.toContain(OPENAI)
  expect(input).toContain('«密鑰 h1: Telegram bot token, getMe: @held_bot (7000000002), 末 4 碼 yyyy, 跟全域憑證 eagle相同»')
  expect(input).toContain('«密鑰 h2: OpenAI API key, 末 4 碼 oooo, 不等於任何已登記的憑證或對話密鑰»')
  expect(input).toContain('<question>\n這則訊息原本是什麼\n</question>')
  expect(r.text).toContain('«密鑰 h1:')
  expect(r.text).toContain(`固定 agent 的回答:\n${answer}`)
  expect(r.text).not.toContain(HELD_TOKEN)
  // handles: this conversation only, 10 minutes by default
  const h1 = db.getHandle('h1')!
  expect(h1).toMatchObject({ event_id: rec.id, n: 1, kind: 'Telegram bot token', last4: 'yyyy', conv: 'dm-666', chat_id: USER })
  expect(Date.parse(h1.expires_at!) - clock).toBe(10 * 60_000)
  expect(db.getSecretRequest(1)).toMatchObject({ conv: 'dm-666', sender: ADMIN, event_id: rec.id, status: 'answered', handles: '["h1","h2"]' })
  const log = sent.find(s => s.text.startsWith('🔎 原文請求 #1'))!
  expect(log.text).toContain(`p${ADMIN} (admin) 在 chat ${USER}`)
  expect(log.text).toContain('代號: h1 (Telegram bot token 末 4 碼 yyyy), h2 (OpenAI API key 末 4 碼 oooo), 10 分鐘, 只在 dm-666 有效')
  expect(log.text).toEndWith('結果: 已回答')
  // the owner's own conversation; longer than an hour is an hour; permanent
  await v.requestRaw(ownerConv, OWNER, { event_id: rec.id, question: 'q', ttl_minutes: 600 })
  expect(Date.parse(db.getHandle('h3')!.expires_at!) - clock).toBe(60 * 60_000)
  await v.requestRaw(ownerConv, null, { event_id: rec.id, question: 'q', permanent: true })
  expect(db.getHandle('h5')!.expires_at).toBeNull()
  // an event with nothing masked: events already is the original
  const plain = v.record('cc', dmUpdate(USER, 'hello'))
  expect((await v.requestRaw(ownerConv, OWNER, { event_id: plain.id, question: 'q' })).text).toStartWith(`event #${plain.id} 沒有偵測到密鑰, events 裡存的就是原文:`)
  expect((await v.requestRaw(ownerConv, OWNER, { event_id: 999, question: 'q' })).ok).toBe(false)
})

test('event_raw exit check: an answer with a value, a held value or any token format is held back whole, the handles revoked, the owner told; haiku is refused; no answer still gives the handles', async () => {
  const v = makeVault()
  const rec = v.record('cc', dmUpdate(OWNER, `key ${OPENAI}`))
  const c = conv('dm-555', OWNER, 'owner')
  answer = `原文是 ${OPENAI}`
  const r = await v.requestRaw(c, OWNER, { event_id: rec.id, question: 'q' })
  expect(r).toEqual({ ok: false, text: '⛔ 固定 agent 的回答含有明文或疑似密鑰, router 整份擋下並通知了 owner; 這次的代號也已撤銷.' })
  expect(db.getHandle('h1')!.revoked_by).toBe('router')
  expect(db.getSecretRequest(1)!.status).toBe('blocked')
  expect(notices[0]).toStartWith('⛔ 原文請求 #1')
  expect(sent.find(s => s.text.startsWith('🔎 原文請求 #1'))!.text).not.toContain(OPENAI)
  // a held value, or a token the agent made up
  answer = `也許是 ${HELD_TOKEN}`
  expect((await v.requestRaw(c, OWNER, { event_id: rec.id, question: 'q' })).ok).toBe(false)
  answer = `像是 ${GITHUB} 這樣`
  expect((await v.requestRaw(c, OWNER, { event_id: rec.id, question: 'q' })).ok).toBe(false)
  answer = new Error('timeout')
  const none = await v.requestRaw(c, OWNER, { event_id: rec.id, question: 'q' })
  expect(none.ok).toBe(true)
  expect(none.text).toContain('固定 agent 沒有回答 (timeout)')
  model = 'claude-haiku-4-5'
  expect((await v.requestRaw(c, OWNER, { event_id: rec.id, question: 'q' })).text).toBe('⛔ config.json 的 model 是 haiku, 原文請求不能用 haiku; 請 owner 換 model')
})

test('secret_from_handle: only this conversation\'s live handle; registers as /secret set would (getMe for a bot token, scope syntax), sealed with the handle as source; uses counted', async () => {
  const v = makeVault()
  const rec = v.record('cc', dmUpdate(OWNER, `bot ${HELD_TOKEN} key ${OPENAI}`))
  const mine = conv('dm-555', OWNER, 'owner'), other = conv('dm-666', USER, 'user')
  await v.requestRaw(mine, OWNER, { event_id: rec.id, question: 'q' })
  expect((await v.fromHandle(other, { handle: 'h1', name: 'tool' })).text).toBe('代號 h1 不是這個對話的 (代號只在申請的對話有效)')
  const r = await v.fromHandle(mine, { handle: 'h1', name: 'tool', scope: 'getMe sendMessage' })
  expect(r).toEqual({ ok: true, text: '已登記這個對話的密鑰 tool: telegram-bot @held_bot (7000000002), 方法 getMe, sendMessage\n值加密存在 router, 只有這個對話能用 (bot_api 工具, credential 填 tool)' })
  const s = db.getConvSecret('cc', OWNER, 'tool')!
  expect(s).toMatchObject({ source: 'h1', added_by: 'handle:h1' })
  expect(openSecret(key, 'cc', OWNER, 'tool', s.value)).toBe(HELD_TOKEN)
  expect(db.getHandle('h1')).toMatchObject({ registered: 'tool', uses: 1 })
  v.used('h1')
  expect(db.getHandle('h1')!.uses).toBe(2)
  // an http key with --http
  expect((await v.fromHandle(mine, { handle: 'h2', name: 'oa', scope: '--http https://api.example.com /v1/*' })).text).toStartWith('已登記這個對話的密鑰 oa: http https://api.example.com, 路徑 /v1/*')
  expect(sent.filter(m => m.text.startsWith('🔐 代號')).map(m => m.text)).toEqual([
    `🔐 代號 h1 (Telegram bot token 末 4 碼 yyyy, event #${rec.id}) 已登記成 chat ${OWNER} 的對話密鑰 tool`,
    `🔐 代號 h2 (OpenAI API key 末 4 碼 oooo, event #${rec.id}) 已登記成 chat ${OWNER} 的對話密鑰 oa`,
  ])
  // revoked, expired
  db.revokeHandle('h2', OWNER)
  expect((await v.fromHandle(mine, { handle: 'h2', name: 'x' })).text).toBe('代號 h2 已撤銷')
  clock += 11 * 60_000
  expect((await v.fromHandle(mine, { handle: 'h1', name: 'x' })).text).toBe('代號 h1 已過期, 需要的話重新呼叫 event_raw')
})

test('cli event raw: the plaintext goes into a 600 file in a 700 folder, only the path comes back; recorded in 🔑 密鑰偵測', async () => {
  const v = makeVault()
  const u = dmUpdate(OWNER, `key ${OPENAI}`)
  const rec = v.record('cc', u)
  const out = await v.rawToFile(rec.id)
  expect(out).not.toContain(OPENAI)
  const file = /已寫入 (\S+) \(權限 600\)/.exec(out)![1]!
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(statSync(join(dir, '.router', 'raw')).mode & 0o777).toBe(0o700)
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(u)
  expect(sent.pop()!.text).toBe(`🗝 owner 在終端機取出 event #${rec.id} 的明文 (寫進權限 600 的檔案, 只在終端機)`)
  expect(await v.rawToFile(9999)).toBe('沒有 event #9999')
})

test('/secret handles | revoke in the conversation; /router secret handles | revoke for owner and admin; /router event raw only from the owner terminal', async () => {
  const v = makeVault()
  const rec = v.record('cc', dmUpdate(OWNER, `key ${OPENAI}`))
  const c = conv('dm-555', OWNER, 'owner')
  await v.requestRaw(c, OWNER, { event_id: rec.id, question: 'q', permanent: true })
  const sdeps: SecretDeps = { cfg: { owners: [OWNER], bots: [{ name: 'cc', token: BOT_TOKEN }], secretKey: key }, db, loadAccess: () => access, verifyBot: async () => '@x (1)' }
  const dm = (uid: string, text: string) => ({ bot: 'cc', text, senderId: uid, senderName: `u${uid}`, chatId: uid, chatType: 'private' })
  expect((await runSecretCommand(dm(OWNER, '/secret handles'), sdeps))!.reply).toBe(`這個對話有效的密鑰代號:\nh1: OpenAI API key, 末 4 碼 oooo, event #${rec.id}, 永久, 使用 0 次`)
  expect((await runSecretCommand(dm(USER, '/secret revoke h1'), sdeps))!.reply).toStartWith('用法: /secret revoke <代號>')
  expect((await runSecretCommand(dm(OWNER, '/secret revoke h1'), sdeps))!.reply).toBe('已撤銷代號 h1')
  expect((await runSecretCommand(dm(OWNER, '/secret handles'), sdeps))!.reply).toBe('這個對話沒有有效的密鑰代號')
  await v.requestRaw(c, OWNER, { event_id: rec.id, question: 'q' })
  const files: number[] = []
  const cdeps = { cfg: { owners: [OWNER], bots: [{ name: 'cc', token: BOT_TOKEN }], credentials: {} }, db, loadAccess: () => access, events: { async rawToFile(id: number) { files.push(id); return `已寫入 /x (權限 600)` } } } as unknown as CommandDeps
  db.setUserRole(ADMIN, 'admin')
  const list = await runCommand(dm(ADMIN, '/router secret handles'), cdeps)
  expect(list!.reply).toContain(`h1 (dm-555): OpenAI API key, 末 4 碼 oooo, event #${rec.id}, 已撤銷 (${OWNER})`)
  expect(list!.reply).toContain('h2 (dm-555): OpenAI API key')
  expect((await runCommand(dm(ADMIN, '/router secret revoke h2'), cdeps))!.reply).toBe('已撤銷 dm-555 的代號 h2')
  expect((await runCommand(dm(OWNER, `/router event raw ${rec.id}`), cdeps))!.reply).toBe('⛔ event raw 只在 owner 的終端機執行 (cc-telegram-router cli event raw <id>), 不提供 Telegram 裡的明文')
  expect((await runCommand({ ...dm(ADMIN, `/router event raw ${rec.id}`), terminal: true }, cdeps))!.reply).toStartWith('⛔')
  expect((await runCommand({ ...dm(OWNER, `/router event raw ${rec.id}`), terminal: true }, cdeps))!.reply).toBe('已寫入 /x (權限 600)')
  expect(files).toEqual([rec.id])
})

test('the fixed agent is claude -p with the fixed system prompt, no tools, no settings, no MCP, the config model; the input on stdin', async () => {
  const bin = join(dir, 'fake-claude')
  writeFileSync(bin, `#!/bin/bash\nprintf '%s\\n' "$@" > "${dir}/args"\ncat > "${dir}/stdin"\necho '{"type":"result","result":"ok answer","is_error":false}'\n`)
  chmodSync(bin, 0o755)
  const ask = claudeAsk({ claudeBin: bin, model: () => 'claude-opus-5-5', cwd: dir })
  expect(await ask(RAW_SYSTEM, 'the input')).toBe('ok answer')
  const args = readFileSync(join(dir, 'args'), 'utf8').split('\n')
  expect(args.slice(0, 13)).toEqual(['-p', '--model', 'claude-opus-5-5', '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'json', '--system-prompt', RAW_SYSTEM.split('\n')[0]!])
  expect(readFileSync(join(dir, 'stdin'), 'utf8')).toBe('the input')
  writeFileSync(bin, `#!/bin/bash\necho '{"type":"result","result":"x","is_error":true}'\n`)
  await expect(ask(RAW_SYSTEM, 'x')).rejects.toThrow()
})

test('docs: README 「原始事件與密鑰保護」, /telegram:doc, /telegram:bot-skill and the tool definitions describe what this does', async () => {
  const root = join(import.meta.dir, '..', '..')
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  const sec = readme.slice(readme.indexOf('### 原始事件與密鑰保護'), readme.indexOf('### bot 設定提醒'))
  for (const s of ['`<已遮蔽 #<event id>.<序號>>`', 'event_raw', 'AES-256-GCM', '綁定 event id', '「🔑 密鑰偵測」', '5 分鐘後刪除', '取消刪除', '發送者, owner, admin', 'claude -p', 'haiku', '出口檢查', '預設 10 分鐘, 最多 60 分鐘, 或永久', 'secret_from_handle', '/secret handles', 'cli event raw', '權限 600', '5 筆舊紀錄', '文字類附件', '`download_attachment`', '1 MB', '圖片, 二進位檔']) expect(sec).toContain(s)
  expect(readme).toContain('### 10e 原始事件與密鑰保護驗收對照')
  expect(readme).toContain('「🔑 密鑰偵測」五個話題')
  const doc = readFileSync(join(root, 'plugin', 'skills', 'doc', 'SKILL.md'), 'utf8')
  for (const s of ['## 密鑰與原文 (event_raw)', '文字類附件', '<已遮蔽 #<event id>.<序號>: 種類, 末 4 碼 xxxx>', '取消刪除', 'event_raw', 'secret_from_handle', '/secret handles', 'cli event raw', '五個話題']) expect(doc).toContain(s)
  expect(readFileSync(join(root, 'plugin', 'skills', 'bot-skill', 'SKILL.md'), 'utf8')).toContain('`secret_from_handle`')
  const { TOOL_DEFINITIONS } = await import('../../shared/tools')
  const tool = (n: string) => TOOL_DEFINITIONS.find(t => t.name === n) as any
  expect(tool('event_raw').inputSchema.required).toEqual(['event_id', 'question'])
  expect(Object.keys(tool('event_raw').inputSchema.properties)).toEqual(['event_id', 'question', 'ttl_minutes', 'permanent'])
  expect(tool('event_raw').description).toContain('owner or admin')
  expect(tool('secret_from_handle').inputSchema.required).toEqual(['handle', 'name'])
  expect(tool('download_attachment').description).toContain('checked for secrets')
})

test('text attachments: by name (.env, .env.local, config and source extensions) or mime text/*; images and binaries are not', () => {
  for (const [n, m] of [['prod.env', null], ['.env', null], ['.env.local', null], ['a.json', null], ['c.yaml', null], ['c.yml', null], ['s.ini', null], ['n.conf', null], ['r.md', null], ['d.csv', null], ['x.py', null], ['x.ts', null], ['x.go', null], ['noext', 'text/plain'], ['note.TXT', null]] as const) expect(isTextAttachment(n, m)).toBe(true)
  for (const [n, m] of [['photo.png', 'image/png'], ['a.pdf', 'application/pdf'], ['b.zip', null], [null, null]] as const) expect(isTextAttachment(n, m)).toBe(false)
  expect(isTextAttachment(null, null, 'documents/file_3.env')).toBe(true)
})

test('download_attachment of a text file with a key: the worker gets markers, the original is sealed as an attachment event, the message it came with is answered and deleted in 5 minutes, recorded with the file name; once per file', async () => {
  const v = makeVault()
  const doc = (id: number, file_id: string, file_name: string, mime_type = 'application/octet-stream') => ({ update_id: id, message: { message_id: id, date: 0, chat: { id: Number(USER), type: 'private' }, from: { id: Number(USER), is_bot: false, first_name: 'U' }, document: { file_id, file_unique_id: 'u' + id, file_name, mime_type } } })
  v.record('cc', doc(40, 'F1', 'prod.env'))
  const body = `A=1\nKEY=${OPENAI}\n`
  const out = await v.attachment('cc', { file_id: 'F1', file_path: 'documents/file_1.env' }, Buffer.from(body))
  const ev = db.attachmentEvent('F1')!
  expect(out.toString()).toBe(`A=1\nKEY=<已遮蔽 #${ev.id}.1: OpenAI API key, 末 4 碼 oooo>\n`)
  expect(ev.masked).toBe(1)
  expect(JSON.parse(ev.update_json).attachment).toMatchObject({ file_id: 'F1', file_name: 'prod.env', chat_id: USER, message_id: 40, text: `A=1\nKEY=<已遮蔽 #${ev.id}.1>\n` })
  expect(ev.update_json).not.toContain(OPENAI)
  expect(JSON.parse(openRaw(key, ev.id, db.getEventRaw(ev.id)!.sealed)).attachment.text).toBe(body)
  await new Promise(r => setTimeout(r, 20))
  const reminder = sent.find(m => m.chatId === USER)!
  expect(reminder).toMatchObject({ replyTo: 40 })
  expect(reminder.text).toStartWith('⚠️ 這則訊息的附件 prod.env 含有密鑰 (OpenAI API key 末 4 碼 oooo), 10:05 會刪除.')
  expect(db.getDeletion(1)).toMatchObject({ event_id: ev.id, chat_id: USER, message_id: 40, status: 'pending' })
  const log = sent.find(m => m.chatId === OWNER)!.text
  expect(log).toContain('附件: prod.env (worker 下載時偵測)')
  expect(log).toContain('欄位: attachment.text')
  // the same file again: the same markers, nothing recorded twice
  const n = sent.length
  expect((await v.attachment('cc', { file_id: 'F1', file_path: 'documents/file_1.env' }, Buffer.from(body))).toString()).toBe(out.toString())
  await new Promise(r => setTimeout(r, 20))
  expect(sent.length).toBe(n)
  // event_raw works on it like on any event
  const r = await v.requestRaw(conv('dm-555', OWNER, 'owner'), OWNER, { event_id: ev.id, question: '這個檔案原本是什麼' })
  expect(r.ok).toBe(true)
  expect(asked[0]!.input).toContain('«密鑰 h1: OpenAI API key')
  expect(asked[0]!.input).not.toContain(OPENAI)
  // passed on as they are: an image, a text file without keys, NUL bytes, too large
  v.record('cc', doc(41, 'F2', 'shot.png', 'image/png'))
  expect((await v.attachment('cc', { file_id: 'F2', file_path: 'documents/x.png' }, Buffer.from(body))).toString()).toBe(body)
  v.record('cc', doc(42, 'F3', 'notes.txt'))
  expect((await v.attachment('cc', { file_id: 'F3', file_path: 'documents/x.txt' }, Buffer.from('hello'))).toString()).toBe('hello')
  expect((await v.attachment('cc', { file_id: 'F3', file_path: 'documents/x.txt' }, Buffer.from(`a\0${OPENAI}`))).toString()).toContain(OPENAI)
  const big = Buffer.from(OPENAI + 'x'.repeat(MAX_TEXT_ATTACHMENT))
  expect((await v.attachment('cc', { file_id: 'F3', file_path: 'documents/x.txt' }, big)).equals(big)).toBe(true)
  expect(db.attachmentEvent('F2')).toBeNull()
  expect(db.attachmentEvent('F3')).toBeNull()
})

test('the fixed agent answers in Taiwan traditional Chinese with half-width punctuation', () => {
  expect(RAW_SYSTEM).toContain('一律使用台灣正體中文與半形標點')
  expect(RAW_SYSTEM).not.toMatch(/[，。：；（）]/)
})
