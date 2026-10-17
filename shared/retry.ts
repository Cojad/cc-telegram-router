// How long the worker hook keeps trying while the router restarts
// (docs/permissions.md 「router 連不到時」, 柯姊 2026-10-17). One schedule for
// both ends: the hook (hooks/hook.ts) retries a router it cannot reach, the
// router (router/elevation.ts) waits for a worker's plugin to say hello
// again, neither past the deadline the hook's first try set. A router that
// has not answered for over 3 minutes gets one try per request until it
// answers again (the breaker below).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { isAbsolute, join } from 'path'
import type { PluginToRouter } from './protocol'

/** Try at once, then after 3, 5, 7, 15 and 15 seconds more: checkpoints 0, 3, 8, 15, 30, 45 s. */
export const RETRY_GAPS_MS = [3000, 5000, 7000, 15_000, 15_000]
/** The whole wait: first try + this is the deadline sent to the router. */
export const RETRY_WINDOW_MS = 45_000
/** Once connected after the window, still this long for the router's answer. */
export const ANSWER_GRACE_MS = 5000
/** The hook's whole run stays under this (templates/base-settings.json gives it 60 s). */
export const HOOK_LIMIT_MS = 55_000
/** A package review (router/pkgreview.ts) gets this long for its answer. */
export const INSTALL_WAIT_MS = 55_000
/** Hook events retried when the router cannot be reached; the rest go once. */
export const RETRY_EVENTS: ReadonlySet<string> = new Set(['pre', 'subagent-start'])

/** When each try starts, ms after the first; none past window. */
export function checkpoints(window = RETRY_WINDOW_MS): number[] {
  const at = [0]
  for (const g of RETRY_GAPS_MS) at.push(at.at(-1)! + g)
  return at.filter(t => t <= window)
}

export type Clock = { now(): number; sleep(ms: number): Promise<void> }
export const realClock: Clock = { now: () => Date.now(), sleep: ms => new Promise(r => setTimeout(r, ms)) }

/** What a try returns when nothing answered on the other end (no socket, refused, closed before the answer). */
export const UNREACHABLE = Symbol('unreachable')

/** Run attempt at each checkpoint from start until it reaches the router.
 *  value: what it returned, null when no try reached it. */
export async function untilReached<T>(attempt: (tries: number) => Promise<T | typeof UNREACHABLE>, start: number, window = RETRY_WINDOW_MS, clock: Clock = realClock, at_: number[] = checkpoints(window)): Promise<{ value: T | null; tries: number; waitedMs: number }> {
  let tries = 0
  for (const at of at_) {
    const left = start + at - clock.now()
    if (left > 0) await clock.sleep(left)
    tries++
    const v = await attempt(tries)
    if (v !== UNREACHABLE) return { value: v, tries, waitedMs: clock.now() - start }
  }
  return { value: null, tries, waitedMs: clock.now() - start }
}

/** How long one request waits for the router's answer: through the deadline
 *  plus ANSWER_GRACE_MS (a package review INSTALL_WAIT_MS), never past HOOK_LIMIT_MS from start. */
export function answerWait(start: number, deadline: number, now: number, install = false): number {
  const end = Math.min(install ? now + INSTALL_WAIT_MS : deadline + ANSWER_GRACE_MS, start + HOOK_LIMIT_MS)
  return Math.max(end - now, 0)
}

/** The router's own wait ends at the hook's deadline, and never more than RETRY_WINDOW_MS from now. */
export function waitUntil(deadline: number, now: number): number {
  return Math.min(deadline, now + RETRY_WINDOW_MS)
}

// The breaker (柯姊 2026-10-17): the router has not been reached for over
// BREAKER_MS since a try first failed, none reaching it since: each request
// tries once and falls back. Any try that reaches it (any event) ends that.
// The state is shared by every hook process (each run is a new one) in a
// small file per router socket in the user's runtime dir; written
// atomically, and missing or unreadable means normal.

