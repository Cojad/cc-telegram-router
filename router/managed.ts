// Managed mode's housekeeping (docs/managed-channel.md): the router's own
// Claude Code config folder made ready, the managed settings written, the
// daemon kept inside bwrap (checked through /proc/<pid>/root and put right
// when a daemon or worker cannot see /etc/claude-code), and the conversations'
// transcripts copied over from the user's config folder once.

import { spawn } from 'child_process'
import { cpSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync, chmodSync, closeSync } from 'fs'
import { dirname, join, resolve } from 'path'
import type { Conversation } from './db'
import { projectStore } from './conversations'
import { listJobs } from './jobs'
import { claudeJsonOf, managedSettings, type Launcher, type ManagedPaths } from './claudecmd'

const readJson = (p: string): any => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }

/** Write JSON through a temporary file and rename (Claude Code reads these files at any time). */
function writeJson(p: string, v: unknown, mode = 0o600): void {
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 })
  writeFileSync(`${p}.cctr-new`, JSON.stringify(v, null, 2) + '\n', { mode })
  renameSync(`${p}.cctr-new`, p)
}

/** <stateDir>/managed/managed-settings.json as it should be (rewritten only when different). */
export function writeManagedSettings(p: Pick<ManagedPaths, 'managedDir' | 'managedFile'>): void {
  mkdirSync(p.managedDir, { recursive: true, mode: 0o755 })
  const want = managedSettings()
  let have = ''
  try { have = readFileSync(p.managedFile, 'utf8') } catch {}
  if (have !== want) { writeFileSync(`${p.managedFile}.new`, want, { mode: 0o644 }); renameSync(`${p.managedFile}.new`, p.managedFile) }
}

/** The config folder ready for background sessions: 700; settings.json accepts the
 *  bypass warning (--bg refuses otherwise); .claude.json trusts home and the given
 *  folders. Other keys of both files are kept. */
export function initConfigDir(p: Pick<ManagedPaths, 'configDir'>, trust: string[]): { changed: string[] } {
  const changed: string[] = []
  mkdirSync(p.configDir, { recursive: true, mode: 0o700 })
  chmodSync(p.configDir, 0o700)
  const settingsPath = join(p.configDir, 'settings.json')
  const s = readJson(settingsPath) ?? {}
  if (s.skipDangerousModePermissionPrompt !== true) { s.skipDangerousModePermissionPrompt = true; writeJson(settingsPath, s); changed.push('settings.json') }
  const cjPath = join(p.configDir, '.claude.json')
  const cj = readJson(cjPath) ?? {}
  const projects = (cj.projects && typeof cj.projects === 'object') ? cj.projects : (cj.projects = {})
  let add = false
  for (const dir of trust.map(d => resolve(d))) {
    const e = (projects[dir] && typeof projects[dir] === 'object') ? projects[dir] : (projects[dir] = {})
    if (e.hasTrustDialogAccepted !== true) { e.hasTrustDialogAccepted = true; add = true }
  }
  if (add) { writeJson(cjPath, cj); changed.push('.claude.json') }
  return { changed }
}

// --- the daemon and its workers seen through /proc ------------------------------

export interface NsCheck {
  /** The daemon's pid when one is running for the config folder. */
  daemon: number | null
  /** Processes (daemon or worker) that cannot see the managed settings. */
  bad: { pid: number; what: string }[]
  workers: number
}

const alive = (procRoot: string, pid: number) => existsSync(join(procRoot, String(pid)))

/** The daemon (daemon.status.json) and its workers (daemon/roster.json) of the config
 *  folder: does each see <procRoot>/<pid>/root/etc/claude-code/managed-settings.json
 *  with the content the router wrote? Reads files only. */
