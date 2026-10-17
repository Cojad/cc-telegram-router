// Conversation secrets (plan 10b 對話專屬密鑰): sealing, masking, the /secret
// and /router secret commands, the use checks, getMe for bot tokens,
// --header. Also: masking every token-carrying command in the events table
// (and the one-time migration), dot segments in global http credential
// paths, bot settings notices (group privacy, bot-to-bot). Keep in sync with
// README 「對話專屬密鑰」「bot 設定提醒」 and /telegram:bot-skill; end to end in
// e2e-secrets.test.ts.

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openRouterDb, type RouterDb } from '../db'
import { sealSecret, openSecret, newSecretKey, maskSecretText, maskSecretUpdate, scrubSecret, refuseSecret, runSecretCommand, MAX_SECRETS, type SecretDeps } from '../secrets'
import { runCommand, isCommand, type CommandDeps } from '../commands'
import { parseRelay } from '../relay'
import { buildReplyMeta } from '../telegram/inbound'
import type { Access } from '../telegram/policy'
import { refuseUse, badPath } from '../credentials'
import { privacyNotice, botSettingsNotice, B2B_NOTICE, escHtml, htmlToText } from '../setup'

const OWNER = '137438526', MEMBER = '700', STRANGER = '800', GROUP = '-100700'
let dir: string, db: RouterDb, deps: SecretDeps, access: Access
const key = newSecretKey()
// stands in for getMe: tokens "<digits>:..." are bots, anything else 401
const verifyBot = async (t: string) => { if (!/^\d+:/.test(t)) throw new Error('401: Unauthorized'); return '@fake_bot (1)' }
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cctr-sec-'))
  mkdirSync(join(dir, '.router'))
  db = openRouterDb(join(dir, '.router', 'router.db'))
  access = { dmPolicy: 'allowlist', allowFrom: [OWNER, MEMBER], groups: { [GROUP]: { requireMention: true, allowFrom: [] } }, pending: {} }
  deps = { cfg: { owners: [OWNER], bots: [{ name: 'cc', token: '1:routerbot' }], secretKey: key }, db, loadAccess: () => access, verifyBot }
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

const dm = (uid: string, text: string) => ({ bot: 'cc', text, senderId: uid, senderName: `u${uid}`, chatId: uid, chatType: 'private' })
const grp = (uid: string, text: string) => ({ bot: 'cc', text, senderId: uid, senderName: `u${uid}`, chatId: GROUP, chatType: 'supergroup' })

test('seal/open: AES-256-GCM, a fresh IV each time, bound to bot, chat and name; a wrong key or another row fails', async () => {
  const a = sealSecret(key, 'cc', MEMBER, 'mykey', 'sk-fake-value')
  const b = sealSecret(key, 'cc', MEMBER, 'mykey', 'sk-fake-value')
  expect(a).toStartWith('v1:')
  expect(a).not.toBe(b)
  expect(a).not.toContain('sk-fake-value')
  expect(openSecret(key, 'cc', MEMBER, 'mykey', a)).toBe('sk-fake-value')
  expect(() => openSecret(key, 'cc', MEMBER, 'other', a)).toThrow()
  expect(() => openSecret(key, 'cc', OWNER, 'mykey', a)).toThrow()
  expect(() => openSecret(newSecretKey(), 'cc', MEMBER, 'mykey', a)).toThrow()
})

