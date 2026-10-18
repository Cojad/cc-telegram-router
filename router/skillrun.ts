// run_skill: one privileged skill action for a conversation (plan 10d; the
// mechanics are in router/privskill.ts). Finds the approved skill in the
// conversation's bot or all-bots scope, checks its hash, role, arguments and
// the hourly limit, runs it sandboxed with its credential folders, retries
// once after the refresh action when the credentials were refused, and
// scrubs what comes back. An action with a database (store) runs holding its
// lock, on a staged copy written back only when the checks pass
// (router/skillstore.ts).

import { mkdirSync, mkdtempSync, existsSync, rmSync } from 'fs'
import { basename, join } from 'path'
import type { Conversation, RouterDb } from './db'
import { loadManifest, hashSkill, buildArgv, sandboxArgv, secretsIn, scrubOutputs, redact, argRoleRefusal, storeOf, hostOf, ownerOnly, VIRT, RUNS_PER_HOUR, type Action, type Manifest } from './privskill'
import { runIsolated, netMissing, OUT_PORTS, SLIRP_HOST, type IsolatedRun, type NetRun } from './sandboxnet'
import { binDir, missingTools } from './toolbox'
import { lockFiles, ensureEnv } from './skillenv'
import { limitsOf, limitMode, limitPrefix, endNote, raisedLimits, DEFAULT_LIMITS, type LimitMode } from './sandboxlimits'
import type { Credential } from './config'
import { storesOf, withStoreLocks, stage, check, commit, workDir, RUN_MAX, type Plan, type StoreUse } from './skillstore'

/** note: why the run ended, when a limit ended it (router/sandboxlimits.ts endNote). */
export type RunResult = { code: number; out: string; note?: string }

/** Router-private paths in text going back (8a, 柯姊 2026-10-18): each whole path under one of them becomes <router 私有路徑>. */
export function maskPaths(text: string, paths: string[] = []): string {
  for (const p of [...paths].filter(Boolean).sort((a, b) => b.length - a.length)) {
    const esc = p.replace(/\/+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    text = text.replace(new RegExp(`${esc}(?=[/\\s'"\`:,;)\\]]|$)[^\\s'"\`,;)\\]]*`, 'g'), '<router 私有路徑>')
  }
  return text
}

/** A whole run's output for the owner or the terminal (8c): up to max characters, the start and the end when longer. */
export function summary(text: string, max = 3500): string {
  if (text.length <= max) return text
  const half = Math.floor((max - 20) / 2)
  return `${text.slice(0, half)}\n...(中間略過 ${text.length - 2 * half} 字)...\n${text.slice(-half)}`
}

export interface SkillRunDeps {
  db: RouterDb
  home: string
  /** Where credential folders live (router-private), <stateDir>/creds */
  credsRoot: string
  /** $HOME of the router user: never in the sandbox ("~/" of an internal action's host mounts) */
  userHome: string
  /** Covered when inside something bound read-only (/usr, extraRo): the router's home, its state
   *  dir, config sandboxDenyRead (config.ts hiddenPaths) */
  hidden: string[]
  /** config sandboxExtraRo: more paths every sandbox sees read-only (their bin folders on PATH) */
  extraRo: string[]
  /** passwd, group and hosts for the sandbox's /etc (router/sandboxfs.ts writeSandboxEtc) */
  etcDir: string
  /** Router-private folder for each run's network files: <stateDir>/sandbox-run */
  runRoot: string
  /** The host's own addresses the network refuses (router/sandboxnet.ts). */
  hostAddrs(): Promise<string[]>
  /** Run a sandbox in its own network (router/sandboxnet.ts runIsolated; skill_try adds its fake service). */
  isolated?(o: IsolatedRun): Promise<NetRun>
  /** Which network tools are missing (router/sandboxnet.ts netMissing; replaced in tests). */
  netMissing?(): string | null
  /** <stateDir>/toolbox (router/toolbox.ts): mounted at /cctr/tools/bin; uv and Python for the environments. */
  toolbox?: string
  /** <stateDir>/skill-env (router/skillenv.ts): the skills' Python environments. */
  envRoot?: string
  /** uv's --python-preference for the environments (only-managed; tests use the system's). */
  pythonPreference?: string
  /** skill_try: drafts' environments are kept apart (try-<key>). */
  envPrefix?: string
  /** The sandbox's time zone (config sandboxTimezone, default Asia/Taipei). */
  timezone?: string
  /** How runs are limited (router/sandboxlimits.ts limitMode; replaced in tests). */
  limitMode?(): LimitMode
  /** Router-private folders (its stateDir): masked in what goes back (maskPaths). */
  privatePaths?: string[]
  /** skill_try: unapproved drafts run with the default limits, whatever they declare. */
  defaultLimits?: boolean
  botDir(bot: string): string
  /** An http API credential by name (router config), for actions that declare http. */
  httpCred?(name: string): Credential | undefined
  /** A bot token credential by name (router config), for actions that declare bots. */
  botCred?(name: string): Credential | undefined
  /** Bot API base URL (config apiRoot) for bot credentials without their own apiRoot; default https://api.telegram.org. */
  apiRoot?: string
  /** Trial runs (skill_try, skill run --api): every bot credential goes to this server instead, even one with its own apiRoot. */
  apiRootFixed?: string
  /** Databases of actions that declare store: <stateDir>/skill-store (router/skillstore.ts). */
  storeRoot?: string
  notifyOwner(conv: Conversation, text: string): void
  log?(msg: string): void
}

/** Only bot or all-bots scope: a conversation's own skills are writable by it. */
export function skillDirs(deps: Pick<SkillRunDeps, 'home' | 'botDir'>, bot: string, skill: string): string[] {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(skill)) return []
  return [join(deps.botDir(bot), '.claude', 'skills', skill), join(deps.home, '.claude', 'skills', skill)].filter(d => existsSync(join(d, 'privileged.json')))
}

