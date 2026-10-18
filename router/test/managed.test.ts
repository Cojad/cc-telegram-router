// docs/managed-channel.md, module level: the mode decision (every reason for
// legacy, the probe's mount), bwrap's options, the launcher (argv, environment,
// one shell line, the Runner), the settings' plugin keys, the managed settings
// file, the config folder made ready, the daemon and workers checked through a
// fake /proc, the daemon keeper (kept, started, repaired, given up after 3
// failures, one notice per cause), the transcripts' migration (copied, never
// over a file, dry run, trust, the user's daemon's jobs) and the copy back,
// `managed migrate`, the toolbox's host tools and the marketplace check.
// config managed.shareSessions (the registry bind on or off), and `managed
// agents|attach` (the launcher's command, arguments as they are, a conversation
// key or chat_id turned into its job id).
// End to end through the real router: e2e-managed.test.ts.

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import type { Conversation } from '../db'
import { bwrapArgs, CHANNELS, claudeJsonOf, decideMode, describeMode, launcherRunner, makeLauncher, managedPaths, managedSettings, MARKETPLACE, pluginSettings, resolveChannel, shellLine } from '../claudecmd'
import { checkNamespaces, createDaemonKeeper, describeMigration, initConfigDir, migrateCli, migrated, migrateTranscripts, prepareMounts, syncBack, writeManagedSettings, resolveAttachTarget, agentsCli, attachCli, MANAGED_USAGE } from '../managed'
import { createSupervisor } from '../supervisor'
import { HOST_TOOLS, hostDir, hostTool, installTools, installed, binDir, type Tool } from '../toolbox'
import { checkMarketplace, writeFingerprint, MARKETPLACE_FINGERPRINT_FILE } from '../pluginguard'
import { writeSessionSettings } from '../settings'
import { parseChannelMode, parseManaged } from '../config'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cctr-managed-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const sha = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex')
const conv = (key: string, folder: string, session: string | null): Conversation =>
  ({ key, bot: 'cc', chat_id: key.replace(/\D/g, ''), type: 'dm', folder, role: 'user', session_id: session, created_at: '' } as Conversation)

/** A host tool in installed.json as toolbox install leaves it. */
function putBwrap(toolbox: string, content = '#!/bin/sh\nexit 0\n'): string {
  mkdirSync(hostDir(toolbox), { recursive: true })
  const p = join(hostDir(toolbox), 'bwrap')
  writeFileSync(p, content)
  chmodSync(p, 0o755)
  writeFileSync(join(toolbox, 'installed.json'), JSON.stringify({ bwrap: { version: '0.13.1', bins: { bwrap: sha(content) }, host: true } }))
  return p
}

// --- the mode ---------------------------------------------------------------

test('bwrap options: the whole host, /etc an overlay of itself, the managed folder at /etc/claude-code, then /etc read-only; the user\'s session registry over the router\'s', () => {
  expect(bwrapArgs({ managedDir: '/s/managed', userSessions: '/h/.claude/sessions', sessionsDir: '/s/claude-config/sessions' })).toEqual(['--bind', '/', '/', '--dev-bind', '/dev', '/dev', '--overlay-src', '/etc', '--tmp-overlay', '/etc', '--ro-bind', '/s/managed', '/etc/claude-code', '--remount-ro', '/etc', '--bind', '/h/.claude/sessions', '/s/claude-config/sessions'])
})

test('mode: legacy by config, off Linux, without bwrap, with a changed bwrap, when the probe fails; managed when the full mount runs', () => {
  const toolbox = join(dir, 'state', 'toolbox')
  const paths = { managedDir: join(dir, 'state', 'managed'), userSessions: join(dir, 'h', 'sessions'), sessionsDir: join(dir, 'state', 'claude-config', 'sessions') }
  const yes = () => ({ ok: true, out: '' })
  expect(decideMode({ setting: 'legacy', toolbox, paths, probe: yes })).toEqual({ mode: 'legacy', reason: 'config 的 channelMode 是 legacy' })
  expect(decideMode({ setting: 'auto', platform: 'darwin', toolbox, paths, probe: yes }).reason).toContain('只能在 Linux')
  expect(decideMode({ setting: 'auto', platform: 'linux', toolbox, paths, probe: yes }).reason).toContain('工具箱沒有 bwrap')
  const bw = putBwrap(toolbox)
  writeFileSync(bw, '#!/bin/sh\necho changed\n')
  expect(decideMode({ setting: 'auto', platform: 'linux', toolbox, paths, probe: yes }).reason).toContain('sha256 跟安裝時不同')
  putBwrap(toolbox)
  const tried: string[][] = []
  const no = (argv: string[]) => { tried.push(argv); return { ok: false, out: 'bwrap: setting up uid map: Permission denied' } }
  const d = decideMode({ setting: 'auto', platform: 'linux', toolbox, paths, probe: no })
  expect(d.mode).toBe('legacy')
  expect(d.reason).toContain('apparmor_restrict_unprivileged_userns=1')
  expect(d.reason).toContain('setting up uid map: Permission denied')
  expect(tried[0]).toEqual([bw, ...bwrapArgs(paths), '--', 'true'])
  expect(decideMode({ setting: 'auto', platform: 'linux', toolbox, paths, probe: yes })).toEqual({ mode: 'managed', bwrap: bw })
  // prepare runs right before the probe, never when legacy was decided before it
  const order: string[] = []
  decideMode({ setting: 'auto', platform: 'linux', toolbox, paths, prepare: () => order.push('prepare'), probe: () => { order.push('probe'); return { ok: true, out: '' } } })
  decideMode({ setting: 'legacy', toolbox, paths, prepare: () => order.push('legacy prepare') })
  decideMode({ setting: 'auto', platform: 'darwin', toolbox, paths, prepare: () => order.push('darwin prepare') })
  expect(order).toEqual(['prepare', 'probe'])
  expect(describeMode({ mode: 'managed' })).toStartWith('managed')
  expect(describeMode({ mode: 'legacy', reason: 'x' })).toContain('降級: x')
})

