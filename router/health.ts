// The health endpoint for outside monitors such as Gatus (docs/operations.md
// 「健康檢查端點」): optional, off unless config.json has "health". Any
// address listens; one that is not loopback is warned about in the log and
// in the start notice, louder when it is public. GET /healthz answers 200 when every bot's last
// successful getUpdates is within staleAfterS, else 503, with a JSON body:
// version, uptime, each bot's polling (by its config name), how many
// conversations are on standby, asleep, held back after failed wakes or
// running without the plugin, and the last wake that failed. Never a token,
// chat, user, conversation key or message: the cause of a failed wake has
// the conversation's folder, key, chat id, title and long numbers replaced.
// A wrong setting or a port in use only turns it off, with a log line.
// Also the router's start and stop notices to 🔔 重要通知 (startNotice,
// stopNotice, stopSource): its version, the endpoint and how exposed it is,
// and who stopped or restarted it.
// Tests: router/test/health.test.ts, e2e-health.test.ts.

import { createHash, timingSafeEqual } from 'crypto'
import { iso8 } from '../shared/time'
import { maskTokens } from './context'

export type HealthConfig = {
  /** An IPv4 or IPv6 address (without brackets) or a host name, as written. */
  host: string
  port: number
  /** When set, GET /healthz needs Authorization: Bearer <token>. */
  token?: string
  /** A bot whose last successful getUpdates is older than this is down (503). */
  staleAfterS: number
}

/** Three times the router's getUpdates long polling timeout (30 s, main.ts):
 *  an idle bot succeeds at least every 30 s, and one failed call with the
 *  first retries (5 s, 10 s, 30 s, router/poller.ts) still fits. */
export const DEFAULT_STALE_AFTER_S = 90

/** config health: { listen: "127.0.0.1:8787", token?, staleAfterS? }; missing =
 *  off. Any address (exposure tells how far it reaches); anything wrong (no
 *  port, not an address, a token that is not a string) turns it off with a
 *  warning; a wrong staleAfterS uses the default. */
export function parseHealth(v: unknown, warnings: string[]): HealthConfig | undefined {
  if (v === undefined || v === null || v === false) return undefined
  const off = (why: string) => { warnings.push(`health ${why}; 健康檢查端點不開`); return undefined }
  if (typeof v !== 'object' || Array.isArray(v)) return off(`要是 { "listen": "127.0.0.1:<port>" }, 收到 ${JSON.stringify(v)}`)
  const o = v as Record<string, unknown>
  const listen = typeof o.listen === 'string' ? o.listen.trim() : ''
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(listen) ?? /^([^:\s]+):(\d+)$/.exec(listen)
  if (!m) return off(`.listen 要是 "<位址>:<port>" (IPv6 寫成 "[::1]:<port>"), 例如 "127.0.0.1:8787", 收到 ${JSON.stringify(o.listen)}`)
  const host = m[1]!.toLowerCase(), port = Number(m[2])
  const known = /^[\d.]+$/.test(host) ? ipv4(host) : host.includes(':') ? ipv6(host) : /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host)
  if (!known) return off(`.listen 的位址 ${JSON.stringify(m[1])} 不是 IP 位址或主機名稱`)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return off(`.listen 的 port 要是 1 到 65535, 收到 ${m[2]}`)
  let token: string | undefined
  if (o.token !== undefined && o.token !== null && o.token !== '') {
    // never echo it back: not even a wrong one
    if (typeof o.token !== 'string') return off('.token 要是字串')
    token = o.token
  }
  let staleAfterS = DEFAULT_STALE_AFTER_S
  if (o.staleAfterS !== undefined && o.staleAfterS !== null) {
    if (typeof o.staleAfterS === 'number' && Number.isFinite(o.staleAfterS) && o.staleAfterS >= 1) staleAfterS = o.staleAfterS
    else warnings.push(`health.staleAfterS 要是 1 以上的秒數, 收到 ${JSON.stringify(o.staleAfterS)}; 用預設 ${DEFAULT_STALE_AFTER_S}`)
  }
  return { host, port, ...(token ? { token } : {}), staleAfterS }
}

// --- how far an address reaches --------------------------------------------------

/** An IPv4 address as 4 bytes, or null. */
function ipv4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (!m) return null
  const b = m.slice(1).map(Number)
  return b.every(x => x <= 255) ? b : null
}

