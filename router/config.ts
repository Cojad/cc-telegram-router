// config.json loading (plan 03 「專案位置與部署」). Default location: next to
// the router executable; --config <path> overrides. Holds bot tokens, so the
// file is expected to be mode 600 in the router's state dir (<home>/.router
// by default; the router may be installed anywhere).

import { readFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, isAbsolute, join, resolve } from 'path'
import { outermost } from './settings'
import { zoneOk } from './sandboxfs'
import { parseClassifier, type ClassifierConfig } from './classifier'
import { parseReactMode, type ReactMode } from './reactions'
import { parseHealth, type HealthConfig } from './health'

export type BotConfig = {
  name: string
  token: string
  /** This bot's Bot API server (e.g. a self-hosted telegram-bot-api); default the config's apiRoot, then the official one. */
  apiRoot?: string
  /** Self-hosted server in --local mode: attachments are read from disk only under this folder (its --dir); optional. */
  localFilesDir?: string
}

export const OFFICIAL_API_ROOT = 'https://api.telegram.org'
/** The router's first backlog sweep after start (already-running workers get this long to reconnect). */
export const BACKLOG_SWEEP_FIRST_MS = 15_000
/** How often the router checks for secret deletions that are due. */
export const VAULT_TICK_MS = 10_000

/** A token for cross-bot skills (router/credentials.ts); never shown to workers. */
export type Credential = {
  token: string
  /** telegram-bot (default): a bot token used through bot_api; http: an API
   *  key used through http_api against baseUrl. */
  kind?: 'telegram-bot' | 'http'
  /** Bot API methods it may be used for; for http, the allowed request paths
   *  (exact, or ending in * for a prefix). */
  methods: string[]
  /** http: e.g. https://api.openai.com */
  baseUrl?: string
  /** telegram-bot: the Bot API server to use it with; default the config's apiRoot. */
  apiRoot?: string
  /** http: header carrying the key (default Authorization) and its scheme (default Bearer; "" for the bare key). */
  header?: string
  scheme?: string
  /** http: query parameter carrying the key instead of a header (e.g. "key"). */
  query?: string
  /** http: headers sent when the worker's http_api call has none of that
   *  name (e.g. anthropic-version); not secret, shown by /router cred list. */
  defaultHeaders?: Record<string, string>
  /** Conversation roles that may use it; default owner and admin. */
  roles?: string[]
  /** "@username (id)" from getMe when it was added. */
  label?: string
  addedBy?: string
}

export type Config = {
  /** Where this config file lives; relative paths below resolve against it. */
  path: string
  bots: BotConfig[]
  /** Root holding one folder per conversation (the router's home), e.g. /srv/cc. */
  home: string
  /** Router-private state: db, socket, settings, access.json. */
  stateDir: string
  socket: string
  /** Telegram UIDs with the owner role. */
  owners: string[]
  /** Worker model, passed as --model. */
  model: string
  /** Default autoCompactWindow for new conversations. */
  autoCompactWindow: number
  /** claude CLI to spawn workers with. */
  claudeBin: string
  /** Bot API server for every bot and credential without their own (a
   *  self-hosted telegram-bot-api, or tests); default https://api.telegram.org. */
  apiRoot?: string
  credentials: Record<string, Credential>
  /** base64 AES-256 key for conversation secrets (router/secrets.ts); generated at startup when missing. */
  secretKey?: string
  /** Daily refresh of privileged skills' credentials (router/skillrefresh.ts):
   *  "HH:MM" GMT+8, default "05:00"; null when config says "off". */
  skillRefreshAt?: string | null
  /** Daily check of the official plugin's cache against what deploy/install.sh
   *  plugin recorded (router/pluginguard.ts): "HH:MM" GMT+8, default "09:07"; null when "off". */
  pluginCheckAt?: string | null
  /** Tool call classifier, stage 1 (router/classifier.ts): record only; off when missing. */
  classifier?: ClassifierConfig
  /** Extra absolute paths hidden from every sandbox (role templates' denyRead,
   *  privileged skill bwrap) besides home, stateDir and the user's home: e.g.
   *  other projects on the same machine. Default none. */
  sandboxDenyRead?: string[]
  /** Extra absolute paths every privileged skill's sandbox sees read-only (router/sandboxfs.ts:
   *  besides /usr and a few /etc files nothing of the host is there); their bin folders go on
   *  PATH. Default none. */
  sandboxExtraRo?: string[]
  /** The privileged sandboxes' time zone (TZ and /etc/localtime): a name under /usr/share/zoneinfo, default Asia/Taipei. */
  sandboxTimezone?: string
  /** Which message reactions reach workers when the conversation has no
   *  /router chat react of its own (router/reactions.ts); default botself_only. */
  receiveReact: ReactMode
  /** How long reactions wait for more before going to the worker alone (default 60000); only tests shorten it. */
  reactFlushMs?: number
  /** The health endpoint for outside monitors (router/health.ts): loopback only; off when missing or wrong. */
  health?: HealthConfig
  /** How long after start the router first sweeps the backlog (default BACKLOG_SWEEP_FIRST_MS); only tests shorten it. */
  backlogSweepFirstMs?: number
  /** How often due secret deletions are checked (default VAULT_TICK_MS); only tests shorten it. */
  vaultTickMs?: number
  /** How workers get their channel (docs/managed-channel.md): auto (default) runs every claude
   *  inside bwrap with the router's own config folder and plugin when it can, else legacy;
   *  legacy always uses the official plugin's cache in the user's config folder. */
  channelMode?: 'auto' | 'legacy'
  /** Managed mode's options (docs/managed-channel.md): shareSessions (default true) binds the user's
   *  session registry over the router's, so ListAgents and SendMessage by name reach both ways. */
  managed?: { shareSessions: boolean }
  /** Optional settings that were wrong and so turned off (logged at start): the router still runs. */
  warnings?: string[]
}

