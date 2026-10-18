// skill_try: run one action of a skill draft (in the conversation's own
// folder) without approval, for power and up (docs/credentials-and-skills.md
// 「試跑技能草稿」). It goes through the same run as run_skill and the
// terminal's trial (router/skillrun.ts runPrepared: argument patterns, argv,
// sandbox, store staging and write-back checks, output scan) but:
//   - the skill folder is the draft itself, read-only in the sandbox; no
//     approval or hash check; internal actions may be tried, without their
//     host access (ports, mounts, env); the timeout is at most 600 seconds
//   - credentials are fake: each http credential's URL and each bot's API
//     point at a fake service on the sandbox's own 127.0.0.1
//     (router/skilltry-fake.ts) with random keys and tokens, scrubbed from
//     the output like real ones; credential folders (creds) start empty
//   - databases start empty (never copied from the bot's real ones: a draft
//     may name any database), or from store_seed, a folder in the
//     conversation folder; session keeps them (and the credential folders)
//     for the runs that follow, for 24 hours after its last use
//   - the network is router/sandboxnet.ts, as for every action: the internet
//     on ports 80, 443, 53, 22 and the action's outbound_ports (an internal
//     action's trial too), nothing on the host or its private networks;
//     refused when that cannot be set up
//   - the working folder, the only writable one, is
//     <conversation>/skill-try/<time>-<action>/
//   - at most 20 runs per conversation per hour, recorded in skill_runs as
//     try:<conversation key>, apart from run_skill's 10
// user conversations are refused until the whitelisted sandbox (phase 2).

import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync } from 'fs'
import { randomBytes } from 'crypto'
import { basename, isAbsolute, join, relative } from 'path'
import type { Conversation } from './db'
import type { Credential } from './config'
import { loadManifest, argRoleRefusal, redact, type Action, type Manifest } from './privskill'
import { runPrepared, NET_FAILED, type SkillRunDeps } from './skillrun'
import { resolveSkillDir } from './skillcheck'
import { snap, diff } from './skillcli'
import { RANK } from './permcheck'
import { netMissing, runIsolated, OUT_PORTS } from './sandboxnet'

export const TRY_PER_HOUR = 20
export const TRY_MAX_TIMEOUT = 600
export const TRY_PREFIX = 'try:'
export const TRY_OUT = 'skill-try'
const SESSION = /^[a-z0-9][a-z0-9-]{0,31}$/
const SESSION_TTL_MS = 24 * 3_600_000
const SEED_MAX = 20 * 1024 * 1024
const FAKE = '__CCTR_FAKE__'

export interface SkillTryDeps extends SkillRunDeps {
  stateDir: string
  /** A credential by name (router config): only its kind, header and scheme are used. */
  cred(name: string): Credential | undefined
  /** How the sandbox starts the fake service, and what it must see read-only for that (router/selfpath.ts fakeService). */
  fake: { cmd: string[]; ro: string[] }
}

const inside = (p: string, dir: string) => { const r = relative(dir, p); return r === '' || (!r.startsWith('..') && !isAbsolute(r)) }
const rnd = (n: number) => randomBytes(n).toString('base64url').replace(/[-_]/g, 'x').slice(0, n)
const stamp = () => new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')

/** Why store_seed may not seed the trial databases (a folder of database folders, plain files only), or its path. */
function seedDir(folder: string, p: string): string | { error: string } {
  const abs = isAbsolute(p) ? p : join(folder, p)
  let real: string
  try { real = realpathSync(abs) } catch { return { error: `找不到 store_seed ${p}` } }
  if (!inside(real, realpathSync(folder))) return { error: `store_seed ${p} 不在這個對話的資料夾裡` }
  if (!statSync(real).isDirectory()) return { error: `store_seed ${p} 要是資料夾 (裡面每個子資料夾是一個資料庫, 名稱同 privileged.json 的資料庫名稱)` }
  let total = 0
  const walk = (d: string): string | null => {
    for (const e of readdirSync(d)) {
      const q = join(d, e), st = lstatSync(q)
      if (st.isDirectory()) { const w = walk(q); if (w) return w; continue }
      if (!st.isFile()) return `store_seed 裡的 ${relative(real, q)} 不是一般檔案 (符號連結, fifo 等不接受)`
      if ((total += st.size) > SEED_MAX) return `store_seed 超過 ${SEED_MAX} bytes`
    }
    return null
  }
  const why = walk(real)
  return why ? { error: why } : real
}

/** A copy of an action fit for a trial: no host access, the timeout capped. What changed goes to notes. */
function forTrial(n: string, a: Action, notes: string[]): Action {
  const t = { ...a }
  if (a.host || a.mounts?.length || (a.env && Object.keys(a.env).length)) { delete t.host; delete t.mounts; delete t.env; notes.push(`動作 ${n} 的主機存取 (host: ports, mounts, env) 在試跑時一律不給 (正式執行時 owner 核准的 internal 動作才有)`) }
  if ((a.timeout ?? 600) > TRY_MAX_TIMEOUT) { t.timeout = TRY_MAX_TIMEOUT; notes.push(`動作 ${n} 的 timeout 在試跑時最多 ${TRY_MAX_TIMEOUT} 秒`) }
  return t
}

