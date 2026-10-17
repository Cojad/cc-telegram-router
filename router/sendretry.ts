// Command replies are retried (柯姊 2026-10-17): a network error, a
// Telegram 5xx or a 429 (after its retry_after) is tried again, at most 3
// more times within a minute of the first try; any other 4xx is not. The
// last failure is logged by the caller's what.

import { classify } from './poller'

export const SEND_RETRY_S = [2, 5, 15]
export const SEND_RETRY_WINDOW_MS = 60_000

export async function sendWithRetry<T>(send: () => Promise<T>, o: { what: string; log(msg: string): void; now?: () => number; sleep?: (ms: number) => Promise<void> }): Promise<T> {
  const now = o.now ?? Date.now
  const sleep = o.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)))
  const deadline = now() + SEND_RETRY_WINDOW_MS
  for (let tries = 1; ; tries++) {
    try {
      return await send()
    } catch (e) {
      const c = classify(e)
      const retryable = c.kind === 'network' || c.kind === 'server' || c.kind === 'rate'
      const wait = c.kind === 'rate' && c.retryAfterS != null ? c.retryAfterS * 1000 : (SEND_RETRY_S[tries - 1] ?? 0) * 1000
      if (!retryable || tries > SEND_RETRY_S.length || now() + wait > deadline) {
        o.log(`${o.what} failed${tries > 1 ? ` after ${tries} tries` : ''}: ${c.reason}`)
        throw e
      }
      await sleep(wait)
    }
  }
}

/** Telegram refused a parse_mode HTML message ("can't parse entities": an escape was missed). */
export function isHtmlRefused(e: unknown): boolean {
  const err = e as { error_code?: number; description?: string; message?: string }
  return err?.error_code === 400 && /can't parse entities/i.test(String(err.description ?? err.message ?? ''))
}

/** Send as HTML; if Telegram refuses the HTML, send it once more as plain
 *  text (tags dropped) and log why: the message still arrives (柯姊 2026-10-17). */
export async function htmlOrPlain<T>(html: () => Promise<T>, plain: () => Promise<T>, o: { what: string; log(msg: string): void }): Promise<T> {
  try {
    return await html()
  } catch (e) {
    if (!isHtmlRefused(e)) throw e
    o.log(`${o.what}: Telegram refused the HTML (${(e as { description?: string }).description ?? e}), sent as plain text`)
    return plain()
  }
}