test('config channelMode: auto by default, legacy, anything else auto with a warning', () => {
  const w: string[] = []
  expect(parseChannelMode(undefined, w)).toBe('auto')
  expect(parseChannelMode('legacy', w)).toBe('legacy')
  expect(parseChannelMode('managed', w)).toBe('auto')
  expect(w).toEqual(['channelMode 要是 "auto" 或 "legacy", 收到 "managed"; 用 auto'])
})

test('resolveChannel: the mounts prepared before the probe (managed settings, both session registry folders), then the launcher of the decided mode', () => {
  const stateDir = join(dir, 'state')
  putBwrap(join(stateDir, 'toolbox'))
  let seen = ''
  const ch = resolveChannel({ stateDir, claudeBin: 'claude' }, { platform: 'linux', env: {}, home: join(dir, 'home'), prepare: prepareMounts, probe: argv => { seen = readFileSync(join(argv[argv.indexOf('/etc/claude-code') - 1]!, 'managed-settings.json'), 'utf8'); return { ok: true, out: '' } } })
  expect(seen).toBe(managedSettings())
  for (const d of [join(dir, 'home', '.claude', 'sessions'), join(stateDir, 'claude-config', 'sessions')]) expect(statSync(d).mode & 0o777).toBe(0o700)
  expect(ch.paths.userSessions).toBe(join(dir, 'home', '.claude', 'sessions'))
  expect(ch.launcher.mode).toBe('managed')
  expect(ch.launcher.channel).toBe(CHANNELS.managed)
  const other = join(dir, 'state-legacy')
  expect(resolveChannel({ stateDir: other, claudeBin: 'claude', channelMode: 'legacy' }, { env: {}, home: join(dir, 'home2'), prepare: prepareMounts }).launcher.channel).toBe('plugin:telegram@claude-plugins-official')
  expect(existsSync(join(other, 'claude-config'))).toBe(false) // nothing made for a mode that needs none
})

// --- the launcher -------------------------------------------------------------

test('launcher: managed wraps claude in bwrap with the router\'s config folder and the user\'s for the login; legacy runs claude as it is; TELEGRAM_* never passed', () => {
  const home = join(dir, 'home')
  const paths = managedPaths('/s', { CLAUDE_CONFIG_DIR: undefined }, home)
  expect(paths).toEqual({ configDir: '/s/claude-config', managedDir: '/s/managed', managedFile: '/s/managed/managed-settings.json', marketplace: '/s/marketplace', pluginDir: '/s/marketplace/telegram', userConfigDir: join(home, '.claude'), userSessions: join(home, '.claude', 'sessions'), sessionsDir: '/s/claude-config/sessions' })
  expect(managedPaths('/s', { CLAUDE_CONFIG_DIR: '/c' }, home)).toMatchObject({ userConfigDir: '/c', userSessions: '/c/sessions' })
  const m = makeLauncher({ mode: 'managed', claudeBin: 'claude', paths, bwrap: '/s/toolbox/host/bwrap', home })
  expect(m.argv(['agents', '--json'])).toEqual(['/s/toolbox/host/bwrap', ...bwrapArgs(paths), '--', 'claude', 'agents', '--json'])
  const e = m.env({ PATH: '/bin', TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_STATE_DIR: 'y' })
  expect(e).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/s/claude-config', CLAUDE_SECURESTORAGE_CONFIG_DIR: join(home, '.claude') })
  expect(m.configDir).toBe('/s/claude-config')
  expect(m.claudeJson).toBe('/s/claude-config/.claude.json')
  const l = makeLauncher({ mode: 'legacy', claudeBin: '/opt/claude', paths, home })
  expect(l.argv(['stop', 'ab'])).toEqual(['/opt/claude', 'stop', 'ab'])
  expect(l.env({ PATH: '/bin', TELEGRAM_X: '1' })).toEqual({ PATH: '/bin' })
  expect(l.claudeJson).toBe(join(home, '.claude.json'))
  expect(claudeJsonOf('/c', home)).toBe('/c/.claude.json')
  expect(() => makeLauncher({ mode: 'managed', claudeBin: 'claude', paths })).toThrow()
  // one shell line for tmux (relay): env, then argv, quoted where needed
  expect(shellLine(l, ['attach', 'ab12'])).toBe('/opt/claude attach ab12')
  const q = makeLauncher({ mode: 'managed', claudeBin: 'claude', paths: { ...paths, configDir: "/s/it's", userConfigDir: '/h/.claude' }, bwrap: '/b', home })
  expect(shellLine(q, ['attach', 'x'])).toBe(`env CLAUDE_CONFIG_DIR='/s/it'\\''s' CLAUDE_SECURESTORAGE_CONFIG_DIR=/h/.claude /b ${bwrapArgs(paths).join(' ')} -- claude attach x`)
})

