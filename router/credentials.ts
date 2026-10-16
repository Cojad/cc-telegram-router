// Credentials for cross-bot skills (plan 03 憑證). Tokens a skill needs that
// are not one of the router's own bots (e.g. another bot that owns a sticker
// set) live in config.json under "credentials", never in a skill, a .env a
// worker can read, or a chat. Workers use them through the bot_api tool: the
// router checks the conversation's role and the method against the
// credential's lists and makes the Bot API call itself.

import type { Config, Credential } from './config'

export const DEFAULT_CRED_ROLES = ['owner', 'admin']

/** Why a request path may not be used with an API key, or null. fetch
 *  resolves dot segments (new URL turns /v1/images/../files into /v1/files),
 *  so a prefix match on the raw path could be walked out of: "..", ".", their
 *  %2e forms, an encoded "/" and "\\" are refused, as is "#". */
export function badPath(path: string): string | null {
  if (!path.startsWith('/')) return 'path 要以 / 開頭'
  const p = path.split('?')[0]!
  if (/\\|#/.test(path) || p.split('/').some(s => s === '..' || s === '.' || /%2e/i.test(s) || /%2f/i.test(s) || /%5c/i.test(s))) return 'path 不能含 .., ., \\, # 或編碼過的 . / \\'
  return null
}

/** Why this use is refused, or null when allowed. */
export function refuseUse(cred: Credential | undefined, name: string, role: string, method: string, kind: 'telegram-bot' | 'http' = 'telegram-bot'): string | null {
  if (!cred) return `沒有名為 ${name} 的憑證 (/router cred list 查看)`
  if ((cred.kind ?? 'telegram-bot') !== kind) return `憑證 ${name} 是 ${cred.kind ?? 'telegram-bot'} 類, 要用 ${cred.kind === 'http' ? 'http_api' : 'bot_api'} 工具`
  if (kind === 'http') { const bad = badPath(method); if (bad) return bad }
  if (!(cred.roles ?? DEFAULT_CRED_ROLES).includes(role)) return `憑證 ${name} 只開放 ${(cred.roles ?? DEFAULT_CRED_ROLES).join(', ')} 角色的對話使用, 這個對話是 ${role}`
  const allowed = cred.methods.some(m => m === method || (m.endsWith('*') && method.startsWith(m.slice(0, -1))))
  if (!allowed) return `憑證 ${name} 沒有開放 ${method} (允許: ${cred.methods.join(', ') || '(無)'}); owner 可用 /router cred allow ${name} ${method} 加入`
  return null
}

/** Call the Bot API with a credential's token. files: field -> local path, sent as multipart. */
export async function botApiCall(o: { apiRoot?: string; token: string; method: string; params: Record<string, unknown>; files?: Record<string, string> }): Promise<any> {
  const url = `${o.apiRoot ?? 'https://api.telegram.org'}/bot${o.token}/${o.method}`
  let init: RequestInit
  if (o.files && Object.keys(o.files).length) {
    const form = new FormData()
    for (const [k, v] of Object.entries(o.params)) form.append(k, typeof v === 'string' ? v : JSON.stringify(v))
    for (const [field, path] of Object.entries(o.files)) form.append(field, Bun.file(path), path.split('/').pop())
    init = { method: 'POST', body: form }
  } else {
    init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o.params) }
  }
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) })
  return r.json()
}

/** Methods a worker may never call with the router's own bot token: they
 *  would take the updates away from the router or log the bot out. */
export const ROUTER_ONLY_METHODS = new Set(['getUpdates', 'setWebhook', 'deleteWebhook', 'logOut', 'close'])

/** bot_api with credential "self" (or the bot's own name): owner and admin
 *  conversations may call any Bot API method as their own bot. */
export function refuseOwnBot(role: string, method: string): string | null {
  if (role !== 'owner' && role !== 'admin') return `只有 owner 與 admin 的對話能用這隻 bot 自己的 token, 這個對話是 ${role}`
  if (ROUTER_ONLY_METHODS.has(method)) return `${method} 會讓 router 收不到訊息或讓 bot 登出, 不開放`
  return null
}

