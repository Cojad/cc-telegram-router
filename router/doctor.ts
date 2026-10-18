// `cc-telegram-router cli doctor` (through the running router) and
// `cc-telegram-router [--config x] doctor` (without it, e.g. at the end of the
// setup wizard): one pass over what a router needs, as plain text to paste to
// someone else (docs/operations.md 「cli doctor」). Never a token: every line
// goes through maskTokens. Tests: router/test/diagnose.test.ts.

import { existsSync } from 'fs'
import { Database } from 'bun:sqlite'
import { loadConfig } from './config'
import { homedir } from 'os'
import { join } from 'path'
import type { Conversation } from './db'
import type { AgentEntry } from './supervisor'
import { maskTokens } from './context'
import { modelWindowNotes, readProjects, trustFix, trustOf, unitPathCheck, unitFile } from './diagnose'
import { checkMarketplace, checkPluginCache, pluginsRoot } from './pluginguard'
import { resolveChannel, describeMode, LEGACY_BY_CONFIG, type Channel } from './claudecmd'
import { checkNamespaces, prepareMounts, type NsCheck } from './managed'
import { readLocator, locatorPath } from '../shared/locate'
import { blockedWhy, daemonReport, jobsDir, listJobs, readProcs, reportNotices, strayJobs, TURN_END_NOTE, type JobState, type Proc } from './jobs'
import { dirname as dirOf } from 'path'
import { realpathSync } from 'fs'

export interface DoctorDeps {
  cfg: { home: string; stateDir: string; socket: string; model: string; autoCompactWindow: number; claudeBin: string; bots: Array<{ name: string; apiRoot?: string }>; apiRoot?: string }
  userHome?: string
  /** The router's conversations (router.db), when it can be read. */
  conversations?: Conversation[]
  /** claude agents --json --all; null when it failed. */
  agents?: AgentEntry[] | null
  /** The daemon's job records (~/.claude/jobs, router/jobs.ts listJobs). */
  jobs?: JobState[]
  /** This user's processes (router/jobs.ts readProcs), for the daemon's state. */
  procs?: Proc[]
  /** The folder of the claude the router runs (daemonReport looks only at that install). */
  claudeDir?: string
  /** Through the running router: which workers' plugins are connected. */
  isConnected?: (key: string) => boolean
  which?: (cmd: string) => string | null
  version?: string
  /** How workers get their channel (router/claudecmd.ts) and, in managed mode, the daemon's check (router/managed.ts). */
  channel?: Channel & { check?: NsCheck | null }
}

const ok = (s: string) => `✅ ${s}`
const warn = (s: string) => `⚠️ ${s}`
const bad = (s: string) => `❌ ${s}`