/** An IPv6 address as 8 groups, or null (an IPv4 tail as in ::ffff:10.0.0.1 is read too). */
function ipv6(s: string): number[] | null {
  if (!s.includes(':') || !/^[0-9a-f:.]+$/.test(s)) return null
  // an IPv4 tail becomes its two groups
  const v4 = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (v4) {
    const b = ipv4(v4[2]!)
    if (!b) return null
    s = `${v4[1]}${((b[0]! << 8) | b[1]!).toString(16)}:${((b[2]! << 8) | b[3]!).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const part = (x: string) => (x ? x.split(':') : []).map(g => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN))
  const head = part(halves[0]!), rest = halves.length === 2 ? part(halves[1]!) : []
  const fill = 8 - head.length - rest.length
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill(0), ...rest]
  return groups.every(g => Number.isInteger(g)) ? groups : null
}

const inV4 = (b: number[], net: [number, number, number, number], bits: number) => {
  const n = (x: number[]) => ((x[0]! << 24) | (x[1]! << 16) | (x[2]! << 8) | x[3]!) >>> 0
  return bits === 0 || (n(b) >>> (32 - bits)) === (n(net) >>> (32 - bits))
}

/** How far a listen address reaches: loopback (this machine only), private
 *  (10/8, 172.16/12, 192.168/16, 100.64/10 CGNAT, 169.254/16 link-local,
 *  fc00::/7, fe80::/10) or public (anything else, 0.0.0.0 and :: included,
 *  and a host name, which may resolve anywhere). */
export function exposure(host: string): 'loopback' | 'private' | 'public' {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost') return 'loopback'
  let v4 = ipv4(h)
  const v6 = v4 ? null : ipv6(h)
  // IPv4-mapped (::ffff:a.b.c.d): the IPv4 address decides
  if (v6 && v6.slice(0, 5).every(g => g === 0) && v6[5] === 0xffff) v4 = [v6[6]! >> 8, v6[6]! & 255, v6[7]! >> 8, v6[7]! & 255]
  if (v4) {
    if (inV4(v4, [127, 0, 0, 0], 8)) return 'loopback'
    const priv: Array<[[number, number, number, number], number]> = [[[10, 0, 0, 0], 8], [[172, 16, 0, 0], 12], [[192, 168, 0, 0], 16], [[100, 64, 0, 0], 10], [[169, 254, 0, 0], 16]]
    return priv.some(([net, bits]) => inV4(v4!, net, bits)) ? 'private' : 'public'
  }
  if (v6) {
    if (v6.slice(0, 7).every(g => g === 0) && v6[7] === 1) return 'loopback'
    if ((v6[0]! & 0xfe00) === 0xfc00 || (v6[0]! & 0xffc0) === 0xfe80) return 'private'
  }
  return 'public'
}

const hostPort = (h: HealthConfig) => `${h.host.includes(':') ? `[${h.host}]` : h.host}:${h.port}`
export const healthUrl = (h: HealthConfig) => `http://${hostPort(h)}/healthz`

/** For /router config show: where it listens and whether a token is set, never the token. */
export function describeHealth(h: HealthConfig | undefined): string {
  if (!h) return '關閉'
  return `${hostPort(h)}/healthz${h.token ? ' (要 token, 已設定)' : ' (未設 token)'}, 門檻 ${h.staleAfterS} 秒`
}

/** Log lines about who can reach it: an address that is not loopback, and no token. */
export function exposureWarnings(h: HealthConfig): string[] {
  const e = exposure(h.host)
  const out: string[] = []
  if (e === 'public') out.push(`health: ⚠️ 聽在 ${hostPort(h)}, 不是本機也不是私有網段: health point 對外開放, 請注意防範`)
  if (e === 'private') out.push(`health: ⚠️ 聽在 ${hostPort(h)}, 不是本機位址: 同一個私有網段的其他機器連得到`)
  if (!h.token) out.push(`health: ⚠️ 未設 token: 連得到 ${hostPort(h)} 的${e === 'loopback' ? '這台機器上的程式' : '人'}都看得到狀態`)
  return out
}

// --- the router's start and stop notices (🔔 重要通知) -------------------------------

/** At every start: the version; with health, its URL (or that it did not
 *  start), a public address and a missing token each a line of their own. */
export function startNotice(version: string, h: HealthConfig | undefined, listening: boolean): string {
  const out = [`🟢 cc-telegram-router ${version} 啟動`]
  if (h && !listening) out.push(`⚠️ health point (${healthUrl(h)}) 沒有啟動, 原因見 router 的 log`)
  if (h && listening) {
    out.push(`health point (${healthUrl(h)}) 啟動`)
    if (exposure(h.host) === 'public') out.push('⚠️ health point 對外開放, 請注意防範')
    if (exposure(h.host) === 'private') out.push('⚠️ health point 不在本機位址, 同一個私有網段的其他機器連得到')
    if (!h.token) out.push('⚠️ health point 未設 token, 連得到的都看得到狀態')
  }
  return out.join('\n')
}

/** Who stopped the router: cli, telegram: <name>, systemd when its job for
 *  the unit was found (systemdJob), else the signal (systemd's when it runs
 *  under systemd). */
export function stopSource(o: { by?: string; signal?: string; systemd?: boolean; job?: SystemdJob | null }): string {
  if (o.by) return o.by
  if (o.systemd && o.job) return 'systemd'
  return o.systemd ? `systemd (${o.signal ?? '?'})` : `訊號 ${o.signal ?? '?'}`
}

export type SystemdJob = 'restart' | 'stop'

/** The type of the job systemd runs on unit, from systemctl --user list-jobs
 *  --no-legend ("<id> <unit> <type> <state>" per line): restart or stop, else null. */
export function parseJobType(listJobs: string, unit: string): SystemdJob | null {
  for (const line of listJobs.split('\n')) {
    const [, u, type] = line.trim().split(/\s+/)
    if (u === unit && (type === 'restart' || type === 'stop')) return type
  }
  return null
}

export type JobRunner = (args: string[], signal: AbortSignal) => Promise<{ code: number; stdout: string }>

/** At a SIGTERM under systemd: whether systemd is restarting or stopping the
 *  unit (its job in list-jobs); null when not known within timeoutMs or the
 *  command fails, so a stop is never held up longer. */
export async function systemdJob(unit: string, run: JobRunner, timeoutMs = 2_000): Promise<SystemdJob | null> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await Promise.race([
      run(['systemctl', '--user', 'list-jobs', '--no-legend', '--full'], ac.signal),
      new Promise<null>(res => ac.signal.addEventListener('abort', () => res(null), { once: true })),
    ])
    return r && r.code === 0 ? parseJobType(r.stdout, unit) : null
  } catch { return null } finally { clearTimeout(timer) }
}