/** config managed: { "shareSessions": true|false }; missing is on, anything wrong is on with a warning. */
export function parseManaged(v: unknown, warnings: string[]): { shareSessions: boolean } {
  if (v === undefined || v === null) return { shareSessions: true }
  if (typeof v !== 'object' || Array.isArray(v)) { warnings.push(`managed 要是物件 (例如 { "shareSessions": true }), 收到 ${JSON.stringify(v)}; 用預設 (shareSessions 開)`); return { shareSessions: true } }
  const s = (v as Record<string, unknown>).shareSessions
  if (s === undefined || typeof s === 'boolean') return { shareSessions: s ?? true }
  warnings.push(`managed.shareSessions 要是 true 或 false, 收到 ${JSON.stringify(s)}; 用預設 (開)`)
  return { shareSessions: true }
}

/** config channelMode: "auto" (or missing) or "legacy"; anything else is auto with a warning. */
export function parseChannelMode(v: unknown, warnings: string[]): 'auto' | 'legacy' {
  if (v === undefined || v === null || v === 'auto') return 'auto'
  if (v === 'legacy') return 'legacy'
  warnings.push(`channelMode 要是 "auto" 或 "legacy", 收到 ${JSON.stringify(v)}; 用 auto`)
  return 'auto'
}

/** skillRefreshAt as loadConfig takes it: a wrong value turns the daily refresh off with a warning instead of stopping the router (an optional feature). */
export function refreshAtOrOff(v: unknown, warnings: string[]): string | null {
  try { return parseRefreshAt(v) } catch (e) { warnings.push(`${e instanceof Error ? e.message : e}; 特權技能的每日憑證更新已關閉`); return null }
}

/** config skillRefreshAt: "HH:MM" (GMT+8), "off" (or false) to disable, missing = 05:00. */
export function parseRefreshAt(v: unknown): string | null {
  return parseDailyAt(v, 'skillRefreshAt', '05:00')
}

/** A daily time in config: "HH:MM" (GMT+8), "off" (or false) to disable, missing = dflt. */
export function parseDailyAt(v: unknown, key: string, dflt: string): string | null {
  if (v === undefined || v === null) return dflt
  if (v === false || v === 'off') return null
  const m = typeof v === 'string' ? /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(v.trim()) : null
  if (!m) throw new Error(`${key} 要是 "HH:MM" (GMT+8) 或 "off", 收到 ${JSON.stringify(v)}`)
  return `${m[1]!.padStart(2, '0')}:${m[2]}`
}

