// Credentials for cross-bot skills (plan 03 憑證). Tokens a skill needs that
// are not one of the router's own bots (e.g. another bot that owns a sticker
// set) live in config.json under "credentials", never in a skill, a .env a
// worker can read, or a chat. Workers use them through the bot_api tool: the
// router checks the conversation's role and the method against the
// credential's lists and makes the Bot API call itself.

import { realpathSync, statSync, readFileSync } from 'fs'
import { isAbsolute, join, sep } from 'path'
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

/** Call the Bot API with a credential's token, on apiRoot (the bot's or the credential's server). files: field -> local path, sent as multipart. */
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
/** The whole value is a Telegram bot token (bot id, ":", 35 characters):
 *  only such a value is checked with getMe. */
export const BOT_TOKEN_FULL = /^\d{1,20}:[A-Za-z0-9_-]{35}$/

/** For a value that is not a bot token: what it looks like and the --http
 *  words that would register it (never the value itself). */
export function httpExample(value: string): { what: string; flags: string } {
  if (/^sk-ant-/.test(value)) return { what: 'Anthropic API key', flags: '--http https://api.anthropic.com --header x-api-key' }
  if (/^sk-/.test(value)) return { what: 'OpenAI API key', flags: '--http https://api.openai.com' }
  if (/^AIza/.test(value)) return { what: 'Google API key', flags: '--http https://generativelanguage.googleapis.com --header x-goog-api-key' }
  return { what: '', flags: '--http https://api.example.com' }
}

/** Headers the key may not go in: fetch sets them, or they would change the request. */
export const RESERVED_HEADERS = new Set(['host', 'content-length', 'content-type', 'transfer-encoding', 'connection', 'cookie', 'te', 'upgrade', 'expect', 'proxy-authorization'])

/** Where an http key goes: a header (default Authorization) with a scheme
 *  (default Bearer, "" for the bare key), or a query parameter. */
export type KeyPlacement = { header?: string; scheme?: string; query?: string }
/** An http credential's URL, key placement and default headers (cred add, cred-import). */
export type HttpScope = { baseUrl: string; defaultHeaders?: Record<string, string> } & KeyPlacement

/** The words after an API key: "--http <網址> [--header <標頭>] [--scheme
 *  <前綴|none>] [--query <參數>] [路徑...]", the options anywhere. Same
 *  syntax for /router cred add, cred-import and /secret set. */
export function parseHttpScope(words: string[]): { baseUrl: string; placement: KeyPlacement; paths: string[]; defaultHeaders: Record<string, string> } | { error: string } {
  const rest = [...words]
  const opt: Record<string, string> = {}
  // --default-header <名稱>:<值>, any number of times
  const defaults: Array<[string, string]> = []
  for (let i = rest.indexOf('--default-header'); i >= 0; i = rest.indexOf('--default-header')) {
    const d = parseDefaultHeader(rest[i + 1])
    if ('error' in d) return d
    defaults.push([d.name, d.value])
    rest.splice(i, 2)
  }
  for (const flag of ['--http', '--header', '--scheme', '--query']) {
    const i = rest.indexOf(flag)
    if (i < 0) continue
    const v = rest[i + 1]
    if (!v || v.startsWith('--')) return { error: `${flag} 後面要接${{ '--http': '網址, 例如 --http https://api.example.com', '--header': '標頭名稱, 例如 --header x-api-key', '--scheme': '前綴, 例如 --scheme Token (none: 不加前綴)', '--query': 'query 參數名稱, 例如 --query key' }[flag]}` }
    opt[flag] = v
    rest.splice(i, 2)
  }
  let u: URL | null = null
  try { u = new URL(opt['--http'] ?? '') } catch {}
  if (!u || !/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash) return { error: '--http 後面要接網址, 例如 --http https://api.example.com (不含帳密, ? 或 #)' }
  const placement: KeyPlacement = {}
  const header = opt['--header'], scheme = opt['--scheme'], query = opt['--query']
  if (query != null) {
    if (header != null || scheme != null) return { error: '--query 不能跟 --header 或 --scheme 一起用: key 放在 query 參數就不放標頭' }
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(query)) return { error: `query 參數 ${query} 不行: 只能用英數與 . _ -` }
    placement.query = query
  }
  if (header != null) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(header) || RESERVED_HEADERS.has(header.toLowerCase())) return { error: `標頭 ${header} 不行: 只能用英數與 -, 不能是 Host, Content-Type, Cookie, Proxy-Authorization 這類標頭` }
    placement.header = header.toLowerCase() === 'authorization' ? 'Authorization' : header
  }
  if (scheme != null) {
    if (scheme.toLowerCase() !== 'none' && !/^[A-Za-z0-9._-]{1,32}$/.test(scheme)) return { error: `前綴 ${scheme} 不行: 只能用英數與 . _ - (none: 不加前綴)` }
    placement.scheme = scheme.toLowerCase() === 'none' ? '' : scheme
  }
  // only --header: the key goes in that header as it is
  if (placement.header && placement.scheme == null) placement.scheme = ''
  const bad = rest.find(p => !p.startsWith('/') || badPath(p.replace(/\*$/, '')))
  if (bad) return { error: `路徑 ${bad} 不行: 要以 / 開頭, 不能含 .. 等, 例如 /v1/images/generations (結尾 * 代表前綴)` }
  const defaultHeaders: Record<string, string> = {}
  for (const [n, v] of defaults) {
    const why = refuseDefaultHeader(placement, n, v)
    if (why) return { error: why }
    setHeader(defaultHeaders, n, v)
  }
  return { baseUrl: opt['--http']!.replace(/\/+$/, ''), placement, paths: rest, defaultHeaders }
}