test('masking: the value is <已遮蔽> in text, "cc /secret", every string of an update and reply quotes; responses have the value scrubbed', async () => {
  expect(maskSecretText('/secret set openai sk-fake --http https://x.example /v1/*')).toBe('/secret set openai <已遮蔽> --http https://x.example /v1/*')
  expect(maskSecretText('cc /secret@my_bot set mybot 123456:ABCDEFGHIJ')).toBe('cc /secret@my_bot set mybot <已遮蔽>')
  expect(maskSecretText('/secret set onlyvalue')).toBe('/secret set <已遮蔽>')
  expect(maskSecretText('/secret list')).toBe('/secret list')
  const u = maskSecretUpdate({ update_id: 1, message: { text: '/secret set k sk-fake', chat: { id: 5 }, reply_to_message: { text: 'hi' } } })
  expect(JSON.stringify(u)).not.toContain('sk-fake')
  expect(u.message.chat.id).toBe(5)
  expect(buildReplyMeta({ message_id: 9, date: 0, chat: { id: 1, type: 'group', title: 't' }, text: '/secret set k sk-fake-quoted' } as any).reply_to_text).toBe('/secret set k <已遮蔽>')
  expect(scrubSecret('{"echo":"sk-fake-123","t":"123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}', 'sk-fake-123')).toBe('{"echo":"<密鑰>","t":"123456789:…AAAA"}')
})

test('/secret is a router command, also as "cc /secret"; /secret@another_bot is not for this bot', async () => {
  expect(isCommand('/secret list')).toBe(true)
  expect(isCommand('/secret@cc_bot set a b')).toBe(true)
  expect(parseRelay('cc /secret set a b')).toEqual({ cmd: '/secret', args: 'set a b', raw: false })
  expect(await runSecretCommand({ ...dm(MEMBER, '/secret@other_bot list'), botUsername: 'cc_bot' }, deps)).toBeNull()
  expect((await runSecretCommand({ ...dm(MEMBER, '/secret@cc_bot list'), botUsername: 'cc_bot' }, deps))!.reply).toStartWith('這個對話還沒有密鑰')
})

test('/secret set in a DM (any role): stored sealed, the message deleted, the worker log masked; list shows name, kind, scope only; rm', async () => {
  const r = (await runSecretCommand(dm(MEMBER, '/secret set openai sk-fake-1 --http https://api.example.com/ /v1/images/* /v1/models'), deps))!
  expect(r.reply).toBe('已登記這個對話的密鑰 openai: http https://api.example.com, 路徑 /v1/images/*, /v1/models\n值加密存在 router, 只有這個對話能用 (http_api 工具, credential 填 openai)')
  expect(r).toMatchObject({ deleteMessage: true, deleteLabel: '含密鑰的訊息' })
  const row = db.getConvSecret('cc', MEMBER, 'openai')!
  expect(row).toMatchObject({ kind: 'http', base_url: 'https://api.example.com', allowed: '["/v1/images/*","/v1/models"]', added_by: MEMBER })
  expect(row.value).not.toContain('sk-fake-1')
  expect(openSecret(key, 'cc', MEMBER, 'openai', row.value)).toBe('sk-fake-1')
  // telegram-bot kind: methods optional, none = all
  expect((await runSecretCommand(dm(MEMBER, '/secret set mybot 123:fake-token'), deps))!.reply).toStartWith('已登記這個對話的密鑰 mybot: telegram-bot @fake_bot (1), 方法 全部')
  expect((await runSecretCommand(dm(MEMBER, '/secret set mybot 123:fake-token sendMessage get*'), deps))!.reply).toStartWith('已更新這個對話的密鑰 mybot: telegram-bot @fake_bot (1), 方法 sendMessage, get*')
  const list = (await runSecretCommand(dm(MEMBER, '/secret list'), deps))!
  expect(list.reply).toBe(`這個對話的密鑰 (2/${MAX_SECRETS}):\nmybot: telegram-bot @fake_bot (1), 方法 sendMessage, get*\nopenai: http https://api.example.com, 路徑 /v1/images/*, /v1/models`)
  expect(list.deleteMessage).toBeUndefined()
  // only this chat sees them
  expect((await runSecretCommand(dm(OWNER, '/secret list'), deps))!.reply).toStartWith('這個對話還沒有密鑰')
  expect((await runSecretCommand(dm(MEMBER, '/secret rm openai'), deps))!.reply).toBe('已移除密鑰 openai')
  expect((await runSecretCommand(dm(MEMBER, '/secret rm openai'), deps))!.reply).toBe('這個對話沒有名為 openai 的密鑰')
})