/** config pluginCheckAt as loadConfig takes it: a wrong value turns the daily check off with a warning (the check at each hello stays). */
export function pluginCheckAtOrOff(v: unknown, warnings: string[]): string | null {
  try { return parseDailyAt(v, 'pluginCheckAt', '09:07') } catch (e) { warnings.push(`${e instanceof Error ? e.message : e}; 官方 plugin 快取的每日檢查已關閉`); return null }
}

/** config sandboxDenyRead: absolute paths, not "/". A wrong entry is left out
 *  with a warning (home, stateDir and the user's home stay hidden regardless). */
export function parseDenyRead(v: unknown, warnings: string[], field = 'sandboxDenyRead', none = '沒有額外隱藏的路徑'): string[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) { warnings.push(`${field} 要是路徑陣列, 收到 ${JSON.stringify(v)}; ${none}`); return [] }
  const out: string[] = []
  for (const p of v) {
    if (typeof p !== 'string' || !isAbsolute(p) || resolve(p) === '/') warnings.push(`${field} 的 ${JSON.stringify(p)} 不是絕對路徑 (也不能是 /), 略過`)
    else out.push(resolve(p))
  }
  return out
}

/** config sandboxTimezone: a zone the sandbox has (/usr/share/zoneinfo); missing or wrong = Asia/Taipei (a wrong one warns). */
export function parseTimezone(v: unknown, warnings: string[]): string {
  if (v === undefined || v === null || v === '') return 'Asia/Taipei'
  if (typeof v === 'string' && zoneOk(v)) return v
  warnings.push(`sandboxTimezone 要是 /usr/share/zoneinfo 裡的時區名稱 (例如 Asia/Taipei), 收到 ${JSON.stringify(v)}; 用 Asia/Taipei`)
  return 'Asia/Taipei'
}

/** config sandboxExtraRo: absolute paths, not "/"; a wrong entry is left out with a warning. */
export const parseExtraRo = (v: unknown, warnings: string[]) => parseDenyRead(v, warnings, 'sandboxExtraRo', '特權技能的沙箱沒有額外的唯讀路徑')

/** Folders a worker cannot do without: a socket configured as one of these is never hidden. */
const SYSTEM_DIRS = new Set(['/', '/tmp', '/var/tmp', '/run', '/var/run', '/run/user', '/dev', '/dev/shm', '/proc', '/sys', '/usr', '/etc', '/var', '/home'])

/** What every sandbox hides (besides the user's home): the router's home,
 *  its state dir when that lies elsewhere, config sandboxDenyRead, and the
 *  router's socket when it lies outside all of them: the socket file itself
 *  (never its folder, say /tmp or /run), and not when it is in the user's
 *  home (hidden by ~ already), is that home or a folder above it, or is a
 *  system folder. */
export function hiddenPaths(cfg: Pick<Config, 'home' | 'stateDir' | 'sandboxDenyRead'> & { socket?: string }, userHome = homedir()): string[] {
  const sock = cfg.socket ? resolve(cfg.socket) : null
  const home = resolve(userHome)
  const under = (p: string, dir: string) => p === dir || p.startsWith(dir === '/' ? dir : dir + '/')
  const showSock = !sock || SYSTEM_DIRS.has(sock) || under(sock, home) || under(home, sock)
  return outermost([cfg.home, cfg.stateDir, ...(cfg.sandboxDenyRead ?? []), ...(showSock ? [] : [sock!])])
}

/** An apiRoot as config takes it: an http(s) URL without the trailing /; anything else is left out with a warning (the next level applies). */
export function parseApiRoot(v: unknown, where: string, warnings: string[]): string | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v === 'string' && /^https?:\/\/[^/\s]+/.test(v.trim())) return v.trim().replace(/\/+$/, '')
  warnings.push(`${where} 要是 http(s) 網址, 收到 ${JSON.stringify(v)}; 改用${where === 'apiRoot' ? '官方 Bot API' : '上一層的 apiRoot'}`)
  return undefined
}

/** The Bot API server of one of the router's bots: its own apiRoot, else the config's, else the official one. */
export function botApiRoot(cfg: Pick<Config, 'apiRoot' | 'bots'>, bot: string | Pick<BotConfig, 'apiRoot'> | undefined): string {
  const b = typeof bot === 'string' ? cfg.bots.find(x => x.name === bot) : bot
  return b?.apiRoot ?? cfg.apiRoot ?? OFFICIAL_API_ROOT
}

