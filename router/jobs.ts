// The daemon's jobs of the router's workers (docs/operations.md 「背景 session
// 的 job 與 daemon」). `claude --bg` keeps each session as a job under
// ~/.claude/jobs/<short id>/state.json, with the flags it was started with
// (respawnFlags). A plain `--bg --resume <session>` brings the job back with
// those saved flags, so a changed model, channel or settings path would not
// apply: when the saved flags differ from what the router would give now, the
// job is removed (claude rm) and the session resumed with the new flags.
// Jobs of the router's own conversations that are not the conversation's
// current session (copies, older sessions) are cleaned up; nothing else is
// touched. Also looks at the daemon processes (read-only): who started the
// daemon (its environment is the workers' environment, #98872) and warm
// spare processes left without a daemon.

import { readFileSync, readdirSync, readlinkSync, statSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import type { Conversation } from './db'
import type { AgentEntry } from './supervisor'

/** Claude Code's jobs folder: <CLAUDE_CONFIG_DIR or ~/.claude>/jobs. */
export function jobsDir(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  return join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'jobs')
}

export interface JobState { id: string; name?: string; sessionId?: string; cwd?: string; state?: string; respawnFlags?: string[] }

export function readJob(dir: string, id: string): JobState | null {
  if (!/^[\w-]+$/.test(id)) return null
  try {
    const j = JSON.parse(readFileSync(join(dir, id, 'state.json'), 'utf8'))
    return {
      id,
      ...(typeof j.name === 'string' ? { name: j.name } : {}),
      ...(typeof j.sessionId === 'string' ? { sessionId: j.sessionId } : {}),
      ...(typeof j.cwd === 'string' ? { cwd: j.cwd } : {}),
      ...(typeof j.state === 'string' ? { state: j.state } : {}),
      ...(Array.isArray(j.respawnFlags) && j.respawnFlags.every((x: unknown) => typeof x === 'string') ? { respawnFlags: j.respawnFlags } : {}),
    }
  } catch { return null }
}

export function listJobs(dir: string): JobState[] {
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return [] }
  return names.map(n => readJob(dir, n)).filter((j): j is JobState => !!j)
}

/** Flags as flag -> value ("" for a switch). The daemon keeps them in its own
 *  order (respawnFlags put --model last), so the order does not count. */
export function flagMap(f: string[]): Map<string, string> {
  const m = new Map<string, string>()
  for (let i = 0; i < f.length; i++) {
    const k = f[i]!
    if (!k.startsWith('-')) continue
    const next = f[i + 1]
    if (next !== undefined && !next.startsWith('-')) { m.set(k, next); i++ } else m.set(k, '')
  }
  return m
}

export function sameFlags(a: string[], b: string[]): boolean {
  const x = flagMap(a), y = flagMap(b)
  return x.size === y.size && [...x].every(([k, v]) => y.get(k) === v)
}

/** "--model a → b" for each flag whose value changed; flags only on one side as "+ --x v" / "- --x v". */
export function flagDiff(saved: string[], wanted: string[]): string {
  const a = flagMap(saved), b = flagMap(wanted)
  const out: string[] = []
  for (const [k, v] of b) if (!a.has(k)) out.push(`+ ${k}${v ? ` ${v}` : ''}`); else if (a.get(k) !== v) out.push(`${k} ${a.get(k)} → ${v}`)
  for (const [k, v] of a) if (!b.has(k)) out.push(`- ${k}${v ? ` ${v}` : ''}`)
  return out.join(', ') || 'same'
}

/** The flags the conversation's job was last started with, as the router recorded them. */
export function recordedFlags(c: Pick<Conversation, 'worker_flags'>): string[] | null {
  if (!c.worker_flags) return null
  try {
    const v = JSON.parse(c.worker_flags)
    return Array.isArray(v) && v.every(x => typeof x === 'string') ? v : null
  } catch { return null }
}

export interface Stray { id: string; key: string; sessionId: string | null; running: boolean }

const inside = (p: string | undefined, dir: string) => !!p && resolve(p) === resolve(dir)

/** Jobs of the router's own conversations (name tg-<key> and the conversation's
 *  folder as cwd) that are not the conversation's current session. A
 *  conversation without a session (its first wake may be under way) is left alone. */
