// Privileged skill actions: a skill's sudo bit (plan 10d, 柯姊 2026-10-16).
// A skill installed at bot or all-bots scope may carry privileged.json, a
// list of actions (like sudoers entries). Once owner or admin approves the
// skill (/router skill approve), a conversation of an allowed role calls an
// action with run_skill; the router runs it outside the conversation's own
// sandbox, in a bwrap sandbox made for that action (docs/skill-runtime.md):
//   - a whitelisted file system (router/sandboxfs.ts): /usr, a few /etc files,
//     the skill folder and the action's credential folders read-only; the
//     conversation folder (its .chat read-only) and a private /tmp writable;
//     nothing else exists (the user's home, the router's home and state dir,
//     other conversations and skills)
//   - its own network (router/sandboxnet.ts): the internet on ports 80, 443,
//     53, 22, nothing on the host or private networks
//   - an internal action may declare host access (host: ports, mounts, env),
//     approved only by owner
// Credentials are handed to the script as folder paths in env vars; the
// conversation never gets them. The skill's files are hashed at approval and
// checked before every run. Arguments are matched against the action's
// patterns and passed one by one (no shell). Output going back to the
// conversation, and text files the run wrote, are scanned for credential
// content: anything found is removed and the owner told. At most 10 runs per
// conversation per hour. An action may name a refresh action (internal, not
// callable by conversations) the router runs once when the output shows the
// credentials were refused, then it retries. An action may also use an http
// API credential (http): the script gets the auth header in an env var, the
// key never reaches the conversation and is scrubbed from what comes back.
// An argument may need a higher role (args.<name>.roles, e.g. a "longer than
// 15 minutes" flag): lower roles get refused, which the router's hook turns
// into an elevation request (router/elevation.ts extraCheck).
// An action may use a bot token credential (bots): the script gets
// $<ENV>_API = <apiRoot>/bot<token>, scrubbed from what comes back like http.
// An action may keep a database (store, router/skillstore.ts): the bot's copy
// under <stateDir>/skill-store/, staged writable for the run and written back
// only when what changed passes the checks of its mode (append or full).

import { createHash } from 'crypto'
import { existsSync, readdirSync, readFileSync, statSync, lstatSync, rmSync } from 'fs'
import { join, relative, isAbsolute } from 'path'
import { systemArgs } from './sandboxfs'
import { TOOL_NAMES } from './toolbox'
import { limitsError, raisedLimits } from './sandboxlimits'

export type ArgSpec = {
  pattern?: string
  flag?: string
  /** Only these roles may pass this argument (a flag: set it); others need elevation. */
  roles?: string[]
}
export type Action = {
  /** argv: "scripts/x.sh" resolves inside the skill; "{name}" an argument;
   *  "{name?}" an optional flag argument; "{cred:ENV}" that credential's folder. */
  run: string[]
  args?: Record<string, ArgSpec>
  roles?: string[]
  /** env var -> credential folder name (under the router's creds dir) */
  creds?: Record<string, string>
  timeout?: number
  /** Not callable by conversations: only the router runs it (refresh). */
  internal?: boolean
  /** Output matching this means the credentials were refused... */
  auth_failure?: string
  /** ...then run this internal action once and retry. */
  refresh?: string
  /** Internal actions only, owner approval: what of the host it reaches (HostDecl). */
  host?: HostDecl
  /** Raised resource limits (router/sandboxlimits.ts: memory_mb, tasks, file_mb, output_kb); above the defaults only owner approves. */
  limits?: Partial<Record<'memory_mb' | 'tasks' | 'file_mb' | 'output_kb', number>>
  /** Exit codes that are a normal stop, not a failure, with what they mean (e.g. {"4": "影片太長"}). */
  stop_exits?: Record<string, string>
  /** Toolbox tools the action needs (router/toolbox.ts: ffmpeg, deno, uv): refused, saying which, when one is missing. */
  tools?: string[]
  /** Not internal, owner approval: internet ports besides 80, 443, 53, 22 (tcp and udp). */
  outbound_ports?: number[]
  /** Old spelling of host.mounts and host.env (internal actions only), read as such. */
  mounts?: string[]
  env?: Record<string, string>
  /** env var -> http credential name (router config): the script gets
   *  $<ENV>_URL (base URL) and $<ENV>_HEADER ("Authorization: Bearer ..."). */
  http?: Record<string, string>
  /** env var -> telegram-bot credential name (router config): the script gets
   *  $<ENV>_API = <apiRoot>/bot<token>. */
  bots?: Record<string, string>
  /** env var -> database name, or { name, mode }: the bot's database
   *  (router/skillstore.ts), its folder path in $<ENV>. mode append (default)
   *  or full (owner/admin-only actions). */
  store?: Record<string, StoreDecl>
}
export type StoreDecl = string | { name: string; mode?: 'append' | 'full' }
/** An internal action's host access (柯姊 2026-10-18; only owner may approve a skill that has one):
 *  ports: the host's TCP ports it reaches, at $CCTR_HOST (slirp's host alias, the host's 127.0.0.1),
 *  e.g. a browser's CDP and an ssh forward; mounts: host paths visible read-only ("~/" = the user's
 *  home), e.g. an ssh agent socket and known_hosts; with mounts it may create unix sockets; env:
 *  extra environment variables. Still its own network namespace: nothing else of the host. */