test('launcherRunner: a claudeBin call goes through bwrap with the environment; any other command as it is', async () => {
  const log = join(dir, 'calls')
  const bw = join(dir, 'bw.sh')
  writeFileSync(bw, `#!/bin/sh\necho "bwrap $* CFG=$CLAUDE_CONFIG_DIR TG=$TELEGRAM_BOT_TOKEN" >> ${log}\nwhile [ "$1" != "--" ]; do shift; done; shift; exec "$@"\n`)
  chmodSync(bw, 0o755)
  const paths = managedPaths(join(dir, 's'), {}, dir)
  const run = launcherRunner(makeLauncher({ mode: 'managed', claudeBin: 'echo', paths, bwrap: bw }))
  process.env.TELEGRAM_BOT_TOKEN = 'secret'
  try {
    const r = await run(['echo', 'hello'], dir)
    expect(r).toEqual({ code: 0, stdout: 'hello\n', stderr: '' })
    expect((await run(['true'], dir)).code).toBe(0)
  } finally { delete process.env.TELEGRAM_BOT_TOKEN }
  const calls = readFileSync(log, 'utf8').trim().split('\n')
  expect(calls).toHaveLength(1)
  expect(calls[0]).toBe(`bwrap ${bwrapArgs(paths).join(' ')} -- echo hello CFG=${paths.configDir} TG=`)
})

test('settings: managed mode replaces the template\'s plugin keys with our plugin from the local marketplace; legacy keeps the official ones', () => {
  const t = join(dir, 'templates')
  mkdirSync(join(t, 'roles'), { recursive: true })
  writeFileSync(join(t, 'base-settings.json'), JSON.stringify({ enabledPlugins: { 'telegram@claude-plugins-official': true }, extraKnownMarketplaces: { 'claude-plugins-official': { source: { source: 'github', repo: 'anthropics/claude-plugins-official' } } }, autoMemoryDirectory: '{{folder}}/memory' }))
  writeFileSync(join(t, 'roles', 'user.json'), JSON.stringify({ permissions: { allow: [] } }))
  const top = pluginSettings('managed', { marketplace: '/s/marketplace' })
  expect(top).toEqual({ enabledPlugins: { 'telegram@cc-telegram-router': true }, extraKnownMarketplaces: { 'cc-telegram-router': { source: { source: 'directory', path: '/s/marketplace' } } } })
  expect(pluginSettings('legacy', { marketplace: '/s/marketplace' })).toBeNull()
  const s = JSON.parse(readFileSync(writeSessionSettings(join(dir, 'st'), t, 'dm-1', 'user', { folder: '/f' }, [], top), 'utf8'))
  expect(s.enabledPlugins).toEqual(top!.enabledPlugins)
  expect(s.extraKnownMarketplaces).toEqual(top!.extraKnownMarketplaces)
  expect(s.autoMemoryDirectory).toBe('/f/memory')
  const l = JSON.parse(readFileSync(writeSessionSettings(join(dir, 'st'), t, 'dm-2', 'user', { folder: '/f' }, [], null), 'utf8'))
  expect(l.enabledPlugins).toEqual({ 'telegram@claude-plugins-official': true })
  expect(MARKETPLACE).toBe('cc-telegram-router')
})

// --- the files ---------------------------------------------------------------

test('managed settings: channels on, only telegram@cc-telegram-router; written once, 644', () => {
  const p = managedPaths(join(dir, 's'))
  writeManagedSettings(p)
  expect(JSON.parse(readFileSync(p.managedFile, 'utf8'))).toEqual({ channelsEnabled: true, allowedChannelPlugins: [{ marketplace: 'cc-telegram-router', plugin: 'telegram' }] })
  expect(statSync(p.managedFile).mode & 0o777).toBe(0o644)
  const t = statSync(p.managedFile).mtimeMs
  writeManagedSettings(p)
  expect(statSync(p.managedFile).mtimeMs).toBe(t)
})

test('config folder: 700, the bypass warning accepted and the folders trusted, other keys kept; nothing written the second time', () => {
  const p = { configDir: join(dir, 'cfg') }
  mkdirSync(p.configDir, { mode: 0o755 })
  writeFileSync(join(p.configDir, 'settings.json'), JSON.stringify({ theme: 'dark' }))
  writeFileSync(join(p.configDir, '.claude.json'), JSON.stringify({ numStartups: 3, projects: { '/h': { allowedTools: ['x'] } } }))
  expect(initConfigDir(p, ['/h', '/h/repo/']).changed).toEqual(['settings.json', '.claude.json'])
  expect(statSync(p.configDir).mode & 0o777).toBe(0o700)
  expect(JSON.parse(readFileSync(join(p.configDir, 'settings.json'), 'utf8'))).toEqual({ theme: 'dark', skipDangerousModePermissionPrompt: true })
  expect(JSON.parse(readFileSync(join(p.configDir, '.claude.json'), 'utf8'))).toEqual({ numStartups: 3, projects: { '/h': { allowedTools: ['x'], hasTrustDialogAccepted: true }, '/h/repo': { hasTrustDialogAccepted: true } } })
  expect(initConfigDir(p, ['/h']).changed).toEqual([])
  expect(initConfigDir({ configDir: join(dir, 'new') }, ['/h']).changed).toEqual(['settings.json', '.claude.json'])
})