test('/secret set refusals: bad name, self, too long, the router\'s own token, bad URL or path, 20 per conversation; the message is deleted whenever a value was in it', async () => {
  const say = async (t: string) => (await runSecretCommand(dm(MEMBER, t), deps))!
  expect((await say('/secret set Bad_Name v')).reply).toStartWith('用法:')
  expect((await say('/secret set self v')).reply).toBe('self 是 bot_api 保留給 bot 自己的名稱, 換一個名稱')
  expect((await say(`/secret set big ${'x'.repeat(4097)}`)).reply).toBe('值太長, 最多 4096 bytes')
  expect((await say('/secret set mine 1:routerbot')).reply).toStartWith('⛔ 這是 router 自己的 bot token')
  expect((await say('/secret set k v --http ftp://x.example')).reply).toStartWith('--http 後面要接網址')
  expect((await say('/secret set k v --http https://user:pw@x.example')).reply).toStartWith('--http 後面要接網址')
  expect((await say('/secret set k v --http https://x.example v1')).reply).toStartWith('路徑 v1 不行')
  expect((await say('/secret set k v --http https://x.example /v1/../admin')).reply).toStartWith('路徑 /v1/../admin 不行')
  expect((await say('/secret set k v send-message')).reply).toStartWith('方法 send-message 不像 Bot API 方法名稱')
  const r = await say('/secret set Bad v')
  expect(r.deleteMessage).toBe(true)
  for (let i = 0; i < MAX_SECRETS; i++) await say(`/secret set k${i} 9:v${i}`)
  expect((await say('/secret set one-more 9:x')).reply).toBe(`這個對話已經有 ${MAX_SECRETS} 把密鑰, 先 /secret rm 不用的`)
  expect((await say('/secret set k0 9:replaced')).reply).toStartWith('已更新') // replacing does not count
  expect(db.listConvSecrets('cc', MEMBER)).toHaveLength(MAX_SECRETS)
})

test('/secret in a group: any member, any role; only groups (and senders) the router serves; DMs only from allowed senders', async () => {
  db.setUserRole(MEMBER, 'guest')
  const r = (await runSecretCommand(grp(MEMBER, '/secret set gk 9:sk-group'), deps))!
  expect(r.reply).toStartWith('已登記這個對話的密鑰 gk')
  expect(r.deleteMessage).toBe(true)
  expect(db.getConvSecret('cc', GROUP, 'gk')!.added_by).toBe(MEMBER)
  expect((await runSecretCommand(grp(STRANGER, '/secret list'), deps))!.reply).toContain('gk: telegram-bot')
  access.groups[GROUP]!.allowFrom = [OWNER]
  expect((await runSecretCommand(grp(STRANGER, '/secret set gk2 v'), deps))!).toMatchObject({ reply: '⛔ 這個對話沒有開放給 bot 使用, 不能登記密鑰; 值曾出現在這裡, 請到發出它的地方換一把新的', deleteMessage: true })
  expect((await runSecretCommand({ ...grp(MEMBER, '/secret set x v'), chatId: '-100999' }, deps))!.reply).toStartWith('⛔ 這個對話沒有開放')
  expect((await runSecretCommand(dm(STRANGER, '/secret set x v'), deps))!.reply).toStartWith('⛔ 這個對話沒有開放')
})

