// config.json loading (plan 03 「專案位置與部署」). Default location: next to
// the router executable; --config <path> overrides. Holds bot tokens, so the
// file is expected to be mode 600 under /x/cc/.router/.

import { readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'

export type BotConfig = { name: string; token: string }

export type Config = {
  /** Where this config file lives; relative paths below resolve against it. */
  path: string
  bots: BotConfig[]
  /** Root holding one folder per conversation, e.g. /x/cc. */
  home: string
  /** Router-private state: db, socket, settings, access.json. */
  stateDir: string
  socket: string
  /** Telegram UIDs with the owner role. */
  owners: string[]
  /** Worker model, passed as --model. */
  model: string
  /** Default autoCompactWindow for new conversations. */
  autoCompactWindow: number
  /** claude CLI to spawn workers with. */
  claudeBin: string
  /** Bot API base URL; only tests point this elsewhere. */
  apiRoot?: string
}

export function defaultConfigPath(argv: string[], execPath: string): string {
  const i = argv.indexOf('--config')
  if (i >= 0 && argv[i + 1]) return resolve(argv[i + 1])
  return join(dirname(execPath), 'config.json')
}

export function loadConfig(path: string): Config {
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  const base = dirname(path)
  const abs = (p: string | undefined, fallback: string) => resolve(base, p ?? fallback)
  if (!Array.isArray(raw.bots) || raw.bots.length === 0) throw new Error(`${path}: bots[] is empty`)
  for (const b of raw.bots) {
    if (!b.name || !b.token) throw new Error(`${path}: every bot needs name and token`)
  }
  const stateDir = abs(raw.stateDir, '.')
  return {
    path,
    bots: raw.bots,
    home: abs(raw.home, '..'),
    stateDir,
    socket: abs(raw.socket, join(stateDir, 'router.sock')),
    owners: (raw.owners ?? []).map(String),
    model: raw.model ?? 'claude-opus-5-5',
    autoCompactWindow: raw.autoCompactWindow ?? 750000,
    claudeBin: raw.claudeBin ?? 'claude',
    apiRoot: raw.apiRoot,
  }
}
