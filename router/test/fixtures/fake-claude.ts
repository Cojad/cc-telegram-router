#!/usr/bin/env bun
// Stand-in for the claude CLI in e2e tests: just enough of `--bg`,
// `--resume`, `agents --json --all`, `stop` and `rm` for the router's
// supervisor. A "worker" is fake-worker.ts, a real process that connects to
// the router socket the way the plugin would. State lives in FAKE_STATE.

import { readFileSync, writeFileSync, appendFileSync } from 'fs'
import { join } from 'path'

const STATE = process.env.FAKE_STATE!
type Job = { id: string; sessionId: string; name: string; cwd: string; pid: number | null }
const load = (): Record<string, Job> => { try { return JSON.parse(readFileSync(STATE, 'utf8')) } catch { return {} } }
const save = (j: Record<string, Job>) => writeFileSync(STATE, JSON.stringify(j))
const alive = (pid: number | null) => { if (!pid) return false; try { process.kill(pid, 0); return true } catch { return false } }
const args = process.argv.slice(2)
appendFileSync(STATE + '.log', args.join(' ') + '\n')
const jobs = load()

if (args[0] === 'agents') {
  console.log(JSON.stringify(Object.values(jobs).map(j => ({ id: j.id, sessionId: j.sessionId, name: j.name, cwd: j.cwd, ...(alive(j.pid) ? { pid: j.pid, status: 'idle', state: 'done' } : { state: 'stopped' }) }))))
} else if (args[0] === 'stop' || args[0] === 'rm') {
  const j = jobs[args[1]!]
  if (j?.pid && alive(j.pid)) process.kill(j.pid, 'SIGTERM')
  if (j) { if (args[0] === 'rm') delete jobs[args[1]!]; else j.pid = null; save(jobs) }
} else if (args[0] === '--bg') {
  const r = args.indexOf('--resume')
  const sessionId = r >= 0 ? args[r + 1]! : crypto.randomUUID()
  const id = sessionId.slice(0, 8)
  const n = args.indexOf('--name')
  const p = Bun.spawn(['bun', join(import.meta.dir, 'fake-worker.ts'), process.cwd()], { stdio: ['ignore', 'ignore', 'ignore'], env: process.env })
  p.unref()
  jobs[id] = { id, sessionId, name: n >= 0 ? args[n + 1]! : jobs[id]?.name ?? '', cwd: process.cwd(), pid: p.pid }
  save(jobs)
  console.log(`backgrounded · ${id} · ${jobs[id].name}`)
}