test('refuseSecret: only the kind, methods or paths given at registration; no role involved; path tricks refused', async () => {
  const s = (kind: 'telegram-bot' | 'http', allowed: string[]) => ({ bot: 'cc', chat_id: MEMBER, name: 'k', kind, value: '', base_url: kind === 'http' ? 'https://x.example' : null, allowed: JSON.stringify(allowed), added_by: MEMBER, created_at: '' })
  expect(refuseSecret(s('telegram-bot', ['*']), 'anyMethod', 'telegram-bot')).toBeNull()
  expect(refuseSecret(s('telegram-bot', ['sendMessage']), 'getMe', 'telegram-bot')).toBe('密鑰 k 沒有開放 getMe (允許: sendMessage); 要改範圍就重新 /secret set')
  expect(refuseSecret(s('telegram-bot', ['*']), '/v1', 'http')).toBe('密鑰 k 是 telegram-bot 類, 要用 bot_api 工具')
  expect(refuseSecret(s('http', ['/v1/*']), '/v1/models', 'http')).toBeNull()
  expect(refuseSecret(s('http', ['/v1/*']), '/v2/models', 'http')).toContain('沒有開放 /v2/models')
  expect(refuseSecret(s('http', ['/v1/*']), '/v1/../admin', 'http')).toContain('不能含 ..')
  expect(refuseSecret(s('http', ['/v1/*']), '/v1/%2e%2e/admin', 'http')).toContain('不能含 ..')
  expect(refuseSecret(s('http', ['*']), 'evil.example/x', 'http')).toBe('path 要以 / 開頭')
})

test('/router secret list|rm: owner and admin see and remove any conversation\'s secrets; others are refused', async () => {
  await runSecretCommand(dm(MEMBER, '/secret set a 9:v1'), deps)
  await runSecretCommand(dm(MEMBER, '/secret set b v2 --http https://x.example'), deps)
  await runSecretCommand(grp(MEMBER, '/secret set g 9:v3'), deps)
  const cdeps = { cfg: { owners: [OWNER], bots: [{ name: 'cc', token: '1:routerbot' }], secretKey: key, credentials: {} }, db, loadAccess: () => access, verifyBot } as unknown as CommandDeps
  const run = (uid: string, text: string) => runCommand(dm(uid, text), cdeps)
  expect((await run(OWNER, '/router secret list'))!).toMatchObject({ reply: `cc ${GROUP}: 1 把\ncc ${MEMBER}: 2 把`, private: true })
  expect((await run(OWNER, `/router secret list ${MEMBER}`))!.reply).toBe('a: telegram-bot @fake_bot (1), 方法 全部\nb: http https://x.example, 路徑 全部')
  expect((await run(OWNER, `/router secret rm ${MEMBER} a`))!.reply).toBe(`已移除對話 ${MEMBER} 的密鑰 a`)
  db.setUserRole('900', 'admin')
  expect((await run('900', `/router secret rm ${GROUP}`))!.reply).toBe(`已移除對話 ${GROUP} 的全部 1 把密鑰`)
  expect((await run(MEMBER, `/router secret list ${MEMBER}`))!.reply).toStartWith('⛔')
  expect(db.listConvSecrets('cc', MEMBER).map(s => s.name)).toEqual(['b'])
  // /secret goes through runCommand too, for any role
  expect((await run(MEMBER, '/secret list'))!.reply).toContain('b: http')
})

test('the worker is told: bot_api / http_api descriptions, /telegram:bot-skill and /telegram:doc explain conversation secrets', async () => {
  const { TOOL_DEFINITIONS: TOOLS } = await import('../../shared/tools') as any
  const desc = (n: string) => (TOOLS as Array<{ name: string; description: string }>).find(t => t.name === n)!.description
  expect(desc('bot_api')).toContain('/secret set')
  expect(desc('http_api')).toContain('/secret set')
  expect(desc('http_api')).toContain('<密鑰>')
  const root = join(import.meta.dir, '..', '..', 'plugin', 'skills')
  const skill = await Bun.file(join(root, 'bot-skill', 'SKILL.md')).text()
  for (const s of ['### 對話專屬密鑰', '/secret set <名稱> <token> [方法...]', '--http <網址>', '/secret list', '/secret rm <名稱>', '<已遮蔽>', '<密鑰>', '不要叫他把值貼給你', '[--header <標頭>] [--scheme <前綴>]', '--header x-api-key', '先用 getMe 驗證']) expect(skill).toContain(s)
  const doc = await Bun.file(join(root, 'doc', 'SKILL.md')).text()
  for (const s of ['/secret set', '/router secret list|rm <chat_id>']) expect(doc).toContain(s)
})

