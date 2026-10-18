// Resource limits of a privileged action's sandbox (docs/skill-runtime.md 「資源上限」,
// 柯姊 2026-10-18): time, memory, processes (tasks: threads count too), the size
// of any one file written, the output (stdout and stderr) the router takes in.
// Every action has the defaults; privileged.json "limits" (and "timeout") may
// raise them up to the hard maximums, which only owner may approve.
//   - memory and tasks: a transient systemd scope (`systemd-run --user --scope`,
//     MemoryMax with no swap, TasksMax) around bwrap; /tmp is a tmpfs, so what
//     the script keeps there counts as memory too
//   - file size: RLIMIT_FSIZE (prlimit --fsize), the core size 0
//   - output: counted by the router as it reads; past the limit the run is killed
//   - time: the router kills the run at its timeout (already so)
// On a host without cgroup delegation for the user (no systemd user manager, or
// no memory and pids controllers in user@<uid>.service) the router degrades
// instead of refusing: prlimit --data (an approximation of memory; --as would
// break V8 and others that reserve address space) and --cpu; no limit on the
// number of processes (RLIMIT_NPROC counts every process of the user, the
// router's and workers' too); /tmp unbounded. The router logs that once and
// /router status says it.

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

export type LimitKey = 'timeout' | 'memory_mb' | 'tasks' | 'file_mb' | 'output_kb'
export type Limits = Record<LimitKey, number>
export const DEFAULT_LIMITS: Limits = { timeout: 600, memory_mb: 1024, tasks: 256, file_mb: 512, output_kb: 2048 }
export const MAX_LIMITS: Limits = { timeout: 3600, memory_mb: 8192, tasks: 1024, file_mb: 8192, output_kb: 16384 }
export const LIMIT_KEYS = ['memory_mb', 'tasks', 'file_mb', 'output_kb'] as const
const LABEL: Record<LimitKey, string> = { timeout: '時間 (秒)', memory_mb: '記憶體 (MB)', tasks: '程序與執行緒數', file_mb: '單檔大小 (MB)', output_kb: '輸出 (KB)' }

/** An action's limits: the defaults, raised where it says so (privileged.json timeout and limits). */
export function limitsOf(a: { timeout?: number; limits?: Partial<Record<string, number>> }): Limits {
  const l = { ...DEFAULT_LIMITS }
  if (typeof a.timeout === 'number') l.timeout = a.timeout
  for (const k of LIMIT_KEYS) if (typeof a.limits?.[k] === 'number') l[k] = a.limits[k]!
  return l
}

/** What loadManifest refuses in an action's limits and timeout. */
export function limitsError(n: string, a: { timeout?: unknown; limits?: unknown }): string | null {
  // a timeout that is not a positive number: skill_check says so (router/skillcheck.ts); past the maximum: refused here
  if (typeof a.timeout === 'number' && a.timeout > MAX_LIMITS.timeout) return `動作 ${n} 的 timeout 最多 ${MAX_LIMITS.timeout} 秒`
  if (a.limits === undefined) return null
  if (!a.limits || typeof a.limits !== 'object' || Array.isArray(a.limits)) return `動作 ${n} 的 limits 要是物件, 例如 { "memory_mb": 2048 }`
  for (const [k, v] of Object.entries(a.limits)) {
    if (!(LIMIT_KEYS as readonly string[]).includes(k)) return `動作 ${n} 的 limits 不認得 ${k} (有: ${LIMIT_KEYS.join(', ')}; 時間寫在 timeout)`
    const max = MAX_LIMITS[k as LimitKey]
    if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > max) return `動作 ${n} 的 limits.${k} 要是 1 到 ${max} 的整數`
  }
  return null
}

/** The limits an action raises above the defaults (owner approval), as the approval shows them. */
export function raisedLimits(a: { timeout?: number; limits?: Partial<Record<string, number>> }): string[] {
  const l = limitsOf(a)
  return (Object.keys(DEFAULT_LIMITS) as LimitKey[]).filter(k => l[k] > DEFAULT_LIMITS[k]).map(k => `${LABEL[k]} ${l[k]} (預設 ${DEFAULT_LIMITS[k]})`)
}

export type LimitMode = { kind: 'cgroup'; systemdRun: string; prlimit: string; env?: string; runtimeDir?: string } | { kind: 'rlimit'; prlimit: string; why: string } | { kind: 'none'; why: string }

const DIRS = ['/usr/bin', '/bin', '/usr/local/bin', ...(process.env.PATH ?? '').split(':')]
const which = (t: string) => DIRS.map(d => d && join(d, t)).find(p => p && existsSync(p)) ?? null