const credDir = (deps: Pick<SkillRunDeps, 'credsRoot'>, name: string) => { const d = join(deps.credsRoot, name); mkdirSync(d, { recursive: true, mode: 0o700 }); return d }
/** env var -> credential folder of an action. */
export const credEnv = (deps: Pick<SkillRunDeps, 'credsRoot'>, a: Action) => Object.fromEntries(Object.entries(a.creds ?? {}).map(([env, name]) => [env, credDir(deps, name)]))
const httpCreds = (deps: Pick<SkillRunDeps, 'httpCred'>, a: Action) => Object.entries(a.http ?? {}).map(([env, name]) => ({ env, name, cred: deps.httpCred?.(name) }))
const botCreds = (deps: Pick<SkillRunDeps, 'botCred'>, a: Action) => Object.entries(a.bots ?? {}).map(([env, name]) => ({ env, name, cred: deps.botCred?.(name) }))
/** Why an action's bot credentials cannot be used, or null. */
function botCredRefusal(deps: Pick<SkillRunDeps, 'botCred'>, a: Action): string | null {
  for (const b of botCreds(deps, a)) {
    if (!b.cred) return `需要的 bot 憑證 ${b.name} 不存在`
    if ((b.cred.kind ?? 'telegram-bot') !== 'telegram-bot') return `需要的 bot 憑證 ${b.name} 是 ${b.cred.kind} 類, bots 只接受 telegram-bot 憑證`
  }
  return null
}
/** Every token an action's run must never hand back: http keys and bot tokens. */
const tokensOf = (deps: Pick<SkillRunDeps, 'httpCred' | 'botCred'>, a: Action) => [...httpCreds(deps, a), ...botCreds(deps, a)].map(h => h.cred?.token ?? '').filter(t => t.length >= 16)