export type HostDecl = { ports?: number[]; mounts?: string[]; env?: Record<string, string> }
export type Manifest = { actions: Record<string, Action> }

export const RUNS_PER_HOUR = 10
const SKIP = /(^|\/)(venv|\.venv|node_modules|__pycache__|\.git)(\/|$)/

export function loadManifest(skillDir: string): Manifest | null {
  const p = join(skillDir, 'privileged.json')
  if (!existsSync(p)) return null
  const m = JSON.parse(readFileSync(p, 'utf8')) as Manifest
  if (!m.actions || typeof m.actions !== 'object') throw new Error('privileged.json 要有 actions')
  for (const [n, a] of Object.entries(m.actions)) {
    if (a && typeof a === 'object' && a.internal && (a.mounts !== undefined || a.env !== undefined)) {
      // the old spelling: top-level mounts and env of an internal action are its host mounts and env
      a.host = { ...a.host, mounts: a.host?.mounts ?? a.mounts, env: a.host?.env ?? a.env }
      delete a.mounts; delete a.env
    }
    checkAction(n, a)
  }
  return m
}

/** What host access an action has (its host declaration), or null. */
export function hostOf(a: Action): HostDecl | null {
  const h = a.host
  return h && (h.ports?.length || h.mounts?.length || Object.keys(h.env ?? {}).length) ? h : null
}

/** Why only owner may approve this skill (host access, more internet ports), or []. */
export function ownerOnly(m: Manifest): string[] {
  return Object.entries(m.actions).flatMap(([n, a]) => [
    ...(hostOf(a) ? [`動作 ${n} 宣告了主機存取 (host)`] : []),
    ...(raisedLimits(a).length ? [`動作 ${n} 放寬了資源上限 (${raisedLimits(a).join(', ')})`] : []),
    ...(a.outbound_ports?.length ? [`動作 ${n} 宣告了額外的對外 port (outbound_ports ${a.outbound_ports.join(', ')})`] : []),
  ])
}

