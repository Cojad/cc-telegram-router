// Conversation secrets (plan 10b 對話專屬密鑰). A conversation of any role
// keeps its own token or API key in router.db (table conv_secrets),
// encrypted with AES-256-GCM under config.json "secretKey". Registered with
// /secret set in that chat (the router answers it itself and deletes the
// message; in a group any member may), used only by that conversation
// through bot_api / http_api (looked up before the global credentials, no
// role check, no authorization), limited to the methods or URL and paths
// given at registration. The value never reaches a worker: logs, the events
// table and reply quotes show <已遮蔽>, responses have it scrubbed.

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import type { Config, Credential } from './config'
import type { RouterDb, ConvSecret, SecretHandle } from './db'
import type { Access } from './telegram/policy'
import type { CommandInput, CommandOutput } from './commands'
import { maskTokens, gmt8 } from './context'
import { badPath, parseHttpScope, placementText, defaultHeadersText, BOT_TOKEN_FULL, httpExample } from './credentials'

export const MAX_SECRETS = 20
export const MAX_SECRET_BYTES = 4096
export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
export const SECRET_RE = /^\/secret(?:@(\w+))?(?:\s+([\s\S]*))?$/i
const MASK = '<已遮蔽>'

export function newSecretKey(): string { return randomBytes(32).toString('base64') }

function keyOf(b64: string): Buffer {
  const k = Buffer.from(b64, 'base64')
  if (k.length !== 32) throw new Error('config.json secretKey 要是 32 bytes 的 base64')
  return k
}
const aadOf = (bot: string, chatId: string, name: string) => Buffer.from(`${bot}\n${chatId}\n${name}`)

