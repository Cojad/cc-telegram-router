// A bot's own info (getMe) for /router bot list and status (柯姊 2026-10-16).
// bot add and rotate store getMe right away; otherwise it comes from the
// poller's start. Until it is in, list and status show 讀取中, and the router
// calls getMe itself 30 seconds later, then every 30 seconds until it works.

export const INFO_RETRY_MS = 30_000

export type BotInfo = { id: number; username: string; first_name: string }

export async function awaitBotInfo<T extends BotInfo>(o: {
  /** The info is in (from the poller, bot add or rotate). */
  ready(): boolean
  /** The bot is still this one (not removed or rotated since). */
  current(): boolean
  getMe(): Promise<T>
  set(me: T): void
  log(msg: string): void
  sleep?(ms: number): Promise<void>
  intervalMs?: number
}): Promise<void> {
  const sleep = o.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)))
  const every = o.intervalMs ?? INFO_RETRY_MS
  for (let n = 1; ; n++) {
    await sleep(every)
    if (o.ready() || !o.current()) return
    try {
      o.set(await o.getMe())
      return
    } catch (e) {
      o.log(`getMe failed (${n}): ${e}; retry in ${every / 1000}s`)
    }
  }
}
