// Conversation secrets (plan 10b 對話專屬密鑰): sealing, masking, the /secret
// and /router secret commands, the use checks. Keep in sync with README
// 「對話專屬密鑰」 and /telegram:bot-skill; end to end in e2e-secrets.test.ts.

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

const OWNER = '137438526', MEMBER = '700', STRANGER = '800', GROUP = '-100700'
let dir: string, db: RouterDb, deps: SecretDeps, access: Access
const key = newSecretKey()
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cctr-sec-'))
  mkdirSync(join(dir, '.router'))
  db = openRouterDb(join(dir, '.router', 'router.db'))
  access = { dmPolicy: 'allowlist', allowFrom: [OWNER, MEMBER], groups: { [GROUP]: { requireMention: true, allowFrom: [] } }, pending: {} }
  deps = { cfg: { owners: [OWNER], bots: [{ name: 'cc', token: '1:routerbot' }], secretKey: key }, db, loadAccess: () => access }
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

const dm = (uid: string, text: string) => ({ bot: 'cc', text, senderId: uid, senderName: `u${uid}`, chatId: uid, chatType: 'private' })
const grp = (uid: string, text: string) => ({ bot: 'cc', text, senderId: uid, senderName: `u${uid}`, chatId: GROUP, chatType: 'supergroup' })