/** The skill's Python environment (router/skillenv.ts), built when missing; none without pyproject.toml and uv.lock. */
async function pyEnvOf(deps: Omit<SkillRunDeps, 'notifyOwner'>, dir: string): Promise<{ env?: { env: string; python: string } } | { error: string }> {
  const f = lockFiles(dir)
  if (!f) return {}
  if ('error' in f) return { error: `技能的 Python 套件設定有誤: ${f.error}` }
  if (!deps.toolbox || !deps.envRoot) return { error: '這個 router 沒有設定工具箱與 Python 環境的位置' }
  const r = await ensureEnv({ toolbox: deps.toolbox, envRoot: deps.envRoot, etcDir: deps.etcDir, runRoot: deps.runRoot, hostAddrs: deps.hostAddrs, isolated: deps.isolated, pythonPreference: deps.pythonPreference, limitMode: deps.limitMode, log: deps.log }, f, deps.envPrefix ?? '')
  if (!r.ok) return { error: `技能的 Python 環境建不起來, 沒有執行: ${r.why}` }
  return { env: { env: r.dir, python: join(deps.toolbox, 'python') } }
}

/** A Bot API URL as the sandbox reaches it: one on the host's loopback (http://127.0.0.1, localhost or
 *  [::1], e.g. a self-hosted Bot API server or a test's fake) becomes slirp's host alias on that port,
 *  the one host port the run may then use (the server must listen on 127.0.0.1); any other is kept. */
export function apiForSandbox(apiRoot: string): { root: string; port?: number } {
  const root = apiRoot.replace(/\/+$/, '')
  let u: URL
  try { u = new URL(root) } catch { return { root } }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && !/^127\./.test(u.hostname)) return { root }
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
  return { root: `${u.protocol}//${SLIRP_HOST}:${port}${u.pathname.replace(/\/+$/, '')}`, port }
}

/** The internet ports an action may use (router/sandboxnet.ts): any for the router's own internal
 *  actions, else 80, 443, 53, 22 and what it declared (outbound_ports, owner approval). */
export const outPortsOf = (a: Action): number[] | null => a.internal ? null : [...new Set([...OUT_PORTS, ...(a.outbound_ports ?? [])])]

/** One action in its own sandbox, the conversation (or router) folder
 *  writable: shared by run_skill and the daily refresh (router/skillrefresh.ts).
 *  The whitelisted file system and its own network (docs/skill-runtime.md);
 *  only internal (router-run) actions get host access (host: ports, mounts,
 *  env) and write their credential folders: a conversation's actions never
 *  see the ssh agent. */