export function strayJobs(o: { agents: AgentEntry[]; jobs: JobState[]; convs: Conversation[] }): Stray[] {
  const byName = new Map(o.convs.map(c => [`tg-${c.key}`, c]))
  const seen = new Map<string, { name?: string; cwd?: string; sessionId?: string; running: boolean }>()
  for (const j of o.jobs) seen.set(j.id, { name: j.name, cwd: j.cwd, sessionId: j.sessionId, running: false })
  for (const a of o.agents) {
    const prev = seen.get(a.id)
    seen.set(a.id, { name: a.name ?? prev?.name, cwd: a.cwd ?? prev?.cwd, sessionId: a.sessionId ?? prev?.sessionId, running: a.pid != null && a.status != null })
  }
  const out: Stray[] = []
  for (const [id, j] of seen) {
    const c = j.name ? byName.get(j.name) : undefined
    if (!c || !c.session_id || !inside(j.cwd, c.folder)) continue
    if (j.sessionId === c.session_id) continue
    out.push({ id, key: c.key, sessionId: j.sessionId ?? null, running: j.running })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

// --- the daemon processes (read-only) ----------------------------------------

export interface Proc { pid: number; ppid: number; args: string[]; exe?: string }

/** This user's processes from /proc: pid, parent, command line (never the environment). */
export function readProcs(procRoot = '/proc', uid = process.getuid?.() ?? -1): Proc[] {
  const out: Proc[] = []
  let names: string[] = []
  try { names = readdirSync(procRoot) } catch { return out }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue
    try {
      const dir = join(procRoot, n)
      if (uid >= 0 && statSync(dir).uid !== uid) continue
      const args = readFileSync(join(dir, 'cmdline'), 'utf8').split('\0').filter(Boolean)
      const stat = readFileSync(join(dir, 'stat'), 'utf8')
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      let exe: string | undefined
      try { exe = readlinkSync(join(dir, 'exe')) } catch {}
      out.push({ pid: Number(n), ppid, args, ...(exe ? { exe } : {}) })
    } catch {}
  }
  return out
}

export interface DaemonInfo { pid: number; spawnedBy: { label?: string; cwd?: string; pid?: number } | null; ours: boolean }
export interface DaemonReport { daemons: DaemonInfo[]; spares: number[]; orphanSpares: number[] }

const isDaemon = (p: Proc) => p.args[1] === 'daemon' && p.args[2] === 'run'

/** The supervisors (claude daemon run) with who started them, and the warm
 *  spare hosts (bg-pty-host on a .../spare/ socket): an orphan's parent is no
 *  running supervisor, so nothing will claim or reap it. ours: started from
 *  the router's home or stateDir. claudeDir: only processes of the claude
 *  install the router runs (its executable in that folder, e.g. .../claude/versions). */
export function daemonReport(procs: Proc[], ourDirs: string[], claudeDir?: string): DaemonReport {
  procs = claudeDir ? procs.filter(p => !!p.exe && dirname(p.exe) === claudeDir) : procs
  const daemons: DaemonInfo[] = procs.filter(isDaemon).map(p => {
    const i = p.args.indexOf('--spawned-by')
    let spawnedBy: DaemonInfo['spawnedBy'] = null
    try { if (i >= 0) spawnedBy = JSON.parse(p.args[i + 1] ?? '') } catch {}
    const cwd = spawnedBy?.cwd ? resolve(spawnedBy.cwd) : null
    const ours = !!cwd && ourDirs.some(d => cwd === resolve(d) || cwd.startsWith(resolve(d) + '/'))
    return { pid: p.pid, spawnedBy, ours }
  })
  const daemonPids = new Set(daemons.map(d => d.pid))
  const spares = procs.filter(p => p.args.includes('--bg-pty-host') && p.args.some(a => /\/spare\/[^/]+\.pty\.sock$/.test(a)))
  return {
    daemons,
    spares: spares.map(p => p.pid).sort((a, b) => a - b),
    orphanSpares: spares.filter(p => !daemonPids.has(p.ppid)).map(p => p.pid).sort((a, b) => a - b),
  }
}

/** The owner's notices for a report: a daemon started elsewhere, spares without a daemon. */
export function reportNotices(r: DaemonReport): string[] {
  const out: string[] = []
  for (const d of r.daemons.filter(x => !x.ours)) {
    out.push([
      `⚠️ claude daemon (pid ${d.pid}) 不是由 router 帶起的${d.spawnedBy?.cwd ? `, 而是 ${d.spawnedBy.cwd} 的 ${d.spawnedBy.label ?? 'session'}` : ''}.`,
      'worker 的環境變數來自 daemon (GitHub #98872): router 叫醒時給的變數會疊上去, 但 daemon 有而 router 沒給的 (例如 router 刻意拿掉的 TELEGRAM_*) 會留在 worker 裡.',
      'router 不會自動重啟 daemon (會影響其他 session). 沒有其他 session 在用時, 可以在終端機執行 claude daemon stop --any --keep-workers, 下一次叫醒 worker 時由 router 帶起新的 daemon.',
    ].join('\n'))
  }
  if (r.orphanSpares.length) {
    out.push([
      `⚠️ 有 ${r.orphanSpares.length} 個 Claude Code 的暖機 spare 程序沒有 daemon 在管 (pid ${r.orphanSpares.join(', ')}), 不會再被使用.`,
      '這是 Claude Code 的行為 (daemon 被強制結束, 或從不同環境帶起的 daemon 用了不同的執行期資料夾); 同一個資料夾的下一個 daemon 啟動時會回收它們. router 不會自動結束它們; 確認後可以手動 kill.',
    ].join('\n'))
  }
  return out
}