function checkHost(n: string, a: Action) {
  const h = a.host as unknown
  if (h === undefined) return
  if (!h || typeof h !== 'object' || Array.isArray(h)) throw new Error(`動作 ${n} 的 host 要是物件, 例如 { "ports": [9222], "mounts": ["~/.ssh/known_hosts"] }`)
  if (!a.internal) throw new Error(`動作 ${n} 不是 internal, 不能宣告 host (主機存取只給 router 執行的內部動作)`)
  const { ports, mounts, env, ...rest } = h as HostDecl & Record<string, unknown>
  const extra = Object.keys(rest)
  if (extra.length) throw new Error(`動作 ${n} 的 host 不認得 ${extra.join(', ')} (只有 ports, mounts, env)`)
  if (ports !== undefined) {
    if (!Array.isArray(ports) || ports.some(p => !Number.isInteger(p) || p < 1 || p > 65535)) throw new Error(`動作 ${n} 的 host.ports 要是 1 到 65535 的整數陣列`)
    if (new Set(ports).size !== ports.length) throw new Error(`動作 ${n} 的 host.ports 有重複`)
  }
  if (mounts !== undefined) {
    if (!Array.isArray(mounts) || mounts.some(p => typeof p !== 'string' || !(p.startsWith('/') || p.startsWith('~/')) || p.split('/').includes('..') || p === '/' || p === '~/')) throw new Error(`動作 ${n} 的 host.mounts 要是絕對路徑或 ~/ 開頭的路徑 (不能是 /, 不能有 ..)`)
  }
  if (env !== undefined) {
    if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error(`動作 ${n} 的 host.env 要是 {名稱: 值}`)
    for (const [k, v] of Object.entries(env)) {
      if (!ENV_NAME.test(k) || RESERVED_ENV.has(k)) throw new Error(`動作 ${n} 的 host.env 環境變數名稱不行: ${k}`)
      if (typeof v !== 'string') throw new Error(`動作 ${n} 的 host.env.${k} 要是字串`)
    }
  }
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const RESERVED_ENV = new Set(['PATH', 'HOME', 'LANG', 'TMPDIR', 'TZ', 'CCTR_HOST', 'VIRTUAL_ENV'])
export const STORE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

/** A database declaration as { name, mode }. */
export function storeOf(d: StoreDecl): { name: string; mode: 'append' | 'full' } {
  return typeof d === 'string' ? { name: d, mode: 'append' } : { name: d.name, mode: d.mode ?? 'append' }
}

/** What loadManifest refuses in one action's store and bots (thrown, shown by /router skill approve). */
function checkAction(n: string, a: Action) {
  checkHost(n, a)
  const lim = limitsError(n, a)
  if (lim) throw new Error(lim)
  if (a.stop_exits !== undefined) {
    const se = a.stop_exits as unknown
    if (!se || typeof se !== 'object' || Array.isArray(se)) throw new Error(`動作 ${n} 的 stop_exits 要是 {"exit code": "說明"}, 例如 {"4": "影片太長, 沒有下載"}`)
    for (const [k, v] of Object.entries(se)) {
      if (!/^([1-9]\d?|1[01]\d|12[0-5])$/.test(k)) throw new Error(`動作 ${n} 的 stop_exits 的 ${k} 不行: 要是 1 到 125 的 exit code (0 本來就是成功, 126 以上是 shell 與訊號用的)`)
      if (typeof v !== 'string' || !v.trim()) throw new Error(`動作 ${n} 的 stop_exits.${k} 要寫說明`)
    }
  }
  if (a.tools !== undefined) {
    if (!Array.isArray(a.tools) || a.tools.some(t => typeof t !== 'string')) throw new Error(`動作 ${n} 的 tools 要是工具名稱陣列, 例如 ["ffmpeg", "deno"]`)
    const bad = a.tools.filter(t => !TOOL_NAMES.includes(t))
    if (bad.length) throw new Error(`動作 ${n} 的 tools 裡的 ${bad.join(', ')} 不在工具箱裡 (有: ${TOOL_NAMES.join(', ')})`)
  }
  if (a.outbound_ports !== undefined) {
    const p = a.outbound_ports as unknown
    if (a.internal) throw new Error(`動作 ${n} 是 internal, 對外本來就不限 port, 不用 outbound_ports`)
    if (!Array.isArray(p) || p.some(x => !Number.isInteger(x) || x < 1 || x > 65535)) throw new Error(`動作 ${n} 的 outbound_ports 要是 1 到 65535 的整數陣列`)
    if (new Set(p).size !== p.length) throw new Error(`動作 ${n} 的 outbound_ports 有重複`)
  }
  const envs: string[] = [...Object.keys(a.creds ?? {}), ...Object.keys(a.http ?? {}).flatMap(e => [`${e}_URL`, `${e}_HEADER`])]
  const add = (e: string, what: string) => {
    if (!ENV_NAME.test(e) || RESERVED_ENV.has(e)) throw new Error(`動作 ${n} 的 ${what} 環境變數名稱不行: ${e}`)
    if (envs.includes(e)) throw new Error(`動作 ${n} 的環境變數 ${e} 重複`)
    envs.push(e)
  }
  for (const k of Object.keys(a.host?.env ?? {})) add(k, 'host.env')
  if (a.store !== undefined) {
    if (!a.store || typeof a.store !== 'object' || Array.isArray(a.store)) throw new Error(`動作 ${n} 的 store 要是 {環境變數: 資料庫名稱}`)
    if (a.internal && Object.keys(a.store).length) throw new Error(`動作 ${n} 是 internal, 不能用 store`)
    const names = new Set<string>()
    for (const [env, d] of Object.entries(a.store)) {
      add(env, 'store')
      const raw = d as unknown
      if (typeof raw !== 'string' && (!raw || typeof raw !== 'object' || typeof (raw as { name?: unknown }).name !== 'string')) throw new Error(`動作 ${n} 的 store.${env} 要是資料庫名稱或 { name, mode }`)
      const s = storeOf(d)
      if (!STORE_NAME.test(s.name)) throw new Error(`動作 ${n} 的資料庫名稱不行: ${s.name} (小寫英數字與 -)`)
      if (s.mode !== 'append' && s.mode !== 'full') throw new Error(`動作 ${n} 的資料庫 ${s.name} mode 只能是 append 或 full`)
      if (names.has(s.name)) throw new Error(`動作 ${n} 的資料庫 ${s.name} 重複`)
      names.add(s.name)
      if (s.mode === 'full' && (!a.roles?.length || a.roles.some(r => r !== 'owner' && r !== 'admin'))) {
        throw new Error(`動作 ${n} 的資料庫 ${s.name} 是 full 模式, 動作的 roles 只能有 owner, admin (現在: ${(a.roles ?? ['owner', 'admin', 'power', 'user']).join(', ')})`)
      }
    }
  }
  if (a.bots !== undefined) {
    if (!a.bots || typeof a.bots !== 'object' || Array.isArray(a.bots)) throw new Error(`動作 ${n} 的 bots 要是 {環境變數: 憑證名稱}`)
    if (a.internal && Object.keys(a.bots).length) throw new Error(`動作 ${n} 是 internal, 不能用 bots`)
    for (const [env, c] of Object.entries(a.bots)) {
      if (typeof c !== 'string' || !c) throw new Error(`動作 ${n} 的 bots.${env} 要是憑證名稱`)
      add(`${env}_API`, 'bots')
    }
  }
}

/** Every file of the skill (skipping venv and the like), in order: approval pins this. */
export function hashSkill(skillDir: string): string {
  const files: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d).sort()) {
      const p = join(d, e), rel = relative(skillDir, p)
      if (SKIP.test(rel)) continue
      const st = lstatSync(p)
      if (st.isSymbolicLink()) { files.push(`${rel} -> link`); continue }
      if (st.isDirectory()) walk(p); else files.push(rel)
    }
  }
  walk(skillDir)
  const h = createHash('sha256')
  for (const rel of files) {
    h.update(rel + '\0')
    if (!rel.endsWith(' -> link')) h.update(readFileSync(join(skillDir, rel)))
  }
  return h.digest('hex')
}

