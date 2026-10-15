// One router per config file (plan 00). The lock is a pid file next to the
// config; a stale one (dead pid, or a pid recycled by an unrelated process)
// is taken over.

import { openSync, writeSync, closeSync, readFileSync, rmSync } from 'fs'

function alive(pid: number, marker: string): boolean {
  try { process.kill(pid, 0) } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(marker)
  } catch { return true }
}

/** Returns a release function, or throws if another live instance holds it. */
export function acquireLock(lockPath: string, marker = 'cc-telegram-router'): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600)
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return () => {
        try {
          if (readFileSync(lockPath, 'utf8').trim() === String(process.pid)) rmSync(lockPath)
        } catch {}
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const holder = parseInt(readFileSync(lockPath, 'utf8'), 10)
      if (holder > 1 && holder !== process.pid && alive(holder, marker)) {
        throw new Error(`another router (pid ${holder}) already holds ${lockPath}`)
      }
      rmSync(lockPath, { force: true })
    }
  }
  throw new Error(`could not acquire ${lockPath}`)
}
