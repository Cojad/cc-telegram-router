// One router per config file (plan 00). The lock is a pid file next to the
// config; a stale one (dead pid, or a pid recycled by an unrelated process)
// is taken over.

import { openSync, writeSync, closeSync, readFileSync, rmSync } from 'fs'
import { basename } from 'path'

/** The executable's names: cctr since 2.33.0, cc-telegram-router before (also the
 *  link deploy/install.sh leaves under the old name, whose argv[0] keeps that name). */
export const ROUTER_EXE_NAMES = ['cctr', 'cc-telegram-router']

/** Whether a command line (as /proc/<pid>/cmdline, NUL-separated) is a router: argv[0]'s
 *  basename is one of the executable's names (the compiled router), or bun with an
 *  argument ending in router/main.ts (from source). Only argv[0] and that argument
 *  count: bwrap, the claude daemon and the workers have the state dir (.router) in
 *  their arguments, a lock whose pid one of them took again is stale. */
export function isRouterCmdline(cmdline: string): boolean {
  const argv = cmdline.split('\0')
  const exe = basename(argv[0] ?? '')
  if (ROUTER_EXE_NAMES.includes(exe)) return true
  return exe === 'bun' && argv.slice(1).some(a => a.endsWith('router/main.ts'))
}

function alive(pid: number, isHolder: (cmdline: string) => boolean): boolean {
  try { process.kill(pid, 0) } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
  try {
    return isHolder(readFileSync(`/proc/${pid}/cmdline`, 'utf8'))
  } catch { return true }
}

/** Returns a release function, or throws if another live instance holds it.
 *  isHolder tells a live holder's command line from a recycled pid's (default: a router). */
export function acquireLock(lockPath: string, isHolder: (cmdline: string) => boolean = isRouterCmdline): () => void {
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
      if (holder > 1 && holder !== process.pid && alive(holder, isHolder)) {
        throw new Error(`another router (pid ${holder}) already holds ${lockPath}`)
      }
      rmSync(lockPath, { force: true })
    }
  }
  throw new Error(`could not acquire ${lockPath}`)
}
