// The daemon's jobs of the router's workers (docs/operations.md 「背景 session 的
// job 與 daemon」), module level, with a fake claude (a Runner) and a fake jobs
// folder: a job saved with other flags (state.json respawnFlags, or the
// router's own record when state.json cannot be read) is removed (stopped
// first when running) and the session resumed with the new flags; a failed rm
// falls back to the saved flags; the flags are recorded; stray jobs (our
// conversations, not their current session) and nothing else; /config set
// model marks the conversations on the default model; the daemon report
// (who started the daemon, spares without one) from a fake /proc; router.db
// from the version before (no conversations.worker_flags, with data).
// End to end through the real router: e2e-jobs.test.ts.

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import type { Config } from '../config'
import { openRouterDb, type RouterDb } from '../db'
import { ensureConversation } from '../conversations'
import { createSupervisor, workerArgs, type Runner, type AgentEntry } from '../supervisor'
import { jobsDir, readJob, listJobs, sameFlags, flagDiff, recordedFlags, strayJobs, readProcs, daemonReport, reportNotices, type Proc } from '../jobs'

let dir: string, cfg: Config, db: RouterDb, jobs: string
const SETTINGS = '/r/.router/sessions/dm-666.json'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cctr-jobs-'))
  const stateDir = join(dir, '.router')
  mkdirSync(stateDir)
  jobs = join(dir, 'jobs')
  mkdirSync(jobs)
  cfg = {
    path: join(stateDir, 'config.json'), bots: [{ name: 'main', token: 'x' }],
    home: dir, stateDir, socket: join(stateDir, 'router.sock'), owners: ['555'],
    model: 'claude-new', autoCompactWindow: 750000, claudeBin: 'claude',
  } as Config
  db = openRouterDb(join(stateDir, 'router.db'), { owners: cfg.owners })
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

function job(id: string, j: Record<string, unknown>) {
  mkdirSync(join(jobs, id), { recursive: true })
  writeFileSync(join(jobs, id, 'state.json'), JSON.stringify(j))
}
const flagsWith = (model: string) => ['--allow-dangerously-skip-permissions', '--name', 'tg-dm-666', '--setting-sources', 'project,local', '--settings', SETTINGS, '--channels', 'plugin:telegram@claude-plugins-official', '--model', model]

// --- reading jobs and comparing flags ---------------------------------------

test('jobs folder: CLAUDE_CONFIG_DIR, else ~/.claude; a job\'s state.json; unreadable ones left out', () => {
  expect(jobsDir({}, '/home/u')).toBe('/home/u/.claude/jobs')
  expect(jobsDir({ CLAUDE_CONFIG_DIR: '/c' }, '/home/u')).toBe('/c/jobs')
  job('aaaa1111', { name: 'tg-dm-666', sessionId: 's1', cwd: '/f', state: 'done', respawnFlags: flagsWith('m'), providerEnv: {} })
  mkdirSync(join(jobs, 'broken'))
  writeFileSync(join(jobs, 'broken', 'state.json'), '{oops')
  writeFileSync(join(jobs, 'pins.json'), '{}')
  expect(readJob(jobs, 'aaaa1111')).toEqual({ id: 'aaaa1111', name: 'tg-dm-666', sessionId: 's1', cwd: '/f', state: 'done', respawnFlags: flagsWith('m') })
  expect(readJob(jobs, 'broken')).toBeNull()
  expect(readJob(jobs, '../x')).toBeNull()
  expect(listJobs(jobs).map(j => j.id)).toEqual(['aaaa1111'])
  expect(listJobs(join(dir, 'none'))).toEqual([])
})

test('flags: equal whatever their order (the daemon keeps its own); the difference in words; the router\'s record', () => {
  expect(sameFlags(flagsWith('a'), flagsWith('a'))).toBe(true)
  // the order respawnFlags come back in (--model last) against workerArgs' (--model after --name)
  expect(sameFlags(flagsWith('m'), ['--allow-dangerously-skip-permissions', '--name', 'tg-dm-666', '--model', 'm', '--setting-sources', 'project,local', '--settings', SETTINGS, '--channels', 'plugin:telegram@claude-plugins-official'])).toBe(true)
  expect(sameFlags(['--a', '--b', 'x'], ['--a', '--b', 'y'])).toBe(false)
  expect(sameFlags(['--a'], ['--a', '--c'])).toBe(false)
  expect(sameFlags(flagsWith('a'), flagsWith('b'))).toBe(false)
  expect(flagDiff(flagsWith('claude-old'), flagsWith('claude-new'))).toBe('--model claude-old → claude-new')
  expect(flagDiff(['--x', '1', '--y'], ['--x', '1', '--z', '2'])).toBe('+ --z 2, - --y')
  expect(flagDiff(['--a', '--b'], ['--b', '--a'])).toBe('same')
  expect(recordedFlags({ worker_flags: JSON.stringify(['--a']) })).toEqual(['--a'])
  expect(recordedFlags({ worker_flags: '{bad' })).toBeNull()
  expect(recordedFlags({ worker_flags: null })).toBeNull()
})