// --- the daemon through /proc ------------------------------------------------

/** A fake /proc: each pid a folder; sees: its root has the managed settings with that content. */
function fakeProc(procRoot: string, pid: number, sees: string | null) {
  mkdirSync(join(procRoot, String(pid), 'root', 'etc'), { recursive: true })
  if (sees !== null) { mkdirSync(join(procRoot, String(pid), 'root', 'etc', 'claude-code'), { recursive: true }); writeFileSync(join(procRoot, String(pid), 'root', 'etc', 'claude-code', 'managed-settings.json'), sees) }
}
function fakeDaemon(configDir: string, pid: number, workers: Record<string, number> = {}) {
  mkdirSync(join(configDir, 'daemon'), { recursive: true })
  writeFileSync(join(configDir, 'daemon.status.json'), JSON.stringify({ supervisorPid: pid, workers: {} }))
  writeFileSync(join(configDir, 'daemon', 'roster.json'), JSON.stringify({ proto: 1, supervisorPid: pid, workers: Object.fromEntries(Object.entries(workers).map(([k, v]) => [k, { pid: v }])) }))
}

test('namespace check: no daemon; the daemon and every live worker of its roster seeing the managed settings; the ones that do not', () => {
  const p = managedPaths(join(dir, 's'))
  const proc = join(dir, 'proc')
  writeManagedSettings(p)
  const want = managedSettings()
  expect(checkNamespaces(p, proc)).toEqual({ daemon: null, bad: [], workers: 0 })
  fakeDaemon(p.configDir, 100, { aa: 101, bb: 102, gone: 103 })
  expect(checkNamespaces(p, proc).daemon).toBeNull() // pid 100 not running
  fakeProc(proc, 100, want); fakeProc(proc, 101, want); fakeProc(proc, 102, want)
  expect(checkNamespaces(p, proc)).toEqual({ daemon: 100, bad: [], workers: 2 })
  fakeProc(proc, 102, null)
  rmSync(join(proc, '102', 'root', 'etc', 'claude-code'), { recursive: true })
  fakeProc(proc, 101, '{"other": true}')
  expect(checkNamespaces(p, proc)).toEqual({ daemon: 100, bad: [{ pid: 101, what: 'worker aa' }, { pid: 102, what: 'worker bb' }], workers: 2 })
  // a roster of another daemon is not this one's
  writeFileSync(join(p.configDir, 'daemon', 'roster.json'), JSON.stringify({ supervisorPid: 99, workers: { aa: { pid: 101 } } }))
  expect(checkNamespaces(p, proc)).toEqual({ daemon: 100, bad: [], workers: 0 })
})

test('daemon keeper: kept when right; started when missing; stopped and started again when it cannot see the managed settings, told once; given up after 3 failures with one notice; calls shared', async () => {
  const p = managedPaths(join(dir, 's'))
  const proc = join(dir, 'proc')
  writeManagedSettings(p)
  const want = managedSettings()
  const notices: string[] = []
  let next = 200, starts = 0, stops = 0, startSees: string | null = want
  const keeper = createDaemonKeeper({
    launcher: makeLauncher({ mode: 'managed', claudeBin: 'claude', paths: p, bwrap: '/b' }), paths: p, logFile: join(dir, 'd.log'), procRoot: proc,
    notify: t => { notices.push(t) },
    startDaemon: () => { starts++; if (startSees === 'none') return; const pid = next++; fakeProc(proc, pid, startSees); fakeDaemon(p.configDir, pid) },
    stopDaemon: async () => { stops++; const pid = JSON.parse(readFileSync(join(p.configDir, 'daemon.status.json'), 'utf8')).supervisorPid; rmSync(join(proc, String(pid)), { recursive: true }); rmSync(join(p.configDir, 'daemon.status.json')) },
    sleep: async () => {}, startWaitMs: 50,
  })
  expect(await keeper.ensure()).toBe('started')
  expect(starts).toBe(1)
  expect(await keeper.ensure()).toBe('ok')
  expect(starts).toBe(1)
  // a worker outside the namespace
  fakeDaemon(p.configDir, 200, { w1: 300 })
  fakeProc(proc, 300, null)
  const [a, b] = await Promise.all([keeper.ensure(), keeper.ensure()])
  expect([a, b]).toEqual(['repaired', 'repaired'])
  expect(stops).toBe(1)
  expect(starts).toBe(2)
  expect(notices).toHaveLength(1)
  expect(notices[0]).toContain('看不到 managed settings (worker w1)')
  expect(notices[0]).toContain('pid 201')
  // daemon gone and every new one fails
  rmSync(join(proc, '201'), { recursive: true })
  startSees = 'none'
  for (let i = 0; i < 3; i++) expect(await keeper.ensure()).toBe('failed')
  expect(keeper.failures()).toBe(3)
  expect(await keeper.ensure()).toBe('failed')
  expect(starts).toBe(5) // no more tries after the third
  expect(notices).toHaveLength(2)
  expect(notices[1]).toContain('連續 3 次')
  expect(notices[1]).toContain('"channelMode": "legacy"')
  // put right from outside: back to ok
  startSees = want
  fakeProc(proc, 400, want); fakeDaemon(p.configDir, 400)
  expect(await keeper.ensure()).toBe('ok')
  expect(keeper.failures()).toBe(0)
})