/** "v1:" + base64(iv 12 | tag 16 | ciphertext), AES-256-GCM bound to aad. */
function sealWith(keyB64: string, aad: Buffer, value: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', keyOf(keyB64), iv)
  c.setAAD(aad)
  const ct = Buffer.concat([c.update(value, 'utf8'), c.final()])
  return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}`
}
function openWith(keyB64: string, aad: Buffer, sealed: string): string {
  if (!sealed.startsWith('v1:')) throw new Error('密鑰格式不明')
  const raw = Buffer.from(sealed.slice(3), 'base64')
  const d = createDecipheriv('aes-256-gcm', keyOf(keyB64), raw.subarray(0, 12))
  d.setAAD(aad)
  d.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')
}

/** Bound to bot, chat and name. */
export const sealSecret = (keyB64: string, bot: string, chatId: string, name: string, value: string) => sealWith(keyB64, aadOf(bot, chatId, name), value)
export const openSecret = (keyB64: string, bot: string, chatId: string, name: string, sealed: string) => openWith(keyB64, aadOf(bot, chatId, name), sealed)

/** An original update (plan 10e event_raw), bound to its events row: moved to another row it does not open. */
const rawAad = (eventId: number) => Buffer.from(`event_raw\n${eventId}`)
export const sealRaw = (keyB64: string, eventId: number, json: string) => sealWith(keyB64, rawAad(eventId), json)
export const openRaw = (keyB64: string, eventId: number, sealed: string) => openWith(keyB64, rawAad(eventId), sealed)

/** Commands that carry a token or key: "/secret set <名稱> <值>", "/router
 *  cred add|rotate <名稱> <token>", "/router bot add|rotate <名稱> <token>". Only
 *  when the message starts with the command (or "cc /..."; also a reply
 *  quote, which is its own string): a sentence that only names the command
 *  ("教我 /router cred add 的用法") has no value. A value is one word of
 *  printable ASCII (no key holds CJK); a lone argument is masked too, it may
 *  be a value without a name. */
export const SECRET_CMDS = /^(\s*(?:(?:cc|柯柯)\s*)?\/(?:secret(?:@\w+)?\s+set|router(?:@\w+)?\s+(?:cred\s+(?:add|rotate)|bot\s+(?:add|rotate)))\s+)([\x21-\x7e]+)(?=\s|$)(?:(\s+)([\x21-\x7e]+)(?=\s|$))?/i
export function maskSecretText(text: string): string {
  return text.replace(SECRET_CMDS, (_m, head: string, a: string, sp: string | undefined, b: string | undefined) =>
    b ? `${head}${a}${sp}${MASK}` : `${head}${MASK}`)
}

/** Every string inside an update, masked (for the events table). */
export function maskSecretUpdate<T>(v: T): T {
  if (typeof v === 'string') return (/\/(secret|router)/i.test(v) ? maskSecretText(v) : v) as T
  if (Array.isArray(v)) return v.map(maskSecretUpdate) as T
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskSecretUpdate(x)])) as T
  return v
}

/** The value (and Telegram tokens) taken out of text returned to a worker. */
export function scrubSecret(text: string, value: string): string {
  let t = value.length >= 4 ? text.split(value).join('<密鑰>') : text
  // a key sent as a query parameter may come back URL-encoded
  const enc = encodeURIComponent(value)
  if (enc !== value && value.length >= 4) t = t.split(enc).join('<密鑰>')
  return maskTokens(t)
}

const matches = (allowed: string[], x: string) => allowed.some(m => m === x || (m.endsWith('*') && x.startsWith(m.slice(0, -1))))

/** Why this use of a conversation secret is refused, or null. No role check: it is the conversation's own. */
export function refuseSecret(s: ConvSecret, method: string, kind: 'telegram-bot' | 'http'): string | null {
  if (s.kind !== kind) return `密鑰 ${s.name} 是 ${s.kind} 類, 要用 ${s.kind === 'http' ? 'http_api' : 'bot_api'} 工具`
  const allowed = JSON.parse(s.allowed) as string[]
  if (kind === 'http') { const why = badPath(method); if (why) return why }
  if (!matches(allowed, method)) return `密鑰 ${s.name} 沒有開放 ${method} (允許: ${allowed.join(', ')}); 要改範圍就重新 /secret set`
  return null
}

/** The conversation secret as a Credential for botApiCall / httpApiCall. */
export function secretCred(s: ConvSecret, value: string): Credential {
  return {
    token: value, kind: s.kind, methods: JSON.parse(s.allowed), ...(s.base_url ? { baseUrl: s.base_url } : {}),
    ...(s.header != null ? { header: s.header } : {}), ...(s.scheme != null ? { scheme: s.scheme } : {}), ...(s.query != null ? { query: s.query } : {}),
    ...(s.default_headers ? { defaultHeaders: JSON.parse(s.default_headers) } : {}),
  }
}

const scope = (s: Pick<ConvSecret, 'kind' | 'base_url' | 'allowed' | 'header' | 'scheme' | 'query' | 'label' | 'default_headers'>) => {
  const allowed = JSON.parse(s.allowed) as string[]
  const all = allowed.length === 1 && allowed[0] === '*'
  return s.kind === 'http'
    ? `http ${s.base_url}${placementText({ header: s.header ?? undefined, scheme: s.scheme ?? undefined, query: s.query ?? undefined })}${defaultHeadersText(s.default_headers ? JSON.parse(s.default_headers) : null)}, 路徑 ${all ? '全部' : allowed.join(', ')}`
    : `telegram-bot${s.label ? ` ${s.label}` : ''}, 方法 ${all ? '全部' : allowed.join(', ')}`
}
export const describeSecrets = (list: ConvSecret[]) => list.map(s => `${s.name}: ${scope(s)}`).join('\n')

const USAGE = [
  '/secret set <名稱> <token> [方法...] (Telegram bot token, 沒寫方法就是全部; 不像 bot token 的值不會拿去 getMe)',
  '/secret set <名稱> <API key> --http <網址> [--header <標頭>] [--scheme <前綴|none>] [--query <參數>] [--default-header <名稱>:<值>]... [路徑...] (結尾 * 代表前綴, 沒寫路徑就是全部; 預設 Authorization: Bearer <key>, 只寫 --header 時值原樣放進那個標頭, --query 改放在網址的 query 參數; --default-header: worker 沒帶同名標頭時 router 補上)',
  '/secret list | rm <名稱>',
  '/secret handles (router 發給這個對話的密鑰代號) | revoke <代號>',
  '密鑰只屬於這個對話, 加密存在 router, 對話裡的分身只拿得到名稱, 用 bot_api / http_api 工具呼叫',
  '跟全域憑證 (/router cred) 的差別與範例: /router help secret',
].join('\n')

export interface SecretDeps {
  cfg: Pick<Config, 'owners' | 'bots'> & { secretKey?: string }
  db: RouterDb
  loadAccess(): Access
  /** getMe with the token: "@username (id)", or throws why it is not a bot token. */
  verifyBot(token: string): Promise<string>
}

/** A chat the router serves for this sender: an allowed DM, an allowed group. */
export function servesChat(access: Access, owners: string[], chatType: string, chatId: string, senderId: string): boolean {
  return chatType === 'private'
    ? owners.includes(senderId) || access.allowFrom.includes(senderId)
    : Object.prototype.hasOwnProperty.call(access.groups, chatId) && (!access.groups[chatId]!.allowFrom?.length || access.groups[chatId]!.allowFrom.includes(senderId))
}

/** Handles (plan 10e secret_handles) as a list: code, kind, last 4, expiry, registered name, uses. */
export function describeHandles(list: SecretHandle[], at = Date.now()): string {
  return list.map(h => {
    const state = h.revoked_at ? `已撤銷 (${h.revoked_by})` : h.expires_at == null ? '永久' : Date.parse(h.expires_at) <= at ? '已過期' : `${gmt8(new Date(h.expires_at))} 到期`
    return `${h.code}: ${h.kind}, 末 4 碼 ${h.last4}, event #${h.event_id}, ${state}${h.registered ? `, 已登記為 ${h.registered}` : ''}, 使用 ${h.uses} 次`
  }).join('\n')
}

