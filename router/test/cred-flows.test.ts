// Registering credentials, module level (柯姊 2026-10-17): the deletion of
// a registration message (rawvault scheduleCommand: 60 seconds in a DM, its
// sender, an owner or an admin cancels; 10 seconds in a group with no
// button; kept in router.db so a restarted router still deletes it), which
// commands ask for it and which delete at once, /router cred rotate (only
// the key; getMe first for a bot token), /router cred add of a name that
// exists (覆蓋 / 取消, the value held 2 minutes in memory only), default
// headers (--default-header, /router cred header and /secret header list,
// set, update, rm; http_api adds them unless the worker sends one) and
// http_api json_file (owner and admin anywhere but router state, user and
// power their folder; size, JSON, one body).
// Keep in sync with docs/credentials-and-skills.md 「登記訊息的延遲刪除」
// 「同名憑證: 覆蓋或取消」「換 key: cred rotate」「預設標頭」「http_api 的
// json_file」 and docs/secrets.md 「登記訊息何時刪除」; end to end in e2e-creds.test.ts.

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync, truncateSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Config } from '../config'
import { openRouterDb, type RouterDb } from '../db'
import { createVault, COMMAND_DELETE_AFTER_MS, GROUP_COMMAND_DELETE_AFTER_MS, type VaultApi } from '../rawvault'
import { runCommand, decideCredOverwrite, type CommandDeps } from '../commands'
import { runSecretCommand, secretCred, newSecretKey, maskSecretText, type SecretDeps } from '../secrets'
import { createCredStaging, credSummary, parseHttpScope, refuseDefaultHeader, httpApiCall, readJsonFile, jsonFileAnywhere, MAX_JSON_FILE, STAGE_TTL_MS, type StagedCred } from '../credentials'

const OWNER = '555', ADMIN = '600', OTHER_ADMIN = '601', USER = '666', OTHER = '667'
const KEY = 'sk-fake-flows-0001', KEY2 = 'sk-fake-flows-0002'
const BOT1 = `424242:${'A'.repeat(35)}`, BOT2 = `434343:${'B'.repeat(35)}`
let dir: string, db: RouterDb, cfg: Config, getMe: string[], clock: number, canDel: boolean
let sent: Array<{ chatId: string; text: string; replyTo?: number; buttons?: unknown[] }>, edits: Array<{ chatId: string; id: number; text: string }>, removed: Array<{ chatId: string; id: number }>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cctr-credflows-'))
  mkdirSync(join(dir, '.router'))
  db = openRouterDb(join(dir, '.router', 'router.db'), { owners: [OWNER] })
  db.setUserRole(ADMIN, 'admin')
  db.setUserRole(OTHER_ADMIN, 'admin')
  cfg = { path: join(dir, '.router', 'config.json'), bots: [{ name: 'cc', token: '1:x' }], home: dir, stateDir: join(dir, '.router'), socket: join(dir, '.router', 's'), owners: [OWNER], model: 'm', autoCompactWindow: 750000, claudeBin: 'claude', credentials: {} } as Config
  getMe = []; sent = []; edits = []; removed = []; clock = Date.parse('2026-10-17T04:00:00Z'); canDel = true
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

function vault() {
  const api: VaultApi = {
    async send(chatId, text, o) { sent.push({ chatId, text, replyTo: o?.replyTo, buttons: o?.buttons }); return 1000 + sent.length },
    async remove(chatId, id) { removed.push({ chatId, id }); return true },
    async edit(chatId, id, text) { edits.push({ chatId, id, text }) },
    async canDelete() { return canDel },
  }
  return createVault({
    db, owners: [OWNER], secretKey: () => newSecretKey(), known: () => [], roleOf: uid => uid === OWNER ? 'owner' : db.getUserRole(uid) ?? 'user', api: () => api,
    approvals: { db, owners: [OWNER], isAdmin: () => false, async send() { return 1 }, async edit() {} },
    verifyBot: async () => '', async ask() { return '' }, model: () => 'm',
    secretDeps: { cfg: { owners: [OWNER], bots: [] }, db, loadAccess: () => ({}) as any, verifyBot: async () => '' },
    rawDir: join(dir, '.router', 'raw'), async notice() {}, personLabel: uid => `p${uid}`, chatLabel: (_b, c) => `chat ${c}`,
    now: () => clock,
  })
}