/** Why role may not pass these arguments (an argument limited to higher roles), or null. */
export function argRoleRefusal(a: Action, args: Record<string, unknown>, role: string): string | null {
  for (const [name, spec] of Object.entries(a.args ?? {})) {
    if (!spec.roles || spec.roles.includes(role)) continue
    const v = args[name]
    const given = spec.flag ? v === true || v === 'true' : v !== undefined && v !== null && v !== ''
    if (given) return `參數 ${name} 只開放給 ${spec.roles.join(', ')} 角色, 本對話角色 ${role} 要提權`
  }
  return null
}

/** argv for an action, or why the arguments are refused. */
export function buildArgv(a: Action, skillDir: string, args: Record<string, unknown>, credDir: (name: string, env: string) => string): string[] | { error: string } {
  const out: string[] = []
  const known = new Set(Object.keys(a.args ?? {}))
  for (const k of Object.keys(args)) if (!known.has(k)) return { error: `沒有這個參數: ${k} (可用: ${[...known].join(', ') || '(無)'})` }
  for (const tok of a.run) {
    const m = /^\{(cred:)?([\w-]+)(\?)?\}$/.exec(tok)
    if (m?.[1]) {
      const name = a.creds?.[m[2]!]
      if (!name) return { error: `動作清單錯誤: ${tok} 沒有對應的 creds` }
      out.push(credDir(name, m[2]!))
      continue
    }
    if (m) {
      const spec = a.args?.[m[2]!]
      const v = args[m[2]!]
      if (!spec) return { error: `動作清單錯誤: ${tok} 沒有對應的 args` }
      if (spec.flag) { if (v === true || v === 'true') out.push(spec.flag); continue }
      if (v === undefined || v === null || v === '') { if (m[3]) continue; return { error: `缺少參數 ${m[2]}` } }
      const s = String(v)
      if (s.length > 2000 || /[\0\n\r]/.test(s)) return { error: `參數 ${m[2]} 格式不對` }
      if (spec.pattern && !new RegExp(`^(?:${spec.pattern})$`).test(s)) return { error: `參數 ${m[2]} 不符合格式: ${spec.pattern}` }
      out.push(s)
      continue
    }
    // a path inside the skill, or a plain word (bash, python3, --flag)
    if (tok.includes('/') && !isAbsolute(tok) && existsSync(join(skillDir, tok))) out.push(join(skillDir, tok))
    else out.push(tok)
  }
  return out
}