/** /secret in any chat the router serves, any role. null: not for this bot. */
export async function runSecretCommand(input: CommandInput & { botUsername?: string }, deps: SecretDeps, now = () => new Date().toISOString()): Promise<CommandOutput | null> {
  const m = SECRET_RE.exec(input.text.trim())
  if (!m) return null
  if (m[1] && input.botUsername && m[1].toLowerCase() !== input.botUsername.toLowerCase()) return null
  const { db } = deps
  const args = (m[2] ?? '').trim().split(/\s+/).filter(Boolean)
  const op = (args[0] ?? 'help').toLowerCase()
  const hasValue = op === 'set' && args.length >= 2
  const here = db.findConversation(input.bot, input.chatId)
  const logs: CommandOutput['logs'] = []
  const shown = maskSecretText(input.text.trim())
  // the message with the value: deleted 60 seconds after the answer in a DM
  // (its sender may cancel), at once in a group or where it is refused (router/main.ts answerCommand)
  const done = (reply: string, del = hasValue, later = true): CommandOutput => {
    if (here) logs.push({ conv: here.key, text: `${input.senderName} ${shown} → ${reply.split('\n')[0]}` })
    return { reply, logs, ...(del ? { deleteMessage: true, deleteLabel: '含密鑰的訊息', ...(later ? { deleteLater: true } : {}) } : {}) }
  }
  // only chats the router serves: an allowed DM, an allowed group
  const served = servesChat(deps.loadAccess(), deps.cfg.owners, input.chatType, input.chatId, input.senderId)
  if (!served) return done(`⛔ 這個對話沒有開放給 bot 使用, 不能登記密鑰${hasValue ? '; 值曾出現在這裡, 請到發出它的地方換一把新的' : ''}`, hasValue, false)

  const bot = input.bot, chatId = input.chatId
  switch (op) {
    case 'help':
      return done(USAGE)
    case 'list': {
      const list = db.listConvSecrets(bot, chatId)
      return done(list.length ? `這個對話的密鑰 (${list.length}/${MAX_SECRETS}):\n${describeSecrets(list)}` : '這個對話還沒有密鑰\n' + USAGE)
    }
    case 'handles': {
      // handles the router gave this conversation (plan 10e event_raw)
      const list = db.listHandles(bot, chatId).filter(h => !h.revoked_at && (h.expires_at == null || Date.parse(h.expires_at) > Date.now()))
      return done(list.length ? `這個對話有效的密鑰代號:\n${describeHandles(list)}` : '這個對話沒有有效的密鑰代號')
    }
    case 'revoke': {
      const code = args[1]
      const h = code ? db.getHandle(code) : null
      if (!h || h.bot !== bot || h.chat_id !== chatId) return done('用法: /secret revoke <代號> (這個對話的代號, /secret handles 列出)')
      return done(db.revokeHandle(h.code, input.senderId) ? `已撤銷代號 ${h.code}${h.registered ? ` (已登記的密鑰 ${h.registered} 不受影響, 要移除用 /secret rm ${h.registered})` : ''}` : `代號 ${h.code} 已經撤銷過`)
    }
    case 'rm': {
      const name = args[1]
      if (!name) return done('用法: /secret rm <名稱>')
      return done(db.removeConvSecret(bot, chatId, name) ? `已移除密鑰 ${name}` : `這個對話沒有名為 ${name} 的密鑰`)
    }
    case 'set': {
      const name = args[1], value = args[2]
      if (!name || !value || !NAME_RE.test(name)) return done(`用法:\n${USAGE}\n名稱用小寫英數, - 或 _, 最多 32 字`)
      return done((await registerSecret(deps, bot, chatId, name, value, args.slice(3), input.senderId, now)).text)
    }
    default:
      return done(USAGE)
  }
}