/** bot_api / http_api refused only because of the conversation's role (the
 *  credential's roles, or "self" for owner/admin): an elevation matter like
 *  any other block. null when the role is fine, or when even the owner would
 *  be refused (unknown credential, method not allowed): refuseUse answers
 *  those at call time. */
export function credRoleRefusal(creds: Record<string, Credential> | undefined, bot: string, tool: string, args: Record<string, unknown>, role: string): string | null {
  const all = creds ?? {}
  const name = String(args.credential ?? '')
  let refuse: (r: string) => string | null
  if (tool === 'bot_api') {
    const method = String(args.method ?? '')
    const own = (name === 'self' || name === bot) && !all[name]
    refuse = r => own ? refuseOwnBot(r, method) : refuseUse(all[name], name, r, method)
  } else if (tool === 'http_api') {
    refuse = r => refuseUse(all[name], name, r, String(args.path ?? ''), 'http')
  } else return null
  const why = refuse(role)
  return why && !refuse('owner') ? why : null
}

/** "123456:AA...": what a Telegram bot token looks like. */
export const TOKEN_RE = /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/

export function describeCreds(cfg: Pick<Config, 'credentials'>): string {
  const all = Object.entries(cfg.credentials ?? {})
  if (!all.length) return '沒有任何憑證. owner 或 admin 可以在私訊用 /router cred add <名稱> <token> [方法...] 加入'
  return all.map(([n, c]) => `${n}: ${c.kind === 'http' ? `http ${c.baseUrl}` : (c.label ?? '(未驗證)')}, ${c.kind === 'http' ? '路徑' : '方法'} ${c.methods.join(', ') || '(無)'}, 角色 ${(c.roles ?? DEFAULT_CRED_ROLES).join(', ')}${c.addedBy ? `, 加入者 ${c.addedBy}` : ''}`).join('\n')
}

/** Call an HTTP API with a credential's key (kind http). json or form +
 *  files (multipart). Returns the status and the parsed body (text when not JSON). */
export async function httpApiCall(o: { cred: Credential; method: string; path: string; json?: unknown; form?: Record<string, unknown>; files?: Record<string, string> }): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { [o.cred.header ?? 'Authorization']: `${o.cred.scheme ?? 'Bearer'} ${o.cred.token}`.trim() }
  let body: BodyInit | undefined
  if (o.files && Object.keys(o.files).length) {
    const form = new FormData()
    for (const [k, v] of Object.entries(o.form ?? {})) form.append(k, typeof v === 'string' ? v : JSON.stringify(v))
    for (const [field, path] of Object.entries(o.files)) form.append(field, Bun.file(path), path.split('/').pop())
    body = form
  } else if (o.form) {
    body = new URLSearchParams(Object.entries(o.form).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]))
  } else if (o.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(o.json)
  }
  const r = await fetch(`${o.cred.baseUrl!.replace(/\/+$/, '')}${o.path}`, { method: o.method, headers, body, signal: AbortSignal.timeout(300_000) })
  const text = await r.text()
  try { return { status: r.status, body: JSON.parse(text) } } catch { return { status: r.status, body: text } }
}

/** Take the base64 at a dotted path out of a response (e.g. data.0.b64_json):
 *  the decoded bytes, and the body with that value replaced by a note. */
export function takeB64(body: any, at: string): { bytes: Buffer | null; body: any } {
  const keys = at.split('.')
  let parent: any = body
  for (const k of keys.slice(0, -1)) parent = parent?.[/^\d+$/.test(k) ? Number(k) : k]
  const last = keys.at(-1)!
  const v = parent?.[/^\d+$/.test(last) ? Number(last) : last]
  if (typeof v !== 'string') return { bytes: null, body }
  const bytes = Buffer.from(v, 'base64')
  parent[/^\d+$/.test(last) ? Number(last) : last] = `<已存檔, ${bytes.length} bytes>`
  return { bytes, body }
}

/** Long strings (base64 images...) would flood the worker's context: cut them. */
export function shorten(v: any, max = 2000): any {
  if (typeof v === 'string') return v.length > max ? `${v.slice(0, 200)}…(${v.length} 字元, 已截斷)` : v
  if (Array.isArray(v)) return v.map(x => shorten(x, max))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shorten(x, max)]))
  return v
}