export function checkNamespaces(p: Pick<ManagedPaths, 'configDir' | 'managedFile'>, procRoot = '/proc'): NsCheck {
  const st = readJson(join(p.configDir, 'daemon.status.json'))
  const pid = typeof st?.supervisorPid === 'number' ? st.supervisorPid : null
  if (!pid || !alive(procRoot, pid)) return { daemon: null, bad: [], workers: 0 }
  let want = ''
  try { want = readFileSync(p.managedFile, 'utf8') } catch {}
  const sees = (n: number) => { try { return readFileSync(join(procRoot, String(n), 'root', 'etc', 'claude-code', 'managed-settings.json'), 'utf8') === want && want !== '' } catch { return false } }
  const bad: NsCheck['bad'] = []
  if (!sees(pid)) bad.push({ pid, what: 'daemon' })
  const roster = readJson(join(p.configDir, 'daemon', 'roster.json'))
  let workers = 0
  if (roster?.supervisorPid === pid && roster.workers && typeof roster.workers === 'object') {
    for (const [id, w] of Object.entries(roster.workers as Record<string, { pid?: number }>)) {
      if (typeof w?.pid !== 'number' || !alive(procRoot, w.pid)) continue
      workers++
      if (!sees(w.pid)) bad.push({ pid: w.pid, what: `worker ${id}` })
    }
  }
  return { daemon: pid, bad, workers }
}

export interface KeeperDeps {
  launcher: Launcher
  paths: Pick<ManagedPaths, 'configDir' | 'managedFile'>
  /** Where claude daemon run writes its own output. */
  logFile: string
  procRoot?: string
  log?: (msg: string) => void
  /** Told once per cause (each bot's notices place); back to normal is logged. */
  notify?: (text: string) => void | Promise<void>
  /** Starts claude daemon run detached (the default spawns it through the launcher). */
  startDaemon?: () => void
  /** claude daemon stop --any for the config folder. */
  stopDaemon?: () => Promise<void>
  sleep?: (ms: number) => Promise<void>
  /** How long a new daemon gets to write daemon.status.json. */
  startWaitMs?: number
}

export type KeeperResult = 'ok' | 'started' | 'repaired' | 'failed'

/** Keeps one claude daemon run inside bwrap for the config folder (docs/managed-channel.md
 *  「daemon 的看管」): kept when there and every process sees the managed settings, started
 *  when missing, stopped and started again when not; after 3 failures in a row it stops
 *  trying until a check finds things right again. Calls are serialized. */
