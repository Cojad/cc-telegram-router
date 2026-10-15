#!/usr/bin/env bun
// Stand-in for the claude CLI in e2e tests: just enough of `--bg`,
// `--resume`, `agents --json --all`, `stop` and `rm` for the router's
// supervisor. A "worker" is fake-worker.ts, a real process that connects to
// the router socket the way the plugin would. State lives in FAKE_STATE.

import { readFileSync, writeFileSync, appendFileSync, readdirSync, rmSync, mkdirSync } from 'fs'
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
const jobs = load()

if (args[0] === 'agents') {
  console.log(JSON.stringify(Object.values(jobs).map(j => ({ id: j.id, sessionId: j.sessionId, name: j.name, cwd: j.cwd, ...(alive(j.pid) ? { pid: j.pid, status: 'idle', state: 'done' } : { state: 'stopped' }) }))))
} else if (args[0] === 'stop' || args[0] === 'rm') {
  const j = jobs[args[1]!]
  if (j?.pid && alive(j.pid)) process.kill(j.pid, 'SIGTERM')
  if (j) { if (args[0] === 'rm') rmSync(join(JOBS, j.id)); else { j.pid = null; writeFileSync(join(JOBS, j.id), JSON.stringify(j)) } }
} else if (args[0] === '--bg') {
  const r = args.indexOf('--resume')
  const sessionId = r >= 0 ? args[r + 1]! : crypto.randomUUID()
  const id = sessionId.slice(0, 8)
  const n = args.indexOf('--name')
  const p = Bun.spawn(['bun', join(import.meta.dir, 'fake-worker.ts'), process.cwd()], { stdio: ['ignore', 'ignore', 'ignore'], env: process.env })
  p.unref()
  jobs[id] = { id, sessionId, name: n >= 0 ? args[n + 1]! : jobs[id]?.name ?? '', cwd: process.cwd(), pid: p.pid }
  writeFileSync(join(JOBS, id), JSON.stringify(jobs[id]))
  console.log(`backgrounded · ${id} · ${jobs[id].name}`)
}
