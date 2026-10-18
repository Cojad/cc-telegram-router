// How the router runs claude (docs/managed-channel.md). Two modes, chosen once
// at start:
//   managed  the default: every claude command runs inside the toolbox's static
//            bwrap, which lays <stateDir>/managed over /etc/claude-code (the
//            managed settings that let telegram@cc-telegram-router be a channel),
//            with CLAUDE_CONFIG_DIR=<stateDir>/claude-config (the router's own
//            daemon, jobs and transcripts) and CLAUDE_SECURESTORAGE_CONFIG_DIR
//            at the user's own config folder (the login is read from there).
//   legacy   when bwrap or user namespaces cannot be used, or config
//            channelMode is "legacy": claude as it is, ~/.claude, the official
//            plugin's cache with plugin v2 laid over it.

import { homedir } from 'os'
import { join } from 'path'
import type { Runner } from './supervisor'
import { hostTool } from './toolbox'

export type ChannelMode = 'managed' | 'legacy'
/** config channelMode: auto (managed when it works) or legacy. */
export type ChannelSetting = 'auto' | 'legacy'

/** The local marketplace deploy/install.sh plugin fills, and the channel each mode starts workers with. */
export const MARKETPLACE = 'cc-telegram-router'
export const CHANNELS: Record<ChannelMode, string> = {
  managed: `plugin:telegram@${MARKETPLACE}`,
  legacy: 'plugin:telegram@claude-plugins-official',
}

export interface ManagedPaths {
  /** <stateDir>/claude-config: CLAUDE_CONFIG_DIR of every claude the router runs in managed mode. */
  configDir: string
  /** <stateDir>/managed: mounted read-only at /etc/claude-code. */
  managedDir: string
  managedFile: string
  /** <stateDir>/marketplace: the local marketplace with the telegram plugin. */
  marketplace: string
  pluginDir: string
  /** The user's own config folder (CLAUDE_CONFIG_DIR of the router's environment, else ~/.claude): login, legacy mode. */
  userConfigDir: string
}

export function managedPaths(stateDir: string, env: Record<string, string | undefined> = process.env, home = homedir()): ManagedPaths {
  const managedDir = join(stateDir, 'managed')
  const marketplace = join(stateDir, 'marketplace')
  return {
    configDir: join(stateDir, 'claude-config'),
    managedDir,
    managedFile: join(managedDir, 'managed-settings.json'),
    marketplace,
    pluginDir: join(marketplace, 'telegram'),
    userConfigDir: env.CLAUDE_CONFIG_DIR || join(home, '.claude'),
  }
}

/** The managed settings: channels on, and only our telegram plugin may be one. */
export function managedSettings(): string {
  return JSON.stringify({ channelsEnabled: true, allowedChannelPlugins: [{ marketplace: MARKETPLACE, plugin: 'telegram' }] }, null, 2) + '\n'
}

/** bwrap's options: the whole host as it is (--bind / / recursive), /etc an overlay of
 *  itself with the managed folder at /etc/claude-code, then /etc read-only (no
 *  managed-settings.d of a worker's own). No pid or network namespace. */
export function bwrapArgs(p: Pick<ManagedPaths, 'managedDir'>): string[] {
  return ['--bind', '/', '/', '--dev-bind', '/dev', '/dev', '--overlay-src', '/etc', '--tmp-overlay', '/etc', '--ro-bind', p.managedDir, '/etc/claude-code', '--remount-ro', '/etc']
}

export interface ModeDecision { mode: ChannelMode; reason?: string; bwrap?: string }
/** The reason when config chose legacy (not a degradation). */
export const LEGACY_BY_CONFIG = 'config 的 channelMode 是 legacy'

export interface DecideDeps {
  setting: ChannelSetting
  platform?: string
  toolbox: string
  paths: Pick<ManagedPaths, 'managedDir'>
  /** Runs argv, true when it exits 0 within a few seconds; else what it said. */
  probe?: (argv: string[]) => { ok: boolean; out: string }
}

/** One try of the full mount, 5 seconds at most. */
export function probeBwrap(argv: string[]): { ok: boolean; out: string } {
  try {
    const p = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', timeout: 5_000 })
    return { ok: p.exitCode === 0, out: `${p.stderr.toString()}${p.stdout.toString()}`.trim().slice(-300) || `exit ${p.exitCode ?? p.signalCode}` }
  } catch (e) { return { ok: false, out: e instanceof Error ? e.message : String(e) } }
}

/** managed, or legacy and why (docs/managed-channel.md 「兩種模式」). The managed folder must exist for the probe. */
export function decideMode(d: DecideDeps): ModeDecision {
  if (d.setting === 'legacy') return { mode: 'legacy', reason: LEGACY_BY_CONFIG }
  const platform = d.platform ?? process.platform
  if (platform !== 'linux') return { mode: 'legacy', reason: `bwrap 只能在 Linux 用 (這台是 ${platform})` }
  const t = hostTool(d.toolbox, 'bwrap')
  if ('why' in t) return { mode: 'legacy', reason: t.why }
  const r = (d.probe ?? probeBwrap)([t.path, ...bwrapArgs(d.paths), '--', 'true'])
  if (!r.ok) return { mode: 'legacy', reason: `bwrap 試跑失敗 (user namespace 可能被系統關閉, 例如 Ubuntu 24.04 的 apparmor_restrict_unprivileged_userns=1): ${r.out}` }
  return { mode: 'managed', bwrap: t.path }
}

