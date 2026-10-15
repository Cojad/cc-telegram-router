// Wakes worker sessions (plan 03 Supervisor, 「喚醒」 flow). One lock per
// conversation so a burst of messages wakes it once. "Awake" means the
// worker's plugin is connected to the router socket — the daemon's own
// status can say idle/working while the plugin is still starting or already
// shutting down, so the socket is the source of truth.

import type { Config } from './config'
import type { Conversation, RouterDb } from './db'

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
  log?: (msg: string) => void
  connectTimeoutMs?: number
}

export const CHANNEL = 'plugin:telegram@claude-plugins-official'

export function workerArgs(cfg: Config, c: Conversation, settings: string): string[] {
  return [
    '--allow-dangerously-skip-permissions',
    '--model', cfg.model,
    '--setting-sources', 'project,local',
    '--settings', settings,
    '--channels', CHANNEL,
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

  async function listAgents(): Promise<AgentEntry[]> {
    const r = await run([cfg.claudeBin, 'agents', '--json', '--all'], cfg.home)
    try { return JSON.parse(r.stdout) as AgentEntry[] } catch { return [] }
  }

  async function start(c: Conversation): Promise<void> {
    const settings = settingsPath(c)
    if (c.session_id) {
      // No flags: the session keeps the options it was created with
      // (--settings path included, so regenerated settings apply). Passing
      // flags here would start a copy under a new session id instead.
      log(`resume ${c.key} ${c.session_id}`)
      const r = await run([cfg.claudeBin, '--bg', '--resume', c.session_id], c.folder)
      if (r.code !== 0) log(`resume ${c.key} failed: ${r.stderr || r.stdout}`)
      return
    }
    log(`spawn ${c.key}`)
    const r = await run([cfg.claudeBin, '--bg', '--name', `tg-${c.key}`, ...workerArgs(cfg, c, settings), '--', initPrompt(c)], c.folder)
    const short = parseShortId(r.stdout)
    if (!short) { log(`spawn ${c.key} failed: ${r.stderr || r.stdout}`); return }
    const entry = (await listAgents()).find(a => a.id === short)
    if (entry?.sessionId) {
      db.setSession(c.key, entry.sessionId)
      c.session_id = entry.sessionId
    }
  }

  async function wake(c: Conversation): Promise<void> {
    if (isConnected(c.key)) return
    const agents = await listAgents()
    const live = agents.find(a => (c.session_id && a.sessionId === c.session_id) && a.pid && a.state !== 'stopped' && a.state !== 'done')
    if (live) {
      // Running but plugin not connected: still starting, or wedged.
      if (await waitConnected(c.key, 20_000)) return
      log(`${c.key} running without plugin connection, restarting`)
      await run([cfg.claudeBin, 'stop', live.id], cfg.home)
    }
    await start(c)
    if (!(await waitConnected(c.key, timeout))) log(`${c.key}: plugin did not connect within ${timeout}ms`)
  }

  /** Serialized per conversation: concurrent callers share one wake. */
  function ensureAwake(c: Conversation): Promise<void> {
    const prev = locks.get(c.key)
    if (prev) return prev
    const p = wake(c).catch(e => log(`wake ${c.key} error: ${e}`)).finally(() => locks.delete(c.key))
    locks.set(c.key, p)
    return p
  }

  return { ensureAwake, listAgents }
}

export const bunRunner: Runner = async (args, cwd) => {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith('TELEGRAM_')) delete env[k]
  const p = Bun.spawn(args, { cwd, env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, stdout, stderr }
}