export async function runAction(deps: Omit<SkillRunDeps, 'notifyOwner'>, dir: string, a: Action, args: Record<string, unknown>, folder: string, stores: Record<string, string> = {}): Promise<RunResult> {
  const http = httpCreds(deps, a)
  const missing = http.find(h => h.cred?.kind !== 'http' || !h.cred.baseUrl)
  if (missing) return { code: -1, out: `需要的 API 憑證 ${missing.name} 不存在或不是 http 憑證` }
  const botWhy = botCredRefusal(deps, a)
  if (botWhy) return { code: -1, out: botWhy }
  const argv = buildArgv(a, dir, args, (_name, env) => `${VIRT.creds}/${env}`)
  if ('error' in argv) return { code: -1, out: argv.error }
  const tools = (deps.netMissing ?? netMissing)()
  if (tools) return { code: -1, out: `這台主機缺少沙箱網路隔離需要的工具 (${tools}), 沒有執行 (不會改成不隔離)` }
  const lack = missingTools(deps.toolbox, a.tools)
  if (lack.length) return { code: -1, out: `工具箱缺少這個動作需要的 ${lack.join(', ')}, 沒有執行 (安裝時下載失敗或還沒裝: owner 在主機上執行 cctr toolbox install)` }
  const py = await pyEnvOf(deps, dir)
  if ('error' in py) return { code: -1, out: py.error }
  const httpEnv: Record<string, string> = Object.fromEntries(http.flatMap(({ env, cred }) => [
    [`${env}_URL`, cred!.baseUrl!.replace(/\/+$/, '')],
    [`${env}_HEADER`, `${cred!.header ?? 'Authorization'}: ${`${cred!.scheme ?? 'Bearer'} ${cred!.token}`.trim()}`],
  ]))
  // each bot credential's Bot API (a trial's fixed one, its own apiRoot, the config's, the official one); one on the
  // host (a self-hosted server, the terminal trial's --api) is reached at slirp's host alias, its port only
  const bots = botCreds(deps, a).map(b => ({ ...b, api: apiForSandbox(deps.apiRootFixed ?? b.cred!.apiRoot ?? deps.apiRoot ?? 'https://api.telegram.org') }))
  const botEnv = Object.fromEntries(bots.map(({ env, cred, api }) => [`${env}_API`, `${api.root}/bot${cred!.token}`]))
  const host = a.internal ? hostOf(a) : null
  const mounts = (host?.mounts ?? []).map(m => m.startsWith('~/') ? join(deps.userHome, m.slice(2)) : m)
  const hostPorts = [...new Set([...(host?.ports ?? []), ...bots.flatMap(b => b.api.port ? [b.api.port] : [])])]
  const hostEnv = { ...(host?.env ?? {}), ...(hostPorts.length ? { CCTR_HOST: SLIRP_HOST } : {}) }
  const toolsBin = deps.toolbox && existsSync(binDir(deps.toolbox)) ? binDir(deps.toolbox) : undefined
  const sb = sandboxArgv({ argv, skillDir: dir, convFolder: folder, etcDir: deps.etcDir, toolsBin, pyEnv: py.env, timezone: deps.timezone, creds: credEnv(deps, a), credsWritable: !!a.internal, stores, hidden: [...deps.hidden, deps.userHome], extraRo: [...deps.extraRo, ...mounts], env: { ...hostEnv, ...httpEnv, ...botEnv } })
  mkdirSync(deps.runRoot, { recursive: true, mode: 0o700 })
  const work = mkdtempSync(join(deps.runRoot, 'run-'))
  try {
    const limits = deps.defaultLimits ? { ...DEFAULT_LIMITS, timeout: Math.min(a.timeout ?? DEFAULT_LIMITS.timeout, DEFAULT_LIMITS.timeout) } : limitsOf(a)
    const mode = (deps.limitMode ?? limitMode)()
    const r = await (deps.isolated ?? runIsolated)({ argv: sb.argv, env: sb.env, timeoutMs: limits.timeout * 1000, workDir: join(work, 'net'), hostAddrs: await deps.hostAddrs(), hostPorts, outPorts: outPortsOf(a), allowUnix: !!mounts.length, prefix: limitPrefix(mode, limits), outputMax: limits.output_kb * 1024 })
    if ('error' in r) return { code: -1, out: `${NET_FAILED}${r.error}` }
    const note = endNote(r.code, limits, r, mode)
    return { code: r.code, out: r.out, ...(note ? { note } : {}) }
  } finally { rmSync(work, { recursive: true, force: true }) }
}
/** What a run's text starts with when its network could not be set up (nothing ran). */
export const NET_FAILED = '沙箱的網路隔離失敗, 沒有執行: '

/** runAs: the skill_runs conversation to record under instead of conv.key
 *  (the owner's terminal, router/skillcli.ts); such a run is not counted
 *  toward, nor held to, the conversation's hourly limit. */
