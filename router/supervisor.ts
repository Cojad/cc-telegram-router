// Wakes worker sessions (plan 03 Supervisor, 「喚醒」 flow). One lock per
// conversation so a burst of messages wakes it once. "Awake" means the
// worker's plugin is connected to the router socket — the daemon's own
// status can say idle/working while the plugin is still starting or already
// shutting down, so the socket is the source of truth.

import type { Config } from './config'
import type { Conversation, RouterDb } from './db'
import { sameFlags, flagDiff, recordedFlags } from './jobs'

export type RunResult = { code: number; stdout: string; stderr: string }
export type Runner = (args: string[], cwd: string) => Promise<RunResult>

export type AgentEntry = { id: string; sessionId?: string; name?: string; pid?: number; state?: string; status?: string; cwd?: string }

export interface SupervisorDeps {
  cfg: Config
  db: RouterDb
  run: Runner
  isConnected: (key: string) => boolean
  /** Resolves true once the conversation's plugin says hello, false on timeout. */
  waitConnected: (key: string, ms: number) => Promise<boolean>
  settingsPath: (c: Conversation) => string
  /** Just before a worker is started; resumed: an existing session goes on (router/freshness.ts). */
  onStart?: (c: Conversation, resumed: boolean) => void
  log?: (msg: string) => void
  connectTimeoutMs?: number
  /** The worker did not wake: claude --bg failed (spawnOut: what it said) or
   *  the plugin did not connect in time (router/diagnose.ts finds out why). */
  onWakeFail?: (c: Conversation, info: { spawnOut?: string }) => void
  /** No wake before this time (ms) after failures in a row; a wake asked for
   *  earlier is put off until then (router/diagnose.ts createWakeTracker). */
  holdUntil?: (key: string) => number
  /** /router session restart: a wake now, whatever holdUntil says. */
  release?: (key: string) => void
  /** The flags a daemon job was started with (its state.json respawnFlags, router/jobs.ts); null when unreadable. */
  jobFlags?: (jobId: string) => string[] | null
  /** --channels for workers (router/claudecmd.ts CHANNELS: the router's own plugin in managed mode); default CHANNEL. */
  channel?: string
  /** Before each wake: managed mode makes sure the daemon is the router's, inside bwrap (router/managed.ts). */
  beforeWake?: () => Promise<unknown>
}

/** The legacy channel: the official plugin's cache with plugin v2 laid over it. */
export const CHANNEL = 'plugin:telegram@claude-plugins-official'

/** Running = the daemon reports a live process. `state` is not it: "done"
 *  only means the last turn finished while the process stays up. */
export function isRunning(a: AgentEntry): boolean {
  return a.pid != null && a.status != null
}

export function workerArgs(cfg: Config, c: Conversation, settings: string, channel = CHANNEL): string[] {
  return [
    '--allow-dangerously-skip-permissions',
    '--name', `tg-${c.key}`,
    '--model', c.model ?? cfg.model,
    '--setting-sources', 'project,local',
    '--settings', settings,
    '--channels', channel,
  ]
}

/** First prompt of a new worker. A background session that never had a
 *  prompt has no transcript yet: it ignores channel messages and cannot be
 *  resumed later, so every worker starts with this one short turn. */
export function initPrompt(c: Conversation): string {
  return `你是 Telegram 對話 ${c.key} 的 worker. 之後的訊息會以 <channel> 送進來, 依 CLAUDE.md 處理. 這句不用回覆.`
}

/** "backgrounded · 979f4788 · tg-dm-1 (idle — ...)" -> 979f4788 */
export function parseShortId(stdout: string): string | null {
  const m = /backgrounded\s*·\s*([0-9a-f]{6,})/.exec(stdout)
  return m ? m[1]! : null
}