const staging = createCredStaging()
function deps(): CommandDeps {
  return {
    cfg, db, loadAccess: () => ({ dmPolicy: 'allowlist', allowFrom: [OWNER, ADMIN, OTHER_ADMIN], groups: {}, pending: {} }) as any, saveAccess() {},
    creds: {
      // stands in for main.ts: getMe only for a bot token
      async add(name: string, token: string, methods: string[], by: string, http?: any) {
        if (!http) getMe.push(token)
        cfg.credentials[name] = { token, methods, roles: ['owner', 'admin'], label: http ? `http ${http.baseUrl}` : '@tool_bot (424242)', ...(http ? { kind: 'http', ...http } : {}), addedBy: by }
        return cfg.credentials[name]!.label!
      },
      async rotate(name: string, token: string, headers?: Record<string, string>) {
        const c = cfg.credentials[name]!
        if (c.kind !== 'http') { getMe.push(token); c.label = '@tool2_bot (434343)' }
        c.token = token
        if (headers) c.defaultHeaders = { ...c.defaultHeaders, ...headers }
        return c.label!
      },
      staging,
      update(name: string, change: any) { if (change) change(cfg.credentials[name]!); else delete cfg.credentials[name] },
      reload: () => 0, async call() { return null },
    },
  } as unknown as CommandDeps
}
const run = (text: string, sender = OWNER, chatId = sender, chatType = 'private') => runCommand({ bot: 'cc', text, senderId: sender, senderName: 'x', chatId, chatType }, deps())

test('scheduleCommand in a DM: a notice with 取消刪除 replying to the message, deleted 60 seconds later; its sender, an owner or an admin cancels, anyone else has no right; a new vault on the same router.db (a restart) deletes what is due', async () => {
  expect(COMMAND_DELETE_AFTER_MS).toBe(60_000)
  const v = vault()
  const a = await v.scheduleCommand('cc', { chatId: USER, chatType: 'private', messageId: 7, senderId: USER, eventId: 3 })
  expect(sent[0]).toEqual({ chatId: USER, text: '⏳ 這則訊息含有 key, 60 秒後 (12:01) 刪除. 要保留請按「取消刪除」(發訊者本人, owner, admin 能按).', replyTo: 7, buttons: [{ text: '取消刪除', data: `sdel:${a.id}:cancel` }] })
  expect(db.getDeletion(a.id!)).toMatchObject({ kind: 'command', status: 'pending', notice_id: 1001, event_id: 3, due_at: new Date(clock + 60_000).toISOString() })
  // not yet due
  clock += 59_000
  expect(await v.tick()).toBe(0)
  expect(removed).toEqual([])
  // someone else (a user who is not the sender) has no right; the sender may
  expect(await v.cancel(`sdel:${a.id}:cancel`, OTHER)).toBe('沒有權限: 只有發訊者本人, owner, admin 能取消刪除')
  expect(db.getDeletion(a.id!)!.status).toBe('pending')
  expect(await v.cancel(`sdel:${a.id}:cancel`, USER)).toBe('已取消刪除')
  expect(edits.at(-1)).toEqual({ chatId: USER, id: 1001, text: '⚠️ 這則訊息含有 key. 已取消刪除, 訊息保留; 不需要時請自己刪掉.' })
  expect(await v.cancel(`sdel:${a.id}:cancel`, USER)).toBe('已經處理過了')
  clock += 120_000
  expect(await v.tick()).toBe(0)
  expect(removed).toEqual([])
  // an owner and an admin may cancel someone else's; the notice says who
  const byOwner = await v.scheduleCommand('cc', { chatId: USER, chatType: 'private', messageId: 10, senderId: USER, eventId: null })
  expect(await v.cancel(`sdel:${byOwner.id}:cancel`, OWNER)).toBe('已取消刪除')
  expect(edits.at(-1)!.text).toBe('⚠️ 這則訊息含有 key. p555 已取消刪除, 訊息保留; 不需要時請自己刪掉.')
  const byAdmin = await v.scheduleCommand('cc', { chatId: USER, chatType: 'private', messageId: 11, senderId: USER, eventId: null })
  expect(await v.cancel(`sdel:${byAdmin.id}:cancel`, ADMIN)).toBe('已取消刪除')
  expect(db.getDeletion(byAdmin.id!)).toMatchObject({ status: 'cancelled', decided_by: ADMIN })

  const b = await v.scheduleCommand('cc', { chatId: OWNER, chatType: 'private', messageId: 8, senderId: OWNER, eventId: null })
  // the router restarts before it is due: a new vault over the same router.db
  const after = vault()
  clock += 61_000
  expect(await after.tick()).toBe(1)
  expect(removed).toEqual([{ chatId: OWNER, id: 8 }])
  expect(edits.at(-1)).toEqual({ chatId: OWNER, id: sent.length + 1000, text: '🗑 已刪除含 key 的登記訊息' })
  expect(db.getDeletion(b.id!)!.status).toBe('deleted')
  expect(await after.cancel(`sdel:${b.id}:cancel`, OWNER)).toBe('訊息已經刪除了')
  // a 10e detection keeps its own rule: sender, owner or admin
  const d = db.scheduleDeletion({ event_id: 1, bot: 'cc', chat_id: USER, message_id: 9, sender: USER, notice_id: null, due_at: new Date(clock + 300_000).toISOString() })
  expect(db.getDeletion(d)!.kind).toBe('detect')
  expect(await after.cancel(`sdel:${d}:cancel`, OWNER)).toStartWith('已取消刪除')
})

