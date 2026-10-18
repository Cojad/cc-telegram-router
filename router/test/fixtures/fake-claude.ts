#!/usr/bin/env bun
// Stand-in for the claude CLI in e2e tests: just enough of `--bg`,
// `--resume`, `agents --json --all`, `stop` and `rm` for the router's
// supervisor. A "worker" is fake-worker.ts, a real process that connects to
// the router socket the way the plugin would. State lives in FAKE_STATE.
// Managed mode (e2e-managed.test.ts): `daemon run` stays up as the daemon of
// CLAUDE_CONFIG_DIR (daemon.status.json, daemon/roster.json with the workers
// --bg starts), `daemon stop` ends it; FAKE_ENV_LOG gets one JSON line per call
// with the config folders and whether /etc/claude-code had the managed settings.

import { readFileSync, writeFileSync, appendFileSync, readdirSync, rmSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'

// One file per job under FAKE_STATE.jobs/: workers are spawned concurrently
// (DM and group at once) and a single shared file would lose one of them.
const STATE = process.env.FAKE_STATE!
const JOBS = STATE + '.jobs'
mkdirSync(JOBS, { recursive: true })
type Job = { id: string; sessionId: string; name: string; cwd: string; pid: number | null }
const load = (): Record<string, Job> => Object.fromEntries(readdirSync(JOBS).map(f => [f, JSON.parse(readFileSync(join(JOBS, f), 'utf8')) as Job]))
const save = (j: Record<string, Job>) => {
  for (const [id, job] of Object.entries(j)) writeFileSync(join(JOBS, id), JSON.stringify(job))
  for (const f of readdirSync(JOBS)) if (!(f in j)) rmSync(join(JOBS, f))
}
const alive = (pid: number | null) => { if (!pid) return false; try { process.kill(pid, 0); return true } catch { return false } }
const args = process.argv.slice(2)
appendFileSync(STATE + '.log', args.join(' ') + '\n')
if (process.env.FAKE_ENV_LOG) appendFileSync(process.env.FAKE_ENV_LOG, JSON.stringify({ args, config: process.env.CLAUDE_CONFIG_DIR ?? null, secure: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? null, managed: existsSync('/etc/claude-code/managed-settings.json'), telegram: Object.keys(process.env).filter(k => k.startsWith('TELEGRAM_')) }) + '\n')
const jobs = load()
const CFG = process.env.CLAUDE_CONFIG_DIR
const statusFile = CFG ? join(CFG, 'daemon.status.json') : ''
const rosterFile = CFG ? join(CFG, 'daemon', 'roster.json') : ''

if (args[0] === 'daemon' && args[1] === 'run' && CFG) {
  mkdirSync(join(CFG, 'daemon'), { recursive: true })
  writeFileSync(statusFile, JSON.stringify({ supervisorPid: process.pid, workers: {} }))
  writeFileSync(rosterFile, JSON.stringify({ proto: 1, supervisorPid: process.pid, workers: {} }))
  process.on('SIGTERM', () => { try { if (JSON.parse(readFileSync(statusFile, 'utf8')).supervisorPid === process.pid) rmSync(statusFile) } catch {} process.exit(0) })
  setInterval(() => {}, 1 << 30)
} else if (args[0] === 'daemon' && args[1] === 'stop' && CFG) {
  try { process.kill(JSON.parse(readFileSync(statusFile, 'utf8')).supervisorPid, 'SIGTERM') } catch {}
  rmSync(statusFile, { force: true })
} else if (args[0] === 'agents') {
  console.log(JSON.stringify(Object.values(jobs).map(j => ({ id: j.id, sessionId: j.sessionId, name: j.name, cwd: j.cwd, ...(alive(j.pid) ? { pid: j.pid, status: 'idle', state: 'done' } : { state: 'stopped' }) }))))
} else if (args[0] === 'stop' || args[0] === 'rm') {
  const j = jobs[args[1]!]
  if (j?.pid && alive(j.pid)) process.kill(j.pid, 'SIGTERM')
  if (j) { if (args[0] === 'rm') rmSync(join(JOBS, j.id)); else { j.pid = null; writeFileSync(join(JOBS, j.id), JSON.stringify(j)) } }
} else if (args[0] === '--bg' && existsSync(STATE + '.hold')) {
  // FAKE_STATE.hold: the worker cannot be started (e2e-sessionsend keeps a message queued across a router restart)
  console.error('fake claude: held, no worker started')
  process.exit(1)
} else if (args[0] === '--bg') {
  const r = args.indexOf('--resume')
  const sessionId = r >= 0 ? args[r + 1]! : crypto.randomUUID()
  const id = sessionId.slice(0, 8)
  const n = args.indexOf('--name')
  const p = Bun.spawn(['bun', join(import.meta.dir, 'fake-worker.ts'), process.cwd()], { stdio: ['ignore', 'ignore', 'ignore'], env: process.env })
  p.unref()
  jobs[id] = { id, sessionId, name: n >= 0 ? args[n + 1]! : jobs[id]?.name ?? '', cwd: process.cwd(), pid: p.pid }
  writeFileSync(join(JOBS, id), JSON.stringify(jobs[id]))
  // a daemon of this config folder: the worker in its roster (what the router's namespace check reads)
  try {
    const r = JSON.parse(readFileSync(rosterFile, 'utf8'))
    r.workers[id] = { pid: p.pid }
    writeFileSync(rosterFile, JSON.stringify(r))
  } catch {}
  console.log(`backgrounded · ${id} · ${jobs[id].name}`)
}