/** "<名稱>:<值>" after --default-header (or /router cred header set). */
export function parseDefaultHeader(word: string | undefined): { name: string; value: string } | { error: string } {
  const at = word ? word.indexOf(':') : -1
  if (!word || word.startsWith('--') || at <= 0) return { error: '--default-header 後面要接 <名稱>:<值>, 例如 --default-header anthropic-version:2023-06-01' }
  return { name: word.slice(0, at), value: word.slice(at + 1) }
}

/** Set a header by name, replacing one that differs only in case. */
export function setHeader(all: Record<string, string>, name: string, value: string): void {
  for (const k of Object.keys(all)) if (k.toLowerCase() === name.toLowerCase()) delete all[k]
  all[name] = value
}

/** Why a default header (sent when the worker does not send one of that
 *  name) is refused, or null: the same rules as a worker's own headers. */
export function refuseDefaultHeader(cred: Pick<Credential, 'header' | 'query'>, name: string, value: string): string | null {
  const why = refuseHeaders(cred, { [name]: value })
  return why ? `預設${why}` : null
}

/** Default headers for lists: "" when none. */
export function defaultHeadersText(h: Record<string, string> | undefined | null): string {
  const all = Object.entries(h ?? {})
  return all.length ? `, 預設標頭 ${all.map(([k, v]) => `${k}: ${v}`).join(', ')}` : ''
}

/** How the key is sent, for lists: "" for Authorization: Bearer. */
export function placementText(p: KeyPlacement): string {
  if (p.query) return `, key 放在 query 參數 ${p.query}`
  const h = p.header ?? 'Authorization', sc = p.scheme ?? 'Bearer'
  return h === 'Authorization' && sc === 'Bearer' ? '' : `, 標頭 ${h}${sc ? ` (${sc} <key>)` : ''}`
}

/** Headers a worker may never send with http_api: authentication the
 *  router does not hand out, and transport headers fetch sets itself.
 *  Content-Type too: the router sets it for the body it builds (JSON, form,
 *  multipart with its boundary). An exact list, not name fragments: an
 *  x-csrf-token or idempotency-key is the API's business. */
export const WORKER_DENIED_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade', 'expect', 'content-type'])
export const MAX_EXTRA_HEADERS = 20

/** Why the extra headers a worker gave http_api are refused, or null. Any
 *  header is passed on as it is, except the one the key goes in and
 *  WORKER_DENIED_HEADERS. */
export function refuseHeaders(cred: Pick<Credential, 'header' | 'query'>, headers: unknown): string | null {
  if (headers == null) return null
  if (typeof headers !== 'object' || Array.isArray(headers)) return 'headers 要是物件, 例如 {"anthropic-version": "2023-06-01"}'
  const all = Object.entries(headers as Record<string, unknown>)
  if (all.length > MAX_EXTRA_HEADERS) return `headers 最多 ${MAX_EXTRA_HEADERS} 個`
  const keyHeader = cred.query ? null : (cred.header ?? 'Authorization').toLowerCase()
  for (const [k, v] of all) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(k)) return `標頭 ${k} 不行: 只能用英數與 -`
    if (typeof v !== 'string' || /[\r\n\0]/.test(v) || v.length > 2000) return `標頭 ${k} 的值要是一行文字 (最多 2000 字)`
    const low = k.toLowerCase()
    if (low === keyHeader) return `標頭 ${k} 是憑證放 key 的地方, 由 router 設定, 不能自己帶`
    if (WORKER_DENIED_HEADERS.has(low)) return `標頭 ${k} 不能自己帶: Authorization, Proxy-Authorization, Cookie 只由 router 依憑證放, Host, Content-Type, Content-Length 這類由 router 設定`
  }
  return null
}