/** At a stop: a restart says so (a start notice follows), with where it came from. */
export function stopNotice(version: string, restart: boolean, source: string): string {
  return `🔴 cc-telegram-router ${version} ${restart ? '重啟' : '關機'} (來源: ${source})`
}

/** Constant time: both sides hashed to the same length first, so neither the length nor the first wrong byte shows in the timing. */
export function sameSecret(given: string, token: string): boolean {
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(token).digest()
  return timingSafeEqual(a, b)
}

/** Whether a request may see the report: no token configured, or Authorization: Bearer <token>. */
export function authorized(header: string | null, token: string | undefined): boolean {
  if (!token) return true
  const m = /^Bearer[ \t]+(.+)$/i.exec(header?.trim() ?? '')
  return sameSecret(m ? m[1]!.trim() : '', token)
}

/** Text from a failed wake without who it was about: the conversation's
 *  folder, key, chat id and title, bot usernames, then any run of 6 or more
 *  digits (Telegram ids) and tokens. */
export function scrubPrivate(text: string, known: Array<string | null | undefined>): string {
  let s = maskTokens(text)
  // longest first: a folder contains the key, the key contains the chat id
  for (const k of [...new Set(known.filter((x): x is string => !!x && x.length >= 2))].sort((a, b) => b.length - a.length)) s = s.split(k).join('<隱藏>')
  return s.replace(/\d{3,15}:…[A-Za-z0-9_-]{4}/g, '<token>').replace(/\d{6,}/g, '<id>')
}

export type BotPoll = { name: string; state: string; lastOk: number | null; since: number }
export type WorkerCounts = { total: number; standby: number; asleep: number; backoff: number; pluginDisconnected: number | null }
export type WakeFailure = { at: number; bot: string; failures: number; cause: string }