/** Values in Netscape cookie files (and plain secret files): what must never come back. */
export function secretsIn(dirs: string[]): string[] {
  const out = new Set<string>()
  for (const d of dirs) {
    if (!existsSync(d)) continue
    for (const f of readdirSync(d)) {
      const p = join(d, f)
      if (!statSync(p).isFile() || statSync(p).size > 2_000_000) continue
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        if (!line || line.startsWith('#') && !line.startsWith('#HttpOnly_')) continue
        const cols = line.split('\t')
        const v = cols.length >= 7 ? cols[6]!.trim() : line.trim()
        if (v.length >= 16) out.add(v)
      }
    }
  }
  return [...out]
}

const TEXT = /\.(json|txt|vtt|srt|err|log|md|csv|html?|xml)$/i

/** Remove what the run wrote that holds a secret (or looks like a cookie jar). Returns the files removed. */
export function scrubOutputs(root: string, since: number, secrets: string[]): string[] {
  const removed: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e)
      const st = lstatSync(p)
      if (st.isDirectory()) { if (e !== '.chat') walk(p); continue }
      if (!st.isFile() || st.mtimeMs < since) continue
      const cookieJar = /cookie/i.test(e)
      const leaked = !cookieJar && TEXT.test(e) && st.size < 5_000_000 && secrets.some(s => readFileSync(p, 'utf8').includes(s))
      if (cookieJar || leaked) { rmSync(p, { force: true }); removed.push(relative(root, p)) }
    }
  }
  if (existsSync(root)) walk(root)
  return removed
}

export function redact(text: string, secrets: string[]): { text: string; hit: boolean } {
  let hit = false
  for (const s of secrets) if (text.includes(s)) { hit = true; text = text.split(s).join('<已遮蔽>') }
  return { text, hit }
}

export type Sandbox = { argv: string[]; env: Record<string, string> }

/** Where the router's own folders appear in every sandbox (docs/skill-runtime.md 「掛載路徑」): fixed
 *  paths, so a script never sees (or prints) where the router keeps them. */