// --- the wake ---------------------------------------------------------------

function supervisor(agents: () => AgentEntry[], opts: { rmFails?: boolean; jobFlags?: (id: string) => string[] | null } = {}) {
  const runs: string[][] = []
  let connected = false
  const run: Runner = async args => {
    runs.push(args)
    if (args[1] === 'agents') return { code: 0, stdout: JSON.stringify(agents()), stderr: '' }
    if (args[1] === 'rm' && opts.rmFails) return { code: 1, stdout: '', stderr: 'no such job' }
    if (args[1] === '--bg') { connected = true; return { code: 0, stdout: 'backgrounded · aaaa1111 · tg-dm-666 (idle)', stderr: '' } }
    return { code: 0, stdout: '', stderr: '' }
  }
  const logs: string[] = []
  const sup = createSupervisor({
    cfg, db, run, log: m => logs.push(m),
    isConnected: () => connected,
    async waitConnected() { return connected },
    settingsPath: () => SETTINGS,
    jobFlags: opts.jobFlags ?? (id => readJob(jobs, id)?.respawnFlags ?? null),
  })
  return { sup, runs, logs, reset: () => { connected = false; runs.length = 0 } }
}

test('a job saved with another model is removed and the session resumed with the router\'s flags now, which are recorded', async () => {
  const c = ensureConversation(cfg, db, 'main', '666', 'private', () => {})
  db.setSession(c.key, 'sess-1')
  job('aaaa1111', { name: 'tg-dm-666', sessionId: 'sess-1', cwd: c.folder, state: 'done', respawnFlags: flagsWith('claude-old') })
  const { sup, runs, logs } = supervisor(() => [{ id: 'aaaa1111', sessionId: 'sess-1', name: 'tg-dm-666', cwd: c.folder, state: 'done' }])
  await sup.ensureAwake(db.getConversation(c.key)!)
  const wanted = workerArgs(cfg, db.getConversation(c.key)!, SETTINGS)
  expect(sameFlags(wanted, flagsWith('claude-new'))).toBe(true)
  expect(runs.filter(a => a[1] !== 'agents')).toEqual([['claude', 'rm', 'aaaa1111'], ['claude', '--bg', '--resume', 'sess-1', ...wanted]])
  expect(logs).toContain('dm-666: job aaaa1111 was started with other flags (--model claude-old → claude-new); removing it to resume with the new ones')
  expect(recordedFlags(db.getConversation(c.key)!)).toEqual(wanted)
})

test('a running job with other flags is stopped first; the same flags resume without any', async () => {
  const c = ensureConversation(cfg, db, 'main', '666', 'private', () => {})
  db.setSession(c.key, 'sess-1')
  job('aaaa1111', { name: 'tg-dm-666', sessionId: 'sess-1', cwd: c.folder, respawnFlags: flagsWith('claude-old') })
  let running = true
  const s = supervisor(() => running ? [{ id: 'aaaa1111', sessionId: 'sess-1', name: 'tg-dm-666', pid: 42, status: 'idle' }] : [{ id: 'aaaa1111', sessionId: 'sess-1' }])
  // wake() itself stops a running worker whose plugin is not connected; start() stops it again before rm when it still runs
  await s.sup.ensureAwake(db.getConversation(c.key)!)
  expect(s.runs.filter(a => a[1] === 'rm')).toEqual([['claude', 'rm', 'aaaa1111']])
  expect(s.runs.findIndex(a => a[1] === 'stop')).toBeLessThan(s.runs.findIndex(a => a[1] === 'rm'))
  // now saved = what the router gives: plain resume
  running = false
  job('aaaa1111', { name: 'tg-dm-666', sessionId: 'sess-1', cwd: c.folder, respawnFlags: flagsWith('claude-new') })
  s.reset()
  await s.sup.ensureAwake(db.getConversation(c.key)!)
  expect(s.runs.filter(a => a[1] !== 'agents')).toEqual([['claude', '--bg', '--resume', 'sess-1']])
})