/** Why the path's query is refused, or null: with --query the key's
 *  parameter is the router's, the worker may not write it. */
export function refuseKeyParam(cred: Pick<Credential, 'query'>, path: string): string | null {
  if (!cred.query) return null
  const q = path.includes('?') ? path.slice(path.indexOf('?') + 1) : ''
  return [...new URLSearchParams(q).keys()].includes(cred.query) ? `query 參數 ${cred.query} 是憑證放 key 的地方, 由 router 設定, path 裡不能自己帶` : null
}

export function describeCreds(cfg: Pick<Config, 'credentials'>): string {
  const all = Object.entries(cfg.credentials ?? {})
  if (!all.length) return '沒有任何憑證. owner 或 admin 可以在私訊用 /router cred add <名稱> <token> [方法...] 加入'
  // "*" is every path or method; an empty list blocks every call, no roles means no conversation may use it
  const list = (xs: string[], none: string) => xs.length === 1 && xs[0] === '*' ? '全部' : xs.join(', ') || none
  return all.map(([n, c]) => `${n}: ${c.kind === 'http' ? `http ${c.baseUrl}${placementText(c)}${defaultHeadersText(c.defaultHeaders)}` : `${c.label ?? '(未驗證)'}${c.apiRoot ? `, Bot API ${c.apiRoot}` : ''}`}, ${c.kind === 'http' ? '路徑' : '方法'} ${list(c.methods, '(無, 全部擋下)')}, 角色 ${list(c.roles ?? DEFAULT_CRED_ROLES, '(無, 沒有對話能用)')}${c.addedBy ? `, 加入者 ${c.addedBy}` : ''}`).join('\n')
}

/** Call an HTTP API with a credential's key (kind http). json (or jsonText,
 *  a json_file's content sent as it is) or form + files (multipart);
 *  headers: the credential's default headers, then the worker's extra
 *  headers (refuseHeaders first; one of the same name wins), the key's own
 *  header set last. Returns the status and the parsed body (text when not JSON). */
export async function httpApiCall(o: { cred: Credential; method: string; path: string; json?: unknown; jsonText?: string; form?: Record<string, unknown>; files?: Record<string, string>; headers?: Record<string, string> }): Promise<{ status: number; body: any }> {
  const headers = new Headers(o.cred.defaultHeaders ?? {})
  for (const [k, v] of Object.entries(o.headers ?? {})) headers.set(k, v)
  let url = `${o.cred.baseUrl!.replace(/\/+$/, '')}${o.path}`
  if (o.cred.query) {
    const u = new URL(url)
    u.searchParams.set(o.cred.query, o.cred.token)
    url = u.toString()
  } else headers.set(o.cred.header ?? 'Authorization', `${o.cred.scheme ?? 'Bearer'} ${o.cred.token}`.trim())
  let body: BodyInit | undefined
  if (o.files && Object.keys(o.files).length) {
    const form = new FormData()
    for (const [k, v] of Object.entries(o.form ?? {})) form.append(k, typeof v === 'string' ? v : JSON.stringify(v))
    for (const [field, path] of Object.entries(o.files)) form.append(field, Bun.file(path), path.split('/').pop())
    body = form
  } else if (o.form) {
    body = new URLSearchParams(Object.entries(o.form).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]))
  } else if (o.jsonText !== undefined) {
    headers.set('content-type', 'application/json')
    body = o.jsonText
  } else if (o.json !== undefined) {
    headers.set('content-type', 'application/json')
    body = JSON.stringify(o.json)
  }
  const r = await fetch(url, { method: o.method, headers, body, signal: AbortSignal.timeout(300_000) })
  const text = await r.text()
  try { return { status: r.status, body: JSON.parse(text) } } catch { return { status: r.status, body: text } }
}

/** json_file outside the conversation's folder: owner and admin conversations (the turn's role, an elevated one included). */
export const jsonFileAnywhere = (role: string) => role === 'owner' || role === 'admin'

/** Largest json_file http_api sends. */
export const MAX_JSON_FILE = 20 * 1024 * 1024

/** http_api json_file: a file (relative to the conversation's folder, or
 *  absolute) sent as the JSON body, so a large request is not written out as
 *  tool arguments. Only one body: not with json, form or files. The router
 *  reads it, not the worker: never router state (stateDir), and for a
 *  conversation that is not owner or admin (wide false) inside its folder,
 *  both after symlinks. Returns the text to send. */