// --- transcripts ---------------------------------------------------------------

function userConfig(root: string, convs: Conversation[]) {
  for (const c of convs) {
    if (!c.session_id) continue
    const store = join(root, 'projects', c.folder.replace(/[/.]/g, '-'))
    mkdirSync(join(store, c.session_id, 'tool-results'), { recursive: true })
    writeFileSync(join(store, `${c.session_id}.jsonl`), `{"session":"${c.session_id}"}\n`)
    writeFileSync(join(store, c.session_id, 'tool-results', 'r1.txt'), 'result')
    writeFileSync(join(store, 'other-session.jsonl'), 'not this one')
  }
}

test('migration: each current session (transcript, tool-results) copied, never over one already there; trust copied; the conversations\' jobs in the user\'s daemon removed, no other; migrated.json; dry run changes nothing', async () => {
  const home = join(dir, 'home')
  const from = join(dir, 'user', '.claude'), to = join(dir, 's', 'claude-config')
  const a = conv('dm-1', join(home, 'bot1', 'dm-1'), '11111111-1111-1111-1111-111111111111')
  const b = conv('group-2', join(home, 'bot1', 'group-2'), '22222222-2222-2222-2222-222222222222')
  const c = conv('dm-3', join(home, 'bot1', 'dm-3'), null)
  const gone = conv('dm-4', join(home, 'bot1', 'dm-4'), '44444444-4444-4444-4444-444444444444')
  userConfig(from, [a, b])
  writeFileSync(join(dir, 'user', 'claude.json'), JSON.stringify({ projects: { [join(home, 'bot1', 'group-2')]: { hasTrustDialogAccepted: true }, [home]: { hasTrustDialogAccepted: true }, '/elsewhere': { hasTrustDialogAccepted: true } } }))
  const job = (id: string, name: string, cwd: string) => { mkdirSync(join(from, 'jobs', id), { recursive: true }); writeFileSync(join(from, 'jobs', id, 'state.json'), JSON.stringify({ name, cwd, sessionId: 'x' })) }
  job('aaaa1111', 'tg-dm-1', a.folder); job('bbbb2222', 'tg-group-2', '/elsewhere'); job('cccc3333', 'mine', a.folder)
  // the router's copy already has b's session
  const bDst = join(to, 'projects', b.folder.replace(/[/.]/g, '-'))
  mkdirSync(bDst, { recursive: true })
  writeFileSync(join(bDst, `${b.session_id}.jsonl`), 'newer, the router\'s own')

  const removed: string[] = []
  const deps = { convs: [a, b, c, gone], from, to, fromClaudeJson: join(dir, 'user', 'claude.json'), home, removeJob: async (id: string) => { removed.push(id); return true }, now: () => new Date('2026-10-18T08:00:00Z') }
  const dry = await migrateTranscripts({ ...deps, dryRun: true })
  expect(dry.copied).toEqual([{ key: 'dm-1', session: a.session_id! }])
  expect(existsSync(join(to, 'projects', a.folder.replace(/[/.]/g, '-')))).toBe(false)
  expect(dry.oldJobs).toEqual([{ id: 'aaaa1111', key: 'dm-1', removed: null }])
  expect(removed).toEqual([])
  expect(migrated(to)).toBe(false)
  expect(describeMigration(dry, true)).toContain('會複製 1 個 session (dm-1)')

  const r = await migrateTranscripts(deps)
  const aDst = join(to, 'projects', a.folder.replace(/[/.]/g, '-'))
  expect(readFileSync(join(aDst, `${a.session_id}.jsonl`), 'utf8')).toBe(`{"session":"${a.session_id}"}\n`)
  expect(readFileSync(join(aDst, a.session_id!, 'tool-results', 'r1.txt'), 'utf8')).toBe('result')
  expect(existsSync(join(aDst, 'other-session.jsonl'))).toBe(false)
  expect(readFileSync(join(bDst, `${b.session_id}.jsonl`), 'utf8')).toBe('newer, the router\'s own')
  expect(r.skipped).toEqual([
    { key: 'group-2', why: '目的地已有這個 session' },
    { key: 'dm-3', why: '沒有 session' },
    { key: 'dm-4', why: `找不到 ${join(from, 'projects', gone.folder.replace(/[/.]/g, '-'), `${gone.session_id}.jsonl`)}` },
  ])
  expect(r.trusted).toEqual([b.folder])
  expect(JSON.parse(readFileSync(join(to, '.claude.json'), 'utf8')).projects).toEqual({ [b.folder]: { hasTrustDialogAccepted: true } })
  expect(removed).toEqual(['aaaa1111'])
  expect(r.oldJobs).toEqual([{ id: 'aaaa1111', key: 'dm-1', removed: true }])
  expect(existsSync(join(from, 'projects', a.folder.replace(/[/.]/g, '-'), `${a.session_id}.jsonl`))).toBe(true) // the user's copy stays
  expect(migrated(to)).toBe(true)
  expect(JSON.parse(readFileSync(join(to, 'migrated.json'), 'utf8')).at).toBe('2026-10-18T08:00:00.000Z')
  expect(describeMigration(r, false)).toBe([
    '對話紀錄: 已複製 1 個 session (dm-1)',
    '  略過 group-2: 目的地已有這個 session',
    '  略過 dm-3: 沒有 session',
    `  略過 dm-4: 找不到 ${join(from, 'projects', gone.folder.replace(/[/.]/g, '-'), `${gone.session_id}.jsonl`)}`,
    `資料夾信任: 已照抄 ${b.folder}`,
    '原本 daemon 裡的 job: aaaa1111 (dm-1) 已移除',
  ].join('\n'))
})