test('state.json unreadable: the router\'s record decides; neither known: plain resume as before; rm failing: saved flags kept', async () => {
  const c = ensureConversation(cfg, db, 'main', '666', 'private', () => {})
  db.setSession(c.key, 'sess-1')
  db.setWorkerFlags(c.key, flagsWith('claude-old'))
  const a = supervisor(() => [{ id: 'bbbb2222', sessionId: 'sess-1' }])
  await a.sup.ensureAwake(db.getConversation(c.key)!)
  expect(a.runs.filter(x => x[1] !== 'agents').map(x => x.slice(1, 4))).toEqual([['rm', 'bbbb2222'], ['--bg', '--resume', 'sess-1']])
  db.setWorkerFlags(c.key, null)
  const b = supervisor(() => [{ id: 'bbbb2222', sessionId: 'sess-1' }])
  await b.sup.ensureAwake(db.getConversation(c.key)!)
  expect(b.runs.filter(x => x[1] !== 'agents')).toEqual([['claude', '--bg', '--resume', 'sess-1']])
  expect(db.getConversation(c.key)!.worker_flags).toBeNull()
  job('bbbb2222', { name: 'tg-dm-666', sessionId: 'sess-1', respawnFlags: flagsWith('claude-old') })
  const f = supervisor(() => [{ id: 'bbbb2222', sessionId: 'sess-1' }], { rmFails: true })
  await f.sup.ensureAwake(db.getConversation(c.key)!)
  expect(f.runs.filter(x => x[1] !== 'agents')).toEqual([['claude', 'rm', 'bbbb2222'], ['claude', '--bg', '--resume', 'sess-1']])
  expect(f.logs).toContain('dm-666: claude rm bbbb2222 failed, resuming with its saved flags: no such job')
  expect(recordedFlags(db.getConversation(c.key)!)).toEqual(flagsWith('claude-old'))
})

// --- strays -----------------------------------------------------------------

test('stray jobs: only our conversations\' (name tg-<key>, its folder) that are not the current session; nothing else', () => {
  const c = ensureConversation(cfg, db, 'main', '666', 'private', () => {})
  db.setSession(c.key, 'sess-2')
  const fresh = ensureConversation(cfg, db, 'main', '777', 'private', () => {})
  const convs = db.listConversations()
  const jobsList = [
    { id: 'cur00001', name: 'tg-dm-666', cwd: c.folder, sessionId: 'sess-2' },
    { id: 'old00001', name: 'tg-dm-666', cwd: c.folder, sessionId: 'sess-1', state: 'blocked' },
    { id: 'old00002', name: 'tg-dm-666', cwd: c.folder, sessionId: 'sess-0' },
    { id: 'other001', name: 'tg-dm-666', cwd: '/elsewhere', sessionId: 'sess-9' },
    { id: 'other002', name: 'my-session', cwd: c.folder, sessionId: 'sess-8' },
    { id: 'new00001', name: 'tg-dm-777', cwd: fresh.folder, sessionId: 'sess-7' },
  ]
  const agents: AgentEntry[] = [{ id: 'old00002', name: 'tg-dm-666', cwd: c.folder, sessionId: 'sess-0', pid: 9, status: 'idle' }, { id: 'term0001', name: 'tg-dm-666', sessionId: 'x' }]
  expect(strayJobs({ agents, jobs: jobsList, convs })).toEqual([
    { id: 'old00001', key: 'dm-666', sessionId: 'sess-1', running: false },
    { id: 'old00002', key: 'dm-666', sessionId: 'sess-0', running: true },
  ])
})

test('config set model: the conversations on the default model rotate once idle, those with their own model not', async () => {
  const { runCommand } = await import('../commands')
  const a = ensureConversation(cfg, db, 'main', '666', 'private', () => {})
  const b = ensureConversation(cfg, db, 'main', '777', 'private', () => {})
  const n = ensureConversation(cfg, db, 'main', '888', 'private', () => {})
  db.setSession(a.key, 's-a'); db.setSession(b.key, 's-b')
  db.updateConversation(b.key, { model: 'claude-own' })
  let rotated = 0
  const deps = {
    cfg, db, writeConfig: () => {}, loadAccess: () => ({ dmPolicy: 'pairing', allowFrom: ['555'], groups: {}, pending: {} }), saveAccess: () => {},
    sessions: { rotateNow: () => { rotated++ }, isConnected: () => false, restart: async () => {}, stop: async () => {} },
  } as any
  const out = (await runCommand({ bot: 'main', text: '/router config set model claude-newer', senderId: '555', senderName: 'o', chatId: '555', chatType: 'private' }, deps))!
  expect(out.reply).toBe('model: "claude-new" → "claude-newer"; 用預設模型的 1 個對話閒置時換成新模型 (dm-666)')
  expect(db.getConversation(a.key)!.rotate_pending).toBe(1)
  expect(db.getConversation(b.key)!.rotate_pending).toBe(0)
  expect(db.getConversation(n.key)!.rotate_pending).toBe(0)
  expect(rotated).toBe(0)
  out.after!()
  expect(rotated).toBe(1)
})

// --- daemon report ----------------------------------------------------------