test('scheduleCommand in a group: deleted 10 seconds later, a notice with no 取消刪除; without the right to delete only a reminder and nothing scheduled', async () => {
  expect(GROUP_COMMAND_DELETE_AFTER_MS).toBe(10_000)
  const v = vault(), GROUP = '-100500'
  const g = await v.scheduleCommand('cc', { chatId: GROUP, chatType: 'supergroup', messageId: 20, senderId: USER, eventId: null })
  expect(sent[0]).toEqual({ chatId: GROUP, text: '⏳ 這則訊息含有 key, 10 秒後 (12:00) 刪除.', replyTo: 20, buttons: undefined })
  expect(db.getDeletion(g.id!)).toMatchObject({ kind: 'command', status: 'pending', chat_id: GROUP, due_at: new Date(clock + 10_000).toISOString() })
  clock += 9_000
  expect(await v.tick()).toBe(0)
  clock += 1_000
  expect(await v.tick()).toBe(1)
  expect(removed).toEqual([{ chatId: GROUP, id: 20 }])
  expect(edits.at(-1)).toEqual({ chatId: GROUP, id: 1001, text: '🗑 已刪除含 key 的登記訊息' })
  // the bot may not delete there
  canDel = false
  const n = await v.scheduleCommand('cc', { chatId: GROUP, chatType: 'supergroup', messageId: 21, senderId: USER, eventId: null })
  expect(n).toEqual({ id: null, due: null, noticed: true })
  expect(sent.at(-1)).toEqual({ chatId: GROUP, text: '⚠️ 這則訊息含有 key. bot 沒有刪除權限, 請自己刪掉這則訊息.', replyTo: 21, buttons: undefined })
  expect(db.dueDeletions(new Date(clock + 3_600_000).toISOString())).toEqual([])
})

test('which messages wait 60 seconds (deleteLater) and which go at once: in your own DM add, rotate, a failed add, bot add|rotate wait; a group, a refusal, no right to the credential go at once', async () => {
  const later = { deleteMessage: true, deleteLater: true }
  expect(await run(`/router cred add a ${KEY} --http https://a.example`)).toMatchObject(later)
  expect(await run(`/router cred add b ${KEY}`)).toMatchObject(later) // not a bot token: a hint, still later
  expect(await run(`/router cred rotate a ${KEY2}`)).toMatchObject(later)
  expect(await run(`/router cred rotate nope ${KEY2}`)).toMatchObject({ ...later, reply: '找不到憑證 nope; 新增用 /router cred add' })
  const group = (await run(`/router cred add c ${KEY} --http https://a.example`, OWNER, '-100500', 'supergroup'))!
  expect(group.deleteMessage).toBe(true)
  expect(group.deleteLater).toBeUndefined()
  const groupRotate = (await run(`/router cred rotate a ${KEY}`, OWNER, '-100500', 'supergroup'))!
  expect(groupRotate).toMatchObject({ deleteMessage: true, reply: '⛔ /router cred rotate 只能在你自己和 bot 的私訊使用; token 曾出現在群組, 請到發 token 的地方換一把新的' })
  expect(groupRotate.deleteLater).toBeUndefined()
  // an admin and someone else's credential: refused, at once
  const notHis = (await run(`/router cred rotate a ${KEY2}`, ADMIN))!
  expect(notHis).toMatchObject({ reply: '⛔ admin 只能更換自己加入的憑證', deleteMessage: true })
  expect(notHis.deleteLater).toBeUndefined()
  const taken = (await run(`/router cred add a ${KEY2} --http https://b.example`, ADMIN))!
  expect(taken).toMatchObject({ reply: '⛔ 已經有名為 a 的憑證, 不是你加入的, 只有 owner 能取代', deleteMessage: true })
  expect(taken.deleteLater).toBeUndefined()
  expect(cfg.credentials.a!.token).toBe(KEY2)
  // a user role: /router is not theirs at all
  const user = (await run(`/router cred add d ${KEY} --http https://a.example`, USER))!
  expect(user.deleteLater).toBeUndefined()
  // /secret set: in a served chat later (a DM 60 seconds, a group 10: rawvault scheduleCommand), not served at once
  const sd: SecretDeps = { cfg: { owners: [OWNER], bots: [], secretKey: newSecretKey() }, db, loadAccess: () => ({ dmPolicy: 'allowlist', allowFrom: [OWNER], groups: { '-100500': { requireMention: false, allowFrom: [] } }, pending: {} }) as any, verifyBot: async () => '' }
  const secret = (t: string, sender: string, chatId = sender, chatType = 'private') => runSecretCommand({ bot: 'cc', text: t, senderId: sender, senderName: 'x', chatId, chatType }, sd)
  expect(await secret(`/secret set k ${KEY} --http https://a.example`, OWNER)).toMatchObject({ deleteMessage: true, deleteLater: true, deleteLabel: '含密鑰的訊息' })
  expect(await secret(`/secret set k ${KEY} --http https://a.example`, USER, '-100500', 'supergroup')).toMatchObject({ deleteMessage: true, deleteLater: true })
  const stranger = (await secret(`/secret set k ${KEY} --http https://a.example`, USER))!
  expect(stranger.deleteMessage).toBe(true)
  expect(stranger.deleteLater).toBeUndefined()
  const otherGroup = (await secret(`/secret set k ${KEY} --http https://a.example`, USER, '-100999', 'supergroup'))!
  expect(otherGroup.deleteMessage).toBe(true)
  expect(otherGroup.deleteLater).toBeUndefined()
  // the value is masked in rotate too (events, logs, the worker)
  expect(maskSecretText(`/router cred rotate a ${KEY2}`)).toBe('/router cred rotate a <已遮蔽>')
})

