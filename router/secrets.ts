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
import type { RouterDb, ConvSecret } from './db'
import type { Access } from './telegram/policy'
import type { CommandInput, CommandOutput } from './commands'
import { maskTokens } from './context'
import { badPath } from './credentials'

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

/** "v1:" + base64(iv 12 | tag 16 | ciphertext); bound to bot, chat and name. */
export function sealSecret(keyB64: string, bot: string, chatId: string, name: string, value: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', keyOf(keyB64), iv)
  c.setAAD(aadOf(bot, chatId, name))
  const ct = Buffer.concat([c.update(value, 'utf8'), c.final()])
  return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}`
}

export function openSecret(keyB64: string, bot: string, chatId: string, name: string, sealed: string): string {
  if (!sealed.startsWith('v1:')) throw new Error('密鑰格式不明')
  const raw = Buffer.from(sealed.slice(3), 'base64')
  const d = createDecipheriv('aes-256-gcm', keyOf(keyB64), raw.subarray(0, 12))
  d.setAAD(aadOf(bot, chatId, name))
  d.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')
}

/** Commands that carry a token or key: "/secret set <名稱> <值>", "/router
 *  cred add <名稱> <token>", "/router bot add|rotate <名稱> <token>". The
 *  value becomes <已遮蔽> (a lone argument is masked too, it may be a value
 *  without a name). Also inside "cc /..." and reply quotes. */
const SECRET_CMDS = /(\/(?:secret(?:@\w+)?\s+set|router(?:@\w+)?\s+(?:cred\s+add|bot\s+(?:add|rotate)))\s+)(\S+)(?:(\s+)(\S+))?/gi
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
  const t = value.length >= 4 ? text.split(value).join('<密鑰>') : text
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
    ...(s.header != null ? { header: s.header } : {}), ...(s.scheme != null ? { scheme: s.scheme } : {}),
  }
}

/** How the key is sent, as httpApiCall does it: "<header>: <scheme> <key>". */
const headerOf = (s: Pick<ConvSecret, 'header' | 'scheme'>) => {
  const h = s.header ?? 'Authorization', sc = s.scheme ?? 'Bearer'
  return h === 'Authorization' && sc === 'Bearer' ? '' : `, 標頭 ${h}${sc ? ` (${sc} <key>)` : ''}`
}
const scope = (s: Pick<ConvSecret, 'kind' | 'base_url' | 'allowed' | 'header' | 'scheme' | 'label'>) => {
  const allowed = JSON.parse(s.allowed) as string[]
  const all = allowed.length === 1 && allowed[0] === '*'
  return s.kind === 'http'
    ? `http ${s.base_url}${headerOf(s)}, 路徑 ${all ? '全部' : allowed.join(', ')}`
    : `telegram-bot${s.label ? ` ${s.label}` : ''}, 方法 ${all ? '全部' : allowed.join(', ')}`
}
/** Headers the key may not go in: fetch sets them, or they would change the request. */
const RESERVED_HEADERS = new Set(['host', 'content-length', 'content-type', 'transfer-encoding', 'connection', 'cookie', 'te', 'upgrade', 'expect'])
export const describeSecrets = (list: ConvSecret[]) => list.map(s => `${s.name}: ${scope(s)}`).join('\n')

const USAGE = [
  '/secret set <名稱> <token> [方法...] (Telegram bot token, 沒寫方法就是全部)',
  '/secret set <名稱> <API key> --http <網址> [--header <標頭>] [--scheme <前綴>] [路徑...] (結尾 * 代表前綴, 沒寫路徑就是全部; 預設 Authorization: Bearer <key>, 只寫 --header 時值原樣放進那個標頭)',
  '/secret list | rm <名稱>',
  '密鑰只屬於這個對話, 加密存在 router, 對話裡的分身只拿得到名稱, 用 bot_api / http_api 工具呼叫',
].join('\n')

export interface SecretDeps {
  cfg: Pick<Config, 'owners' | 'bots'> & { secretKey?: string }
  db: RouterDb
  loadAccess(): Access
  /** getMe with the token: "@username (id)", or throws why it is not a bot token. */
  verifyBot(token: string): Promise<string>
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
  const done = (reply: string, del = hasValue): CommandOutput => {
    if (here) logs.push({ conv: here.key, text: `${input.senderName} ${shown} → ${reply.split('\n')[0]}` })
    return { reply, logs, ...(del ? { deleteMessage: true, deleteLabel: '含密鑰的訊息' } : {}) }
  }
  // only chats the router serves: an allowed DM, an allowed group
  const access = deps.loadAccess()
  const served = input.chatType === 'private'
    ? deps.cfg.owners.includes(input.senderId) || access.allowFrom.includes(input.senderId)
    : Object.prototype.hasOwnProperty.call(access.groups, input.chatId) && (!access.groups[input.chatId]!.allowFrom?.length || access.groups[input.chatId]!.allowFrom.includes(input.senderId))
  if (!served) return done(`⛔ 這個對話沒有開放給 bot 使用, 不能登記密鑰${hasValue ? '; 值曾出現在這裡, 請到發出它的地方換一把新的' : ''}`)

  const bot = input.bot, chatId = input.chatId
  switch (op) {
    case 'help':
      return done(USAGE)
    case 'list': {
      const list = db.listConvSecrets(bot, chatId)
      return done(list.length ? `這個對話的密鑰 (${list.length}/${MAX_SECRETS}):\n${describeSecrets(list)}` : '這個對話還沒有密鑰\n' + USAGE)
    }
    case 'rm': {
      const name = args[1]
      if (!name) return done('用法: /secret rm <名稱>')
      return done(db.removeConvSecret(bot, chatId, name) ? `已移除密鑰 ${name}` : `這個對話沒有名為 ${name} 的密鑰`)
    }
    case 'set': {
      const name = args[1], value = args[2]
      if (!name || !value || !NAME_RE.test(name)) return done(`用法:\n${USAGE}\n名稱用小寫英數, - 或 _, 最多 32 字`)
      if (name === 'self') return done('self 是 bot_api 保留給 bot 自己的名稱, 換一個名稱')
      if (!deps.cfg.secretKey) return done('router 還沒有加密金鑰 (config.json secretKey), 請 owner 重啟 router')
      if (Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES) return done(`值太長, 最多 ${MAX_SECRET_BYTES} bytes`)
      if (deps.cfg.bots.some(b => b.token === value)) return done('⛔ 這是 router 自己的 bot token, 不能登記; 它出現在對話裡了, 請 owner 換一把新的')
      const rest = args.slice(3)
      const httpAt = rest.indexOf('--http')
      let kind: ConvSecret['kind'] = 'telegram-bot', baseUrl: string | null = null, allowed: string[]
      let header: string | null = null, scheme: string | null = null, label: string | null = null
      if (httpAt >= 0) {
        if (httpAt !== 0) return done('--http 要接在值的後面: /secret set <名稱> <API key> --http <網址> [路徑...]')
        baseUrl = rest[1] ?? ''
        // --header <標頭> / --scheme <前綴>, anywhere after the URL
        const after = rest.slice(2)
        for (const flag of ['--header', '--scheme'] as const) {
          const i = after.indexOf(flag)
          if (i < 0) continue
          const v = after[i + 1]
          if (!v || v.startsWith('--')) return done(`${flag} 後面要接${flag === '--header' ? '標頭名稱, 例如 --header x-api-key' : '前綴, 例如 --scheme Token'}`)
          if (flag === '--header') {
            if (!/^[A-Za-z0-9-]{1,64}$/.test(v) || RESERVED_HEADERS.has(v.toLowerCase())) return done(`標頭 ${v} 不行: 只能用英數與 -, 不能是 Host, Content-Type, Cookie 這類標頭`)
            header = v
          } else {
            if (!/^[A-Za-z0-9._-]{1,32}$/.test(v)) return done(`前綴 ${v} 不行: 只能用英數與 . _ -`)
            scheme = v
          }
          after.splice(i, 2)
        }
        // only --header: the key goes in that header as it is
        if (header && scheme == null) scheme = ''
        if (header?.toLowerCase() === 'authorization') header = 'Authorization'
        rest.splice(2, rest.length - 2, ...after)
        let u: URL | null = null
        try { u = new URL(baseUrl) } catch {}
        if (!u || !/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash) return done('--http 後面要接網址, 例如 --http https://api.example.com (不含帳密, ? 或 #)')
        baseUrl = baseUrl.replace(/\/+$/, '')
        kind = 'http'
        allowed = rest.slice(2)
        const bad = allowed.find(p => !p.startsWith('/') || badPath(p.replace(/\*$/, '')))
        if (bad) return done(`路徑 ${bad} 不行: 要以 / 開頭, 不能含 .. 等, 例如 /v1/images/generations (結尾 * 代表前綴)`)
      } else {
        allowed = rest
        const bad = allowed.find(x => !/^([A-Za-z]+\*?|\*)$/.test(x))
        if (bad) return done(`方法 ${bad} 不像 Bot API 方法名稱, 例如 sendMessage 或 get* (要登記一般 API key 請加 --http <網址>)`)
        // a bot token must be one: getMe with it (no switch to skip this)
        try { label = await deps.verifyBot(value) } catch (e) { return done(`這不是可用的 bot token (getMe 失敗: ${e instanceof Error ? e.message : e}), 沒有登記`) }
      }
      if (!allowed.length) allowed = ['*']
      const exists = db.getConvSecret(bot, chatId, name)
      if (!exists && db.listConvSecrets(bot, chatId).length >= MAX_SECRETS) return done(`這個對話已經有 ${MAX_SECRETS} 把密鑰, 先 /secret rm 不用的`)
      db.setConvSecret({ bot, chat_id: chatId, name, kind, value: sealSecret(deps.cfg.secretKey, bot, chatId, name, value), base_url: baseUrl, allowed: JSON.stringify(allowed), header, scheme, label, added_by: input.senderId, created_at: now() })
      return done([
        `已${exists ? '更新' : '登記'}這個對話的密鑰 ${name}: ${scope({ kind, base_url: baseUrl, allowed: JSON.stringify(allowed), header, scheme, label })}`,
        `值加密存在 router, 只有這個對話能用 (${kind === 'http' ? 'http_api' : 'bot_api'} 工具, credential 填 ${name})`,
      ].join('\n'))
    }
    default:
      return done(USAGE)
  }
}
