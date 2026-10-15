// Rotation (柯姊 2026-10-16): /router session rotate marks workers that
// should pick up new plugin code or settings. Every minute, and right after
// marking, each marked worker that is idle is stopped; the next message
// wakes it with the new code. Busy workers are left alone until idle.

import type { Conversation, RouterDb } from './db'
import type { AgentEntry } from './supervisor'

export interface RotateDeps {
  db: Pick<RouterDb, 'rotatePending' | 'setRotate' | 'undelivered'>
  liveJob(c: Conversation): Promise<AgentEntry | undefined>
  stop(c: Conversation): Promise<void>
  ensureAwake(c: Conversation): Promise<void>
  log?: (msg: string) => void
}

export async function rotateTick(deps: RotateDeps): Promise<{ stopped: string[]; waiting: string[] }> {
  const stopped: string[] = [], waiting: string[] = []
  for (const c of deps.db.rotatePending()) {
    const job = await deps.liveJob(c)
    if (job && job.status !== 'idle') { waiting.push(c.key); continue }
    if (job) {
      deps.log?.(`rotate ${c.key}: idle, stopping`)
      await deps.stop(c)
      stopped.push(c.key)
    }
    deps.db.setRotate(c.key, false)
    // A message that arrived while it was stopping must not wait for the sweep.
    if (deps.db.undelivered(c.key).length) void deps.ensureAwake(c)
  }
  return { stopped, waiting }
}