test('/router cred rotate keeps everything but the key; a bot token only after getMe, a value that is not one never sent; --default-header only for http; an admin rotates their own', async () => {
  await run(`/router cred add ant ${KEY} --http https://api.example.com --header x-api-key --default-header anthropic-version:2023-06-01 /v1/*`)
  await run('/router cred roles ant owner')
  const r = (await run(`/router cred rotate ant ${KEY2}`))!
  expect(r.reply).toBe('已更換憑證 ant 的 key\n其他設定不變: ant: http https://api.example.com, 標頭 x-api-key, 預設標頭 anthropic-version: 2023-06-01, 路徑 /v1/*, 角色 owner, 加入者 555')
  expect(cfg.credentials.ant).toMatchObject({ token: KEY2, baseUrl: 'https://api.example.com', header: 'x-api-key', scheme: '', methods: ['/v1/*'], roles: ['owner'], defaultHeaders: { 'anthropic-version': '2023-06-01' } })
  expect(JSON.stringify(r)).not.toContain(KEY2)
  expect((await run(`/router cred rotate ant ${KEY} /v2/*`))!.reply).toStartWith('/v2/* 不行: rotate 只換值, 後面只能接 --default-header <名稱>:<值>')
  expect((await run(`/router cred rotate ant ${KEY} --default-header x-api-key:1`))!.reply).toBe('預設標頭 x-api-key 是憑證放 key 的地方, 由 router 設定, 不能自己帶; 沒有更換')
  expect(cfg.credentials.ant!.token).toBe(KEY2)
  expect((await run('/router cred rotate ant'))!.reply).toStartWith('用法: /router cred rotate <名稱> <新的 key 或 token>')

  await run(`/router cred add tool ${BOT1} getStickerSet`)
  expect((await run(`/router cred rotate tool ${KEY}`))!.reply).toBe('tool 是 Telegram bot token 憑證, 這個值不像 bot token (數字:35 字元), 沒有更換, 也沒有拿去 Telegram 驗證')
  expect((await run(`/router cred rotate tool ${BOT2} --default-header a:b`))!.reply).toStartWith('--default-header 不行: rotate 只換值; 網址')
  expect(getMe).toEqual([BOT1])
  expect((await run(`/router cred rotate tool ${BOT2}`))!.reply).toBe('已更換憑證 tool 的 token: @tool2_bot (434343)\n其他設定不變: tool: Telegram bot token @tool2_bot (434343), 方法 getStickerSet, 角色 owner, admin, 加入者 555')
  expect(getMe).toEqual([BOT1, BOT2])

  await run(`/router cred add mine ${KEY} --http https://m.example`, ADMIN)
  expect((await run(`/router cred rotate mine ${KEY2}`, ADMIN))!.reply).toStartWith('已更換憑證 mine 的 key')
  expect((await run(`/router cred rotate mine ${KEY}`, OTHER_ADMIN))!.reply).toBe('⛔ admin 只能更換自己加入的憑證')
  expect(cfg.credentials.mine!.token).toBe(KEY2)
})