/** How one mode runs claude: argv and environment. */
export interface Launcher {
  mode: ChannelMode
  claudeBin: string
  channel: string
  /** The config folder claude uses in this mode (jobs, transcripts, .claude.json). */
  configDir: string
  /** .claude.json of that config folder (folder trust). */
  claudeJson: string
  argv(args: string[]): string[]
  env(base?: Record<string, string | undefined>): Record<string, string | undefined>
}

/** Where Claude Code keeps .claude.json for a config folder: inside it when set by CLAUDE_CONFIG_DIR, ~/.claude.json for the default. */
export function claudeJsonOf(configDir: string, home = homedir()): string {
  return configDir === join(home, '.claude') ? join(home, '.claude.json') : join(configDir, '.claude.json')
}

export function makeLauncher(o: { mode: ChannelMode; claudeBin: string; paths: ManagedPaths; bwrap?: string; home?: string }): Launcher {
  const managed = o.mode === 'managed'
  if (managed && !o.bwrap) throw new Error('managed mode needs bwrap')
  const configDir = managed ? o.paths.configDir : o.paths.userConfigDir
  return {
    mode: o.mode,
    claudeBin: o.claudeBin,
    channel: CHANNELS[o.mode],
    configDir,
    claudeJson: claudeJsonOf(configDir, o.home),
    argv: args => managed ? [o.bwrap!, ...bwrapArgs(o.paths), '--', o.claudeBin, ...args] : [o.claudeBin, ...args],
    env: (base = process.env) => {
      const e: Record<string, string | undefined> = { ...base }
      // the daemon's environment is every worker's (#98872): no bot token or other TELEGRAM_* in it
      for (const k of Object.keys(e)) if (k.startsWith('TELEGRAM_')) delete e[k]
      if (managed) { e.CLAUDE_CONFIG_DIR = o.paths.configDir; e.CLAUDE_SECURESTORAGE_CONFIG_DIR = o.paths.userConfigDir }
      return e
    },
  }
}

/** A Runner for the supervisor and job cleanup: a call whose first word is claudeBin goes through the launcher. */
export function launcherRunner(l: Launcher): Runner {
  return async (args, cwd) => {
    const argv = args[0] === l.claudeBin ? l.argv(args.slice(1)) : args
    const p = Bun.spawn(argv, { cwd, env: l.env(), stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
    const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
    return { code: await p.exited, stdout, stderr }
  }
}

const shq = (s: string) => /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`

/** The launcher's command as one shell line (tmux new-session, relay): env assignments, then argv. */
export function shellLine(l: Launcher, args: string[]): string {
  const e = l.env({})
  const vars = Object.entries(e).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${shq(v!)}`)
  return [...(vars.length ? ['env', ...vars] : []), ...l.argv(args).map(shq)].join(' ')
}

export interface Channel { decision: ModeDecision; paths: ManagedPaths; launcher: Launcher }

/** The mode for this router and how to run claude in it: managed settings written
 *  (the probe mounts them), the mode decided, the launcher made. */
export function resolveChannel(cfg: { stateDir: string; claudeBin: string; channelMode?: ChannelSetting }, o: { probe?: DecideDeps['probe']; platform?: string; env?: Record<string, string | undefined>; home?: string; writeManaged?: (p: ManagedPaths) => void } = {}): Channel {
  const paths = managedPaths(cfg.stateDir, o.env, o.home)
  o.writeManaged?.(paths)
  const decision = decideMode({ setting: cfg.channelMode ?? 'auto', platform: o.platform, toolbox: join(cfg.stateDir, 'toolbox'), paths, probe: o.probe })
  return { decision, paths, launcher: makeLauncher({ mode: decision.mode, claudeBin: cfg.claudeBin, paths, bwrap: decision.bwrap, home: o.home }) }
}

/** The mode in one line (start notice, doctor, log). */
export function describeMode(d: ModeDecision): string {
  if (d.mode === 'managed') return 'managed (worker 用 router 自己的 telegram plugin, 在 bwrap 裡執行)'
  return d.reason === LEGACY_BY_CONFIG ? `legacy (${d.reason}; worker 用官方 plugin 的快取)` : `legacy (降級: ${d.reason ?? '?'}; worker 用官方 plugin 的快取)`
}

/** Settings keys that replace the template's in managed mode: our plugin enabled, from the local
 *  marketplace declared right here (no plugin install needed: it loads in place, tested with
 *  Claude Code 2.1.302). Legacy: null, the template's official entries stay. */
export function pluginSettings(mode: ChannelMode, p: Pick<ManagedPaths, 'marketplace'>): Record<string, unknown> | null {
  if (mode !== 'managed') return null
  return {
    enabledPlugins: { [`telegram@${MARKETPLACE}`]: true },
    extraKnownMarketplaces: { [MARKETPLACE]: { source: { source: 'directory', path: p.marketplace } } },
  }
}