test('telegram-bot secrets are checked with getMe before they are stored: a token getMe refuses is not stored, the message still deleted; http keys are not', async () => {
  const seen: string[] = []
  deps.verifyBot = async t => { seen.push(t); if (t !== '42:real') throw new Error('401: Unauthorized'); return '@real_bot (42)' }
  const bad = (await runSecretCommand(dm(MEMBER, '/secret set b 42:fake'), deps))!
  expect(bad).toMatchObject({ reply: '這不是可用的 bot token (getMe 失敗: 401: Unauthorized), 沒有登記', deleteMessage: true })
  expect(db.getConvSecret('cc', MEMBER, 'b')).toBeNull()
  expect((await runSecretCommand(dm(MEMBER, '/secret set b 42:real'), deps))!.reply).toStartWith('已登記這個對話的密鑰 b: telegram-bot @real_bot (42), 方法 全部')
  expect(db.getConvSecret('cc', MEMBER, 'b')!.label).toBe('@real_bot (42)')
  await runSecretCommand(dm(MEMBER, '/secret set h sk-x --http https://x.example'), deps)
  expect(seen).toEqual(['42:fake', '42:real'])
})

test('--header / --scheme: default Authorization: Bearer; --header alone sends the key as it is; both together; reserved or malformed headers refused; same fields as a global http credential', async () => {
  const set = async (t: string) => (await runSecretCommand(dm(MEMBER, t), deps))!.reply
  expect(await set('/secret set a sk-a --http https://x.example /v1/*')).toStartWith('已登記這個對話的密鑰 a: http https://x.example, 路徑 /v1/*')
  expect(await set('/secret set b sk-b --http https://x.example --header x-api-key /v1/*')).toStartWith('已登記這個對話的密鑰 b: http https://x.example, 標頭 x-api-key, 路徑 /v1/*')
  expect(await set('/secret set c sk-c --http https://x.example /v1/* --header X-Key --scheme Token')).toStartWith('已登記這個對話的密鑰 c: http https://x.example, 標頭 X-Key (Token <key>), 路徑 /v1/*')
  expect(await set('/secret set d sk-d --http https://x.example --scheme Token')).toStartWith('已登記這個對話的密鑰 d: http https://x.example, 標頭 Authorization (Token <key>), 路徑 全部')
  expect(await set('/secret set e sk-e --http https://x.example --header Host')).toStartWith('標頭 Host 不行')
  expect(await set('/secret set e sk-e --http https://x.example --header "x:y"')).toStartWith('標頭 "x:y" 不行')
  expect(await set('/secret set e sk-e --http https://x.example --header')).toBe('--header 後面要接標頭名稱, 例如 --header x-api-key')
  const row = (n: string) => db.getConvSecret('cc', MEMBER, n)!
  expect([row('a').header, row('a').scheme]).toEqual([null, null])
  expect([row('b').header, row('b').scheme]).toEqual(['x-api-key', ''])
  expect([row('c').header, row('c').scheme]).toEqual(['X-Key', 'Token'])
  // the Credential handed to httpApiCall carries them like a global one ({ header, scheme } in config.json)
  const { secretCred } = await import('../secrets')
  expect(secretCred(row('b'), 'sk-b')).toMatchObject({ token: 'sk-b', kind: 'http', baseUrl: 'https://x.example', header: 'x-api-key', scheme: '' })
  expect(secretCred(row('a'), 'sk-a')).not.toHaveProperty('header')
  const seen: Record<string, string | null> = {}
  const api = Bun.serve({ port: 0, fetch(req) { seen.k = req.headers.get('x-api-key'); seen.a = req.headers.get('authorization'); return Response.json({}) } })
  try {
    const { httpApiCall } = await import('../credentials')
    await httpApiCall({ cred: { ...secretCred(row('b'), 'sk-b'), baseUrl: `http://127.0.0.1:${api.port}` }, method: 'GET', path: '/v1/x' })
    expect(seen).toEqual({ k: 'sk-b', a: null })
  } finally { api.stop(true) }
})