test('/router cred add of a name that exists: never replaced silently; 覆蓋 / 取消 only by the sender; 覆蓋 takes this add\'s settings and checks the role again; the value is dropped after 2 minutes, on 取消, or once used', async () => {
  await run(`/router cred add ant ${KEY} --http https://api.example.com --header x-api-key /v1/*`)
  const ask = (await run(`/router cred add ant ${KEY2} --http https://other.example`))!
  expect(ask.reply).toBe([
    '已經有名為 ant 的憑證:',
    'ant: http https://api.example.com, 標頭 x-api-key, 路徑 /v1/*, 角色 owner, admin, 加入者 555',
    '要用這次的設定整個取代嗎? (新的值只暫存在 router 記憶體 2 分鐘, 逾時或取消就丟棄)',
    '只想換 key, 其他設定不變: /router cred rotate ant <新的 key>',
  ].join('\n'))
  expect(ask).toMatchObject({ deleteMessage: true, deleteLater: true, buttons: [{ text: '覆蓋', data: `credow:${ask.staged}:ok` }, { text: '取消', data: `credow:${ask.staged}:cancel` }] })
  expect(JSON.stringify(ask)).not.toContain(KEY2)
  expect(cfg.credentials.ant!.token).toBe(KEY)
  const d = deps()
  expect(await decideCredOverwrite(`credow:${ask.staged}:ok`, ADMIN, d)).toEqual({ answer: '只有下指令的人能決定', text: null })
  expect(await decideCredOverwrite(`credow:${ask.staged}:cancel`, OWNER, d)).toEqual({ answer: '已取消', text: '已取消, 沒有覆蓋憑證 ant, 新的值已丟棄' })
  expect(staging.peek(ask.staged!)).toBeNull()
  expect(await decideCredOverwrite(`credow:${ask.staged}:ok`, OWNER, d)).toMatchObject({ answer: '已逾時或處理過, 新的值已丟棄' })
  expect(cfg.credentials.ant!.token).toBe(KEY)

  const again = (await run(`/router cred add ant ${KEY2} --http https://other.example`))!
  const ok = await decideCredOverwrite(`credow:${again.staged}:ok`, OWNER, d)
  expect(ok).toEqual({ answer: '已覆蓋', text: '已覆蓋. 已加入憑證 ant: http https://other.example\n路徑: 全部\n角色: owner, admin\nAPI key 只存在 router 設定檔, worker 用 http_api 工具使用' })
  expect(cfg.credentials.ant).toMatchObject({ token: KEY2, baseUrl: 'https://other.example', methods: ['*'] })
  expect(cfg.credentials.ant!.header).toBeUndefined()

  // an admin replaces their own the same way; the role is checked again when pressed
  await run(`/router cred add mine ${KEY} --http https://m.example`, ADMIN)
  const mine = (await run(`/router cred add mine ${KEY2} --http https://m.example`, ADMIN))!
  expect(mine.buttons).toHaveLength(2)
  db.setUserRole(ADMIN, 'user')
  expect(await decideCredOverwrite(`credow:${mine.staged}:ok`, ADMIN, d)).toEqual({ answer: '權限不足', text: '⛔ 沒有覆蓋憑證 mine: 只有 owner, 或加入它的 admin 能取代; 新的值已丟棄' })
  expect(cfg.credentials.mine!.token).toBe(KEY)

  // memory only, 2 minutes: expired values are dropped and the question edited (onExpire)
  expect(STAGE_TTL_MS).toBe(120_000)
  const expired: StagedCred[] = []
  const s = createCredStaging({ ttlMs: 30, onExpire: x => expired.push(x) })
  const id = s.stage({ bot: 'cc', name: 'x', token: KEY, methods: ['*'], addedBy: OWNER, chatId: OWNER })
  s.attach(id, 77)
  expect(s.size()).toBe(1)
  await Bun.sleep(80)
  expect(s.size()).toBe(0)
  expect(s.peek(id)).toBeNull()
  expect(expired).toMatchObject([{ name: 'x', messageId: 77 }])
})

