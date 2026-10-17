// How long the worker hook keeps trying while the router restarts
// (docs/permissions.md 「router 連不到時」, 柯姊 2026-10-17). One schedule for
// both ends: the hook (hooks/hook.ts) retries a router it cannot reach, the
// router (router/elevation.ts) waits for a worker's plugin to say hello
// again, neither past the deadline the hook's first try set.

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
export async function untilReached<T>(attempt: (tries: number) => Promise<T | typeof UNREACHABLE>, start: number, window = RETRY_WINDOW_MS, clock: Clock = realClock): Promise<{ value: T | null; tries: number; waitedMs: number }> {
  let tries = 0
  for (const at of checkpoints(window)) {
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

type HookMsg = Extract<PluginToRouter, { t: 'hook' }>

/** Send one hook event (hooks/hook.ts): RETRY_EVENTS keep trying a router
 *  send could not reach, each try carrying the deadline (and from the second
 *  on, which try it is); the rest go once with 5 s for the answer.
 *  The router's decision, null when none came. */
export async function reportEvent<T>(event: string, projectDir: string, ev: Record<string, unknown>, send: (msg: HookMsg, waitMs: number) => Promise<T | null | typeof UNREACHABLE>, window = RETRY_WINDOW_MS, clock: Clock = realClock): Promise<T | null> {
  if (!RETRY_EVENTS.has(event)) {
    const d = await send({ t: 'hook', id: 1, project_dir: projectDir, ev }, 5000)
    return d === UNREACHABLE ? null : d
  }
  window = Math.min(window, RETRY_WINDOW_MS)
  const start = clock.now(), deadline = start + window
  const r = await untilReached(tries => send({
    t: 'hook', id: 1, project_dir: projectDir, ev, deadline,
    ...(tries > 1 ? { retry: { tries, waited_ms: clock.now() - start } } : {}),
  }, answerWait(start, deadline, clock.now(), !!ev.install)), start, window, clock)
  return r.value
}
