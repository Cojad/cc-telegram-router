// Long polling with the router's own retry policy (柯姊 2026-10-17), in
// place of grammY's bot.start (which retries every 3 seconds without a word
// and gives up for good when getMe fails at start):
//   network errors, Telegram 5xx (and other unexpected errors): retry after
//     5s, 10s, 30s, 1m, 2m, 5m, then every 5 minutes for as long as it takes;
//     a 429 waits its retry_after. Down for more than 2 minutes: the owner is
//     told once; when it works again, told once more.
//   409 conflict (another program polls with this token): retry every 60
//     seconds, the owner told at once (and again when it is over).
//   401 (the token no longer works): no more retries, the owner told at once
//     to use /router bot rotate.
// The same goes for the start (getMe, deleteWebhook) and for polling later
// on. Where the notices go is the caller's (main.ts: through another bot that
// still works, else only the log).

import { iso8 } from '../shared/time'

export const BACKOFF_S = [5, 10, 30, 60, 120, 300]
export const DOWN_NOTICE_MS = 120_000
export const CONFLICT_RETRY_MS = 60_000

export type PollState =
  | { kind: 'starting' }
  | { kind: 'ok'; since: number }
  | { kind: 'retrying'; since: number; reason: string; conflict?: boolean }
  | { kind: 'unauthorized'; since: number; reason: string }
  | { kind: 'stopped' }

export type PollEvent =
  | { kind: 'down'; since: number; reason: string }
  | { kind: 'conflict'; since: number }
  | { kind: 'unauthorized'; reason: string }
  | { kind: 'recovered'; since: number; at: number }

type Kind = 'network' | 'server' | 'rate' | 'conflict' | 'unauthorized' | 'other'

/** What an error from the Bot API means for retrying. */
export function classify(e: unknown): { kind: Kind; reason: string; retryAfterS?: number } {
  const err = e as { error_code?: number; description?: string; parameters?: { retry_after?: number }; message?: string; name?: string }
  const code = typeof err?.error_code === 'number' ? err.error_code : null
  if (code === 401) return { kind: 'unauthorized', reason: `401 ${err.description ?? 'Unauthorized'}` }
  if (code === 409) return { kind: 'conflict', reason: '409 衝突: 另一個程式在用這個 token 收訊息' }
  if (code === 429) return { kind: 'rate', reason: '429 請求太頻繁', retryAfterS: err.parameters?.retry_after }
  if (code != null && code >= 500) return { kind: 'server', reason: `Telegram ${code} ${err.description ?? ''}`.trim() }
  if (code != null) return { kind: 'other', reason: `${code} ${err.description ?? ''}`.trim() }
  return { kind: 'network', reason: `連不上 Telegram (${String(err?.message ?? e).slice(0, 120)})` }
}

export interface PollerDeps<Me, U extends { update_id: number }> {
  getMe(signal: AbortSignal): Promise<Me>
  deleteWebhook(signal: AbortSignal): Promise<unknown>
  /** first: the first call of this poller (sends allowed_updates). */
  getUpdates(offset: number, first: boolean, signal: AbortSignal): Promise<U[]>
  onInfo(me: Me): void
  handle(update: U): Promise<void>
  notify(e: PollEvent): void
  log(msg: string): void
  now?(): number
  /** Resolves after ms, or early when the signal aborts. */
  sleep?(ms: number, signal: AbortSignal): Promise<void>
}

const realSleep = (ms: number, signal: AbortSignal) => new Promise<void>(r => {
  const t = setTimeout(r, ms)
  signal.addEventListener('abort', () => { clearTimeout(t); r() }, { once: true })
})

export function createPoller<Me, U extends { update_id: number }>(deps: PollerDeps<Me, U>) {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? realSleep
  const ac = new AbortController()
  let running = true
  let state: PollState = { kind: 'starting' }
  let offset = 0
  let failing: { since: number; attempt: number; told: boolean } | null = null
  const createdAt = now()
  let lastOk: number | null = null

  const ok = () => {
    if (!running) return
    lastOk = now()
    if (failing?.told) deps.notify({ kind: 'recovered', since: failing.since, at: now() })
    if (failing) deps.log(`working again (down since ${iso8(failing.since, ' ')})`)
    failing = null
    if (state.kind !== 'ok') state = { kind: 'ok', since: now() }
  }

  /** One failed call: false when there is nothing more to try (401, stopped). */
  async function failed(e: unknown, what: string): Promise<boolean> {
    if (!running) return false
    const c = classify(e)
    const t = now()
    failing ??= { since: t, attempt: 0, told: false }
    failing.attempt++
    if (c.kind === 'unauthorized') {
      state = { kind: 'unauthorized', since: t, reason: c.reason }
      deps.log(`${what}: ${c.reason}; the token no longer works, polling stopped`)
      deps.notify({ kind: 'unauthorized', reason: c.reason })
      running = false
      return false
    }
    state = { kind: 'retrying', since: failing.since, reason: c.reason, ...(c.kind === 'conflict' ? { conflict: true } : {}) }
    let wait: number
    if (c.kind === 'conflict') {
      wait = CONFLICT_RETRY_MS
      if (!failing.told) { failing.told = true; deps.notify({ kind: 'conflict', since: failing.since }) }
    } else if (c.kind === 'rate' && c.retryAfterS != null) wait = c.retryAfterS * 1000
    else wait = BACKOFF_S[Math.min(failing.attempt - 1, BACKOFF_S.length - 1)]! * 1000
    deps.log(`${what} failed (${c.reason}), retry in ${wait / 1000}s`)
    // down for 2 minutes: tell the owner then, even in the middle of a wait
    const tellAt = failing.since + DOWN_NOTICE_MS
    if (!failing.told && t + wait > tellAt) {
      if (tellAt > t) await sleep(tellAt - t, ac.signal)
      if (!running) return false
      failing.told = true
      deps.notify({ kind: 'down', since: failing.since, reason: c.reason })
      const left = t + wait - now()
      if (left > 0) await sleep(left, ac.signal)
    } else await sleep(wait, ac.signal)
    return running
  }

  /** Retry one call by the policy until it works; null when given up. */
  async function call<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
    while (running) {
      try { const r = await fn(); return r } catch (e) { if (!(await failed(e, what))) return null }
    }
    return null
  }

  async function start(): Promise<void> {
    const me = await call('getMe', () => deps.getMe(ac.signal))
    if (me == null) return
    deps.onInfo(me)
    if ((await call('deleteWebhook', () => deps.deleteWebhook(ac.signal))) === null && !running) return
    ok()
    let first = true
    while (running) {
      const updates = await call('getUpdates', () => deps.getUpdates(offset, first, ac.signal))
      if (updates == null) break
      first = false
      ok()
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1)
        try { await deps.handle(u) } catch (e) { deps.log(`handler error: ${e}`) }
      }
    }
  }

  return {
    start,
    state: () => state,
    offset: () => offset,
    /** When a Bot API call last worked (deleteWebhook at start, then every getUpdates), null before; for the health endpoint (router/health.ts). */
    lastOk: () => lastOk,
    /** When this poller was made: a bot that never worked counts from here. */
    createdAt: () => createdAt,
    /** Stop polling; resolves with the next offset to confirm (getUpdates offset, limit 1). */
    stop(): number {
      running = false
      if (state.kind !== 'unauthorized') state = { kind: 'stopped' }
      ac.abort()
      return offset
    },
  }
}