test('seal/open: AES-256-GCM, a fresh IV each time, bound to bot, chat and name; a wrong key or another row fails', () => {
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

test('masking: the value is <已遮蔽> in text, "cc /secret", every string of an update and reply quotes; responses have the value scrubbed', () => {
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
  expect(runSecretCommand({ ...dm(MEMBER, '/secret@other_bot list'), botUsername: 'cc_bot' }, deps)).toBeNull()
  expect(runSecretCommand({ ...dm(MEMBER, '/secret@cc_bot list'), botUsername: 'cc_bot' }, deps)!.reply).toStartWith('這個對話還沒有密鑰')
})

test('/secret set in a DM (any role): stored sealed, the message deleted, the worker log masked; list shows name, kind, scope only; rm', () => {
  const r = runSecretCommand(dm(MEMBER, '/secret set openai sk-fake-1 --http https://api.example.com/ /v1/images/* /v1/models'), deps)!
  expect(r.reply).toBe('已登記這個對話的密鑰 openai: http https://api.example.com, 路徑 /v1/images/*, /v1/models\n值加密存在 router, 只有這個對話能用 (http_api 工具, credential 填 openai)')
  expect(r).toMatchObject({ deleteMessage: true, deleteLabel: '含密鑰的訊息' })
  const row = db.getConvSecret('cc', MEMBER, 'openai')!
  expect(row).toMatchObject({ kind: 'http', base_url: 'https://api.example.com', allowed: '["/v1/images/*","/v1/models"]', added_by: MEMBER })
  expect(row.value).not.toContain('sk-fake-1')
  expect(openSecret(key, 'cc', MEMBER, 'openai', row.value)).toBe('sk-fake-1')
  // telegram-bot kind: methods optional, none = all
  expect(runSecretCommand(dm(MEMBER, '/secret set mybot 123:fake-token'), deps)!.reply).toStartWith('已登記這個對話的密鑰 mybot: telegram-bot, 方法 全部')
  expect(runSecretCommand(dm(MEMBER, '/secret set mybot 123:fake-token sendMessage get*'), deps)!.reply).toStartWith('已更新這個對話的密鑰 mybot: telegram-bot, 方法 sendMessage, get*')
  const list = runSecretCommand(dm(MEMBER, '/secret list'), deps)!
  expect(list.reply).toBe(`這個對話的密鑰 (2/${MAX_SECRETS}):\nmybot: telegram-bot, 方法 sendMessage, get*\nopenai: http https://api.example.com, 路徑 /v1/images/*, /v1/models`)
  expect(list.deleteMessage).toBeUndefined()
  // only this chat sees them
  expect(runSecretCommand(dm(OWNER, '/secret list'), deps)!.reply).toStartWith('這個對話還沒有密鑰')
  expect(runSecretCommand(dm(MEMBER, '/secret rm openai'), deps)!.reply).toBe('已移除密鑰 openai')
  expect(runSecretCommand(dm(MEMBER, '/secret rm openai'), deps)!.reply).toBe('這個對話沒有名為 openai 的密鑰')
})

test('/secret set refusals: bad name, self, too long, the router\'s own token, bad URL or path, 20 per conversation; the message is deleted whenever a value was in it', () => {
  const say = (t: string) => runSecretCommand(dm(MEMBER, t), deps)!
  expect(say('/secret set Bad_Name v').reply).toStartWith('用法:')
  expect(say('/secret set self v').reply).toBe('self 是 bot_api 保留給 bot 自己的名稱, 換一個名稱')
  expect(say(`/secret set big ${'x'.repeat(4097)}`).reply).toBe('值太長, 最多 4096 bytes')
  expect(say('/secret set mine 1:routerbot').reply).toStartWith('⛔ 這是 router 自己的 bot token')
  expect(say('/secret set k v --http ftp://x.example').reply).toStartWith('--http 後面要接網址')
  expect(say('/secret set k v --http https://user:pw@x.example').reply).toStartWith('--http 後面要接網址')
  expect(say('/secret set k v --http https://x.example v1').reply).toStartWith('路徑 v1 不行')
  expect(say('/secret set k v --http https://x.example /v1/../admin').reply).toStartWith('路徑 /v1/../admin 不行')
  expect(say('/secret set k v send-message').reply).toStartWith('方法 send-message 不像 Bot API 方法名稱')
  const r = say('/secret set Bad v')
  expect(r.deleteMessage).toBe(true)
  for (let i = 0; i < MAX_SECRETS; i++) say(`/secret set k${i} v${i}`)
  expect(say('/secret set one-more v').reply).toBe(`這個對話已經有 ${MAX_SECRETS} 把密鑰, 先 /secret rm 不用的`)
  expect(say('/secret set k0 replaced').reply).toStartWith('已更新') // replacing does not count
  expect(db.listConvSecrets('cc', MEMBER)).toHaveLength(MAX_SECRETS)
})

test('/secret in a group: any member, any role; only groups (and senders) the router serves; DMs only from allowed senders', () => {
  db.setUserRole(MEMBER, 'guest')
  const r = runSecretCommand(grp(MEMBER, '/secret set gk sk-group'), deps)!
  expect(r.reply).toStartWith('已登記這個對話的密鑰 gk')
  expect(r.deleteMessage).toBe(true)
  expect(db.getConvSecret('cc', GROUP, 'gk')!.added_by).toBe(MEMBER)
  expect(runSecretCommand(grp(STRANGER, '/secret list'), deps)!.reply).toContain('gk: telegram-bot')
  access.groups[GROUP]!.allowFrom = [OWNER]
  expect(runSecretCommand(grp(STRANGER, '/secret set gk2 v'), deps)!).toMatchObject({ reply: '⛔ 這個對話沒有開放給 bot 使用, 不能登記密鑰; 值曾出現在這裡, 請到發出它的地方換一把新的', deleteMessage: true })
  expect(runSecretCommand({ ...grp(MEMBER, '/secret set x v'), chatId: '-100999' }, deps)!.reply).toStartWith('⛔ 這個對話沒有開放')
  expect(runSecretCommand(dm(STRANGER, '/secret set x v'), deps)!.reply).toStartWith('⛔ 這個對話沒有開放')
})

test('refuseSecret: only the kind, methods or paths given at registration; no role involved; path tricks refused', () => {
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
  runSecretCommand(dm(MEMBER, '/secret set a v1'), deps)
  runSecretCommand(dm(MEMBER, '/secret set b v2 --http https://x.example'), deps)
  runSecretCommand(grp(MEMBER, '/secret set g v3'), deps)
  const cdeps = { cfg: { owners: [OWNER], bots: [{ name: 'cc', token: '1:routerbot' }], secretKey: key, credentials: {} }, db, loadAccess: () => access } as unknown as CommandDeps
  const run = (uid: string, text: string) => runCommand(dm(uid, text), cdeps)
  expect((await run(OWNER, '/router secret list'))!).toMatchObject({ reply: `cc ${GROUP}: 1 把\ncc ${MEMBER}: 2 把`, private: true })
  expect((await run(OWNER, `/router secret list ${MEMBER}`))!.reply).toBe('a: telegram-bot, 方法 全部\nb: http https://x.example, 路徑 全部')
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
  for (const s of ['### 對話專屬密鑰', '/secret set <名稱> <token> [方法...]', '--http <網址> [路徑...]', '/secret list', '/secret rm <名稱>', '<已遮蔽>', '<密鑰>', '不要叫他把值貼給你']) expect(skill).toContain(s)
  const doc = await Bun.file(join(root, 'doc', 'SKILL.md')).text()
  for (const s of ['/secret set', '/router secret list|rm <chat_id>']) expect(doc).toContain(s)
})