/** The Bot API server a telegram-bot credential is used with: its own apiRoot, else the config's, else the official one. */
export function credApiRoot(cfg: Pick<Config, 'apiRoot'>, cred: Pick<Credential, 'apiRoot'> | undefined): string {
  return (cred?.apiRoot ? cred.apiRoot.replace(/\/+$/, '') : undefined) ?? cfg.apiRoot ?? OFFICIAL_API_ROOT
}

export function defaultConfigPath(argv: string[], execPath: string): string {
  const i = argv.indexOf('--config')
  if (i >= 0 && argv[i + 1]) return resolve(argv[i + 1])
  return join(dirname(execPath), 'config.json')
}

export function loadConfig(path: string): Config {
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  const base = dirname(path)
  const abs = (p: string | undefined, fallback: string) => resolve(base, p ?? fallback)
  if (!Array.isArray(raw.bots) || raw.bots.length === 0) throw new Error(`${path}: bots[] is empty`)
  for (const b of raw.bots) {
    if (!b.name || !b.token) throw new Error(`${path}: every bot needs name and token`)
  }
  const stateDir = abs(raw.stateDir, '.')
  const warnings: string[] = []
  const bots: BotConfig[] = raw.bots.map((b: Record<string, unknown>) => {
    const { apiRoot: _a, localFilesDir: _l, ...rest } = b
    const apiRoot = parseApiRoot(b.apiRoot, `bots[${b.name}].apiRoot`, warnings)
    let localFilesDir: string | undefined
    if (b.localFilesDir !== undefined && b.localFilesDir !== null && b.localFilesDir !== '') {
      if (typeof b.localFilesDir === 'string' && isAbsolute(b.localFilesDir) && resolve(b.localFilesDir) !== '/') localFilesDir = resolve(b.localFilesDir)
      else warnings.push(`bots[${b.name}].localFilesDir 要是絕對路徑 (不能是 /), 收到 ${JSON.stringify(b.localFilesDir)}; 不限制附件的資料夾`)
    }
    return { ...rest, ...(apiRoot ? { apiRoot } : {}), ...(localFilesDir ? { localFilesDir } : {}) } as BotConfig
  })
  return {
    path,
    bots,
    home: abs(raw.home, '..'),
    stateDir,
    socket: abs(raw.socket, join(stateDir, 'router.sock')),
    owners: (raw.owners ?? []).map(String),
    model: raw.model ?? 'claude-opus-5-5',
    autoCompactWindow: raw.autoCompactWindow ?? 750000,
    claudeBin: raw.claudeBin ?? 'claude',
    apiRoot: parseApiRoot(raw.apiRoot, 'apiRoot', warnings),
    credentials: raw.credentials ?? {},
    secretKey: raw.secretKey,
    skillRefreshAt: refreshAtOrOff(raw.skillRefreshAt, warnings),
    pluginCheckAt: pluginCheckAtOrOff(raw.pluginCheckAt, warnings),
    classifier: parseClassifier(raw.classifier),
    sandboxDenyRead: parseDenyRead(raw.sandboxDenyRead, warnings),
    sandboxExtraRo: parseExtraRo(raw.sandboxExtraRo, warnings),
    sandboxTimezone: parseTimezone(raw.sandboxTimezone, warnings),
    receiveReact: parseReactMode(raw.receiveReact, warnings),
    reactFlushMs: typeof raw.reactFlushMs === 'number' && raw.reactFlushMs > 0 ? raw.reactFlushMs : undefined,
    health: parseHealth(raw.health, warnings),
    backlogSweepFirstMs: typeof raw.backlogSweepFirstMs === 'number' && raw.backlogSweepFirstMs > 0 ? raw.backlogSweepFirstMs : undefined,
    vaultTickMs: typeof raw.vaultTickMs === 'number' && raw.vaultTickMs > 0 ? raw.vaultTickMs : undefined,
    channelMode: parseChannelMode(raw.channelMode, warnings),
    managed: parseManaged(raw.managed, warnings),
    warnings,
  }
}