test('default headers: --default-header in cred add, cred-import and /secret set (repeatable, name:value); never the key header or a refused header; /router cred header set|rm; shown in lists', async () => {
  expect(parseHttpScope(['--http', 'https://a.example', '--default-header', 'anthropic-version:2023-06-01', '--default-header', 'x-b:1:2', '/v1/*'])).toEqual({ baseUrl: 'https://a.example', placement: {}, paths: ['/v1/*'], defaultHeaders: { 'anthropic-version': '2023-06-01', 'x-b': '1:2' } })
  const err = (w: string[]) => (parseHttpScope(['--http', 'https://a.example', ...w]) as { error: string }).error
  expect(err(['--default-header'])).toStartWith('--default-header 後面要接 <名稱>:<值>')
  expect(err(['--default-header', ':x'])).toStartWith('--default-header 後面要接 <名稱>:<值>')
  expect(err(['--default-header', 'Authorization:x'])).toBe('預設標頭 Authorization 是憑證放 key 的地方, 由 router 設定, 不能自己帶')
  expect(err(['--header', 'x-api-key', '--default-header', 'X-Api-Key:x'])).toBe('預設標頭 X-Api-Key 是憑證放 key 的地方, 由 router 設定, 不能自己帶')
  expect(err(['--query', 'key', '--default-header', 'authorization:x'])).toStartWith('預設標頭 authorization 不能自己帶')
  expect(err(['--default-header', 'host:x'])).toStartWith('預設標頭 host 不能自己帶')
  expect(err(['--default-header', 'bad_name:x'])).toStartWith('預設標頭 bad_name 不行: 只能用英數與 -')
  expect(refuseDefaultHeader({ header: 'x-api-key' }, 'anthropic-version', '2023-06-01')).toBeNull()

  await run(`/router cred add ant ${KEY} --http https://api.example.com --header x-api-key --default-header anthropic-version:2023-06-01`)
  expect(cfg.credentials.ant!.defaultHeaders).toEqual({ 'anthropic-version': '2023-06-01' })
  expect((await run('/router cred header ant'))!.reply).toBe('ant 的預設標頭: anthropic-version: 2023-06-01')
  expect((await run('/router cred header ant set anthropic-beta:b1'))!.reply).toBe('ant 的預設標頭: anthropic-version: 2023-06-01, anthropic-beta: b1')
  // the same name (any case) updates it
  expect((await run('/router cred header ant set Anthropic-Beta:b2'))!.reply).toBe('ant 的預設標頭: anthropic-version: 2023-06-01, Anthropic-Beta: b2')
  expect(cfg.credentials.ant!.defaultHeaders).toEqual({ 'anthropic-version': '2023-06-01', 'Anthropic-Beta': 'b2' })
  expect((await run('/router cred header ant rm anthropic-beta'))!.reply).toBe('ant 的預設標頭: anthropic-version: 2023-06-01')
  expect((await run('/router cred header ant rm anthropic-version'))!.reply).toBe('ant 的預設標頭: (無)')
  expect(cfg.credentials.ant!.defaultHeaders).toBeUndefined()
  expect((await run('/router cred header ant set x-api-key:1'))!.reply).toBe('預設標頭 x-api-key 是憑證放 key 的地方, 由 router 設定, 不能自己帶')
  expect((await run('/router cred header ant'))!.reply).toBe('ant 的預設標頭: (無)')
  expect((await run('/router cred header ant bogus'))!.reply).toBe('用法: /router cred header <名稱> (列出) | /router cred header <名稱> set <標頭>:<值> (同名就更新) | /router cred header <名稱> rm <標頭> (http 憑證的預設標頭, 不用重貼 key)')
  expect((await run('/router cred header ant set'))!.reply).toStartWith('用法: /router cred header <名稱> (列出)')
  // no key in it: any chat, owner or the admin who added it
  expect((await run('/router cred header ant set a:1', ADMIN))!.reply).toBe('⛔ admin 只能調整自己加入的憑證')
  expect((await run('/router cred header ant set a:1', OWNER, '-100500', 'supergroup'))!.reply).toBe('ant 的預設標頭: a: 1')
  expect(credSummary('ant', cfg.credentials.ant!)).toBe('ant: http https://api.example.com, 標頭 x-api-key, 預設標頭 a: 1, 路徑 全部, 角色 owner, admin, 加入者 555')
  expect((await run('/router cred list'))!.reply).toBe('ant: http https://api.example.com, 標頭 x-api-key, 預設標頭 a: 1, 路徑 全部, 角色 owner, admin, 加入者 555')

  // cred-import (terminal): the same option
  writeFileSync(join(dir, 'k.env'), `ANT=${KEY}\n`)
  writeFileSync(cfg.path!, JSON.stringify({ bots: [{ name: 'cc', token: '1:x' }], home: dir, stateDir: cfg.stateDir, socket: cfg.socket, owners: [OWNER] }))
  const p = Bun.spawn(['bun', join(import.meta.dir, '..', 'main.ts'), '--config', cfg.path!, 'cred-import', 'imp', join(dir, 'k.env'), 'ANT', '--http', 'https://api.example.com', '--header', 'x-api-key', '--default-header', 'anthropic-version:2023-06-01'], { stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(p.stdout).text()
  expect(await p.exited).toBe(0)
  expect(out).toContain('已存入憑證 imp: http https://api.example.com, 標頭 x-api-key, 預設標頭 anthropic-version: 2023-06-01, 路徑 *')
  expect(JSON.parse(readFileSync(cfg.path!, 'utf8')).credentials.imp).toMatchObject({ token: KEY, defaultHeaders: { 'anthropic-version': '2023-06-01' } })
  const bad = Bun.spawn(['bun', join(import.meta.dir, '..', 'main.ts'), '--config', cfg.path!, 'cred-import', 'imp2', join(dir, 'k.env'), 'ANT', '--http', 'https://api.example.com', '--default-header', 'cookie:a'], { stdout: 'pipe', stderr: 'pipe' })
  expect(await new Response(bad.stderr).text()).toStartWith('預設標頭 cookie 不能自己帶')
  expect(await bad.exited).toBe(2)

  // /secret set --default-header: stored with the secret, used by http_api
  const sd: SecretDeps = { cfg: { owners: [OWNER], bots: [], secretKey: newSecretKey() }, db, loadAccess: () => ({ dmPolicy: 'allowlist', allowFrom: [OWNER], groups: {}, pending: {} }) as any, verifyBot: async () => '' }
  const r = (await runSecretCommand({ bot: 'cc', text: `/secret set s ${KEY} --http https://s.example --default-header x-team:whales`, senderId: OWNER, senderName: 'x', chatId: OWNER, chatType: 'private' }, sd))!
  expect(r.reply).toStartWith('已登記這個對話的密鑰 s: http https://s.example, 預設標頭 x-team: whales, 路徑 全部')
  expect(secretCred(db.getConvSecret('cc', OWNER, 's')!, KEY).defaultHeaders).toEqual({ 'x-team': 'whales' })
  expect((await runSecretCommand({ bot: 'cc', text: '/secret list', senderId: OWNER, senderName: 'x', chatId: OWNER, chatType: 'private' }, sd))!.reply).toContain('s: http https://s.example, 預設標頭 x-team: whales, 路徑 全部')
}, 20000)

test('/secret header: list, set (the same name in any case updates it), rm, without the value; any member of a served chat; the key header and refused headers cannot be defaults; a telegram-bot secret has none', async () => {
  const GROUP = '-100500'
  const sd: SecretDeps = { cfg: { owners: [OWNER], bots: [], secretKey: newSecretKey() }, db, loadAccess: () => ({ dmPolicy: 'allowlist', allowFrom: [OWNER], groups: { [GROUP]: { requireMention: false, allowFrom: [] } }, pending: {} }) as any, verifyBot: async () => '@t_bot (1)' }
  const sec = async (text: string, sender = USER) => (await runSecretCommand({ bot: 'cc', text, senderId: sender, senderName: 'x', chatId: GROUP, chatType: 'supergroup' }, sd))!
  await sec(`/secret set ant ${KEY} --http https://api.example.com --header x-api-key --default-header anthropic-version:2023-06-01 /v1/*`)
  const before = db.getConvSecret('cc', GROUP, 'ant')!
  expect((await sec('/secret header ant')).reply).toBe('ant 的預設標頭: anthropic-version: 2023-06-01')
  const set = await sec('/secret header ant set anthropic-beta:b1')
  expect(set.reply).toBe('ant 的預設標頭: anthropic-version: 2023-06-01, anthropic-beta: b1')
  // no value in it: nothing to delete
  expect(set.deleteMessage).toBeUndefined()
  expect((await sec('/secret header ant set Anthropic-Version:2099-01-01', OWNER)).reply).toBe('ant 的預設標頭: anthropic-beta: b1, Anthropic-Version: 2099-01-01')
  expect((await sec('/secret header ant rm ANTHROPIC-BETA')).reply).toBe('ant 的預設標頭: Anthropic-Version: 2099-01-01')
  // the value, URL, key header, paths stay
  const after = db.getConvSecret('cc', GROUP, 'ant')!
  expect({ ...after, default_headers: null }).toEqual({ ...before, default_headers: null })
  expect(secretCred(after, KEY).defaultHeaders).toEqual({ 'Anthropic-Version': '2099-01-01' })
  expect((await sec('/secret header ant rm anthropic-version')).reply).toBe('ant 的預設標頭: (無)')
  expect(db.getConvSecret('cc', GROUP, 'ant')!.default_headers).toBeNull()
  expect((await sec('/secret header ant')).reply).toBe('ant 的預設標頭: (無)')
  expect((await sec('/secret header ant rm nothing')).reply).toBe('ant 沒有預設標頭 nothing')
  expect((await sec('/secret header ant set x-api-key:1')).reply).toBe('預設標頭 x-api-key 是憑證放 key 的地方, 由 router 設定, 不能自己帶')
  expect((await sec('/secret header ant set cookie:a=b')).reply).toStartWith('預設標頭 cookie 不能自己帶')
  expect((await sec('/secret header ant set novalue')).reply).toStartWith('--default-header 後面要接 <名稱>:<值>')
  expect((await sec('/secret header ant bogus x')).reply).toBe('用法: /secret header <名稱> (列出) | /secret header <名稱> set <標頭>:<值> | /secret header <名稱> rm <標頭>')
  expect((await sec('/secret header')).reply).toStartWith('用法: /secret header <名稱> (列出)')
  expect((await sec('/secret header nope')).reply).toBe('這個對話沒有名為 nope 的密鑰')
  await sec(`/secret set tb ${BOT1}`)
  expect((await sec('/secret header tb set a:b')).reply).toBe('tb 是 Telegram bot token 密鑰, 沒有標頭可設')
  // another chat does not see it
  expect((await runSecretCommand({ bot: 'cc', text: '/secret header ant', senderId: OWNER, senderName: 'x', chatId: OWNER, chatType: 'private' }, sd))!.reply).toBe('這個對話沒有名為 ant 的密鑰')
  // listed in the usage
  expect((await sec('/secret help')).reply).toContain('/secret header <名稱> (列出) | header <名稱> set <標頭>:<值> (同名就更新) | header <名稱> rm <標頭>')
})

test('httpApiCall: default headers go out unless the worker sends one of that name (any case); jsonText is sent as it is with content-type application/json (a local server sees it)', async () => {
  const seen: Array<{ headers: Record<string, string>; body: string }> = []
  const srv = Bun.serve({ port: 0, async fetch(req) { seen.push({ headers: Object.fromEntries(req.headers.entries()), body: await req.text() }); return Response.json({ ok: 1 }) } })
  try {
    const cred = { token: KEY, kind: 'http' as const, baseUrl: `http://127.0.0.1:${srv.port}`, methods: ['*'], header: 'x-api-key', scheme: '', defaultHeaders: { 'anthropic-version': '2023-06-01', 'x-b': 'd' } }
    await httpApiCall({ cred, method: 'POST', path: '/v1/messages/count_tokens', jsonText: '{"a":  1}' })
    expect(seen[0]!.headers).toMatchObject({ 'anthropic-version': '2023-06-01', 'x-b': 'd', 'x-api-key': KEY, 'content-type': 'application/json' })
    expect(seen[0]!.body).toBe('{"a":  1}')
    await httpApiCall({ cred, method: 'POST', path: '/x', json: { a: 1 }, headers: { 'Anthropic-Version': '2099-01-01' } })
    expect(seen[1]!.headers['anthropic-version']).toBe('2099-01-01')
    expect(seen[1]!.headers['x-b']).toBe('d')
    expect(seen[1]!.body).toBe('{"a":1}')
  } finally { srv.stop(true) }
})

test('readJsonFile: user and power only inside their folder (.., a symlink out refused); owner and admin anywhere the router reads but router state (after symlinks); over 20 MB refused; not JSON refused with why; only one body', () => {
  const folder = join(dir, 'bot1', 'dm-1'), state = join(dir, '.router')
  mkdirSync(join(folder, 'req'), { recursive: true })
  writeFileSync(join(folder, 'req', 'a.json'), '{"x": [1, 2]}')
  // the role rule main.ts applies (the conversation's role, an elevated one included)
  expect(['owner', 'admin', 'power', 'user'].map(jsonFileAnywhere)).toEqual([true, true, false, false])
  const narrow = { wide: false, stateDir: state }, wide = { wide: true, stateDir: state }
  const read = (a: Record<string, unknown>, o = narrow) => readJsonFile(a, folder, o)
  expect(read({})).toBeNull()
  expect(read({ json_file: 'req/a.json' })).toEqual({ text: '{"x": [1, 2]}', path: join(folder, 'req', 'a.json'), bytes: 13 })
  expect(read({ json_file: join(folder, 'req', 'a.json') })).toMatchObject({ bytes: 13 })
  expect(read({ json_file: 'req/a.json', files: {} })).toMatchObject({ bytes: 13 })
  writeFileSync(join(dir, 'out.json'), '{"out": true}')
  expect(read({ json_file: '../../out.json' })).toEqual({ error: 'json_file ../../out.json 要在這個對話的資料夾裡' })
  expect(read({ json_file: join(dir, 'out.json') })).toEqual({ error: `json_file ${join(dir, 'out.json')} 要在這個對話的資料夾裡` })
  symlinkSync(join(dir, 'out.json'), join(folder, 'l.json'))
  expect(read({ json_file: 'l.json' })).toEqual({ error: 'json_file l.json 要在這個對話的資料夾裡' })
  // owner and admin: outside the folder is read (relative, absolute, through a symlink)
  expect(read({ json_file: '../../out.json' }, wide)).toEqual({ text: '{"out": true}', path: join(dir, 'out.json'), bytes: 13 })
  expect(read({ json_file: join(dir, 'out.json') }, wide)).toMatchObject({ bytes: 13 })
  expect(read({ json_file: 'l.json' }, wide)).toMatchObject({ path: join(dir, 'out.json') })
  // router state never, for any role: directly, through a symlink, or a folder inside it
  writeFileSync(join(state, 'config.json'), '{}')
  for (const o of [narrow, wide]) expect(read({ json_file: join(state, 'config.json') }, o)).toEqual({ error: `json_file ${join(state, 'config.json')} 在 router 的狀態目錄裡, 不能送出` })
  symlinkSync(join(state, 'config.json'), join(folder, 'cfg.json'))
  for (const o of [narrow, wide]) expect(read({ json_file: 'cfg.json' }, o)).toEqual({ error: 'json_file cfg.json 在 router 的狀態目錄裡, 不能送出' })
  const inState = join(state, 'conv')
  mkdirSync(inState)
  writeFileSync(join(inState, 'c.json'), '{}')
  expect(readJsonFile({ json_file: 'c.json' }, inState, narrow)).toEqual({ error: 'json_file c.json 在 router 的狀態目錄裡, 不能送出' })
  expect(read({ json_file: 'missing.json' })).toEqual({ error: '找不到 json_file missing.json' })
  expect(read({ json_file: 3 })).toMatchObject({ error: 'json_file 要是檔案路徑 (相對於這個對話的資料夾, 或絕對路徑)' })
  // size, JSON and one body: the same for owner and admin
  writeFileSync(join(folder, 'max.json'), '')
  truncateSync(join(folder, 'max.json'), MAX_JSON_FILE + 1)
  for (const o of [narrow, wide]) expect(read({ json_file: 'max.json' }, o)).toEqual({ error: `json_file max.json 有 ${MAX_JSON_FILE + 1} bytes, 超過上限 ${MAX_JSON_FILE} bytes (20 MB)` })
  writeFileSync(join(folder, 'bad.json'), 'not json')
  for (const o of [narrow, wide]) expect((read({ json_file: 'bad.json' }, o) as { error: string }).error).toMatch(/^json_file bad\.json 不是合法的 JSON \(.+\), 沒有送出$/)
  for (const other of [{ json: {} }, { json: null }, { form: {} }, { files: { a: 'x' } }]) expect(read({ json_file: 'req/a.json', ...other }, wide)).toEqual({ error: 'json_file 與 json, form, files 只能擇一: 請求內容只能有一種' })
})