test('copy back (legacy after managed): only sessions newer in the router\'s config folder, with their tool-results', () => {
  const home = join(dir, 'home')
  const a = conv('dm-1', join(home, 'dm-1'), '11111111-1111-1111-1111-111111111111')
  const b = conv('dm-2', join(home, 'dm-2'), '22222222-2222-2222-2222-222222222222')
  const routerCfg = join(dir, 'r'), user = join(dir, 'u')
  userConfig(routerCfg, [a, b])
  userConfig(user, [a, b])
  const file = (root: string, c: Conversation) => join(root, 'projects', c.folder.replace(/[/.]/g, '-'), `${c.session_id}.jsonl`)
  writeFileSync(file(routerCfg, a), 'router, newer')
  utimesSync(file(user, a), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
  utimesSync(file(routerCfg, b), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
  expect(syncBack({ convs: [a, b], from: routerCfg, to: user })).toEqual([{ key: 'dm-1', session: a.session_id! }])
  expect(readFileSync(file(user, a), 'utf8')).toBe('router, newer')
  expect(readFileSync(file(user, b), 'utf8')).toBe(`{"session":"${b.session_id}"}\n`)
})

test('managed migrate: usage; dry run without the lock; refused once migrated unless --force; --user-config only lists the jobs; the lock held while it runs', async () => {
  const home = join(dir, 'home')
  const user = join(dir, 'user', '.claude')
  const a = conv('dm-1', join(home, 'dm-1'), '11111111-1111-1111-1111-111111111111')
  userConfig(user, [a])
  mkdirSync(join(user, 'jobs', 'aaaa1111'), { recursive: true })
  writeFileSync(join(user, 'jobs', 'aaaa1111', 'state.json'), JSON.stringify({ name: 'tg-dm-1', cwd: a.folder }))
  const paths = { ...managedPaths(join(dir, 's'), {}, join(dir, 'user')), userConfigDir: user }
  const out: string[] = [], removed: string[] = []
  let locks = 0
  const deps = { cfg: { home, stateDir: join(dir, 's'), claudeBin: 'claude' }, convs: () => [a], paths, lock: () => { locks++; return () => { locks-- } }, removeJob: async (id: string) => { removed.push(id); return true }, print: (s: string) => { out.push(s) } }
  expect(await migrateCli(['--nope'], deps)).toBe(2)
  expect(await migrateCli(['--user-config'], deps)).toBe(2)
  expect(out.at(-1)).toStartWith('用法: cc-telegram-router [--config <路徑>] managed migrate')
  expect(await migrateCli(['--dry-run'], deps)).toBe(0)
  expect(out.at(-1)).toContain('(--dry-run, 沒有改任何東西)')
  expect(out.at(-1)).toContain('aaaa1111 (dm-1) 會 stop 加 rm')
  expect(existsSync(paths.configDir)).toBe(false)
  // a rehearsal against a copy: the jobs are only listed
  expect(await migrateCli(['--user-config', user], deps)).toBe(0)
  expect(removed).toEqual([])
  expect(out.at(-1)).toContain('已複製 1 個 session')
  expect(JSON.parse(readFileSync(join(paths.configDir, 'settings.json'), 'utf8')).skipDangerousModePermissionPrompt).toBe(true)
  expect(JSON.parse(readFileSync(join(paths.configDir, '.claude.json'), 'utf8')).projects[home].hasTrustDialogAccepted).toBe(true)
  expect(await migrateCli([], deps)).toBe(0)
  expect(out.at(-1)).toContain('已存在, 之前遷移過')
  expect(await migrateCli(['--force'], deps)).toBe(0)
  expect(removed).toEqual(['aaaa1111'])
  expect(locks).toBe(0)
  const busy = { ...deps, lock: () => { throw new Error('another router (pid 9) already holds x.lock') } }
  expect(await migrateCli(['--force'], busy)).toBe(1)
  expect(out.at(-1)).toBe('遷移失敗: another router (pid 9) already holds x.lock')
})

// --- toolbox and plugin --------------------------------------------------------

test('host tools: a raw file checked by sha256 into toolbox/host (not bin), recorded as host; hostTool finds it, refuses a changed file; the real entry is bwrap 0.13.1 for x64 from this repo\'s release', async () => {
  const box = join(dir, 'state', 'toolbox')
  const mirror = join(dir, 'mirror')
  mkdirSync(mirror)
  const data = '#!/bin/sh\necho static\n'
  writeFileSync(join(mirror, 'bwrap-test'), data)
  const tool: Tool = { name: 'bwrap', version: '9', host: true, files: { x64: [{ url: 'https://example.com/r/bwrap-test', sha256: sha(data), unpack: 'raw', as: 'bwrap' }] } }
  expect((await installTools(box, { mirror, arch: 'x64', tools: [tool] }))[0]!.status).toBe('installed')
  expect(readFileSync(join(hostDir(box), 'bwrap'), 'utf8')).toBe(data)
  expect(statSync(join(hostDir(box), 'bwrap')).mode & 0o111).toBeTruthy()
  expect(existsSync(join(binDir(box), 'bwrap'))).toBe(false)
  expect(installed(box).bwrap).toEqual({ version: '9', bins: { bwrap: sha(data) }, host: true })
  expect(hostTool(box, 'bwrap')).toEqual({ path: join(hostDir(box), 'bwrap') })
  expect((await installTools(box, { mirror, arch: 'x64', tools: [tool] }))[0]!.status).toBe('kept')
  expect((await installTools(box, { mirror, arch: 'arm64', tools: [tool] }))[0]!.status).toBe('unsupported')
  writeFileSync(join(hostDir(box), 'bwrap'), 'changed')
  expect('why' in hostTool(box, 'bwrap')).toBe(true)
  expect(hostTool(box, 'nope')).toEqual({ why: '工具箱沒有 nope (cc-telegram-router toolbox install)' })
  expect(HOST_TOOLS.map(t => [t.name, t.version, t.host, Object.keys(t.files)])).toEqual([['bwrap', '0.13.1', true, ['x64']]])
  const f = HOST_TOOLS[0]!.files.x64![0]!
  expect(f.url).toBe('https://github.com/Cojad/cc-telegram-router/releases/download/bwrap-0.13.1/bwrap-0.13.1-x86_64')
  expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
  expect(f.unpack).toBe('raw')
})

test('marketplace check: no record, as deployed, files changed, another folder recorded, folder gone', () => {
  const state = join(dir, 'state'), plugin = join(dir, 'state', 'marketplace', 'telegram')
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true })
  writeFileSync(join(plugin, 'server.js'), 'v2')
  writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), '{}')
  expect(checkMarketplace(state, plugin)[0]!.kind).toBe('no-fingerprint')
  writeFingerprint(state, plugin, new Date(), MARKETPLACE_FINGERPRINT_FILE)
  expect(existsSync(join(state, 'plugin-fingerprint.json'))).toBe(false)
  expect(checkMarketplace(state, plugin)).toEqual([])
  writeFileSync(join(plugin, 'server.js'), 'v3')
  writeFileSync(join(plugin, 'extra.js'), '')
  expect(checkMarketplace(state, plugin)).toEqual([{ kind: 'files', detail: `${plugin} 的檔案跟部署時不同 (內容改變: server.js; 多出: extra.js)` }])
  expect(checkMarketplace(state, '/other')[0]!.kind).toBe('install-path')
  rmSync(plugin, { recursive: true })
  expect(checkMarketplace(state, plugin)[0]!.kind).toBe('missing-folder')
})