const P = (pid: number, ppid: number, args: string[], exe = '/u/.local/share/claude/versions/2.1.302'): Proc => ({ pid, ppid, args, exe })
const DAEMON_ARGS = (cwd: string) => ['/u/.local/bin/claude', 'daemon', 'run', '--origin', 'transient', '--spawned-by', JSON.stringify({ label: 'claude --bg', cwd, pid: 1 })]
const SPARE = (n: string) => ['claude', 'bg-pty-host', '--bg-pty-host', `/tmp/cc-daemon-1001/477eea43/spare/${n}.pty.sock`, '200', '50', '--', '/u/x']

test('daemon report: who started each daemon, spares, spares without a daemon; only the claude install the router runs', () => {
  const procs = [
    P(10, 1, DAEMON_ARGS('/r/home/bot1/dm-666')),
    P(11, 10, SPARE('a')),
    P(12, 11, ['claude', 'bg-spare', '--bg-spare', '/tmp/cc-daemon-1001/477eea43/spare/a.claim.sock']),
    P(20, 1, SPARE('b')),
    P(30, 1, DAEMON_ARGS('/home/u/project')),
    P(40, 1, ['claude', 'daemon', 'run'], '/tmp/fake/claude'),
    P(41, 1, SPARE('c'), '/other/claude/2.0.0'),
  ]
  const r = daemonReport(procs, ['/r/home', '/r/state'], '/u/.local/share/claude/versions')
  expect(r.daemons).toEqual([
    { pid: 10, spawnedBy: { label: 'claude --bg', cwd: '/r/home/bot1/dm-666', pid: 1 }, ours: true },
    { pid: 30, spawnedBy: { label: 'claude --bg', cwd: '/home/u/project', pid: 1 }, ours: false },
  ])
  expect(r.spares).toEqual([11, 20])
  expect(r.orphanSpares).toEqual([20])
  const notes = reportNotices(r)
  expect(notes).toHaveLength(2)
  expect(notes[0]).toStartWith('⚠️ claude daemon (pid 30) 不是由 router 帶起的, 而是 /home/u/project 的 claude --bg.')
  expect(notes[0]).toContain('GitHub #98872')
  expect(notes[0]).toContain('claude daemon stop --any --keep-workers')
  expect(notes[1]).toStartWith('⚠️ 有 1 個 Claude Code 的暖機 spare 程序沒有 daemon 在管 (pid 20)')
  expect(reportNotices(daemonReport(procs.slice(0, 3), ['/r/home'], '/u/.local/share/claude/versions'))).toEqual([])
})

test('readProcs: pid, parent and command line from a /proc-like folder, other users\' left out', () => {
  const proc = join(dir, 'proc')
  const mk = (pid: number, ppid: number, args: string[]) => {
    mkdirSync(join(proc, String(pid)), { recursive: true })
    writeFileSync(join(proc, String(pid), 'cmdline'), args.join('\0') + '\0')
    writeFileSync(join(proc, String(pid), 'stat'), `${pid} (claude (x)) S ${ppid} 1 1 0`)
    symlinkSync('/u/.local/share/claude/versions/2.1.302', join(proc, String(pid), 'exe'))
  }
  mk(10, 1, DAEMON_ARGS('/r'))
  mk(11, 10, SPARE('a'))
  mkdirSync(join(proc, 'self'))
  const ps = readProcs(proc).sort((a, b) => a.pid - b.pid)
  expect(ps.map(p => [p.pid, p.ppid, p.args[1], p.exe])).toEqual([[10, 1, 'daemon', '/u/.local/share/claude/versions/2.1.302'], [11, 10, 'bg-pty-host', '/u/.local/share/claude/versions/2.1.302']])
  expect(readProcs(proc, 999999)).toEqual([])
})

// --- router.db from the version before --------------------------------------

test('router.db from the version before (conversations without worker_flags, with data) opens with the column added and its data kept', () => {
  const path = join(dir, 'old.db')
  {
    const o = openRouterDb(path)
    const c = ensureConversation(cfg, o, 'main', '666', 'private', () => {})
    o.setSession(c.key, 'sess-1')
    o.updateConversation(c.key, { model: 'claude-own' })
    o.close()
    const raw = new Database(path)
    raw.exec('ALTER TABLE conversations DROP COLUMN worker_flags')
    expect((raw.query('PRAGMA table_info(conversations)').all() as Array<{ name: string }>).map(x => x.name)).not.toContain('worker_flags')
    raw.close()
  }
  const n = openRouterDb(path)
  try {
    expect(n.getConversation('dm-666')).toMatchObject({ key: 'dm-666', session_id: 'sess-1', model: 'claude-own', worker_flags: null })
    n.setWorkerFlags('dm-666', ['--model', 'x'])
    expect(recordedFlags(n.getConversation('dm-666')!)).toEqual(['--model', 'x'])
  } finally { n.close() }
})