export function readJsonFile(args: { json?: unknown; json_file?: unknown; form?: unknown; files?: unknown }, folder: string, opts: { wide: boolean; stateDir: string }): { text: string; path: string; bytes: number } | { error: string } | null {
  if (args.json_file == null) return null
  if (typeof args.json_file !== 'string' || !args.json_file) return { error: 'json_file 要是檔案路徑 (相對於這個對話的資料夾, 或絕對路徑)' }
  if (args.json !== undefined || args.form != null || (args.files != null && Object.keys(args.files as object).length)) return { error: 'json_file 與 json, form, files 只能擇一: 請求內容只能有一種' }
  const path = isAbsolute(args.json_file) ? args.json_file : join(folder, args.json_file)
  let real: string
  try { real = realpathSync(path) } catch { return { error: `找不到 json_file ${args.json_file}` } }
  const realOf = (p: string) => { try { return realpathSync(p) } catch { return p } }
  const state = realOf(opts.stateDir)
  if (real === state || real.startsWith(state + sep)) return { error: `json_file ${args.json_file} 在 router 的狀態目錄裡, 不能送出` }
  // owner and admin: any file the router can read; other roles: their folder only
  if (!opts.wide && !real.startsWith(realOf(folder) + sep)) return { error: `json_file ${args.json_file} 要在這個對話的資料夾裡` }
  const st = statSync(real)
  if (!st.isFile()) return { error: `json_file ${args.json_file} 不是檔案` }
  if (st.size > MAX_JSON_FILE) return { error: `json_file ${args.json_file} 有 ${st.size} bytes, 超過上限 ${MAX_JSON_FILE} bytes (20 MB)` }
  const text = readFileSync(real, 'utf8')
  try { JSON.parse(text) } catch (e) { return { error: `json_file ${args.json_file} 不是合法的 JSON (${e instanceof Error ? e.message : e}), 沒有送出` } }
  return { text, path: real, bytes: st.size }
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


/** A /router cred add for a name that exists, waiting for 覆蓋 or 取消. */
export type StagedCred = { bot: string; name: string; token: string; methods: string[]; http?: HttpScope; addedBy: string; chatId: string; messageId?: number }
export const STAGE_TTL_MS = 2 * 60_000

/** New values held in router memory only (never written anywhere) until the
 *  sender presses 覆蓋 or 取消; dropped after ttlMs (onExpire may edit the
 *  question). A restart drops them too. */
export function createCredStaging(o: { ttlMs?: number; onExpire?(s: StagedCred): void } = {}) {
  const all = new Map<number, { s: StagedCred; timer: ReturnType<typeof setTimeout> }>()
  let next = 1
  return {
    stage(s: StagedCred): number {
      const id = next++
      const timer = setTimeout(() => { if (all.delete(id)) o.onExpire?.(s) }, o.ttlMs ?? STAGE_TTL_MS)
      ;(timer as { unref?(): void }).unref?.()
      all.set(id, { s, timer })
      return id
    },
    /** The question message, so an expiry can edit it. */
    attach(id: number, messageId: number): void { const e = all.get(id); if (e) e.s.messageId = messageId },
    peek: (id: number): StagedCred | null => all.get(id)?.s ?? null,
    /** Taken out (pressed): the value leaves memory here. */
    take(id: number): StagedCred | null {
      const e = all.get(id)
      if (!e) return null
      clearTimeout(e.timer)
      all.delete(id)
      return e.s
    },
    size: () => all.size,
  }
}
export type CredStaging = ReturnType<typeof createCredStaging>

/** What a credential is, without its value (the 覆蓋 question, rotate). */
export function credSummary(name: string, c: Credential): string {
  const roles = c.roles ?? DEFAULT_CRED_ROLES
  const list = (xs: string[], none: string) => xs.length === 1 && xs[0] === '*' ? '全部' : xs.join(', ') || none
  return c.kind === 'http'
    ? `${name}: http ${c.baseUrl}${placementText(c)}${defaultHeadersText(c.defaultHeaders)}, 路徑 ${list(c.methods, '(無, 全部擋下)')}, 角色 ${list(roles, '(無, 沒有對話能用)')}${c.addedBy ? `, 加入者 ${c.addedBy}` : ''}`
    : `${name}: Telegram bot token ${c.label ?? '(未驗證)'}${c.apiRoot ? `, Bot API ${c.apiRoot}` : ''}, 方法 ${list(c.methods, '(無, 全部擋下)')}, 角色 ${list(roles, '(無, 沒有對話能用)')}${c.addedBy ? `, 加入者 ${c.addedBy}` : ''}`
}