export async function runSkill(deps: SkillRunDeps, conv: Conversation, role: string, skill: string, actionName: string, args: Record<string, unknown>, o: { runAs?: string } = {}): Promise<{ ok: boolean; text: string }> {
  const { db } = deps
  const dir = skillDirs(deps, conv.bot, skill)[0]
  if (!dir) return { ok: false, text: `找不到有特權動作的技能 ${skill} (只有這隻 bot 或全部 bot 範圍, 而且帶 privileged.json 的技能可以用)` }
  const approval = db.skillApproval(dir)
  if (!approval) return { ok: false, text: `技能 ${skill} 還沒經 owner 或 admin 核准 (/router skill approve ${skill})` }
  if (hashSkill(dir) !== approval.hash) {
    deps.notifyOwner(conv, `⚠️ 技能 ${skill} 的檔案在核准後被改過, 特權動作已暫停. 檢查後用 /router skill approve ${skill} 重新核准.`)
    return { ok: false, text: `技能 ${skill} 的檔案在核准後被改過, 已暫停, 等 owner 或 admin 重新核准` }
  }
  let manifest: Manifest
  try { manifest = loadManifest(dir)! } catch (e) { return { ok: false, text: `技能 ${skill} 的 privileged.json 有誤: ${e instanceof Error ? e.message : e}` } }
  const action = manifest.actions[actionName]
  if (!action || action.internal) return { ok: false, text: `技能 ${skill} 沒有可呼叫的動作 ${actionName} (可用: ${Object.entries(manifest.actions).filter(([, a]) => !a.internal).map(([n]) => n).join(', ')})` }
  if (!(action.roles ?? ['owner', 'admin', 'power', 'user']).includes(role)) return { ok: false, text: `技能 ${skill} 的 ${actionName} 不開放給 ${role} 角色的對話` }
  const argWhy = argRoleRefusal(action, args, role)
  if (argWhy) return { ok: false, text: `${argWhy}. 需要的話告訴對方, 並用 request_elevation 申請提權` }
  const used = o.runAs ? 0 : db.skillRunsSince(conv.key, new Date(Date.now() - 3_600_000).toISOString())
  if (used >= RUNS_PER_HOUR) { db.addSkillRun(conv.key, skill, actionName, 'refused'); return { ok: false, text: `這個對話一小時內已經用了 ${used} 次特權技能, 上限 ${RUNS_PER_HOUR} 次, 請稍後再試` } }
  return runPrepared(deps, conv, o.runAs ?? conv.key, skill, actionName, dir, manifest, action, args)
}

/** An action already found and allowed (approval, role, arguments' roles, the hourly limit): its
 *  credentials checked, its databases locked and staged, run, scrubbed, recorded under runAs.
 *  run_skill and the terminal come here through runSkill; skill_try (router/skilltry.ts) directly,
 *  with a draft's folder and fake credentials. */
export async function runPrepared(deps: SkillRunDeps, conv: Conversation, runAs: string, skill: string, actionName: string, dir: string, manifest: Manifest, action: Action, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  for (const h of [...httpCreds(deps, action), ...(action.refresh && manifest.actions[action.refresh] ? httpCreds(deps, manifest.actions[action.refresh]!) : [])]) {
    if (h.cred?.kind !== 'http' || !h.cred.baseUrl) return { ok: false, text: `技能 ${skill} 需要的 API 憑證 ${h.name} 不存在或不是 http 憑證, 請 owner 檢查` }
  }
  const botWhy = botCredRefusal(deps, action)
  if (botWhy) return { ok: false, text: `技能 ${skill} ${botWhy}, 請 owner 檢查` }
  if (action.store && Object.keys(action.store).length && !deps.storeRoot) return { ok: false, text: `技能 ${skill} 要用資料庫, 但 router 沒有設定資料庫位置` }
  const stores = deps.storeRoot ? storesOf(action, deps.storeRoot, basename(deps.botDir(conv.bot))) : []
  if (!stores.length) return run(deps, conv, runAs, skill, actionName, dir, manifest, action, args, [])
  return withStoreLocks(stores.map(s => s.dir), async () => {
    const work = workDir(deps.storeRoot!)
    try { return await run(deps, conv, runAs, skill, actionName, dir, manifest, action, args, stores, work) } finally { dropWork(work, deps.log) }
  })
}