test('listAgents: only the daemon\'s jobs; the user\'s interactive sessions the shared registry adds (no job id) are left out', async () => {
  const out = JSON.stringify([
    { id: 'aaaa1111', sessionId: 's1', name: 'tg-dm-1', kind: 'background', pid: 1, status: 'idle' },
    { sessionId: 's2', name: 'probe-n', kind: 'interactive', pid: 2, status: 'idle' },
    { id: '', name: 'odd' },
  ])
  const sup = createSupervisor({ cfg: { claudeBin: 'claude', home: dir } as any, db: {} as any, run: async () => ({ code: 0, stdout: out, stderr: '' }), isConnected: () => false, waitConnected: async () => false, settingsPath: () => '' })
  expect((await sup.listAgents()).map(a => a.id)).toEqual(['aaaa1111'])
})

test('config managed.shareSessions: on by default; false turns the registry bind off; anything wrong is on with a warning', () => {
  const w: string[] = []
  expect(parseManaged(undefined, w)).toEqual({ shareSessions: true })
  expect(parseManaged({}, w)).toEqual({ shareSessions: true })
  expect(parseManaged({ shareSessions: false }, w)).toEqual({ shareSessions: false })
  expect(parseManaged({ shareSessions: 'no' }, w)).toEqual({ shareSessions: true })
  expect(parseManaged(true, w)).toEqual({ shareSessions: true })
  expect(w).toEqual(['managed.shareSessions 要是 true 或 false, 收到 "no"; 用預設 (開)', 'managed 要是物件 (例如 { "shareSessions": true }), 收到 true; 用預設 (shareSessions 開)'])
  const p = { managedDir: '/s/managed', userSessions: '/h/.claude/sessions', sessionsDir: '/s/claude-config/sessions' }
  expect(bwrapArgs(p, false)).toEqual(bwrapArgs(p).slice(0, -3))
  expect(bwrapArgs(p, false)).not.toContain('/h/.claude/sessions')
  const paths = managedPaths('/s', {}, '/h')
  expect(makeLauncher({ mode: 'managed', claudeBin: 'claude', paths, bwrap: '/b', shareSessions: false }).argv(['agents'])).toEqual(['/b', ...bwrapArgs(paths, false), '--', 'claude', 'agents'])
  // off: the probe mounts no registry and nothing is made for it; said in the mode line
  const stateDir = join(dir, 'state')
  putBwrap(join(stateDir, 'toolbox'))
  let probed: string[] = []
  const ch = resolveChannel({ stateDir, claudeBin: 'claude', managed: { shareSessions: false } }, { platform: 'linux', env: {}, home: join(dir, 'home'), prepare: prepareMounts, probe: a => { probed = a; return { ok: true, out: '' } } })
  expect(ch.shareSessions).toBe(false)
  expect(probed).not.toContain(join(dir, 'home', '.claude', 'sessions'))
  expect(existsSync(join(dir, 'home', '.claude', 'sessions'))).toBe(false)
  expect(existsSync(join(stateDir, 'claude-config', 'sessions'))).toBe(false)
  expect(describeMode(ch.decision, false)).toContain('session 名冊不共用 (managed.shareSessions 關閉)')
  expect(describeMode(ch.decision, true)).toContain('session 名冊與使用者共用')
})