export function doctorReport(d: DoctorDeps): string {
  const home = d.userHome ?? homedir()
  const which = d.which ?? ((c: string) => Bun.which(c))
  const { cfg } = d
  const out: string[] = [`cc-telegram-router doctor${d.version ? ` ${d.version}` : ''}${d.isConnected ? ' (經由執行中的 router)' : ' (router 沒有參與, 只看檔案與指令)'}`]

  // bun and claude on the systemd unit's PATH
  const unit = unitPathCheck({ userHome: home, claudeBin: cfg.claudeBin, bun: which('bun'), claude: which(cfg.claudeBin) })
  if (unit.length) out.push(...unit.map(l => l.startsWith('⚠️') ? l : warn(l)))
  else out.push(ok(`bun 與 claude (${cfg.claudeBin}) 在 ${existsSync(unitFile(home)) ? 'systemd unit' : 'unit 預設'} 的 PATH 找得到`))

  // the channel mode (docs/managed-channel.md): managed, or legacy and why
  const ch = d.channel
  const managed = ch?.launcher.mode === 'managed'
  if (ch) {
    const intended = ch.decision.mode === 'legacy' && ch.decision.reason === LEGACY_BY_CONFIG
    out.push(managed || intended ? ok(`channel 模式: ${describeMode(ch.decision, ch.shareSessions)}`) : warn(`channel 模式: ${describeMode(ch.decision, ch.shareSessions)}`))
    if (managed) out.push(ok(`bwrap ${ch.decision.bwrap} (sha256 與工具箱安裝時相同), 設定目錄 ${ch.paths.configDir}`))
  }

  // the telegram plugin as deploy/install.sh plugin left it: the router's marketplace (managed) or the official cache, for this user
  if (managed) {
    const problems = checkMarketplace(cfg.stateDir, ch!.paths.pluginDir)
    if (problems.length) out.push(...problems.map(p => warn(`telegram plugin: ${p.detail}`)))
    else out.push(ok(`telegram plugin 在 router 的商店 (${ch!.paths.pluginDir}), 跟部署時相同`))
  } else {
    const problems = checkPluginCache(cfg.stateDir, pluginsRoot(process.env, home))
    if (problems.length) out.push(...problems.map(p => warn(`telegram plugin: ${p.detail}`)))
    else out.push(ok(`telegram plugin 裝在這個使用者 (${pluginsRoot(process.env, home)}), 跟部署時相同`))
  }

  // the locator the plugin and the hook find the router by
  const loc = readLocator(locatorPath(home))
  if (!loc) out.push(bad(`位置檔 ${locatorPath(home)} 不存在: worker 的 plugin 與 hook 找不到 router; 執行 ${join(cfg.stateDir, 'cc-telegram-router')} register`))
  else if (loc.home !== cfg.home || loc.socket !== cfg.socket) out.push(bad(`位置檔指向另一個 router (home ${loc.home}, socket ${loc.socket}); 執行 ${join(cfg.stateDir, 'cc-telegram-router')} register`))
  else out.push(ok(`位置檔 ${locatorPath(home)} 指向這個 router`))

  // home trusted by Claude Code (children inherit it); managed mode: in the router's own config folder
  const claudeJson = ch?.launcher.claudeJson ?? join(home, '.claude.json')
  const projects = readProjects(claudeJson)
  if (!projects) out.push(warn(`讀不到 ${claudeJson}: 無法確認資料夾信任 (${managed ? 'router 還沒以 managed 模式啟動過?' : 'Claude Code 還沒在這個使用者下執行過?'})`))
  else {
    const t = trustOf(projects, cfg.home, home)
    out.push(t.trusted ? ok(`home ${cfg.home} 已被 Claude Code 信任 (${t.key === cfg.home ? '它自己' : `上層 ${t.key}`})`) : bad(`home ${cfg.home} 沒有被 Claude Code 信任, worker 會 Workspace not trusted: ${trustFix(cfg.home, t)}`))
    const nested = (d.conversations ?? []).filter(c => { const ct = trustOf(projects, c.folder, home); return !ct.trusted && ct.why === 'repo' })
    if (nested.length) out.push(warn(`這些對話資料夾是自己的 git repo, 不吃 home 的信任: ${nested.map(c => c.key).join(', ')} (在那個資料夾互動執行一次 claude)`))
  }

  // the model against autoCompactWindow: the default and each conversation's own
  const notes = modelWindowNotes(cfg.model, cfg.autoCompactWindow)
  out.push(...(notes.length ? notes.map(n => warn(`預設: ${n}`)) : [ok(`預設模型 ${cfg.model}, autoCompactWindow ${cfg.autoCompactWindow}`)]))
  for (const c of d.conversations ?? []) {
    if (!c.model && !c.compact) continue
    for (const n of modelWindowNotes(c.model ?? cfg.model, c.compact ?? cfg.autoCompactWindow)) out.push(warn(`${c.key}: ${n}`))
  }

  // the daemon's jobs and processes, judged as the router's job sweep does (router/jobs.ts)
  if (d.agents === null) out.push(warn(`claude agents --json --all 失敗: 看不到 daemon 的 job (${cfg.claudeBin} 能執行嗎?)`))
  else if (d.agents) {
    const stray = strayJobs({ agents: d.agents, jobs: d.jobs ?? [], convs: d.conversations ?? [] })
    if (stray.length) out.push(warn(`daemon 裡有不是對話目前 session 的 job (router 啟動後 5 秒與每 10 分鐘自動清掉): ${stray.map(j => `${j.key} 的 ${j.id}${j.running ? ' (在跑)' : ''}`).join(', ')}`))
    else out.push(ok('daemon 的 job 都是對話目前的 session'))
    const keys = new Set((d.conversations ?? []).map(c => `tg-${c.key}`))
    // blocked: trouble only for a prompt on the worker's window or an API error; else how the last turn ended (router/jobs.ts blockedWhy)
    const blocked = d.agents.filter(a => a.name && keys.has(a.name)).map(a => ({ a, why: blockedWhy(a, d.jobs ?? []) }))
    const stuck = blocked.flatMap(({ a, why }) => why?.warn ? [`${a.name} (${why.text})`] : [])
    const turnEnd = blocked.flatMap(({ a, why }) => why && !why.warn ? [a.name] : [])
    if (stuck.length) out.push(warn(`這些 worker 卡住 (blocked): ${stuck.join(', ')}`))
    if (turnEnd.length) out.push(`ℹ️ ${TURN_END_NOTE}: ${turnEnd.join(', ')}`)
  }
  if (managed && ch!.check !== undefined) {
    const c = ch!.check
    if (!c || !c.daemon) out.push(warn('router 的 claude daemon 沒有在跑 (router 執行中會自動帶起; 沒在執行時這是正常的)'))
    else if (c.bad.length) out.push(bad(`這些程序看不到 managed settings, Telegram 訊息會被丟掉: ${c.bad.map(b => `${b.what} (pid ${b.pid})`).join(', ')}; router 會自動修復, 修不好看 router 的 log`))
    else out.push(ok(`router 的 claude daemon (pid ${c.daemon}) 與 ${c.workers} 個 worker 都看得到 managed settings`))
  } else if (d.procs && !managed) {
    const r = daemonReport(d.procs, [cfg.home, cfg.stateDir], d.claudeDir)
    const notes = reportNotices(r)
    if (notes.length) out.push(...notes.map(n => n.split('\n')[0]!))
    else out.push(ok(`claude daemon: ${r.daemons.length ? `${r.daemons.length} 個, 都由 router 帶起` : '沒有在跑 (下一次叫醒 worker 時由 router 帶起)'}${r.spares.length ? `, 暖機 spare ${r.spares.length} 個` : ''}`))
  }

  // the workers' plugins, through the running router
  if (d.isConnected && d.conversations) {
    const running = new Set((d.agents ?? []).filter(a => a.pid != null && a.status != null).map(a => a.sessionId))
    const wedged = d.conversations.filter(c => c.session_id && running.has(c.session_id) && !d.isConnected!(c.key))
    out.push(wedged.length ? warn(`這些 worker 在跑但 plugin 沒有連上 router: ${wedged.map(c => c.key).join(', ')} (看 /router status 的原因)`) : ok('在跑的 worker 的 plugin 都連上了'))
  }
  return maskTokens(out.join('\n'))
}