async function run(deps: SkillRunDeps, conv: Conversation, runAs: string, skill: string, actionName: string, dir: string, manifest: Manifest, action: Action, args: Record<string, unknown>, stores: StoreUse[], work = ''): Promise<{ ok: boolean; text: string }> {
  const { db } = deps
  // the main action gets a fresh copy of its databases on every attempt; the refresh none
  const once = (a: Action, a_args: Record<string, unknown>) => runAction(deps, dir, a, a_args, conv.folder, a === action && stores.length ? stage(stores, work) : {})

  // nothing that holds a credential goes back to the conversation
  const creds = Object.values({ ...credEnv(deps, action), ...(action.refresh && manifest.actions[action.refresh] ? credEnv(deps, manifest.actions[action.refresh]!) : {}) })
  const start = Date.now()
  let r = await once(action, args)
  const notes: string[] = []
  if (r.code !== -1 && action.auth_failure && action.refresh && new RegExp(action.auth_failure, 'i').test(r.out)) {
    const refresh = manifest.actions[action.refresh]
    const rr = refresh ? await once(refresh, {}) : { code: 1, out: 'refresh 動作不存在' }
    if (rr.code === 0) {
      notes.push('(憑證被拒, 已自動更新後重試)')
      deps.log?.(`skill ${skill}: credentials refreshed for ${conv.key}`)
      r = await once(action, args)
    } else {
      notes.push('(憑證被拒, 自動更新失敗, 已通知 owner)')
      deps.notifyOwner(conv, `⚠️ 技能 ${skill} 的憑證被拒, 自動更新也失敗 (${conv.key} 使用時), exit ${rr.code}${rr.note ? ` (${rr.note})` : ''}:\n${summary(maskPaths(redact(rr.out, [...secretsIn(creds), ...tokensOf(deps, action)]).text, deps.privatePaths))}`)
    }
  }
  const secrets = [...secretsIn(creds), ...tokensOf(deps, action)]
  const removed = scrubOutputs(conv.folder, start - 1000, secrets)
  const red = redact(r.out, secrets)
  if (removed.length || red.hit) {
    deps.notifyOwner(conv, `⚠️ 技能 ${skill} 的 ${actionName} 在 ${conv.key} 的輸出含有憑證內容, 已${removed.length ? `刪除 ${removed.join(', ')}` : ''}${red.hit ? ' 並遮蔽回傳文字' : ''}. 請檢查這支技能.`)
    notes.push('(輸出含有憑證內容, 已刪除或遮蔽, 已通知 owner)')
  }
  if (r.note) notes.push(`(${r.note})`)
  // an exit code the action declares a normal stop (stop_exits): not a failure, but not a success to write back either
  const stopped = r.code > 0 ? action.stop_exits?.[String(r.code)] : undefined
  let ok = r.code === 0 || !!stopped
  if (stores.length) {
    const names = stores.map(s => s.name).join(', ')
    if (r.code !== 0) notes.push(stopped ? `(正常停止, 資料庫 ${names} 未寫回)` : `(動作沒有成功結束, 資料庫 ${names} 未寫回)`)
    else {
      const why = writeBack(stores, work, secrets)
      if (why) {
        ok = false
        notes.push(`(資料庫 ${names} 未寫回, 整次作廢: ${why})`)
        deps.notifyOwner(conv, `⚠️ 技能 ${skill} 的 ${actionName} 在 ${conv.key} 對資料庫 ${names} 的寫入被拒, 整次作廢, 資料庫沒有變動: ${why}`)
      }
    }
  }
  db.addSkillRun(runAs, skill, actionName, stopped && ok ? 'stopped' : ok ? 'ok' : 'failed')
  const tail = maskPaths(red.text, deps.privatePaths).split('\n').slice(-60).join('\n').slice(-6000)
  return { ok, text: [`exit ${r.code}${stopped && ok ? ` (正常停止: ${stopped})` : ''}`, ...notes, tail].join('\n') }
}

/** Remove a run's work folder, even after the script took its own permissions away. */
function dropWork(work: string, log?: (msg: string) => void) {
  try { rmSync(work, { recursive: true, force: true }) } catch {
    Bun.spawnSync(['chmod', '-R', 'u+rwx', work])
    try { rmSync(work, { recursive: true, force: true }) } catch (e) { log?.(`skill store: could not remove ${work}: ${e}`) }
  }
}