export function createDaemonKeeper(d: KeeperDeps) {
  const log = d.log ?? (() => {})
  const sleep = d.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
  const startDaemon = d.startDaemon ?? (() => {
    mkdirSync(dirname(d.logFile), { recursive: true, mode: 0o700 })
    const fd = openSync(d.logFile, 'a', 0o600)
    try {
      const p = spawn(d.launcher.argv(['daemon', 'run'])[0]!, d.launcher.argv(['daemon', 'run']).slice(1), { detached: true, stdio: ['ignore', fd, fd], env: d.launcher.env() as NodeJS.ProcessEnv, cwd: d.paths.configDir })
      p.unref()
    } finally { closeSync(fd) }
  })
  const stopDaemon = d.stopDaemon ?? (async () => {
    const p = Bun.spawn(d.launcher.argv(['daemon', 'stop', '--any']), { env: d.launcher.env(), stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', cwd: d.paths.configDir })
    await p.exited
  })
  let failures = 0
  let told = ''
  let running: Promise<KeeperResult> | null = null
  const tell = (text: string) => {
    if (text === told) return
    told = text
    log(text.split('\n')[0]!)
    if (d.notify) void (async () => d.notify!(text))().catch(e => log(`daemon keeper notice: ${e}`))
  }

  async function waitUp(): Promise<NsCheck> {
    const until = Date.now() + (d.startWaitMs ?? 15_000)
    let c = checkNamespaces(d.paths, d.procRoot)
    while (!c.daemon && Date.now() < until) { await sleep(250); c = checkNamespaces(d.paths, d.procRoot) }
    return c
  }

  async function once(): Promise<KeeperResult> {
    const c = checkNamespaces(d.paths, d.procRoot)
    if (c.daemon && !c.bad.length) {
      if (failures || told) log(`daemon keeper: daemon ${c.daemon} and its ${c.workers} worker(s) see the managed settings again`)
      failures = 0; told = ''
      return 'ok'
    }
    if (failures >= 3) return 'failed'
    let action: KeeperResult = 'started'
    if (c.daemon) {
      action = 'repaired'
      log(`daemon keeper: ${c.bad.map(b => `${b.what} (pid ${b.pid})`).join(', ')} cannot see /etc/claude-code/managed-settings.json; stopping daemon ${c.daemon}`)
      await stopDaemon()
      for (let t = 0; t < 40 && alive(d.procRoot ?? '/proc', c.daemon); t++) await sleep(250)
    } else log('daemon keeper: no daemon for the router\'s config folder, starting claude daemon run in bwrap')
    try { startDaemon() } catch (e) { log(`daemon keeper: start failed: ${e}`) }
    const after = await waitUp()
    if (after.daemon && !after.bad.length) {
      failures = 0
      if (action === 'repaired') tell([
        `⚠️ router 的 claude daemon (pid ${c.daemon}) 或它的 worker 看不到 managed settings (${c.bad.map(b => b.what).join(', ')}), worker 的 Telegram 訊息可能被丟掉.`,
        `已停掉並在 bwrap 裡重新啟動 daemon (pid ${after.daemon}); worker 會在下一則訊息時接續原本的對話.`,
        '常見原因: 有程序在 bwrap 外用 router 的設定目錄啟動了 claude. 見 docs/managed-channel.md 「daemon 的看管」.',
      ].join('\n'))
      else log(`daemon keeper: daemon ${after.daemon} started`)
      return action
    }
    failures++
    const why = after.daemon ? `新的 daemon (pid ${after.daemon}) 仍看不到 managed settings` : `claude daemon run 沒有起來 (看 ${d.logFile})`
    log(`daemon keeper: ${why} (${failures} in a row)`)
    if (failures >= 3) tell([
      `❌ router 連續 ${failures} 次無法讓 claude daemon 在 bwrap 裡正常運作: ${why}.`,
      'worker 可能叫不醒, 或收不到 Telegram 訊息. router 不再自動重試, 也不會自己切回 legacy 模式.',
      '請跑 cc-telegram-router cli doctor 看原因. 修好後重啟 router; 要暫時退回原本的做法, 在 config.json 設 "channelMode": "legacy" 再重啟.',
    ].join('\n'))
    return 'failed'
  }

  /** Check, and start or repair when needed. */
  function ensure(): Promise<KeeperResult> {
    if (running) return running
    running = once().finally(() => { running = null })
    return running
  }
  return { ensure, check: () => checkNamespaces(d.paths, d.procRoot), failures: () => failures }
}

// --- transcripts ---------------------------------------------------------------

export interface MigrateResult {
  copied: { key: string; session: string }[]
  skipped: { key: string; why: string }[]
  trusted: string[]
  oldJobs: { id: string; key: string; removed: boolean | null }[]
}

export interface MigrateDeps {
  convs: Conversation[]
  /** The user's config folder (where the transcripts are now). */
  from: string
  /** The router's config folder (where they go). */
  to: string
  /** The user's config folder's .claude.json (folder trust copied from it). */
  fromClaudeJson: string
  home: string
  dryRun?: boolean
  /** Removes a job from the user's daemon (claude stop, then rm, without the router's environment); null: list only. */
  removeJob?: ((id: string) => Promise<boolean>) | null
  now?: () => Date
}

const MARK = 'migrated.json'

/** True once the transcripts were copied into this config folder (migrated.json). */
export const migrated = (configDir: string) => existsSync(join(configDir, MARK))

/** Copy each conversation's current session (<session>.jsonl and the <session>/ folder of
 *  tool-results and subagents) from the user's config folder into the router's, never over
 *  a file already there; trust the conversation folders the user's .claude.json trusts;
 *  remove the conversations' jobs from the user's daemon; write migrated.json. Nothing is
 *  deleted from the user's config folder. dryRun: only say what would be done. */
export async function migrateTranscripts(d: MigrateDeps): Promise<MigrateResult> {
  const out: MigrateResult = { copied: [], skipped: [], trusted: [], oldJobs: [] }
  for (const c of d.convs) {
    if (!c.session_id) { out.skipped.push({ key: c.key, why: '沒有 session' }); continue }
    const src = projectStore(c.folder, join(d.from, 'projects')), dst = projectStore(c.folder, join(d.to, 'projects'))
    const file = `${c.session_id}.jsonl`
    if (!existsSync(join(src, file))) { out.skipped.push({ key: c.key, why: `找不到 ${join(src, file)}` }); continue }
    if (existsSync(join(dst, file))) { out.skipped.push({ key: c.key, why: '目的地已有這個 session' }); continue }
    if (!d.dryRun) {
      mkdirSync(dst, { recursive: true, mode: 0o700 })
      if (existsSync(join(src, c.session_id))) cpSync(join(src, c.session_id), join(dst, c.session_id), { recursive: true, force: false, errorOnExist: false, preserveTimestamps: true })
      // the .jsonl last: a copy cut short leaves no transcript, and the next run copies again
      cpSync(join(src, file), join(dst, `${file}.cctr-new`), { preserveTimestamps: true })
      renameSync(join(dst, `${file}.cctr-new`), join(dst, file))
    }
    out.copied.push({ key: c.key, session: c.session_id })
  }
  // conversation folders the user's Claude Code trusts on their own (a git repo needs its own trust)
  const projects = readJson(d.fromClaudeJson)?.projects ?? {}
  for (const c of d.convs) {
    let f = resolve(c.folder)
    for (; f !== dirname(f) && f !== resolve(d.home); f = dirname(f)) if (projects[f]?.hasTrustDialogAccepted === true) { out.trusted.push(f); break }
  }
  out.trusted = [...new Set(out.trusted)]
  if (!d.dryRun && out.trusted.length) initConfigDir({ configDir: d.to }, out.trusted)
  // the conversations' jobs in the user's daemon (they would come back with the official channel)
  const byName = new Map(d.convs.map(c => [`tg-${c.key}`, c]))
  for (const j of listJobs(join(d.from, 'jobs'))) {
    const c = j.name ? byName.get(j.name) : undefined
    if (!c || !j.cwd || resolve(j.cwd) !== resolve(c.folder)) continue
    const removed = d.dryRun || !d.removeJob ? null : await d.removeJob(j.id).catch(() => false)
    out.oldJobs.push({ id: j.id, key: c.key, removed })
  }
  if (!d.dryRun) writeJson(join(d.to, MARK), { at: (d.now?.() ?? new Date()).toISOString(), from: d.from, copied: out.copied, trusted: out.trusted, oldJobs: out.oldJobs })
  return out
}

/** Back to legacy after managed: each conversation's current session copied from the router's
 *  config folder to the user's when the router's copy is newer (nothing deleted). */
export function syncBack(d: { convs: Conversation[]; from: string; to: string }): { key: string; session: string }[] {
  const out: { key: string; session: string }[] = []
  for (const c of d.convs) {
    if (!c.session_id) continue
    const src = projectStore(c.folder, join(d.from, 'projects')), dst = projectStore(c.folder, join(d.to, 'projects'))
    const file = `${c.session_id}.jsonl`
    let s: number, t = 0
    try { s = statSync(join(src, file)).mtimeMs } catch { continue }
    try { t = statSync(join(dst, file)).mtimeMs } catch {}
    if (s <= t) continue
    mkdirSync(dst, { recursive: true, mode: 0o700 })
    if (existsSync(join(src, c.session_id))) cpSync(join(src, c.session_id), join(dst, c.session_id), { recursive: true, force: true, preserveTimestamps: true })
    cpSync(join(src, file), join(dst, `${file}.cctr-new`), { preserveTimestamps: true })
    renameSync(join(dst, `${file}.cctr-new`), join(dst, file))
    out.push({ key: c.key, session: c.session_id })
  }
  return out
}

/** The migration's summary, one line each (managed migrate, the log). */
export function describeMigration(r: MigrateResult, dryRun: boolean): string {
  const v = dryRun ? '會' : '已'
  return [
    `對話紀錄: ${v}複製 ${r.copied.length} 個 session${r.copied.length ? ` (${r.copied.map(x => x.key).join(', ')})` : ''}`,
    ...r.skipped.map(s => `  略過 ${s.key}: ${s.why}`),
    `資料夾信任: ${r.trusted.length ? `${v}照抄 ${r.trusted.join(', ')}` : '沒有要照抄的'}`,
    `原本 daemon 裡的 job: ${r.oldJobs.length ? r.oldJobs.map(j => `${j.id} (${j.key}) ${j.removed === null ? '會 stop 加 rm' : j.removed ? '已移除' : '移除失敗'}`).join(', ') : '沒有'}`,
  ].join('\n')
}

// --- cc-telegram-router managed migrate ----------------------------------------

export interface MigrateCliDeps {
  cfg: { home: string; stateDir: string; claudeBin: string }
  /** The router's conversations (router.db read-only). */
  convs: () => Conversation[]
  paths: ManagedPaths
  /** Takes the router's lock (throws when the router runs); not taken for --dry-run. */
  lock: () => () => void
  /** claude stop/rm in the user's own environment; true when rm succeeded. */
  removeJob: (id: string) => Promise<boolean>
  print?: (s: string) => void
}

/** `managed migrate [--dry-run] [--user-config <dir>] [--force]`: the transcripts copied into the router's
 *  config folder (migrateTranscripts). --user-config: another copy of the user's config folder (a
 *  rehearsal): its jobs are only listed. Exit 0, 1 on failure, 2 on wrong use. */
export async function migrateCli(args: string[], d: MigrateCliDeps): Promise<number> {
  const print = d.print ?? (s => console.log(s))
  const known = new Set(['--dry-run', '--user-config', '--force'])
  const bad = args.find((a, i) => a.startsWith('--') ? !known.has(a) : args[i - 1] !== '--user-config')
  const at = args.indexOf('--user-config')
  const userConfig = at >= 0 ? args[at + 1] : undefined
  if (bad !== undefined || (at >= 0 && (!userConfig || userConfig.startsWith('--')))) { print('用法: cc-telegram-router [--config <路徑>] managed migrate [--dry-run] [--user-config <原本的設定目錄>] [--force]'); return 2 }
  const dryRun = args.includes('--dry-run')
  const from = resolve(userConfig ?? d.paths.userConfigDir)
  if (!dryRun && migrated(d.paths.configDir) && !args.includes('--force')) {
    print(`${join(d.paths.configDir, MARK)} 已存在, 之前遷移過; 要再做一次 (已存在的 session 不會被覆蓋) 加 --force`)
    return 0
  }
  let release: (() => void) | undefined
  try {
    if (!dryRun) release = d.lock()
    if (!dryRun) initConfigDir(d.paths, [d.cfg.home])
    const r = await migrateTranscripts({
      convs: d.convs(), from, to: d.paths.configDir, fromClaudeJson: claudeJsonOf(from), home: d.cfg.home, dryRun,
      removeJob: userConfig ? null : d.removeJob,
    })
    print(`${dryRun ? '(--dry-run, 沒有改任何東西) ' : ''}從 ${from} 到 ${d.paths.configDir}:\n${describeMigration(r, dryRun)}`)
    return r.oldJobs.some(j => j.removed === false) ? 1 : 0
  } catch (e) {
    print(`遷移失敗: ${e instanceof Error ? e.message : e}`)
    return 1
  } finally { release?.() }
}