test('managed attach target: a conversation key or chat_id becomes its current session\'s job id; several bots need --bot; no session or no job is said; anything else goes as it is', () => {
  const convs = [conv('dm-1', '/h/bot1/dm-1', 's1'), { ...conv('dm-9', '/h/bot2/dm-9', 's9'), chat_id: '1', bot: 'two' }, conv('dm-2', '/h/bot1/dm-2', null), conv('dm-3', '/h/bot1/dm-3', 's3')]
  const agents = [{ id: 'aaaa1111', sessionId: 's1' }, { id: 'bbbb2222', sessionId: 's9' }, { sessionId: 's3', name: 'interactive one' }]
  expect(resolveAttachTarget('dm-1', undefined, convs, agents)).toEqual({ id: 'aaaa1111' })
  expect(resolveAttachTarget('1', undefined, convs, agents)).toEqual({ error: 'chat_id 1 在好幾隻 bot 都有對話 (cc, two), 加 --bot <名稱>' })
  expect(resolveAttachTarget('1', 'two', convs, agents)).toEqual({ id: 'bbbb2222' })
  expect(resolveAttachTarget('dm-2', undefined, convs, agents)).toEqual({ error: '對話 dm-2 還沒有 session (還沒叫醒過)' })
  expect(resolveAttachTarget('dm-3', undefined, convs, agents)).toEqual({ error: '對話 dm-3 目前沒有 job (worker 睡著或被移除): 先用 cc-telegram-router cli session send 叫醒它' })
  expect(resolveAttachTarget('cccc3333', undefined, convs, agents)).toEqual({ id: 'cccc3333' })
  expect(resolveAttachTarget('x', 'two', convs, agents)).toEqual({ error: 'bot two 沒有對話 x' })
})

test('managed agents|attach: the launcher\'s command with the arguments as they are and its environment, on the terminal; attach resolves a conversation, asks claude agents only then', async () => {
  const paths = managedPaths(join(dir, 's'), {}, dir)
  const m = makeLauncher({ mode: 'managed', claudeBin: 'claude', paths, bwrap: '/b' })
  const runs: Array<{ argv: string[]; cfg?: string }> = []
  let asked = 0
  const deps = (l = m) => ({
    launcher: l, convs: () => [conv('dm-1', '/h/dm-1', 's1')],
    runTty: async (argv: string[], env: Record<string, string | undefined>) => { runs.push({ argv, cfg: env.CLAUDE_CONFIG_DIR }); return 7 },
    agents: async () => { asked++; return [{ id: 'aaaa1111', sessionId: 's1' }] },
    print: (s: string) => { runs.push({ argv: ['PRINT', s] }) },
  })
  expect(await agentsCli(['--json', '--all'], deps())).toBe(7)
  expect(runs.at(-1)).toEqual({ argv: ['/b', ...bwrapArgs(paths), '--', 'claude', 'agents', '--json', '--all'], cfg: paths.configDir })
  expect(await attachCli(['dm-1', '--some-flag'], deps())).toBe(7)
  expect(runs.at(-1)!.argv.slice(-3)).toEqual(['attach', 'aaaa1111', '--some-flag'])
  expect(asked).toBe(1)
  expect(await attachCli(['--bot', 'cc', 'dm-1'], deps())).toBe(7)
  expect(runs.at(-1)!.argv.slice(-2)).toEqual(['attach', 'aaaa1111'])
  expect(await attachCli(['ab12cd34'], deps())).toBe(7)
  expect(runs.at(-1)!.argv.slice(-2)).toEqual(['attach', 'ab12cd34'])
  expect(asked).toBe(2) // a job id needs no lookup
  expect(await attachCli(['--help'], deps())).toBe(7)
  expect(runs.at(-1)!.argv.slice(-2)).toEqual(['attach', '--help'])
  expect(await attachCli(['--bot'], deps())).toBe(2)
  expect(runs.at(-1)).toEqual({ argv: ['PRINT', MANAGED_USAGE] })
  // legacy: claude as it is, no config folder of the router's
  const l = makeLauncher({ mode: 'legacy', claudeBin: '/opt/claude', paths })
  expect(await agentsCli([], deps(l))).toBe(7)
  expect(runs.at(-1)).toEqual({ argv: ['/opt/claude', 'agents'], cfg: process.env.CLAUDE_CONFIG_DIR })
  for (const t of ['migrate', 'agents', 'attach', 'help']) expect(MANAGED_USAGE).toContain(`  ${t}`)
})