const refused = (why: string) => ({ ok: false, text: `skill try: refused\n${why}` })

/** One trial run; the reply starts with "skill try: ok|failed|refused". role: the conversation's (or elevated) role. */
export async function trySkill(deps: SkillTryDeps, conv: Conversation, role: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  if ((RANK[role] ?? 0) < RANK.power!) return refused(`skill_try 只開放 power 以上的對話 (這個對話是 ${role}): 試跑的程式還沒經過核准, 要等之後的白名單沙箱才開放給 user. 可以先用 skill_check 檢查草稿`)
  const as = args.role === undefined ? role : String(args.role)
  if (RANK[as] === undefined) return refused(`沒有這個角色: ${as} (${Object.keys(RANK).join(', ')})`)
  if (RANK[as]! > RANK[role]!) return refused(`role 只能扮演等於或低於自己的角色 (這個對話是 ${role})`)
  const dir = resolveSkillDir(conv.folder, String(args.path ?? ''))
  if (typeof dir !== 'string') return refused(dir.error)
  const skill = basename(dir)
  let manifest: Manifest | null
  try { manifest = loadManifest(dir) } catch (e) { return refused(`privileged.json 有誤: ${e instanceof Error ? e.message : e} (用 skill_check 看怎麼改)`) }
  if (!manifest) return refused(`${skill} 沒有 privileged.json: 一般技能直接照 SKILL.md 跑腳本即可`)
  const actionName = String(args.action ?? '')
  const raw = manifest.actions[actionName]
  if (!raw) return refused(`沒有動作 ${actionName} (有: ${Object.keys(manifest.actions).join(', ')})`)
  const call = (args.args ?? {}) as Record<string, unknown>
  if (!call || typeof call !== 'object' || Array.isArray(call)) return refused('args 要是物件, 例如 {"name": "..."}')
  if (!raw.internal) {
    if (!(raw.roles ?? ['owner', 'admin', 'power', 'user']).includes(as)) return refused(`動作 ${actionName} 不開放給 ${as} 角色 (正式執行時也會這樣拒絕)`)
    const why = argRoleRefusal(raw, call, as)
    if (why) return refused(`${why} (正式執行時會走提權申請; 試跑不送申請, 要試請用較高的 role)`)
  }
  const session = args.session === undefined || args.session === '' ? null : String(args.session)
  if (session !== null && !SESSION.test(session)) return refused('session 只能用小寫英數與 - (最多 32 字)')
  const seed = args.store_seed === undefined || args.store_seed === '' ? null : seedDir(conv.folder, String(args.store_seed))
  if (seed && typeof seed !== 'string') return refused(seed.error)
  const missing = (deps.netMissing ?? netMissing)()
  if (missing) return refused(`這台主機缺少試跑網路隔離需要的工具 (${missing}), 不試跑 (不會改成不隔離)`)
  const runAs = `${TRY_PREFIX}${conv.key}`
  const used = deps.db.skillRunsSince(runAs, new Date(Date.now() - 3_600_000).toISOString())
  if (used >= TRY_PER_HOUR) { deps.db.addSkillRun(runAs, skill, actionName, 'refused'); return refused(`這個對話一小時內已經試跑 ${used} 次, 上限 ${TRY_PER_HOUR} 次, 請稍後再試`) }

  // the trial's own folders: databases, credential folders, the fake service's log, the network's files
  const base = join(deps.stateDir, 'skill-try', conv.key)
  mkdirSync(base, { recursive: true, mode: 0o700 })
  for (const e of readdirSync(base)) { const p = join(base, e); try { if (Date.now() - statSync(p).mtimeMs > SESSION_TTL_MS) rmSync(p, { recursive: true, force: true }) } catch {} }
  const root = session ? join(base, `s-${session}`) : mkdtempSync(join(base, 'run-'))
  const fresh = !existsSync(join(root, 'store'))
  mkdirSync(join(root, 'store'), { recursive: true, mode: 0o700 })
  mkdirSync(join(root, 'creds'), { recursive: true, mode: 0o700 })
  utimesSync(root, new Date(), new Date())
  const botId = basename(deps.botDir(conv.bot))
  const mine = join(root, 'store', botId)
  if (fresh && seed) cpSync(seed, mine, { recursive: true })
  mkdirSync(mine, { recursive: true, mode: 0o700 })
  const io = mkdtempSync(join(root, 'io-'))
  const log = join(io, 'requests.jsonl')

  const notes: string[] = []
  const actions = Object.fromEntries(Object.entries(manifest.actions).map(([n, a]) => [n, forTrial(n, a, notes)]))
  const action = actions[actionName]!
  // fake credentials: the real one's kind, header and scheme; a random value; the fake service's URL
  const fakes = new Map<string, Credential>()
  const fakeOf = (name: string, kind: 'http' | 'telegram-bot', env: string): Credential => {
    const key = `${kind}:${name}`
    if (!fakes.has(key)) {
      const real = deps.cred(name)
      if (!real || (real.kind ?? 'telegram-bot') !== kind) notes.push(`憑證 ${name} 在 router 裡${real ? `是 ${real.kind ?? 'telegram-bot'} 類, 不是 ${kind}` : '不存在'}: 試跑用假的照跑, 核准後正式執行會拒絕, 請 owner 或 admin 先登記`)
      fakes.set(key, kind === 'http'
        ? { kind: 'http', token: `fake-${rnd(28)}`, baseUrl: `${FAKE}/http/${env}`, header: real?.header, scheme: real?.scheme, methods: [] } as Credential
        : { kind: 'telegram-bot', token: `${1000000000 + randomBytes(3).readUIntBE(0, 3)}:FAKE${rnd(31)}`, methods: [] } as Credential)
    }
    return fakes.get(key)!
  }
  const httpEnv = new Map<string, string>(), botEnv = new Map<string, string>()
  for (const a of Object.values(actions)) {
    for (const [env, n] of Object.entries(a.http ?? {})) httpEnv.set(n, env)
    for (const [env, n] of Object.entries(a.bots ?? {})) botEnv.set(n, env)
  }
  for (const a of Object.values(actions)) for (const tok of a.run ?? []) if (/^(venv|node_modules)\//.test(tok)) notes.push(`${tok}: install_skill 不複製 ${tok.split('/')[0]}, 安裝後要由 owner 在安裝位置建好, 否則正式執行找不到`)
  const notices: string[] = []
  let attempt = 0
  const d: SkillRunDeps = {
    ...deps,
    credsRoot: join(root, 'creds'),
    storeRoot: join(root, 'store'),
    apiRoot: FAKE, apiRootFixed: FAKE,
    httpCred: n => fakeOf(n, 'http', httpEnv.get(n) ?? n.toUpperCase().replace(/\W/g, '_')),
    botCred: n => fakeOf(n, 'telegram-bot', botEnv.get(n) ?? n),
    notifyOwner: (_c, text) => notices.push(text),
    // the fake service starts first inside the sandbox, then runs the action; an internal action's
    // trial still gets only the ports every other action gets (80, 443, 53, 22 and outbound_ports)
    isolated: o => (deps.isolated ?? runIsolated)({ ...o, workDir: join(io, `net-${++attempt}`), wrap: [...deps.fake.cmd, log, '--'], extraRo: [...(o.extraRo ?? []), ...deps.fake.ro], extraRw: [...(o.extraRw ?? []), io], outPorts: o.outPorts ?? OUT_PORTS }),
  }
  const out = join(conv.folder, TRY_OUT, `${stamp()}-${actionName}`)
  mkdirSync(out, { recursive: true })
  const before = snap(mine)
  try {
    const r = await runPrepared(d, { ...conv, folder: out }, runAs, skill, actionName, dir, { actions }, action, call)
    const status = r.ok ? 'ok' : r.text.includes(`\n${NET_FAILED}`) ? 'refused' : 'failed'
    const secrets = [...fakes.values()].map(c => c.token)
    const lines = [
      `skill try: ${status}`,
      `草稿 ${relative(realpathSync(conv.folder), dir)} 的 ${actionName}, 扮演角色 ${as}, 輸出在 ${relative(conv.folder, out)}; 沒有核准, 憑證是假的, 資料庫是試跑複本 (${session ? `session ${session}, 最後一次使用後保留 24 小時` : '用完即丟'}${fresh && seed ? ', 從 store_seed 開始' : fresh ? ', 從空的開始' : ''}); 網路: 外網只開 port ${[...new Set([...OUT_PORTS, ...(action.outbound_ports ?? [])])].join(', ')}, 主機本機與內網擋下`,
      r.text,
    ]
    const changes = diff(before, snap(mine))
    lines.push(`試跑資料庫的變動: ${changes.length ? `\n${changes.join('\n')}` : '無'}`)
    const reqs = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => { try { const q = JSON.parse(l); return `- ${q.method} ${q.path} (${q.bytes} bytes${q.head ? `: ${String(q.head).replace(/\s+/g, ' ').slice(0, 120)}` : ''})` } catch { return null } }).filter(Boolean) as string[] : []
    lines.push(`假服務收到的請求: ${reqs.length ? `\n${reqs.slice(-30).join('\n')}` : '無'}`)
    if (notes.length) lines.push('注意:', ...[...new Set(notes)].map(n => `- ${n}`))
    for (const n of notices) lines.push(`[正式執行時會通知 owner] ${n}`)
    return { ok: r.ok, text: redact(lines.join('\n'), secrets).text.split(FAKE).join('<假服務>') }
  } finally {
    rmSync(io, { recursive: true, force: true })
    if (!session) rmSync(root, { recursive: true, force: true })
  }
}