export const VIRT = {
  /** a credential folder, by its environment variable: <stateDir>/creds/<name> */
  creds: '/cctr/creds',
  /** a database's staged copy, by its environment variable: <stateDir>/skill-store-work/run-* */
  store: '/cctr/store',
  /** the toolbox's programs: <stateDir>/toolbox/bin (router/toolbox.ts) */
  tools: '/cctr/tools/bin',
  /** the skill's Python environment: <stateDir>/skill-env/<key> (router/skillenv.ts) */
  env: '/cctr/env',
  /** uv's own Python builds the environment uses: <stateDir>/toolbox/python */
  python: '/cctr/python',
} as const
export const SYSTEM_PATH = ['/usr/local/bin', '/usr/bin', '/bin']

/** bwrap for one run on the whitelisted file system (router/sandboxfs.ts systemArgs: /usr, a few
 *  /etc files, private /tmp; config sandboxExtraRo and an internal action's host mounts in extraRo,
 *  the hidden paths covered inside them), then the skill folder read-only, each credential folder at
 *  /cctr/creds/<ENV> (writable only for the router's own refresh), each staged database at
 *  /cctr/store/<ENV> (writable), the conversation folder writable (its .chat read-only), the
 *  conversation folder as working directory. The environment: PATH (extra bin folders first), HOME
 *  and TMPDIR /tmp, LANG C.UTF-8, TZ, each credential and database variable with its /cctr path, env. */
export function sandboxArgv(o: { argv: string[]; skillDir: string; convFolder: string; etcDir: string; creds?: Record<string, string>; credsWritable?: boolean; stores?: Record<string, string>; hidden: string[]; extraRo?: string[]; env?: Record<string, string>; timezone?: string; toolsBin?: string; pyEnv?: { env: string; python: string } }): Sandbox {
  const b = ['bwrap', '--die-with-parent', '--unshare-pid', '--new-session', ...systemArgs({ etcDir: o.etcDir, extraRo: o.extraRo, hidden: o.hidden, timezone: o.timezone })]
  // the toolbox and the skill's Python environment, read-only at their fixed paths
  if (o.toolsBin) b.push('--ro-bind', o.toolsBin, VIRT.tools)
  if (o.pyEnv) b.push('--ro-bind', o.pyEnv.env, VIRT.env, '--ro-bind', o.pyEnv.python, VIRT.python)
  b.push('--ro-bind', o.skillDir, o.skillDir)
  const vars: Record<string, string> = {}
  // only the router's own refresh writes credentials; actions a conversation calls read them
  for (const [env, d] of Object.entries(o.creds ?? {})) { vars[env] = `${VIRT.creds}/${env}`; b.push(o.credsWritable ? '--bind' : '--ro-bind', d, vars[env]!) }
  // a database's staged copy for this run (router/skillstore.ts)
  for (const [env, d] of Object.entries(o.stores ?? {})) { vars[env] = `${VIRT.store}/${env}`; b.push('--bind', d, vars[env]!) }
  b.push('--bind', o.convFolder, o.convFolder)
  if (existsSync(join(o.convFolder, '.chat'))) b.push('--ro-bind', join(o.convFolder, '.chat'), join(o.convFolder, '.chat'))
  b.push('--chdir', o.convFolder, '--', ...o.argv)
  // bin folders made visible (config sandboxExtraRo, host mounts) go on PATH before the system's
  const bins = (o.extraRo ?? []).filter(p => p.endsWith('/bin'))
  const path = [...(o.pyEnv ? [`${VIRT.env}/bin`] : []), ...(o.toolsBin ? [VIRT.tools] : []), ...bins, ...SYSTEM_PATH]
  const env: Record<string, string> = { PATH: path.join(':'), HOME: '/tmp', LANG: 'C.UTF-8', TMPDIR: '/tmp', ...(o.timezone ? { TZ: o.timezone } : {}), ...(o.pyEnv ? { VIRTUAL_ENV: VIRT.env } : {}), ...vars, ...o.env }
  return { argv: b, env }
}