/** Without the router (cc-telegram-router doctor, the end of the setup
 *  wizard): conversations read from router.db read-only, the daemon's jobs
 *  from claude agents. */
export async function offlineDoctor(configPath: string, version?: string): Promise<string> {
  const cfg = loadConfig(configPath)
  let conversations: Conversation[] | undefined
  const dbFile = join(cfg.stateDir, 'router.db')
  if (existsSync(dbFile)) {
    try {
      const db = new Database(dbFile, { readonly: true })
      try { conversations = db.query('SELECT * FROM conversations').all() as Conversation[] } finally { db.close() }
    } catch {}
  }
  const channel = resolveChannel(cfg, { prepare: prepareMounts })
  const l = channel.launcher
  let agents: AgentEntry[] | null = null
  try {
    const p = Bun.spawn(l.argv(['agents', '--json', '--all']), { cwd: existsSync(cfg.home) ? cfg.home : undefined, env: l.env(), stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
    const timer = setTimeout(() => p.kill(9), 15_000)
    const text = await new Response(p.stdout).text()
    clearTimeout(timer)
    if ((await p.exited) === 0) agents = JSON.parse(text)
  } catch {}
  return doctorReport({ cfg, conversations, agents, version, ...daemonInputs(cfg.claudeBin, join(l.configDir, 'jobs')), channel: { ...channel, check: l.mode === 'managed' ? checkNamespaces(channel.paths) : null } })
}

/** The daemon's job records and processes for the doctor, as the router's job sweep reads them (router/jobs.ts). */
export function daemonInputs(claudeBin: string, jobs = jobsDir()): Pick<DoctorDeps, 'jobs' | 'procs' | 'claudeDir'> {
  let claudeDir: string | undefined
  try { claudeDir = dirOf(realpathSync(Bun.which(claudeBin) ?? claudeBin)) } catch {}
  return { jobs: listJobs(jobs), procs: readProcs(), ...(claudeDir ? { claudeDir } : {}) }
}