/** Register (or replace) a conversation secret: /secret set, and a handle
 *  registered with secret_from_handle (plan 10e; source = the handle). rest:
 *  what follows the value in /secret set (methods, or --http <網址> ...). */
export async function registerSecret(deps: SecretDeps, bot: string, chatId: string, name: string, value: string, restIn: string[], addedBy: string, now = () => new Date().toISOString(), source: string | null = null): Promise<{ ok: boolean; text: string }> {
  const { db } = deps
  const no = (text: string) => ({ ok: false, text })
  if (!NAME_RE.test(name)) return no('名稱用小寫英數, - 或 _, 最多 32 字')
  if (name === 'self') return no('self 是 bot_api 保留給 bot 自己的名稱, 換一個名稱')
  if (!deps.cfg.secretKey) return no('router 還沒有加密金鑰 (config.json secretKey), 請 owner 重啟 router')
  if (Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES) return no(`值太長, 最多 ${MAX_SECRET_BYTES} bytes`)
  if (deps.cfg.bots.some(b => b.token === value)) return no('⛔ 這是 router 自己的 bot token, 不能登記; 它出現在對話裡了, 請 owner 換一把新的')
  const rest = [...restIn]
  const httpAt = rest.indexOf('--http')
  let kind: ConvSecret['kind'] = 'telegram-bot', baseUrl: string | null = null, allowed: string[]
  let header: string | null = null, scheme: string | null = null, query: string | null = null, label: string | null = null, defaults: string | null = null
  if (httpAt >= 0) {
    if (httpAt !== 0) return no('--http 要接在值的後面: /secret set <名稱> <API key> --http <網址> [路徑...]')
    const h = parseHttpScope(rest)
    if ('error' in h) return no(h.error)
    baseUrl = h.baseUrl
    header = h.placement.header ?? null; scheme = h.placement.scheme ?? null; query = h.placement.query ?? null
    defaults = Object.keys(h.defaultHeaders).length ? JSON.stringify(h.defaultHeaders) : null
    kind = 'http'
    allowed = h.paths
  } else {
    allowed = rest
    const bad = allowed.find(x => !/^([A-Za-z]+\*?|\*)$/.test(x))
    if (bad) return no(`方法 ${bad} 不像 Bot API 方法名稱, 例如 sendMessage 或 get* (要登記一般 API key 請加 --http <網址>)`)
    // not a bot token: never sent to getMe (an API key without --http)
    if (!BOT_TOKEN_FULL.test(value)) {
      const ex = httpExample(value)
      return no([
        `這看起來不是 Telegram bot token${ex.what ? ` (像是 ${ex.what})` : ''}, 沒有登記, 也沒有拿去 Telegram 驗證.`,
        'API key 要加 --http <網址>, 例如:',
        `/secret set ${name} <key> ${ex.flags}`,
        '(沒寫路徑就是那個網址底下全部路徑; 完整說明: /router help secret)',
      ].join('\n'))
    }
    // a bot token must be one: getMe with it (no switch to skip this)
    try { label = await deps.verifyBot(value) } catch (e) { return no(`這不是可用的 bot token (getMe 失敗: ${e instanceof Error ? e.message : e}), 沒有登記`) }
  }
  if (!allowed.length) allowed = ['*']
  const exists = db.getConvSecret(bot, chatId, name)
  if (!exists && db.listConvSecrets(bot, chatId).length >= MAX_SECRETS) return no(`這個對話已經有 ${MAX_SECRETS} 把密鑰, 先 /secret rm 不用的`)
  db.setConvSecret({ bot, chat_id: chatId, name, kind, value: sealSecret(deps.cfg.secretKey, bot, chatId, name, value), base_url: baseUrl, allowed: JSON.stringify(allowed), header, scheme, query, label, added_by: addedBy, created_at: now(), source, default_headers: defaults })
  return { ok: true, text: [
    `已${exists ? '更新' : '登記'}這個對話的密鑰 ${name}: ${scope({ kind, base_url: baseUrl, allowed: JSON.stringify(allowed), header, scheme, query, label, default_headers: defaults })}`,
    `值加密存在 router, 只有這個對話能用 (${kind === 'http' ? 'http_api' : 'bot_api'} 工具, credential 填 ${name})`,
  ].join('\n') }
}