/** Unreached this long (from the first failed try, none reaching it since): one try per request. */
export const BREAKER_MS = 180_000

/** down_since: the first failed try of this outage; last_ok: the last try that reached the router (epoch ms). */
export type ReachState = { down_since: number | null; last_ok: number | null }

/** The state file for the router at socket: $XDG_RUNTIME_DIR (else ~/.cache)/cc-telegram-router/reach-<hash>.json. */
export function reachFile(socket: string, env: Record<string, string | undefined> = process.env): string {
  const base = env.XDG_RUNTIME_DIR && isAbsolute(env.XDG_RUNTIME_DIR) ? env.XDG_RUNTIME_DIR : join(env.HOME || homedir(), '.cache')
  return join(base, 'cc-telegram-router', `reach-${createHash('sha256').update(socket).digest('hex').slice(0, 16)}.json`)
}

const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null

/** The state; missing or broken reads as normal (nothing failed). */
export function readReach(file: string): ReachState {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'))
    return { down_since: num(j?.down_since), last_ok: num(j?.last_ok) }
  } catch { return { down_since: null, last_ok: null } }
}

/** Write the state atomically (a temp file renamed over it); a failure only means the next hook does not know. */
export function writeReach(file: string, st: ReachState): void {
  try {
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(st) + '\n', { mode: 0o600 })
    renameSync(tmp, file)
  } catch {}
}

/** Open: the router has not been reached for over BREAKER_MS (no try reached it after the first failed one). */
export function breakerOpen(st: ReachState, now: number): boolean {
  return st.down_since != null && (st.last_ok == null || st.last_ok <= st.down_since) && now - st.down_since > BREAKER_MS
}

export type Breaker = { open(now: number): boolean; result(reached: boolean, now: number): void }

/** The breaker on a state file. Writes only when the state changes: the first failed
 *  try of an outage, the first try that reaches the router after it. */
export function fileBreaker(file: string): Breaker {
  return {
    open: now => breakerOpen(readReach(file), now),
    result(reached, now) {
      const st = readReach(file)
      if (reached) { if (st.down_since != null) writeReach(file, { down_since: null, last_ok: now }) }
      else if (st.down_since == null || (st.last_ok != null && st.last_ok > st.down_since)) writeReach(file, { down_since: now, last_ok: st.last_ok })
    },
  }
}

type HookMsg = Extract<PluginToRouter, { t: 'hook' }>

/** Send one hook event (hooks/hook.ts): RETRY_EVENTS keep trying a router
 *  send could not reach, each try carrying the deadline (and from the second
 *  on, which try it is), but only once while the breaker is open; the rest go
 *  once with 5 s for the answer. Every try tells the breaker whether it
 *  reached the router. The router's decision, null when none came. */
export async function reportEvent<T>(event: string, projectDir: string, ev: Record<string, unknown>, send: (msg: HookMsg, waitMs: number) => Promise<T | null | typeof UNREACHABLE>, window = RETRY_WINDOW_MS, clock: Clock = realClock, breaker?: Breaker): Promise<T | null> {
  const tried = async (msg: HookMsg, waitMs: number) => {
    const v = await send(msg, waitMs)
    breaker?.result(v !== UNREACHABLE, clock.now())
    return v
  }
  if (!RETRY_EVENTS.has(event)) {
    const d = await tried({ t: 'hook', id: 1, project_dir: projectDir, ev }, 5000)
    return d === UNREACHABLE ? null : d
  }
  window = Math.min(window, RETRY_WINDOW_MS)
  const start = clock.now(), deadline = start + window
  const r = await untilReached(tries => tried({
    t: 'hook', id: 1, project_dir: projectDir, ev, deadline,
    ...(tries > 1 ? { retry: { tries, waited_ms: clock.now() - start } } : {}),
  }, answerWait(start, deadline, clock.now(), !!ev.install)), start, window, clock, breaker?.open(start) ? [0] : checkpoints(window))
  return r.value
}