let probed: LimitMode | undefined
/** How this host limits a run, probed once: a systemd user scope when it works and the memory and pids
 *  controllers are delegated; else prlimit alone; else nothing but the router's time and output limits. */
export function limitMode(o: { refresh?: boolean; probe?: () => boolean } = {}): LimitMode {
  if (probed && !o.refresh) return probed
  const prlimit = which('prlimit')
  const systemdRun = which('systemd-run')
  const scopeWorks = () => Bun.spawnSync([systemdRun!, '--user', '--scope', '--quiet', '--collect', '-p', 'MemoryMax=64M', '-p', 'MemorySwapMax=0', '-p', 'TasksMax=16', '--', 'true'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0
  if (!prlimit) probed = { kind: 'none', why: '沒有 prlimit (util-linux)' }
  else if (systemdRun && (o.probe ?? (() => delegatedNow() && scopeWorks()))()) probed = { kind: 'cgroup', systemdRun, prlimit, env: which('env') ?? '/usr/bin/env', runtimeDir: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}` }
  else probed = { kind: 'rlimit', prlimit, why: systemdRun ? '這個使用者沒有 cgroup 委派 (systemd --user 的 scope 開不起來, 或 user@.service 沒有 memory 與 pids)' : '沒有 systemd-run' }
  return probed
}

/** limitMode without blocking: the router's start probes this way (the scope's probe runs as a child,
 *  never holding up the event loop), then every run reads the cached answer. */
export async function primeLimitMode(): Promise<LimitMode> {
  if (probed) return probed
  const systemdRun = which('systemd-run')
  if (!systemdRun || !which('prlimit')) return limitMode()
  const p = Bun.spawn([systemdRun, '--user', '--scope', '--quiet', '--collect', '-p', 'MemoryMax=64M', '-p', 'MemorySwapMax=0', '-p', 'TasksMax=16', '--', 'true'], { stdout: 'ignore', stderr: 'ignore' })
  const ok = (await p.exited) === 0
  return probed ?? limitMode({ refresh: true, probe: () => ok && delegatedNow() })
}
const delegatedNow = () => {
  const uid = process.getuid?.() ?? 0
  try {
    const c = readFileSync(`/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`, 'utf8').split(/\s+/)
    return c.includes('memory') && c.includes('pids')
  } catch { return false }
}

/** The words put before bwrap to hold a run to l. */
export function limitPrefix(mode: LimitMode, l: Limits): string[] {
  const mb = (n: number) => n * 1024 * 1024
  if (mode.kind === 'none') return []
  const rl = [mode.prlimit, `--fsize=${mb(l.file_mb)}`, '--core=0']
  if (mode.kind === 'rlimit') return [...rl, `--data=${mb(l.memory_mb)}`, `--cpu=${l.timeout}`, '--']
  // systemd-run finds the user manager through XDG_RUNTIME_DIR; the sandbox never gets it (env -u after the scope)
  const env = mode.env ?? '/usr/bin/env'
  return [env, `XDG_RUNTIME_DIR=${mode.runtimeDir ?? `/run/user/${process.getuid?.() ?? 0}`}`, mode.systemdRun, '--user', '--scope', '--quiet', '--collect', '-p', `MemoryMax=${l.memory_mb}M`, '-p', 'MemorySwapMax=0', '-p', `TasksMax=${l.tasks}`, '--', env, '-u', 'XDG_RUNTIME_DIR', ...rl, '--']
}

/** One line for /router status and the router log. */
export function describeLimitMode(m: LimitMode): string {
  if (m.kind === 'cgroup') return '資源上限: cgroup (systemd-run --user --scope: 記憶體, 程序數) + prlimit (單檔大小)'
  if (m.kind === 'rlimit') return `資源上限: 降級為 prlimit (記憶體只是近似值, 沒有程序數上限, /tmp 不受限): ${m.why}`
  return `資源上限: 只有時間與輸出 (${m.why})`
}

/** Why a run ended, from its exit code and what the router saw (the limits it was held to). */
export function endNote(code: number, l: Limits, seen: { timedOut?: boolean; outputOver?: boolean }, mode: LimitMode): string | null {
  if (seen.timedOut) return `超過時間上限 ${l.timeout} 秒, 被終止`
  if (seen.outputOver) return `輸出超過上限 ${l.output_kb} KB, 被終止`
  if (code === 153) return `寫入的單檔超過上限 ${l.file_mb} MB (SIGXFSZ)`
  if (code === 137 && mode.kind !== 'none') return `被 SIGKILL 結束, 可能超過記憶體上限 ${l.memory_mb} MB`
  if (code === 152 && mode.kind === 'rlimit') return `超過 CPU 時間上限 ${l.timeout} 秒 (SIGXCPU)`
  return null
}
