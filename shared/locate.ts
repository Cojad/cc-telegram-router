// Where the plugin and the worker hook find the router. The router may be
// installed anywhere, so nothing here assumes a fixed path: `cc-telegram-router
// register` (run by deploy/install.sh router) writes a small locator file in
// the user's home, ~/.config/cc-telegram-router/router.json, holding the
// router's home, state dir and socket. It holds no secrets.
//
// Not an environment variable: background sessions inherit the claude
// daemon's environment, not the router's, and the owner's own terminal
// session (cwd = the router's home) has no router-written settings at all.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, isAbsolute, join } from 'path'

export type Locator = { home: string; stateDir: string; socket: string }

export function locatorPath(userHome: string = homedir()): string {
  return join(userHome, '.config', 'cc-telegram-router', 'router.json')
}

/** The locator, or null when it is missing or not three absolute paths. */
export function readLocator(path: string = locatorPath()): Locator | null {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'))
    const ok = (v: unknown): v is string => typeof v === 'string' && isAbsolute(v)
    return ok(j.home) && ok(j.stateDir) && ok(j.socket) ? { home: j.home, stateDir: j.stateDir, socket: j.socket } : null
  } catch { return null }
}

export function writeLocator(loc: Locator, path: string = locatorPath()): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path + '.tmp', JSON.stringify(loc, null, 2) + '\n', { mode: 0o644 })
  renameSync(path + '.tmp', path)
}

/** At router start: keep the locator in step when this router is the one it
 *  names (same state dir) but home or socket changed in config.json. A
 *  router with another state dir (tests, a second install) never touches it. */
export function syncLocator(cfg: Locator, path: string = locatorPath()): 'ok' | 'updated' | 'missing' | 'other' {
  const loc = readLocator(path)
  if (!loc) return 'missing'
  if (loc.stateDir !== cfg.stateDir) return 'other'
  if (loc.home === cfg.home && loc.socket === cfg.socket) return 'ok'
  writeLocator({ home: cfg.home, stateDir: cfg.stateDir, socket: cfg.socket }, path)
  return 'updated'
}

/** The socket and home a plugin or hook should use. CC_TELEGRAM_ROUTER_SOCKET
 *  (with CC_TELEGRAM_ROUTER_HOME, else two levels above the socket) is for
 *  tests only; production reads the locator. */
export function findRouter(env: Record<string, string | undefined> = process.env, path?: string): { socket: string; home: string } | { error: string } {
  if (env.CC_TELEGRAM_ROUTER_SOCKET) {
    const socket = env.CC_TELEGRAM_ROUTER_SOCKET
    return { socket, home: env.CC_TELEGRAM_ROUTER_HOME ?? dirname(dirname(socket)) }
  }
  const file = path ?? locatorPath(env.HOME || homedir())
  const loc = readLocator(file)
  if (loc) return { socket: loc.socket, home: loc.home }
  return { error: existsSync(file) ? `${file} 格式不對` : `找不到 ${file} (deploy/install.sh router 或 cc-telegram-router register 會寫入)` }
}