/** Check every staged database and write them all back, or none: why not, or null. */
function writeBack(stores: StoreUse[], work: string, secrets: string[]): string | null {
  const plans: Plan[] = []
  for (const s of stores) {
    let p: ReturnType<typeof check>
    try { p = check(s, join(work, s.env), secrets) } catch (e) { return `${s.name} 檢查失敗: ${e instanceof Error ? e.message : e}` }
    if ('error' in p) return p.error
    plans.push(p)
  }
  const total = plans.reduce((n, p) => n + p.added, 0)
  if (total > RUN_MAX) return `這次共寫入 ${total} bytes, 超過單次上限 ${RUN_MAX} bytes`
  try { commit(plans, work) } catch (e) { return `寫回失敗: ${e instanceof Error ? e.message : e}` }
  return null
}

/** Why this role may not approve the skill in dir (/router skill approve), or null: privileged.json
 *  must load; host access and more internet ports need owner. */
export function approveRefusal(dir: string, name: string, role: string): string | null {
  let m: Manifest
  try { m = loadManifest(dir)! } catch (e) { return `privileged.json 有誤: ${e instanceof Error ? e.message : e}` }
  const why = ownerOnly(m)
  if (why.length && role !== 'owner') return `技能 ${name} 只有 owner 能核准: ${why.join('; ')}. 沒有核准\n${describeActions(dir)}`
  return null
}

/** An internal action's host access, as the approval shows it. */
function hostLine(a: Action): string {
  const h = a.internal ? hostOf(a) : null
  if (!h) return ''
  const parts = [
    ...(h.ports?.length ? [`連得到主機本機的 port ${h.ports.join(', ')} (經 $CCTR_HOST)`] : []),
    ...(h.mounts?.length ? [`可讀 ${h.mounts.join(', ')} (可以連 unix socket)`] : []),
    ...(Object.keys(h.env ?? {}).length ? [`環境變數 ${Object.keys(h.env!).join(', ')}`] : []),
  ]
  return `; ⚠️ 主機存取 (只有 owner 能核准): ${parts.join(', ')}; 主機其他 port 與內網照樣連不到`
}

/** What /router skill approve shows about a skill's actions. */
export function describeActions(dir: string): string {
  const m = loadManifest(dir)
  if (!m) return '(沒有 privileged.json)'
  return Object.entries(m.actions).map(([n, a]) => `${n}${a.internal ? ' (只由 router 執行)' : ''}: ${a.run.join(' ')}; 角色 ${(a.roles ?? ['owner', 'admin', 'power', 'user']).join(', ')}${a.creds ? `; 憑證 ${Object.values(a.creds).join(', ')}` : ''}${a.http ? `; API 憑證 ${Object.values(a.http).join(', ')}` : ''}${a.bots ? `; bot 憑證 ${Object.values(a.bots).join(', ')}` : ''}${a.store ? `; 資料庫 ${Object.values(a.store).map(d => { const s = storeOf(d); return `${s.name} (${s.mode})` }).join(', ')}` : ''}${Object.entries(a.args ?? {}).filter(([, s]) => s.roles).map(([n, s]) => `; 參數 ${n} 限 ${s.roles!.join(', ')}`).join('')}${a.tools?.length ? `; 工具 ${a.tools.join(', ')}` : ''}${raisedLimits(a).length ? `; ⚠️ 放寬資源上限 ${raisedLimits(a).join(', ')} (只有 owner 能核准)` : ''}${a.stop_exits ? `; 正常停止 ${Object.entries(a.stop_exits).map(([c, w]) => `exit ${c} (${w})`).join(', ')}` : ''}${a.outbound_ports?.length ? `; ⚠️ 額外的對外 port ${a.outbound_ports.join(', ')} (只有 owner 能核准)` : ''}${hostLine(a)}`).join('\n')
}