export function createSupervisor(deps: SupervisorDeps) {
  const { cfg, db, run, isConnected, waitConnected, settingsPath } = deps
  const log = deps.log ?? (() => {})
  const timeout = deps.connectTimeoutMs ?? 90_000
  const locks = new Map<string, Promise<void>>()

  /** The daemon's jobs. Managed mode shares the user's session registry (docs/managed-channel.md), so
   *  claude agents also lists the user's interactive sessions: those have no job id and are left out. */
  async function listAgents(): Promise<AgentEntry[]> {
    const r = await run([cfg.claudeBin, 'agents', '--json', '--all'], cfg.home)
    try { return (JSON.parse(r.stdout) as AgentEntry[]).filter(a => typeof a?.id === 'string' && a.id !== '') } catch { return [] }
  }

  /** Started, or why not (what claude said). */
  async function start(c: Conversation, agents: AgentEntry[]): Promise<{ failed: boolean; out: string }> {
    const settings = settingsPath(c)
    const wanted = workerArgs(cfg, c, settings, deps.channel)
    if (c.session_id) {
      // While the daemon still has the job, resume without flags: it keeps
      // the options it was created with (--settings path included, so
      // regenerated settings apply), and passing flags would start a copy
      // under a new session id. Once the job is gone (claude rm, pruned),
      // nothing is saved any more and the flags must be given again.
      let job = agents.find(a => a.sessionId === c.session_id)
      // Saved flags that are not what the router gives now (config model,
      // channel, settings path...): remove the job so the new ones apply.
      const saved = job ? (deps.jobFlags?.(job.id) ?? recordedFlags(c)) : null
      if (job && saved && !sameFlags(saved, wanted)) {
        log(`${c.key}: job ${job.id} was started with other flags (${flagDiff(saved, wanted)}); removing it to resume with the new ones`)
        if (isRunning(job)) await run([cfg.claudeBin, 'stop', job.id], cfg.home)
        const rm = await run([cfg.claudeBin, 'rm', job.id], cfg.home)
        if (rm.code === 0) job = undefined
        else log(`${c.key}: claude rm ${job.id} failed, resuming with its saved flags: ${rm.stderr || rm.stdout}`)
      }
      const hasJob = !!job
      log(`resume ${c.key} ${c.session_id}${hasJob ? '' : ' (job gone, with flags)'}`)
      deps.onStart?.(c, true)
      const args = [cfg.claudeBin, '--bg', '--resume', c.session_id, ...(hasJob ? [] : wanted)]
      const r = await run(args, c.folder)
      if (r.code !== 0) { log(`resume ${c.key} failed: ${r.stderr || r.stdout}`); return { failed: true, out: `${r.stderr}\n${r.stdout}`.trim() } }
      if (!hasJob) db.setWorkerFlags(c.key, wanted)
      else if (saved) db.setWorkerFlags(c.key, saved)
      return { failed: false, out: r.stdout }
    }
    log(`spawn ${c.key}`)
    deps.onStart?.(c, false)
    const r = await run([cfg.claudeBin, '--bg', ...wanted, '--', initPrompt(c)], c.folder)
    const short = parseShortId(r.stdout)
    if (!short) { log(`spawn ${c.key} failed: ${r.stderr || r.stdout}`); return { failed: true, out: `${r.stderr}\n${r.stdout}`.trim() } }
    const entry = (await listAgents()).find(a => a.id === short)
    if (entry?.sessionId) {
      db.setSession(c.key, entry.sessionId)
      db.setWorkerFlags(c.key, wanted)
      c.session_id = entry.sessionId
    }
    return { failed: false, out: r.stdout }
  }

  const later = new Map<string, ReturnType<typeof setTimeout>>()
  /** A held-back wake: once, when the hold ends, if messages still wait. */
  function wakeLater(c: Conversation, at: number): void {
    if (later.has(c.key)) return
    const t = setTimeout(() => {
      later.delete(c.key)
      const now = db.getConversation(c.key) ?? c
      if (db.undelivered(c.key).length) void ensureAwake(now)
    }, Math.max(0, at - Date.now()))
    ;(t as { unref?: () => void }).unref?.()
    later.set(c.key, t)
  }

  async function wake(c: Conversation): Promise<void> {
    if (isConnected(c.key)) return
    // failed several times in a row: wait (messages stay queued)
    const hold = deps.holdUntil?.(c.key) ?? 0
    if (hold > Date.now()) { wakeLater(c, hold); return }
    await deps.beforeWake?.()
    const agents = await listAgents()
    const live = agents.find(a => c.session_id && a.sessionId === c.session_id && isRunning(a))
    if (live) {
      // Running but plugin not connected: still starting, or wedged.
      if (await waitConnected(c.key, 20_000)) return
      log(`${c.key} running without plugin connection, restarting`)
      await run([cfg.claudeBin, 'stop', live.id], cfg.home)
    }
    const s = await start(c, agents)
    // claude --bg itself refused (e.g. Workspace not trusted): no plugin is coming
    if (s.failed) { deps.onWakeFail?.(c, { spawnOut: s.out }); return }
    if (!(await waitConnected(c.key, timeout))) {
      log(`${c.key}: plugin did not connect within ${timeout}ms`)
      deps.onWakeFail?.(c, {})
    }
  }

  /** Serialized per conversation: concurrent callers share one wake. */
  function ensureAwake(c: Conversation): Promise<void> {
    const prev = locks.get(c.key)
    if (prev) return prev
    const p = wake(c).catch(e => log(`wake ${c.key} error: ${e}`)).finally(() => locks.delete(c.key))
    locks.set(c.key, p)
    return p
  }

  async function liveJob(c: Conversation): Promise<AgentEntry | undefined> {
    if (!c.session_id) return undefined
    return (await listAgents()).find(a => a.sessionId === c.session_id && isRunning(a))
  }

  /** Stop the worker; the next message wakes it again. dropJob also forgets
   *  the daemon's saved options, so the next wake passes fresh flags (e.g. a
   *  new model) while continuing the same session. */
  async function stop(c: Conversation, opts: { dropJob?: boolean } = {}): Promise<void> {
    const job = await liveJob(c)
    if (job) {
      log(`stop ${c.key}`)
      await run([cfg.claudeBin, 'stop', job.id], cfg.home)
      for (let t = 0; t < 10_000 && isConnected(c.key); t += 200) await new Promise(r => setTimeout(r, 200))
    }
    if (opts.dropJob && c.session_id) {
      const any = (await listAgents()).find(a => a.sessionId === c.session_id)
      if (any) await run([cfg.claudeBin, 'rm', any.id], cfg.home)
    }
  }

  async function restart(c: Conversation, opts: { dropJob?: boolean } = {}): Promise<void> {
    deps.release?.(c.key)
    const t = later.get(c.key)
    if (t) { clearTimeout(t); later.delete(c.key) }
    await stop(c, opts)
    await ensureAwake(c)
  }

  return { ensureAwake, listAgents, stop, restart, liveJob }
}

export const bunRunner: Runner = async (args, cwd) => {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith('TELEGRAM_')) delete env[k]
  const p = Bun.spawn(args, { cwd, env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, stdout, stderr }
}