export type HealthInput = {
  now: number
  version: string
  startedAt: number
  staleAfterS: number
  /** since: when this bot's poller was made (a bot not polled yet counts from then). */
  bots: BotPoll[]
  workers: WorkerCounts
  lastWakeFailure: WakeFailure | null
}

/** Who is where, by the router's own definitions (/router status): standby =
 *  the worker's plugin is connected (🛜待命中), asleep = not (💤已休眠);
 *  backoff = asleep conversations whose next wake is held back after failed
 *  wakes (router/diagnose.ts createWakeTracker); pluginDisconnected = the
 *  daemon runs the worker but its plugin is not connected (null when the
 *  daemon could not be asked). */
export function countWorkers(keys: string[], o: { isConnected(key: string): boolean; heldUntil(key: string): number; running: Set<string> | null; now: number }): WorkerCounts {
  let standby = 0, backoff = 0, pd = 0
  for (const k of keys) {
    if (o.isConnected(k)) { standby++; continue }
    if (o.heldUntil(k) > o.now) backoff++
    if (o.running?.has(k)) pd++
  }
  return { total: keys.length, standby, asleep: keys.length - standby, backoff, pluginDisconnected: o.running ? pd : null }
}

const secs = (ms: number) => Math.max(0, Math.round(ms / 1000))

/** The report and its status: 503 when any bot's last success (or its start, before one) is older than staleAfterS. */
export function healthReport(i: HealthInput): { status: 200 | 503; body: Record<string, unknown> } {
  const bots: Record<string, unknown> = {}
  let allOk = i.bots.length > 0
  for (const b of i.bots) {
    const ago = secs(i.now - (b.lastOk ?? b.since))
    const ok = ago <= i.staleAfterS
    if (!ok) allOk = false
    bots[b.name] = { ok, state: b.state, lastOkAt: b.lastOk == null ? null : iso8(b.lastOk), lastOkAgoS: b.lastOk == null ? null : ago, ...(b.lastOk == null ? { waitingS: ago } : {}) }
  }
  const f = i.lastWakeFailure
  return {
    status: allOk ? 200 : 503,
    body: {
      status: allOk ? 'ok' : 'down',
      version: i.version,
      now: iso8(i.now),
      startedAt: iso8(i.startedAt),
      uptimeS: secs(i.now - i.startedAt),
      staleAfterS: i.staleAfterS,
      bots,
      workers: i.workers,
      lastWakeFailure: f ? { at: iso8(f.at), agoS: secs(i.now - f.at), bot: f.bot, failures: f.failures, cause: f.cause } : null,
    },
  }
}

const json = (status: number, body: unknown, head: boolean, extra: Record<string, string> = {}) =>
  new Response(head ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } })

/** One request: /healthz only, GET or HEAD, the token when one is set. */
export async function handleHealth(req: Request, token: string | undefined, report: () => Promise<{ status: number; body: unknown }>): Promise<Response> {
  const head = req.method === 'HEAD'
  if (new URL(req.url).pathname !== '/healthz') return json(404, { error: 'not found' }, head)
  if (req.method !== 'GET' && !head) return json(405, { error: 'method not allowed' }, false, { allow: 'GET, HEAD' })
  if (!authorized(req.headers.get('authorization'), token)) return json(401, { error: 'unauthorized' }, head, { 'www-authenticate': 'Bearer' })
  const r = await report()
  return json(r.status, r.body, head)
}

/** Listen, or null (with a log line) when it cannot: a port in use never stops the router. */
export function startHealthServer(h: HealthConfig, report: () => Promise<{ status: number; body: unknown }>, log: (m: string) => void): { stop(): void; port: number } | null {
  try {
    const server = Bun.serve({
      hostname: h.host,
      port: h.port,
      fetch: req => handleHealth(req, h.token, report).catch(e => { log(`health: ${e}`); return json(500, { error: 'internal error' }, req.method === 'HEAD') }),
      error: () => new Response(null, { status: 500 }),
    })
    log(`health: listening on ${describeHealth(h)}`)
    for (const w of exposureWarnings(h)) log(w)
    return { stop: () => server.stop(true), port: server.port ?? h.port }
  } catch (e) {
    log(`health: cannot listen on ${h.host}:${h.port} (${e instanceof Error ? e.message : e}); 健康檢查端點不開, router 照常運作`)
    return null
  }
}