test('events masking covers every command that carries a token: /secret set, /router cred add, /router bot add|rotate (also "cc /...")', () => {
  expect(maskSecretText('/router cred add eagle 777:BBBBBBBBBBBBBBBBBBBB addStickerToSet')).toBe('/router cred add eagle <已遮蔽> addStickerToSet')
  expect(maskSecretText('/router@cc_bot cred add openai sk-x --http https://x.example')).toBe('/router@cc_bot cred add openai <已遮蔽> --http https://x.example')
  expect(maskSecretText('/router bot add two 888:CCCCCCCCCCCCCCCCCCCC')).toBe('/router bot add two <已遮蔽>')
  expect(maskSecretText('cc /router bot rotate cc 888:DDDDDDDDDDDDDDDDDDDD')).toBe('cc /router bot rotate cc <已遮蔽>')
  expect(maskSecretText('/router cred list')).toBe('/router cred list')
  expect(maskSecretText('/router bot list')).toBe('/router bot list')
})

test('one-time events migration: logged updates with a token are masked, only the count comes back, it runs once', () => {
  const raw = (text: string) => ({ update_id: 1, message: { message_id: 1, chat: { id: 5, type: 'private' }, text } })
  db.logEvent('cc', raw('/router cred add eagle 777:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'))
  db.logEvent('cc', raw('/secret set k sk-old-plain'))
  db.logEvent('cc', raw('/router status'))
  db.logEvent('cc', raw('hello'))
  expect(db.maskEventsOnce('mask-events-1', maskSecretUpdate)).toBe(2)
  expect(db.maskEventsOnce('mask-events-1', maskSecretUpdate)).toBeNull()
  const { Database } = require('bun:sqlite')
  const d = new Database(join(dir, '.router', 'router.db'), { readonly: true })
  const all = (d.query('SELECT update_json FROM events').all() as Array<{ update_json: string }>).map(r => r.update_json).join('\n')
  d.close()
  expect(all).not.toContain('BBBBBBBBBB')
  expect(all).not.toContain('sk-old-plain')
  expect(all).toContain('/router cred add eagle <已遮蔽>')
  expect(all).toContain('/router status')
})

test('global http credentials: dot segments and their encodings are refused before the prefix match (new URL would resolve them)', () => {
  const c = { token: 'k', kind: 'http' as const, baseUrl: 'https://x.example', methods: ['/v1/images/*'] }
  expect(refuseUse(c, 'openai', 'owner', '/v1/images/generations', 'http')).toBeNull()
  expect(new URL('https://x.example/v1/images/../files').pathname).toBe('/v1/files')
  for (const p of ['/v1/images/../files', '/v1/images/./x', '/v1/images/%2e%2e/files', '/v1/images/%2E./files', '/v1/images/..%2ffiles', '/v1/images/..\\files', '/v1/images/x#y'])
    expect(refuseUse(c, 'openai', 'owner', p, 'http')).toStartWith('path 不能含')
  expect(refuseUse(c, 'openai', 'owner', '/v1/images/x?q=../y', 'http')).toBeNull() // the query is not part of the path
  expect(badPath('v1/x')).toBe('path 要以 / 開頭')
})

test('group privacy notice (柯姊 wording): what on and off mean, the current setting from getMe (true = off), how to turn it off, re-add after changing, admins are not limited; the bot-to-bot notice says it cannot be checked', () => {
  // HTML now (bold, parse_mode HTML): the words are unchanged
  const on = htmlToText(privacyNotice({ username: 'x_bot', can_read_all_group_messages: false })!)
  const off = htmlToText(privacyNotice({ username: 'x_bot', can_read_all_group_messages: true })!)
  for (const n of [on, off]) for (const s of ['🔒 群組隱私模式 (Group Privacy)', '每隻 bot 預設都是開啟的', '用名字叫它 (例如「柯柯」)', '通常要改為關閉', '私訊 @BotFather → /setprivacy → 選這隻 bot → Disable.', '⚠️ 兩件很重要的事:', '1. 改完之後, 要把 bot 從群組移除再重新加入才會生效', '2. 如果 bot 是該群組的管理員, 就不受隱私模式限制']) expect(n).toContain(s)
  expect(on).toContain('你目前 Group Privacy 設定: ⚠️ 開啟 (ℹ️ Bot 無法看到每則群組訊息, 建議改為關閉)')
  expect(off).toContain('你目前 Group Privacy 設定: ✅ 關閉 (Bot 可以看到每則群組訊息, 符合建議的設定)')
  expect(htmlToText(privacyNotice({ username: 'x_bot' })!)).toBe(on) // missing = on
  expect(privacyNotice(null)).toBeNull()
  for (const s of ['🤖 Bot 之間互傳訊息 (Bot-to-Bot Communication Mode)', '預設關閉. router 沒辦法查到它目前是開是關', '私訊要兩隻 bot 都開啟才能互傳', '設定方式: 私訊 @BotFather → /setbot2bot → 選這隻 bot → Enable (開啟) 或 Disable (關閉); 也可以在 @BotFather 的 Mini App 裡設定.', '包括 /secret 這類指令', '互相回覆停不下來']) expect(htmlToText(B2B_NOTICE)).toContain(s)
})

test('the settings notices are bold where 柯姊\'s reviewed draft is (parse_mode HTML), emoji and the rest not', () => {
  const bold = (html: string) => [...html.matchAll(/<b>([^<]*)<\/b>/g)].map(m => m[1])
  expect(bold(privacyNotice({ username: 'x_bot', can_read_all_group_messages: false })!)).toEqual([
    '群組隱私模式 (Group Privacy)', '開啟 (預設):', '關閉:', '關閉方式:', '兩件很重要的事:',
    '改完之後, 要把 bot 從群組移除再重新加入才會生效.', '如果 bot 是該群組的管理員, 就不受隱私模式限制',
  ])
  expect(bold(B2B_NOTICE)).toEqual(['Bot 之間互傳訊息 (Bot-to-Bot Communication Mode)', '關閉 (預設):', '開啟:', '設定方式:', '開啟的風險:'])
  expect(privacyNotice({ username: 'x_bot' })).toContain('\n你目前 Group Privacy 設定: ⚠️ 開啟') // that line is not bold
  expect(B2B_NOTICE.split('\n').at(-1)).not.toContain('<b>') // her advice paragraph is not bold
  expect(escHtml('<A&B> "x"')).toBe('&lt;A&amp;B&gt; "x"')
  expect(htmlToText(escHtml('<A&B>'))).toBe('<A&B>')
})

test('/router bot add: the reply carries the new bot\'s settings notice (privacy, bot-to-bot); rotate does not', async () => {
  const me = { username: 'two_bot', can_read_all_group_messages: false }
  expect(botSettingsNotice(me)).toBe(`${privacyNotice(me)}\n\n${B2B_NOTICE}`)
  expect(botSettingsNotice(null)).toBe(B2B_NOTICE)
  const cdeps = {
    cfg: { owners: [OWNER], bots: [{ name: 'cc', token: '1:routerbot' }], credentials: {} }, db, loadAccess: () => access, verifyBot,
    bots: { add: async () => 'two_bot', rotate: async () => 'two_bot' }, botNotice: () => botSettingsNotice(me),
  } as unknown as CommandDeps
  const add = (await runCommand(dm(OWNER, '/router bot add two 9:NEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEW'), cdeps))!
  expect(add.reply).toStartWith('已新增 bot two: @two_bot\n')
  expect(add.reply).toEndWith(`\n\n${botSettingsNotice(me)}`)
  expect(add.html).toBe(true) // sent with parse_mode HTML
  expect((await runCommand(dm(OWNER, '/router bot rotate two 9:NEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEW'), cdeps))!.reply).toBe('已更換 bot two: @two_bot')
})
